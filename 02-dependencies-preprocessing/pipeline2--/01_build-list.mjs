// Reference pipeline, step 01: build the list of packages to download.
//
// Reads the FIRST pipeline's output and produces the complete, de-duplicated set
// of `name@version` for the reference dataset:
//   - each selected package itself              (from 04_selected_sample/selected.json)
//   - every one of its bundled dependencies     (from 05_selected_bundles/selected_dependencies.csv)
// Then, per the methodology, expands each `name@x.y.z` to its PATCH-LEVEL siblings:
// every `name@x.y.*` published on npm with the SAME major.minor (and only those).
//
// Version enumeration uses `npm view <name> versions --json` (NOT a raw fetch), so it
// honours the same registry / proxy / auth config npm already uses (step 02 uses npm too).
// If npm cannot reach the registry for a package, it is reported LOUDLY and that package
// keeps only its exact version — it is never silently reduced to one.
//
// Usage:
//   node 01_build-list.mjs <firstPipelineOutputDir|csvFile> <outDir> \
//        [--patch-level all|exact|latest] [--conc 5] [--no-package]
// Env equivalents: PATCH_LEVEL, CONC, INCLUDE_PACKAGE=0
//
// Output:
//   <outDir>/reference-packages.json   [{ name, version, origin }]
//   <outDir>/reference-packages.csv    name,version,origin

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const isWin = process.platform === "win32";
const npmBin = isWin ? "npm.cmd" : "npm";

const args = process.argv.slice(2);
const opt = (name, fb) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fb; };
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--patch-level" && args[i - 1] !== "--conc");

const INPUT = resolve(positional[0] ?? ".");
const outDir = resolve(positional[1] ?? "reference-list");
const PATCH_LEVEL = (opt("--patch-level", process.env.PATCH_LEVEL) ?? "all").toLowerCase();
const CONC = Number(opt("--conc", process.env.CONC) ?? 5);
const INCLUDE_PACKAGE = !args.includes("--no-package") && process.env.INCLUDE_PACKAGE !== "0";

if (!["all", "exact", "latest"].includes(PATCH_LEVEL)) { console.error(`--patch-level must be all|exact|latest`); process.exit(1); }
mkdirSync(outDir, { recursive: true });

function findFile(...c) { for (const x of c) if (existsSync(x)) return x; return null; }
const depsCsv = INPUT.endsWith(".csv") ? INPUT : findFile(join(INPUT, "05_selected_bundles", "selected_dependencies.csv"), join(INPUT, "selected_dependencies.csv"));
const selectedJson = INPUT.endsWith(".csv") ? findFile(join(INPUT, "..", "..", "04_selected_sample", "selected.json")) : findFile(join(INPUT, "04_selected_sample", "selected.json"), join(INPUT, "selected.json"));
if (!depsCsv) { console.error(`Could not find selected_dependencies.csv under ${INPUT}`); process.exit(1); }
console.log(`dependencies CSV : ${depsCsv}`);
console.log(`selected.json    : ${selectedJson ?? "(not found — packages' own versions may be missing)"}`);
console.log(`patch-level      : ${PATCH_LEVEL}   include-package: ${INCLUDE_PACKAGE}\n`);

function parseLine(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) { const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c; }
  out.push(cur); return out;
}

// ---------- base set ----------
const base = new Map();
const addExact = (name, version, origin) => { if (name && version) base.set(`${name}@${version}`, base.get(`${name}@${version}`) ?? origin); };
if (INCLUDE_PACKAGE && selectedJson) for (const e of JSON.parse(readFileSync(selectedJson, "utf8"))) addExact(e.name, e.version, "package");
const lines = readFileSync(depsCsv, "utf8").split(/\r?\n/).filter((l) => l.length);
const header = parseLine(lines[0]);
const depCol = header.findIndex((h) => /depend/i.test(h));
for (const line of lines.slice(1)) {
  const cells = parseLine(line);
  let deps = []; try { deps = JSON.parse(cells[depCol >= 0 ? depCol : 1] || "[]"); } catch {}
  for (const d of deps) { const at = d.lastIndexOf("@"); if (at > 0) addExact(d.slice(0, at), d.slice(at + 1), "dependency"); }
}
console.log(`Base set: ${base.size} exact name@version (before patch expansion)\n`);

// ---------- patch-level expansion via `npm view` ----------
const parseVer = (v) => { const [a, b, c] = v.split("-")[0].split("."); return { major: +a, minor: +b, patch: +c }; };
const isStable = (v) => !v.includes("-");
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

async function patchSiblings(name, version) {
  if (PATCH_LEVEL === "exact") return [version];
  const versions = await allVersions(name);
  if (!versions) { registryFailures.push(`${name}@${version}`); console.warn(`  !! REGISTRY ERROR for ${name}: could not list versions — keeping only ${version}`); return [version]; }
  const t = parseVer(version);
  const same = versions.filter(isStable).map((v) => ({ v, p: parseVer(v) })).filter(({ p }) => p.major === t.major && p.minor === t.minor && Number.isFinite(p.patch));
  if (same.length === 0) { console.warn(`  .. no ${t.major}.${t.minor}.x patches found for ${name} — keeping ${version}`); return [version]; }
  if (PATCH_LEVEL === "latest") { same.sort((a, b) => b.p.patch - a.p.patch); return [same[0].v]; }
  return same.map((x) => x.v);
}

const baseEntries = [...base.entries()].map(([k, origin]) => { const at = k.lastIndexOf("@"); return { name: k.slice(0, at), version: k.slice(at + 1), origin }; });
const result = new Map();
let next = 0;
await Promise.all(Array.from({ length: CONC }, async () => {
  while (next < baseEntries.length) {
    const { name, version, origin } = baseEntries[next++];
    const sibs = await patchSiblings(name, version);
    for (const v of sibs) { const key = `${name}@${v}`; const o = v === version ? origin : "patch-expanded"; if (!result.has(key) || result.get(key) === "patch-expanded") result.set(key, o); }
    console.log(`  ${name}@${version} -> ${sibs.length} version(s)`);
  }
}));

const rows = [...result.entries()].map(([k, origin]) => { const at = k.lastIndexOf("@"); return { name: k.slice(0, at), version: k.slice(at + 1), origin }; })
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

writeFileSync(join(outDir, "reference-packages.json"), JSON.stringify(rows, null, 2) + "\n");
const cell = (s) => (/[",\r\n]/.test(String(s)) ? `"${String(s).replaceAll('"', '""')}"` : String(s));
writeFileSync(join(outDir, "reference-packages.csv"), "name,version,origin\n" + rows.map((r) => [r.name, r.version, r.origin].map(cell).join(",")).join("\n") + "\n");

const byOrigin = rows.reduce((a, r) => ((a[r.origin] = (a[r.origin] ?? 0) + 1), a), {});
console.log(`\nReference set: ${rows.length} name@version  ->  ${join(outDir, "reference-packages.json")}`);
console.log(`  breakdown: ${Object.entries(byOrigin).map(([k, v]) => `${k}=${v}`).join("  ")}`);
if (registryFailures.length) {
  console.warn(`\n!!!!! WARNING: ${registryFailures.length} package(s) could NOT be expanded because npm could not list their versions.`);
  console.warn(`      These were downloaded at their exact version only: ${registryFailures.slice(0, 15).join(", ")}${registryFailures.length > 15 ? ", ..." : ""}`);
  console.warn(`      Check your npm registry/proxy (the same npm runs the download in step 02) and re-run step 01.`);
}
