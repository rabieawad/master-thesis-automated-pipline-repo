#!/usr/bin/env node
/**
 * node src/split-functions.mjs <input> [--out DIR] [--jobs N] [--min-loc N] [--text pretty|compact]
 *                              [--no-text] [--drop-helpers] [--verify] [--timeout SEC]
 *
 * <input> is the output folder of build.mjs (it has bundles/), the bundles/ folder itself,
 * or a single pseudo-bundle .js file.
 *
 * Every pseudo-bundle is dissected into its functions the way DEBUN's function collector does it:
 * inner functions are stripped from their parent and become separate functions.
 *
 * Output (under --out, default ./functions):
 *   <name>@<version>.jsonl   one function per line (see README)
 *   manifest.jsonl           one line per bundle (counts, sizes, errors)
 *   summary.json             totals
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Worker } from "node:worker_threads";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const WORKER_FILE = fileURLToPath(new URL("./split-worker.mjs", import.meta.url));

const { values: o, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        out: { type: "string", default: "functions" },
        jobs: { type: "string", default: String(Math.max(1, os.cpus().length - 1)) },
        "min-loc": { type: "string", default: "6" },
        text: { type: "string", default: "pretty" },
        "no-text": { type: "boolean", default: false },
        "drop-helpers": { type: "boolean", default: false },
        verify: { type: "boolean", default: false },
        timeout: { type: "string", default: "120" },
        help: { type: "boolean", short: "h", default: false },
    },
});

if (o.help || positionals.length !== 1) {
    console.error(
        "usage: node src/split-functions.mjs <input> [--out DIR] [--jobs N] [--min-loc N] [--text pretty|compact] [--no-text] [--drop-helpers] [--verify] [--timeout SEC]",
    );
    process.exit(o.help ? 0 : 1);
}
if (!["pretty", "compact"].includes(o.text)) {
    console.error("--text must be 'pretty' or 'compact'");
    process.exit(1);
}

const input = path.resolve(positionals[0]);
const outRoot = path.resolve(o.out);
const jobs = Math.max(1, Number.parseInt(o.jobs, 10) || 1);
const timeoutMs = Math.max(1, Number.parseInt(o.timeout, 10) || 120) * 1000;
const extractOpts = {
    minLoc: Math.max(0, Number.parseInt(o["min-loc"], 10) || 0),
    textMode: o.text,
    dropHelpers: o["drop-helpers"],
    includeText: !o["no-text"],
    verify: o.verify,
};

// ------------------------------------------------------------- discover bundles
/** "@scope+name@1.2.3.min.js" -> {name:"@scope/name", version:"1.2.3"} */
function parseBundleName(file) {
    const base = path.basename(file).replace(/\.min\.js$|\.js$/, "");
    const at = base.lastIndexOf("@");
    if (at <= 0) return { name: base, version: "" };
    return { name: base.slice(0, at).replace("+", "/"), version: base.slice(at + 1) };
}

async function walk(dir) {
    const out = [];
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...(await walk(p)));
        else if (e.isFile() && e.name.endsWith(".js")) out.push(p);
    }
    return out;
}

const st = await fs.stat(input).catch(() => null);
if (!st) {
    console.error(`Not found: ${input}`);
    process.exit(1);
}
let baseDir;
let files;
if (st.isFile()) {
    baseDir = path.dirname(input);
    files = [input];
} else {
    const bundles = await fs.stat(path.join(input, "bundles")).then((s) => s.isDirectory(), () => false);
    baseDir = bundles ? path.join(input, "bundles") : input;
    files = (await walk(baseDir)).sort();
}
if (files.length === 0) {
    console.error(`No .js bundles found under ${baseDir}`);
    process.exit(1);
}

const tasks = files.map((file) => {
    const { name, version } = parseBundleName(file);
    const rel = path.relative(baseDir, file).replace(/\.min\.js$|\.js$/, "");
    return {
        id: version ? `${name}@${version}` : name,
        name,
        version,
        file,
        outFile: path.join(outRoot, `${rel}.jsonl`),
        opts: extractOpts,
    };
});
console.log(`${tasks.length} bundle(s) to split with ${jobs} worker(s), min-loc=${extractOpts.minLoc}${extractOpts.dropHelpers ? ", dropping helpers" : ""}`);

// ------------------------------------------------------------------ worker pool
// Persistent workers (a bundle takes milliseconds); a worker is replaced after a timeout or crash.
await fs.mkdir(outRoot, { recursive: true });
const manifestFd = await fs.open(path.join(outRoot, "manifest.jsonl"), "w");
const results = [];

function runPool(list) {
    return new Promise((resolve) => {
        const queue = [...list];
        const total = queue.length;
        let done = 0;

        const finish = async (r) => {
            results.push(r);
            await manifestFd.write(JSON.stringify(r) + "\n");
            done++;
            if (done % 50 === 0 || done === total) process.stdout.write(`\r  ${done}/${total}`);
            if (done === total) {
                process.stdout.write("\n");
                resolve();
            }
        };

        const startWorker = () => {
            if (queue.length === 0) return;
            const worker = new Worker(WORKER_FILE, { resourceLimits: { maxOldGenerationSizeMb: 4096, stackSizeMb: 64 } });
            let current = null;
            let timer = null;
            let dead = false;

            const next = () => {
                clearTimeout(timer);
                current = queue.shift() ?? null;
                if (!current) {
                    dead = true;
                    worker.terminate();
                    return;
                }
                timer = setTimeout(() => fail(`timeout after ${timeoutMs / 1000}s`), timeoutMs);
                worker.postMessage(current);
            };
            const fail = async (error) => {
                if (dead) return;
                dead = true;
                clearTimeout(timer);
                worker.terminate();
                if (current) await finish({ id: current.id, name: current.name, version: current.version, bundle: current.file, error });
                startWorker(); // replace this worker
            };
            worker.on("message", async (r) => {
                await finish(r);
                next();
            });
            worker.on("error", (e) => fail(String(e?.stack ?? e)));
            worker.on("exit", (code) => {
                if (!dead && current) fail(`worker exited with code ${code}`);
            });
            next();
        };
        for (let i = 0; i < Math.min(jobs, total); i++) startWorker();
    });
}

const t0 = Date.now();
await runPool(tasks);
await manifestFd.close();

// --------------------------------------------------------------------- summary
const ok = results.filter((r) => !r.error);
const sum = (f) => ok.reduce((n, r) => n + (r[f] ?? 0), 0);
const summary = {
    input,
    bundles: results.length,
    errors: results.length - ok.length,
    functionsTotal: sum("functionsTotal"),
    functionsKept: sum("functionsKept"),
    skippedMinLoc: sum("skippedMinLoc"),
    droppedOutsideWrappers: sum("droppedOutsideWrappers"),
    bundleBytes: sum("bundleBytes"),
    functionTextBytes: sum("textBytes"),
    ...(extractOpts.verify ? { invalidFunctions: sum("invalid") } : {}),
    options: extractOpts,
    seconds: Math.round((Date.now() - t0) / 100) / 10,
};
await fs.writeFile(path.join(outRoot, "summary.json"), JSON.stringify(summary, null, 2));
console.log(summary);
for (const r of results.filter((x) => x.error)) console.log(`  ERROR ${r.id}: ${r.error.split("\n")[0]}`);
process.exitCode = summary.errors ? 2 : 0;
