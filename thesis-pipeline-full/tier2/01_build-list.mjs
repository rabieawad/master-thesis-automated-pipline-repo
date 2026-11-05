// Reference pipeline, step 01: build the list of packages to download.
//
// Reads the FIRST pipeline's output and produces the complete, de-duplicated set
// of `name@version` for the reference dataset:
//   - each selected package itself              (from 04_selected_sample/selected.json)
//   - every one of its bundled dependencies     (from 05_selected_bundles/selected_dependencies.csv)
// Then expands each package to a set of published versions (the Aletheia paper indexes
// every version so it can detect which one a website uses):
//   --versions all     EVERY stable published version, all majors/minors/patches (default)
//   --versions minor   only patches within the recorded version's major.minor
//   --versions latest  only the single newest stable version
//   --versions exact   only the exact recorded version
//
// Version enumeration uses `npm view <name> versions --json` (NOT a raw fetch), so it
// honours the same registry / proxy / auth config npm already uses (step 02 uses npm too).
// If npm cannot reach the registry for a package, it is reported LOUDLY and that package
// keeps only its exact version — it is never silently reduced to one.
//
// Usage:
//   node 01_build-list.mjs <firstPipelineOutputDir|csvFile> <outDir> \
//        [--versions all|minor|latest|exact] [--conc 5] [--no-package]
// Env equivalents: VERSIONS, CONC, INCLUDE_PACKAGE=0  (PATCH_LEVEL / --patch-level still work as aliases)
//
// Output:
//   <outDir>/reference-packages.json   [{ name, version, origin }]
//   <outDir>/reference-packages.csv    name,version,origin

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseVer, cmpVer, isStable, stableOf, sampleKept, keptCountForSample } from "./lib/sampling.mjs";

const run = promisify(execFile);
const isWin = process.platform === "win32";
const npmBin = isWin ? "npm.cmd" : "npm";

const args = process.argv.slice(2);
const opt = (name, fb) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fb; };
const VALUE_FLAGS = ["--versions", "--patch-level", "--conc", "--sample-threshold", "--adjacent-n", "--per-minor-n", "--seed", "--sample-strategy", "--selection"];
const positional = args.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.includes(args[i - 1]));

const INPUT = resolve(positional[0] ?? ".");
const outDir = resolve(positional[1] ?? "reference-list");
// VERSIONS decides which published versions of each package to pull:
//   all    every stable published version (all majors/minors/patches) -- the Aletheia paper's full index (default)
//   minor  only patches within the recorded version's major.minor
//   latest only the single newest stable version
//   exact  only the exact recorded version
//   sample cap huge histories: packages with <= --sample-threshold versions are taken whole;
//          above it, a seeded strategy keeps the observed version + --adjacent-n neighbours and
//          --per-minor-n patches per major.minor group (50/50 random vs contiguous). Strategy is
//          pluggable via --sample-strategy (default "minor-adjacent").
// --patch-level / PATCH_LEVEL stay as backward-compatible aliases for --versions / VERSIONS.
const VERSIONS = (opt("--versions", opt("--patch-level", process.env.VERSIONS ?? process.env.PATCH_LEVEL)) ?? "all").toLowerCase();
const CONC = Number(opt("--conc", process.env.CONC) ?? 5);
const INCLUDE_PACKAGE = !args.includes("--no-package") && process.env.INCLUDE_PACKAGE !== "0";
// --- sampling (only used when VERSIONS=sample) ---
const SAMPLE_THRESHOLD = Number(opt("--sample-threshold", process.env.SAMPLE_THRESHOLD) ?? 50); // <= this many versions -> take all
const ADJACENT_N = Number(opt("--adjacent-n", process.env.ADJACENT_N) ?? 4);                   // neighbours of the observed version to always keep
const PER_MINOR_N = Number(opt("--per-minor-n", process.env.PER_MINOR_N) ?? 4);                // patches taken per major.minor group
const SEED = Number(opt("--seed", process.env.SEED) ?? 42);                                    // reproducible sampling
const SAMPLE_STRATEGY = (opt("--sample-strategy", process.env.SAMPLE_STRATEGY) ?? "minor-window").toLowerCase();
// Preview / dry-run: count what WOULD be downloaded (and a free PER_MINOR_N sweep) without
// writing the real list or downloading anything.
const PREVIEW = args.includes("--preview") || String(process.env.PREVIEW ?? "0") !== "0";

