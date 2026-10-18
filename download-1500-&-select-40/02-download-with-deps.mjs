// Download every package from jsdelivr-top.json WITH all of its dependencies.
// No bundling. Each package gets its own folder with a real node_modules tree:
//
//   packages/<name>/package.json
//   packages/<name>/node_modules/<name>/...        <- the package itself
//   packages/<name>/node_modules/<its deps>/...    <- all transitive dependencies
//
// Usage:
//   node download-with-deps.mjs [list.json=jsdelivr-top.json] [outDir=packages] [concurrency=4] [limit=all]
// Examples:
//   node download-with-deps.mjs
//   node download-with-deps.mjs jsdelivr-top.json packages 6 1050   # only the top 1050
//
// Uses pnpm if it is installed (one shared store, hard-linked into every folder = far less
// disk space), otherwise falls back to npm. Force one with: PM=npm node ... or PM=pnpm node ...
// Install pnpm with:  npm i -g pnpm   (or: corepack enable)
//
// Requires Node 18+. Safe to stop and re-run: finished packages are skipped,
// failed ones are retried. Install scripts are NOT run (--ignore-scripts).

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";

const run = promisify(execFile);
const isWin = process.platform === "win32";

function hasPnpm() {
  try {
    execFileSync(isWin ? "pnpm.cmd" : "pnpm", ["--version"], { stdio: "ignore", shell: isWin });
    return true;
  } catch {
    return false;
  }
}
const PM = process.env.PM ?? (hasPnpm() ? "pnpm" : "npm");
if (PM !== "npm" && PM !== "pnpm") throw new Error("PM must be npm or pnpm");
const pmBin = isWin ? `${PM}.cmd` : PM;
console.log(`Package manager: ${PM}`);

const listPath = process.argv[2] ?? "jsdelivr-top.json";
const outDir = resolve(process.argv[3] ?? "packages");
const CONC = Number(process.argv[4] ?? 4);
const LIMIT = process.argv[5] && process.argv[5] !== "all" ? Number(process.argv[5]) : Infinity;

const pkgs = JSON.parse(readFileSync(listPath, "utf8")).slice(0, LIMIT);
mkdirSync(outDir, { recursive: true });

// pnpm store lives inside outDir so it is on the same disk -> hard links work (no duplicate copies)
const storeDir = join(outDir, ".pnpm-store");

const folderName = (n) => n.replace(/^@/, "").replace("/", "__");
const DONE = ".download-ok"; // marker file written after a successful install

async function download({ rank, name }) {
  const dir = join(outDir, folderName(name));
  if (existsSync(join(dir, DONE))) return { rank, name, ok: true, skipped: true };

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true }); // clean partial install
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "holder", version: "1.0.0", private: true }));
      const args =
        PM === "pnpm"
          ? ["add", name, "--ignore-scripts", "--store-dir", storeDir, "--config.auto-install-peers=true", "--reporter=silent"]
          : ["install", name, "--ignore-scripts", "--no-audit", "--no-fund", "--legacy-peer-deps", "--prefer-offline", "--loglevel=error"];
      await run(pmBin, args, { cwd: dir, timeout: 5 * 60_000, maxBuffer: 20 * 1024 * 1024, shell: isWin });
      const version = JSON.parse(readFileSync(join(dir, "node_modules", ...name.split("/"), "package.json"), "utf8")).version;
      writeFileSync(join(dir, DONE), version);
      return { rank, name, ok: true, version };
    } catch (e) {
      if (attempt === 3)
        return { rank, name, ok: false, error: String(e.stderr || e.message).split("\n").filter(Boolean).slice(0, 2).join(" ").slice(0, 300) };
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
}

const results = [];
let next = 0;
const started = Date.now();

await Promise.all(
  Array.from({ length: CONC }, async () => {
    while (next < pkgs.length) {
      const r = await download(pkgs[next++]);
      results.push(r);
      const mins = ((Date.now() - started) / 60000).toFixed(1);
      console.log(`[${results.length}/${pkgs.length}] ${r.ok ? (r.skipped ? "skip" : "ok  ") : "FAIL"} ${r.name}${r.ok ? "" : "  -> " + r.error}  (${mins} min)`);
    }
  })
);

results.sort((a, b) => a.rank - b.rank);
writeFileSync(join(outDir, "download-results.json"), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\nDone. ok=${results.length - failed.length}  failed=${failed.length}`);
if (failed.length) console.log("Failed packages are listed in download-results.json - just re-run the script to retry them.");
