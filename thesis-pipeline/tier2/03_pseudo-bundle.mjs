// Reference pipeline, step 03: pseudo-bundle each downloaded package.
//
// Runs the Aletheia pseudo-bundler (paper Section 3.3, vendored in ./lib) on each
// package's OWN source files -> module([...]) with ESM imports rewritten to require()
// (dependency code is NOT pulled in).
//
// Packages are stored as single .tgz files (step 02). This step EXTRACTS each tarball
// to a temporary directory just long enough to bundle it, then deletes the temp dir —
// so the only thing kept on disk is the one .tgz per package. (A legacy extracted
// folder with a package.json is still accepted, for older runs.)
//
// By default the bundle is kept UN-minified, so step 04 can measure real line counts.
// Set MINIFY=1 to also run swc.
//
// Usage:  node 03_pseudo-bundle.mjs [packagesDir=packages] [outDir=pseudo-bundles] [concurrency=4]
// Safe to stop and re-run: packages whose bundle already exists are skipped.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readDir, readDirOrFile } from "./lib/aletheia-bundler.mjs";

const run = promisify(execFile);
const isWin = process.platform === "win32";
const packagesDir = resolve(process.argv[2] ?? "packages");
const outRoot = resolve(process.argv[3] ?? "pseudo-bundles");
const CONC = Number(process.argv[4] ?? 4);
const MINIFY = process.env.MINIFY === "1";

const bundlesDir = join(outRoot, "bundles");
mkdirSync(bundlesDir, { recursive: true });

if (!existsSync(packagesDir)) { console.error(`Packages folder not found: ${packagesDir}  (run step 02 first)`); process.exit(1); }

// discover .tgz packages (preferred) and legacy extracted folders
const items = [];
for (const e of readdirSync(packagesDir)) {
  if (e.startsWith(".")) continue;
  const p = join(packagesDir, e);
  if (e.endsWith(".tgz")) items.push({ key: e.slice(0, -4), tgz: p });
  else { try { if (statSync(p).isDirectory() && existsSync(join(p, "package.json"))) items.push({ key: e, dir: p }); } catch {} }
}

async function bundleOne(item) {
  const outFile = join(bundlesDir, `${item.key}.js`);
  if (existsSync(outFile)) return { folder: item.key, ok: true, skipped: true, bytes: statSync(outFile).size };
  let workDir = item.dir, tmp = null;
  try {
    if (item.tgz) {
      tmp = join(packagesDir, `.x-${process.pid}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(tmp, { recursive: true });
      await run("tar", ["-xzf", item.tgz, "-C", tmp, "--strip-components=1"], { timeout: 2 * 60_000, shell: isWin });
      workDir = tmp;
    }
    const result = MINIFY ? await readDirOrFile(workDir) : await readDir(workDir, { encoding: "utf8" });
    writeFileSync(outFile, result.content);
    return { folder: item.key, ok: true, bytes: Buffer.byteLength(result.content) };
  } catch (e) {
    return { folder: item.key, ok: false, error: String(e.message).split("\n").slice(0, 2).join(" ").slice(0, 300) };
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

const results = [];
let next = 0;
const started = Date.now();
await Promise.all(Array.from({ length: CONC }, async () => {
  while (next < items.length) {
    const item = items[next++];
    let r; try { r = await bundleOne(item); } catch (e) { r = { folder: item.key, ok: false, error: String(e.message).slice(0, 300) }; }
    results.push(r);
    const mins = ((Date.now() - started) / 60000).toFixed(1);
    const tag = !r.ok ? "FAIL" : r.skipped ? "skip" : "ok  ";
    console.log(`[${results.length}/${items.length}] ${tag} ${r.folder}${r.ok ? `  (${((r.bytes ?? 0) / 1024).toFixed(1)} KiB)` : "  -> " + r.error}  (${mins} min)`);
  }
}));

results.sort((a, b) => a.folder.localeCompare(b.folder));
writeFileSync(join(outRoot, "bundle-results.json"), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\nDone (${MINIFY ? "minified" : "un-minified"}). bundled=${results.length - failed.length}  failed=${failed.length}  -> ${bundlesDir}`);