if (!["all", "minor", "latest", "exact", "sample"].includes(VERSIONS)) { console.error(`--versions must be all|minor|latest|exact|sample`); process.exit(1); }
mkdirSync(outDir, { recursive: true });

function findFile(...c) { for (const x of c) if (existsSync(x)) return x; return null; }
const depsCsv = INPUT.endsWith(".csv") ? INPUT : findFile(join(INPUT, "05_selected_bundles", "selected_dependencies.csv"), join(INPUT, "selected_dependencies.csv"));
const selectedJson = INPUT.endsWith(".csv") ? findFile(join(INPUT, "..", "..", "04_selected_sample", "selected.json")) : findFile(join(INPUT, "04_selected_sample", "selected.json"), join(INPUT, "selected.json"));
if (!depsCsv) { console.error(`Could not find selected_dependencies.csv under ${INPUT}`); process.exit(1); }
console.log(`dependencies CSV : ${depsCsv}`);
console.log(`selected.json    : ${selectedJson ?? "(not found — packages' own versions may be missing)"}`);
console.log(`versions         : ${VERSIONS}   include-package: ${INCLUDE_PACKAGE}\n`);

function parseLine(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) { const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c; }
  out.push(cur); return out;
}

// ---------- selection (which survived packages, and whether their deps, are included) ----------
// A --selection JSON maps packageName -> { include:bool, withDeps:bool }. Anything not
// listed defaults to fully included. No file at all = include everything (default).
const SELECTION_FILE = opt("--selection", process.env.SELECTION_FILE);
let SELECTION = null;
if (SELECTION_FILE && existsSync(SELECTION_FILE)) {
  try { SELECTION = JSON.parse(readFileSync(SELECTION_FILE, "utf8")); console.log(`selection       : ${SELECTION_FILE} (${Object.keys(SELECTION).length} overrides)`); }
  catch { console.warn(`Could not read selection ${SELECTION_FILE}; including everything`); }
}
const sel = (name) => (SELECTION && SELECTION[name]) ? { include: SELECTION[name].include !== false, withDeps: SELECTION[name].withDeps !== false } : { include: true, withDeps: true };

// ---------- base set ----------
const base = new Map();
const addExact = (name, version, origin) => { if (name && version) base.set(`${name}@${version}`, base.get(`${name}@${version}`) ?? origin); };

// package -> its recorded version (for the package anchors themselves)
const verOf = new Map();
if (selectedJson) for (const e of JSON.parse(readFileSync(selectedJson, "utf8"))) verOf.set(e.name, e.version);

// iterate the dependencies CSV as the master list (one row per survived package); honor the
// per-package selection. A dependency that another INCLUDED package bundles still enters the
// set via that package, even if its own package anchor was excluded.
const lines = readFileSync(depsCsv, "utf8").split(/\r?\n/).filter((l) => l.length);
const header = parseLine(lines[0]);
const depCol = header.findIndex((h) => /depend/i.test(h));
const pkgCol = header.findIndex((h) => /^package$|name/i.test(h));
const csvPkgs = new Set();
for (const line of lines.slice(1)) {
  const cells = parseLine(line);
  const pkg = cells[pkgCol >= 0 ? pkgCol : 0];
  csvPkgs.add(pkg);
  const s = sel(pkg);
  if (INCLUDE_PACKAGE && s.include) { const v = verOf.get(pkg); if (v) addExact(pkg, v, "package"); }
  if (s.withDeps) {
    let deps = []; try { deps = JSON.parse(cells[depCol >= 0 ? depCol : 1] || "[]"); } catch {}
    for (const d of deps) { const at = d.lastIndexOf("@"); if (at > 0) addExact(d.slice(0, at), d.slice(at + 1), "dependency"); }
  }
}
// packages present in selected.json but not in the CSV (safety) — add if included
if (INCLUDE_PACKAGE) for (const [name, v] of verOf) if (!csvPkgs.has(name) && sel(name).include) addExact(name, v, "package");

console.log(`Base set: ${base.size} exact name@version (before version expansion)   versions=${VERSIONS}\n`);

