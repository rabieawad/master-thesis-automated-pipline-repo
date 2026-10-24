// Reference pipeline, step 03: pseudo-bundle each downloaded package.
//
// Runs the Aletheia pseudo-bundler (paper Section 3.3, vendored in ./lib) on each
// package folder. It wraps the package's OWN source files into module([...]) and
// rewrites ESM imports to require() — it does NOT pull in any dependency code.
//
// By default the bundle is kept UN-minified, so step 04 can measure each function's
// real line count (there is no source map here). Set MINIFY=1 to also run swc
// (paper-faithful "matches real bundler syntax"), but then LOC reflects minified code.
//
// Usage:
//   node ref-03-pseudobundle.mjs [packagesDir=packages] [outDir=pseudo-bundles] [concurrency=4]
// Env: MINIFY=1 to minify.
//
// Safe to stop and re-run: packages whose bundle already exists are skipped.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { readDir, readDirOrFile } from "./lib/aletheia-bundler.mjs";

const packagesDir = resolve(process.argv[2] ?? "packages");
const outRoot = resolve(process.argv[3] ?? "pseudo-bundles");
const CONC = Number(process.argv[4] ?? 4);
const MINIFY = process.env.MINIFY === "1";

const bundlesDir = join(outRoot, "bundles");
mkdirSync(bundlesDir, { recursive: true });

if (!existsSync(packagesDir)) { console.error(`Packages folder not found: ${packagesDir}  (run ref-02 first)`); process.exit(1); }
const folders = readdirSync(packagesDir).filter((d) => {
  const p = join(packagesDir, d);
  try { return !d.startsWith(".") && statSync(p).isDirectory() && existsSync(join(p, "package.json")); } catch { return false; }
});

async function bundleOne(folder) {
  const dir = join(packagesDir, folder);
  const outFile = join(bundlesDir, `${folder}.js`);
  if (existsSync(outFile)) return { folder, ok: true, skipped: true, bytes: statSync(outFile).size };
  try {
    const result = MINIFY ? await readDirOrFile(dir) : await readDir(dir, { encoding: "utf8" });
    writeFileSync(outFile, result.content);
    return { folder, ok: true, bytes: Buffer.byteLength(result.content) };
  } catch (e) {
    return { folder, ok: false, error: String(e.message).split("\n").slice(0, 2).join(" ").slice(0, 300) };
  }
}

const results = [];
let next = 0;
const started = Date.now();
await Promise.all(Array.from({ length: CONC }, async () => {
  while (next < folders.length) {
    const folder = folders[next++];
    let r; try { r = await bundleOne(folder); } catch (e) { r = { folder, ok: false, error: String(e.message).slice(0, 300) }; }
    results.push(r);
    const mins = ((Date.now() - started) / 60000).toFixed(1);
    const tag = !r.ok ? "FAIL" : r.skipped ? "skip" : "ok  ";
    console.log(`[${results.length}/${folders.length}] ${tag} ${r.folder}${r.ok ? `  (${((r.bytes ?? 0) / 1024).toFixed(1)} KiB)` : "  -> " + r.error}  (${mins} min)`);
  }
}));

results.sort((a, b) => a.folder.localeCompare(b.folder));
writeFileSync(join(outRoot, "bundle-results.json"), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\nDone (${MINIFY ? "minified" : "un-minified"}). bundled=${results.length - failed.length}  failed=${failed.length}  -> ${bundlesDir}`);
