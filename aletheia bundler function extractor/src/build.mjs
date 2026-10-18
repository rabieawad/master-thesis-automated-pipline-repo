#!/usr/bin/env node
/**
 * node src/build.mjs <dataset-path> [--out DIR] [--jobs N] [--exports keep|strip]
 *                                   [--target es2022] [--timeout SEC] [--only name,name]
 *
 * <dataset-path> is the folder produced by fetch-each.sh (it contains pkgs/<name>/),
 * the pkgs/ folder itself, or a single pnpm-installed project folder.
 *
 * Output (under --out, default ./out):
 *   bundles/<name>@<version>.min.js   pseudo-bundle, minified (one per package version)
 *   sbom/<project>.cdx.json           CycloneDX SBOM per project
 *   manifest.jsonl                    one line per package version (selection, sizes, errors)
 *   summary.json                      totals
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Worker } from "node:worker_threads";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { findProjects, scanInstalled, readLockfile } from "./pnpm-project.mjs";
import { buildSbom } from "./sbom.mjs";

const WORKER_FILE = fileURLToPath(new URL("./worker.mjs", import.meta.url));

const { values: opts, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        out: { type: "string", default: "out" },
        jobs: { type: "string", default: String(Math.max(1, os.cpus().length - 1)) },
        exports: { type: "string", default: "keep" },
        timeout: { type: "string", default: "180" },
        target: { type: "string" },
        only: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
    },
});

if (opts.help || positionals.length !== 1) {
    console.error(
        "usage: node src/build.mjs <dataset-path> [--out DIR] [--jobs N] [--exports keep|strip] [--target es2022] [--timeout SEC] [--only a,b]",
    );
    process.exit(opts.help ? 0 : 1);
}
if (!["strip", "keep"].includes(opts.exports)) {
    console.error("--exports must be 'strip' or 'keep'");
    process.exit(1);
}

const datasetPath = path.resolve(positionals[0]);
const outRoot = path.resolve(opts.out);
const jobs = Math.max(1, Number.parseInt(opts.jobs, 10) || 1);
const timeoutMs = Math.max(1, Number.parseInt(opts.timeout, 10) || 180) * 1000;
const only = opts.only ? new Set(opts.only.split(",")) : null;

const bundleFile = (name, version) => path.join(outRoot, "bundles", `${name.replace("/", "+")}@${version}.min.js`);

// ---------------------------------------------------------------- phase 1: scan
let projects = await findProjects(datasetPath);
if (only) projects = projects.filter((p) => only.has(path.basename(p)) || only.has(path.basename(p).replace("__", "/")));
if (projects.length === 0) {
    console.error(`No pnpm projects (node_modules/.pnpm) found under ${datasetPath}`);
    process.exit(1);
}
console.log(`Found ${projects.length} project(s)`);

const tasks = new Map(); // "name@version" -> task (deduplicated across projects)
const projectInfos = [];
for (const project of projects) {
    const installed = await scanInstalled(project);
    const lock = await readLockfile(project);
    projectInfos.push({ project, installed, lock });
    for (const [key, p] of installed) {
        if (!tasks.has(key)) {
            tasks.set(key, {
                id: key,
                name: p.name,
                version: p.version,
                pkgDir: p.dir,
                outFile: bundleFile(p.name, p.version),
                exportsMode: opts.exports,
                target: opts.target,
            });
        }
    }
}
console.log(`${tasks.size} unique package versions to process with ${jobs} worker(s)`);

// ------------------------------------------------------------ phase 2: worker pool
await fs.mkdir(outRoot, { recursive: true });
const manifestFd = await fs.open(path.join(outRoot, "manifest.jsonl"), "w");
const results = new Map();

function runPool(taskList) {
    return new Promise((resolve) => {
        const queue = [...taskList];
        let active = 0;
        let done = 0;
        const total = queue.length;
        if (total === 0) return resolve();

        const finish = async (result) => {
            results.set(result.id, result);
            await manifestFd.write(JSON.stringify(result) + "\n");
            done++;
            if (done % 25 === 0 || done === total) process.stdout.write(`\r  ${done}/${total}`);
            if (done === total) {
                process.stdout.write("\n");
                resolve();
            }
        };

        const spawn = () => {
            if (queue.length === 0) return;
            const task = queue.shift();
            active++;
            const worker = new Worker(WORKER_FILE, { resourceLimits: { maxOldGenerationSizeMb: 4096 } });
            let settled = false;
            const settle = async (result) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                active--;
                worker.terminate();
                await finish(result);
                spawn();
            };
            const timer = setTimeout(
                () => settle({ id: task.id, name: task.name, version: task.version, dir: task.pkgDir, error: `timeout after ${timeoutMs / 1000}s` }),
                timeoutMs,
            );
            worker.once("message", settle);
            worker.once("error", (e) => settle({ id: task.id, name: task.name, version: task.version, dir: task.pkgDir, error: String(e?.stack ?? e) }));
            worker.once("exit", (code) => {
                if (!settled) settle({ id: task.id, name: task.name, version: task.version, dir: task.pkgDir, error: `worker exited with code ${code}` });
            });
            worker.postMessage(task);
        };

        // one fresh worker per package keeps memory bounded and isolates crashes
        for (let i = 0; i < Math.min(jobs, total); i++) spawn();
    });
}

const t0 = Date.now();
await runPool([...tasks.values()]);
await manifestFd.close();

// ------------------------------------------------------------------ phase 3: SBOMs
await fs.mkdir(path.join(outRoot, "sbom"), { recursive: true });
for (const { project, installed, lock } of projectInfos) {
    const projectName = path.basename(project).replace("__", "/");
    const sbom = await buildSbom({ projectName, lock, installed, results, outRoot });
    await fs.writeFile(path.join(outRoot, "sbom", `${path.basename(project)}.cdx.json`), JSON.stringify(sbom, null, 2));
}

// ------------------------------------------------------------------ summary
const all = [...results.values()];
const summary = {
    dataset: datasetPath,
    projects: projects.length,
    packageVersions: all.length,
    withBundle: all.filter((r) => r.outFile).length,
    emptyNoCode: all.filter((r) => r.empty).length,
    fallbackSelection: all.filter((r) => r.fallback).length,
    withSkippedFiles: all.filter((r) => r.skipped?.length).length,
    errors: all.filter((r) => r.error).length,
    exportsMode: opts.exports,
    target: opts.target ?? "(swc default, es5)",
    seconds: Math.round((Date.now() - t0) / 100) / 10,
};
await fs.writeFile(path.join(outRoot, "summary.json"), JSON.stringify(summary, null, 2));
console.log(summary);
if (summary.errors) {
    console.log("Errors:");
    for (const r of all.filter((x) => x.error)) console.log(`  ${r.id}: ${r.error.split("\n")[0]}`);
}