// ---------- version expansion via `npm view` ----------
// (version/sampling helpers now live in ./lib/sampling.mjs so they can be unit-tested)
const versionsCache = new Map();
let registryFailures = [];

async function allVersions(name) {
  if (versionsCache.has(name)) return versionsCache.get(name);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { stdout } = await run(npmBin, ["view", name, "versions", "--json", "--no-audit", "--no-fund", "--loglevel=error"], { timeout: 60_000, maxBuffer: 20 * 1024 * 1024, shell: isWin });
      let v = JSON.parse(stdout);
      if (typeof v === "string") v = [v];
      if (!Array.isArray(v)) v = [];
      versionsCache.set(name, v);
      return v;
    } catch (e) {
      if (attempt === 3) { versionsCache.set(name, null); return null; }
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

async function selectVersions(name, version) {
  if (VERSIONS === "exact") return [version];
  const versions = await allVersions(name);
  if (!versions) { registryFailures.push(`${name}@${version}`); console.warn(`  !! REGISTRY ERROR for ${name}: could not list versions — keeping only ${version}`); return [version]; }
  const stable = versions.filter(isStable).map((v) => ({ v, p: parseVer(v) }))
    .filter(({ p }) => Number.isFinite(p.major) && Number.isFinite(p.minor) && Number.isFinite(p.patch));
  if (stable.length === 0) { console.warn(`  .. no stable versions listed for ${name} — keeping ${version}`); return [version]; }
  let pick;
  if (VERSIONS === "all") {
    pick = stable;                                        // every major.minor.patch
  } else if (VERSIONS === "latest") {
    pick = [stable.reduce((m, x) => (cmpVer(x.p, m.p) > 0 ? x : m))];
  } else if (VERSIONS === "sample") {
    const chosen = sampleKept(name, version, stable, { strategy: SAMPLE_STRATEGY, perMinorN: PER_MINOR_N, adjacentN: ADJACENT_N, threshold: SAMPLE_THRESHOLD, seed: SEED });
    pick = stable.filter((s) => chosen.has(s.v));
    if (!pick.some((s) => s.v === version)) pick.push({ v: version, p: parseVer(version) }); // observed always in
  } else { // minor: only patches within the recorded version's major.minor
    const t = parseVer(version);
    pick = stable.filter(({ p }) => p.major === t.major && p.minor === t.minor);
    if (pick.length === 0) { console.warn(`  .. no ${t.major}.${t.minor}.x found for ${name} — keeping ${version}`); return [version]; }
  }
  pick.sort((a, b) => cmpVer(a.p, b.p));
  return pick.map((x) => x.v);
}

const baseEntries = [...base.entries()].map(([k, origin]) => { const at = k.lastIndexOf("@"); return { name: k.slice(0, at), version: k.slice(at + 1), origin }; });
const cell = (s) => (/[",\r\n]/.test(String(s)) ? `"${String(s).replaceAll('"', '""')}"` : String(s));

if (PREVIEW) {
  // ---- DRY-RUN: count what would be downloaded, no list written, no download ----
  const SWEEP_NS = [1, 2, 3, 4, 6, 8];
  const perAnchor = [];
  const sweepTotals = Object.fromEntries(SWEEP_NS.map((n) => [n, 0]));
  let totalNow = 0, totalAll = 0, next = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (next < baseEntries.length) {
      const { name, version, origin } = baseEntries[next++];
      const stable = stableOf(await allVersions(name));
      const keptNow = (await selectVersions(name, version)).length; // current settings (any mode)
      const totalStable = stable.length || 1;
      perAnchor.push({ name, origin, observed: version, total_stable: totalStable, kept_now: keptNow });
      totalNow += keptNow; totalAll += totalStable;
      for (const n of SWEEP_NS) sweepTotals[n] += keptCountForSample(name, version, stable, n, { strategy: SAMPLE_STRATEGY, adjacentN: ADJACENT_N, threshold: SAMPLE_THRESHOLD, seed: SEED });
      console.log(`  ${name}@${version}: ${totalStable} stable -> keep ${keptNow}`);
    }
  }));
  perAnchor.sort((a, b) => b.kept_now - a.kept_now || a.name.localeCompare(b.name));
  const byOrigin = perAnchor.reduce((a, r) => ((a[r.origin] = (a[r.origin] ?? 0) + r.kept_now), a), {});

  const summary = {
    settings: { VERSIONS, SAMPLE_THRESHOLD, SAMPLE_STRATEGY, PER_MINOR_N, ADJACENT_N, SEED, INCLUDE_PACKAGE },
    anchors: baseEntries.length,
    downloadsNow: totalNow,
    downloadsIfAll: totalAll,
    byOrigin,
    sweepPerMinorN: VERSIONS === "sample" ? sweepTotals : null,
    perAnchor,
  };
  writeFileSync(join(outDir, "preview.json"), JSON.stringify(summary, null, 2) + "\n");
  writeFileSync(join(outDir, "preview.csv"), "name,origin,observed,total_stable,kept_now\n" +
    perAnchor.map((r) => [r.name, r.origin, r.observed, r.total_stable, r.kept_now].map(cell).join(",")).join("\n") + "\n");

  console.log(`\n==== PREVIEW (no download) ====`);
  console.log(`settings: VERSIONS=${VERSIONS}` + (VERSIONS === "sample" ? `  threshold=${SAMPLE_THRESHOLD}  strategy=${SAMPLE_STRATEGY}  PER_MINOR_N=${PER_MINOR_N}  seed=${SEED}` : ""));
  console.log(`anchors (packages + deps): ${baseEntries.length}`);
  console.log(`WILL DOWNLOAD NOW: ${totalNow} name@version` + (VERSIONS !== "all" ? `   (VERSIONS=all would be ${totalAll})` : ""));
  console.log(`  by origin: ${Object.entries(byOrigin).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  if (VERSIONS === "sample") {
    console.log(`\nPER_MINOR_N sweep (total downloads, same threshold/strategy/seed):`);
    for (const n of SWEEP_NS) console.log(`  PER_MINOR_N=${n}  ->  ${sweepTotals[n]}`);
    console.log(`  (VERSIONS=all would be ${totalAll})`);
  }
  console.log(`\nbiggest anchors now: ` + perAnchor.slice(0, 8).map((r) => `${r.name}(${r.kept_now}/${r.total_stable})`).join(", "));
  console.log(`\nwrote ${join(outDir, "preview.json")} and preview.csv — nothing downloaded.`);
  if (registryFailures.length) console.warn(`\nNote: ${registryFailures.length} anchor(s) could not be version-listed (counted as 1 each): ${registryFailures.slice(0, 10).join(", ")}${registryFailures.length > 10 ? ", ..." : ""}`);
} else {
  const result = new Map();
  let next = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (next < baseEntries.length) {
      const { name, version, origin } = baseEntries[next++];
      const sibs = await selectVersions(name, version);
      for (const v of sibs) { const key = `${name}@${v}`; const o = v === version ? origin : "version-expanded"; if (!result.has(key) || result.get(key) === "version-expanded") result.set(key, o); }
      console.log(`  ${name}@${version} -> ${sibs.length} version(s)`);
    }
  }));

  const rows = [...result.entries()].map(([k, origin]) => { const at = k.lastIndexOf("@"); return { name: k.slice(0, at), version: k.slice(at + 1), origin }; })
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

  writeFileSync(join(outDir, "reference-packages.json"), JSON.stringify(rows, null, 2) + "\n");
  writeFileSync(join(outDir, "reference-packages.csv"), "name,version,origin\n" + rows.map((r) => [r.name, r.version, r.origin].map(cell).join(",")).join("\n") + "\n");

  const byOrigin = rows.reduce((a, r) => ((a[r.origin] = (a[r.origin] ?? 0) + 1), a), {});
  console.log(`\nReference set: ${rows.length} name@version  ->  ${join(outDir, "reference-packages.json")}`);
  console.log(`  breakdown: ${Object.entries(byOrigin).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  if (registryFailures.length) {
    console.warn(`\n!!!!! WARNING: ${registryFailures.length} package(s) could NOT be expanded because npm could not list their versions.`);
    console.warn(`      These were downloaded at their exact version only: ${registryFailures.slice(0, 15).join(", ")}${registryFailures.length > 15 ? ", ..." : ""}`);
    console.warn(`      Check your npm registry/proxy (the same npm runs the download in step 02) and re-run step 01.`);
  }
}
