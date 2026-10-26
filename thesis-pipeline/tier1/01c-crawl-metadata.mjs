// Tier 1, CHEAP MODE, step 01: crawl the top packages AND collect cheap dependency /
// version metadata from the npm registry (no package downloads), then build two tables.
//
// Outputs (in outDir):
//   jsdelivr-top.json / .csv              the top-N package list (same as expensive 01)
//   packages-dependencies.csv             TABLE A: package, declared dependencies (name@range)
//   version-metadata.csv                  TABLE B: one row per package AND per dependency:
//                                         name, origin, majors, minors, patches(total versions),
//                                         latest, versions (sorted list)
//   metadata.json                         structured data used by the cheap select step (02c)
//
// Usage:
//   node 01c-crawl-metadata.mjs <outDir> [TOP_N=1500] [PERIOD=month] [CONC=8]
//
// jsDelivr is used only for the top-N list; all dependency/version data comes from
// `npm view` (so it honours the same registry/proxy config npm uses). If jsdelivr-top.json
// already exists in outDir, the crawl is skipped (resume-friendly / offline-testable).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const isWin = process.platform === "win32";
const npmBin = isWin ? "npm.cmd" : "npm";

const outDir = resolve(process.argv[2] ?? "01_top1500_package_list");
const TOP_N = Number(process.argv[3] ?? 1500);
const PERIOD = process.argv[4] ?? "month";
const CONC = Number(process.argv[5] ?? 8);
mkdirSync(outDir, { recursive: true });

// ---------- 1. crawl top-N from jsDelivr (skip if already present) ----------
const topPath = join(outDir, "jsdelivr-top.json");
let top;
if (existsSync(topPath)) {
  top = JSON.parse(readFileSync(topPath, "utf8"));
  console.log(`Using existing ${topPath} (${top.length} packages)`);
} else {
  const out = [];
  for (let page = 1; out.length < TOP_N; page++) {
    const url = `https://data.jsdelivr.com/v1/stats/packages?type=npm&period=${PERIOD}&limit=100&page=${page}`;
    const res = await fetch(url, { headers: { "User-Agent": "thesis-crawler (research)" } });
    if (!res.ok) throw new Error(`${res.status} on page ${page}`);
    const rows = await res.json();
    if (!rows.length) break;
    out.push(...rows);
    console.log(`page ${page}: ${out.length} total`);
    await new Promise((r) => setTimeout(r, 400));
  }
  top = out.slice(0, TOP_N).map((r, i) => ({ rank: i + 1, name: r.name, hits: r.hits }));
  writeFileSync(topPath, JSON.stringify(top, null, 2));
  writeFileSync(join(outDir, "jsdelivr-top.csv"), "rank,name,hits\n" + top.map((r) => `${r.rank},${r.name},${r.hits}`).join("\n"));
  console.log(`Saved ${top.length} packages`);
}

// ---------- 2. npm metadata per name (latest deps + full version history) ----------
const parseVer = (v) => { const [a, b, c] = v.split("-")[0].split("."); return { major: +a, minor: +b, patch: +c }; };
const isStable = (v) => !v.includes("-");
const cache = new Map();

async function npmInfo(name) {
  if (cache.has(name)) return cache.get(name);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { stdout } = await run(npmBin, ["view", name, "--json", "--no-audit", "--no-fund", "--loglevel=error"], { timeout: 60_000, maxBuffer: 40 * 1024 * 1024, shell: isWin });
      const j = JSON.parse(stdout);
      const m = Array.isArray(j) ? j[j.length - 1] : j; // latest manifest
      let versions = m.versions ?? j.versions ?? [m.version];
      if (typeof versions === "string") versions = [versions];
      versions = versions.filter(isStable).filter((v) => { const p = parseVer(v); return Number.isFinite(p.major) && Number.isFinite(p.minor) && Number.isFinite(p.patch); })
        .sort((a, b) => { const x = parseVer(a), y = parseVer(b); return (x.major - y.major) || (x.minor - y.minor) || (x.patch - y.patch); });
      const info = { name, latest: m.version, dependencies: m.dependencies ?? {}, versions };
      cache.set(name, info);
      return info;
    } catch (e) { if (attempt === 3) { cache.set(name, null); return null; } await new Promise((r) => setTimeout(r, 1500 * attempt)); }
  }
}

