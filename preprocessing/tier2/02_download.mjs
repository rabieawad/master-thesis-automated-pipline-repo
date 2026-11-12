// Reference pipeline, step 02: download each reference package at its exact version.
//
// Uses `npm pack name@version`, which fetches ONLY that one package's tarball from
// the npm registry (no dependency tree). The tarball is KEPT AS A SINGLE .tgz FILE —
// it is NOT extracted — so each package is one file on disk instead of a folder of
// many tiny files (this is the "always tar downloaded packages" rule). Step 03
// extracts each tarball to a temp dir just long enough to pseudo-bundle it.
//
//   packages/<name>@<version>.tgz
//
// Usage:
//   node 02_download.mjs [reference-packages.json=reference-list/reference-packages.json] \
//        [outDir=packages] [concurrency=6]
//
// Safe to stop and re-run: a package whose .tgz already exists is skipped; failures retry.

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, renameSync, readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";

const run = promisify(execFile);
const isWin = process.platform === "win32";
const npmBin = isWin ? "npm.cmd" : "npm";

const listPath = resolve(process.argv[2] ?? "reference-list/reference-packages.json");
const outDir = resolve(process.argv[3] ?? "packages");
const CONC = Number(process.argv[4] ?? 6);

if (!existsSync(listPath)) { console.error(`Reference list not found: ${listPath}  (run step 01 first)`); process.exit(1); }
const pkgs = JSON.parse(readFileSync(listPath, "utf8"));
mkdirSync(outDir, { recursive: true });

const tgzName = (name, version) => `${name.replace("/", "+")}@${version}.tgz`;

async function download({ name, version }) {
  const tgzPath = join(outDir, tgzName(name, version));
  if (existsSync(tgzPath)) return { name, version, ok: true, skipped: true };

  for (let attempt = 1; attempt <= 3; attempt++) {
    // pack into a temp subdir of outDir (same filesystem, so the final rename is atomic)
    const tmp = join(outDir, `.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
    try {
      mkdirSync(tmp, { recursive: true });
      const { stdout } = await run(npmBin, ["pack", `${name}@${version}`, "--json", "--pack-destination", tmp, "--no-audit", "--no-fund", "--loglevel=error"], { timeout: 3 * 60_000, maxBuffer: 20 * 1024 * 1024, shell: isWin });
      let file;
      try { file = JSON.parse(stdout)[0].filename; } catch { file = readdirSync(tmp).find((f) => f.endsWith(".tgz")); }
      renameSync(join(tmp, file), tgzPath); // keep the tarball as-is, one file per package
      rmSync(tmp, { recursive: true, force: true });
      return { name, version, ok: true };
    } catch (e) {
      rmSync(tmp, { recursive: true, force: true });
      if (attempt === 3) return { name, version, ok: false, error: String(e.stderr || e.message).split("\n").filter(Boolean).slice(0, 2).join(" ").slice(0, 300) };
      await new Promise((r) => setTimeout(r, 2500 * attempt));
    }
  }
}

const results = [];
let next = 0;
const started = Date.now();
await Promise.all(Array.from({ length: CONC }, async () => {
  while (next < pkgs.length) {
    const r = await download(pkgs[next++]);
    results.push(r);
    const mins = ((Date.now() - started) / 60000).toFixed(1);
    const tag = !r.ok ? "FAIL" : r.skipped ? "skip" : "ok  ";
    console.log(`[${results.length}/${pkgs.length}] ${tag} ${r.name}@${r.version}${r.ok ? "" : "  -> " + r.error}  (${mins} min)`);
  }
}));

results.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
writeFileSync(join(outDir, "download-results.json"), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\nDone. downloaded/skipped=${results.length - failed.length}  failed=${failed.length}  (each package kept as a single .tgz)`);
if (failed.length) console.log("Failed packages are in download-results.json — re-run to retry.");
