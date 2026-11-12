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
// FAITHFUL to the original aletheia-preprocessor.mjs, whose readDirOrFile ALWAYS runs swc
// (minify: true, compress.unsafe: true). So this step minifies by default. Set UNMINIFIED=1
// for the un-minified thesis variant (step 04 then measures real line counts).
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
const UNMINIFIED = process.env.UNMINIFIED === "1"; // escape hatch for the un-minified thesis variant
// tar extraction timeout. The default (2 min) is too short for many-file packages
// (lodash, framer-motion, core-js, openmoji, ...) on slow/network volumes under concurrency,
// where small-file extraction is slow. Raise with TAR_TIMEOUT_MIN=<minutes>.
const TAR_TIMEOUT_MS = Number(process.env.TAR_TIMEOUT_MIN ?? 20) * 60_000;

const bundlesDir = join(outRoot, "bundles");
mkdirSync(bundlesDir, { recursive: true });

if (!existsSync(packagesDir)) { console.error(`Packages folder not found: ${packagesDir}  (run step 02 first)`); process.exit(1); }

// After extraction, the package.json is normally at the root of `tmp` (npm tarballs put
// everything under package/, stripped by --strip-components=1). Some tarballs use a
// different layout; find the shallowest dir that actually contains a package.json so the
// bundler resolves entry sub-paths against the right base, not one level too high.
function pkgRoot(dir) {
  if (existsSync(join(dir, "package.json"))) return dir;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && existsSync(join(dir, e.name, "package.json"))) return join(dir, e.name);
    }
  } catch {}
  return dir;
}

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
      await run("tar", ["-xzf", item.tgz, "-C", tmp, "--strip-components=1"], { timeout: TAR_TIMEOUT_MS, shell: isWin, maxBuffer: 16 * 1024 * 1024 });
      workDir = pkgRoot(tmp); // use the dir that actually holds package.json (handles odd layouts)
    }
    // Faithful default: readDirOrFile runs swc minify (as the original always did).
    // UNMINIFIED=1 skips swc and keeps raw source for real line-count measurement.
    const result = UNMINIFIED ? await readDir(workDir, { encoding: "utf8" }) : await readDirOrFile(workDir);
    writeFileSync(outFile, result.content);
    return { folder: item.key, ok: true, bytes: Buffer.byteLength(result.content) };
  } catch (e) {
    // Surface the real reason instead of a truncated command string. A killed/timed-out tar
    // (the big-package failures) is reported distinctly so it isn't confused with a bad tarball.
    const timedOut = e.killed || e.signal === "SIGTERM" || e.code === "ETIMEDOUT";
    const error = timedOut
    ? `tar extraction timed out after ${(TAR_TIMEOUT_MS / 60000).toFixed(0)} min (slow disk / many files; raise TAR_TIMEOUT_MIN or lower concurrency)`
    : String(e.stderr || e.message).split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 300);
    return { folder: item.key, ok: false, error };
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
console.log(`\nDone (${UNMINIFIED ? "un-minified" : "minified"}). bundled=${results.length - failed.length}  failed=${failed.length}  -> ${bundlesDir}`);