// fetch top packages' info (gives deps + versions)
console.log(`\nFetching metadata for ${top.length} packages via npm view ...`);
const pkgInfo = new Map();
let next = 0, done = 0;
await Promise.all(Array.from({ length: CONC }, async () => {
  while (next < top.length) {
    const { name } = top[next++];
    const info = await npmInfo(name);
    if (info) pkgInfo.set(name, info);
    if (++done % 50 === 0 || done === top.length) console.log(`  packages ${done}/${top.length}`);
  }
}));

// collect the unique dependency names and fetch their version history too (for Table B)
const depNames = new Set();
for (const info of pkgInfo.values()) for (const d of Object.keys(info.dependencies)) depNames.add(d);
const depList = [...depNames].filter((d) => !pkgInfo.has(d));
console.log(`\nFetching version history for ${depList.length} distinct dependencies ...`);
const depInfo = new Map();
next = 0; done = 0;
await Promise.all(Array.from({ length: CONC }, async () => {
  while (next < depList.length) {
    const name = depList[next++];
    const info = await npmInfo(name);
    if (info) depInfo.set(name, info);
    if (++done % 50 === 0 || done === depList.length) console.log(`  deps ${done}/${depList.length}`);
  }
}));

// ---------- 3. build the tables ----------
const levels = (versions) => {
  const majors = new Set(), minors = new Set();
  for (const v of versions) { const p = parseVer(v); majors.add(p.major); minors.add(p.major + "." + p.minor); }
  return { majors: majors.size, minors: minors.size, patches: versions.length };
};
const csvCell = (s) => (/[",\r\n]/.test(String(s)) ? `"${String(s).replaceAll('"', '""')}"` : String(s));

// Table A: package -> declared dependencies (name@range)
const tableA = [];
for (const { name } of top) {
  const info = pkgInfo.get(name);
  const deps = info ? Object.entries(info.dependencies).map(([n, r]) => `${n}@${r}`) : [];
  tableA.push([name, JSON.stringify(deps)]);
}
writeFileSync(join(outDir, "packages-dependencies.csv"), "package,declared_dependencies\n" + tableA.map((r) => r.map(csvCell).join(",")).join("\n") + "\n");

// Table B: per package AND per dependency -> release-level counts + sorted versions
const tableBrows = [];
const addB = (name, origin, info) => {
  if (!info) { tableBrows.push([name, origin, "", "", "", "", "(registry error)"]); return; }
  const l = levels(info.versions);
  tableBrows.push([name, origin, l.majors, l.minors, l.patches, info.latest, JSON.stringify(info.versions)]);
};
for (const { name } of top) addB(name, "package", pkgInfo.get(name));
for (const name of depList) addB(name, "dependency", depInfo.get(name));
writeFileSync(join(outDir, "version-metadata.csv"), "name,origin,majors,minors,patches,latest,versions\n" + tableBrows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n");

// metadata.json for the cheap select step
const metadata = {
  packages: top.map(({ rank, name }) => {
    const info = pkgInfo.get(name);
    return { rank, name, latest: info?.latest ?? null, declaredDepCount: info ? Object.keys(info.dependencies).length : null, declaredDeps: info ? Object.keys(info.dependencies) : [] };
  }),
};
writeFileSync(join(outDir, "metadata.json"), JSON.stringify(metadata, null, 2));

const withCount = metadata.packages.filter((p) => p.declaredDepCount != null);
console.log(`\nDone. ${top.length} packages, ${depList.length} dependencies.`);
console.log(`  Table A -> packages-dependencies.csv`);
console.log(`  Table B -> version-metadata.csv`);
console.log(`  metadata.json (declared-dep counts for selection): ${withCount.length} packages with metadata`);
