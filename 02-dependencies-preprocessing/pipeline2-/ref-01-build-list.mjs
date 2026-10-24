// Reference pipeline, step 01: build the list of packages to download.
//
// Reads the FIRST pipeline's output and produces the complete, de-duplicated set
// of `name@version` for the reference dataset:
//   - each selected package itself              (from 04_selected_sample/selected.json)
//   - every one of its bundled dependencies     (from 05_selected_bundles/selected_dependencies.csv)
// Then, per the methodology, expands each `name@x.y.z` to its PATCH-LEVEL siblings:
// every `name@x.y.*` published on npm with the SAME major.minor (and only those).
//
// Usage:
//   node ref-01-build-list.mjs <firstPipelineOutputDir|csvFile> <outDir> \
//        [--patch-level all|exact|latest] [--conc 5] [--no-package]
//
// Env equivalents: PATCH_LEVEL, CONC, INCLUDE_PACKAGE=0
//   --patch-level all     every x.y.* patch in the same minor (default)
//   --patch-level latest  only the newest x.y.* patch in that minor
//   --patch-level exact   only the exact x.y.z recorded (no expansion)
//   --no-package          leave out the packages themselves, dependencies only
//
// Output:
//   <outDir>/reference-packages.json   [{ name, version, origin }]  origin: package|dependency|patch-expanded
//   <outDir>/reference-packages.csv    name,version,origin

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve, basename } from "node:path";

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

// ---------- locate the first pipeline's files ----------
function findFile(...candidates) { for (const c of candidates) if (existsSync(c)) return c; return null; }
const depsCsv = INPUT.endsWith(".csv")
  ? INPUT
  : findFile(join(INPUT, "05_selected_bundles", "selected_dependencies.csv"), join(INPUT, "selected_dependencies.csv"));
const selectedJson = INPUT.endsWith(".csv")
  ? findFile(join(INPUT, "..", "..", "04_selected_sample", "selected.json"))
  : findFile(join(INPUT, "04_selected_sample", "selected.json"), join(INPUT, "selected.json"));

if (!depsCsv) { console.error(`Could not find selected_dependencies.csv under ${INPUT}`); process.exit(1); }
console.log(`dependencies CSV : ${depsCsv}`);
console.log(`selected.json    : ${selectedJson ?? "(not found — packages' own versions may be missing)"}`);
console.log(`patch-level      : ${PATCH_LEVEL}   include-package: ${INCLUDE_PACKAGE}\n`);

// ---------- minimal CSV parser ----------
function parseLine(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur); return out;
}

// ---------- gather the base set (exact name@version) ----------
const base = new Map(); // "name@version" -> origin
const addExact = (name, version, origin) => { if (name && version) base.set(`${name}@${version}`, base.get(`${name}@${version}`) ?? origin); };

// packages themselves
if (INCLUDE_PACKAGE && selectedJson) {
  for (const e of JSON.parse(readFileSync(selectedJson, "utf8"))) addExact(e.name, e.version, "package");
}

// bundled dependencies (second column is a JSON list of name@version)
const lines = readFileSync(depsCsv, "utf8").split(/\r?\n/).filter((l) => l.length);
const header = parseLine(lines[0]);
const depCol = header.findIndex((h) => /depend/i.test(h));
for (const line of lines.slice(1)) {
  const cells = parseLine(line);
  const raw = cells[depCol >= 0 ? depCol : 1] || "[]";
  let deps = []; try { deps = JSON.parse(raw); } catch {}
  for (const d of deps) { const at = d.lastIndexOf("@"); if (at > 0) addExact(d.slice(0, at), d.slice(at + 1), "dependency"); }
}

console.log(`Base set: ${base.size} exact name@version (before patch expansion)`);

// ---------- patch-level expansion via the npm registry ----------
const parseVer = (v) => { const [a, b, c] = v.split("-")[0].split("."); return { major: +a, minor: +b, patch: +c }; };
const isStable = (v) => !v.includes("-");
const packumentCache = new Map();

async function fetchPackument(name) {
  if (packumentCache.has(name)) return packumentCache.get(name);
  const url = `https://registry.npmjs.org/${name.replace("/", "%2F")}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { Accept: "application/vnd.npm.install-v1+json" } });
      if (!res.ok) throw new Error(`registry ${res.status}`);
      const data = await res.json();
      packumentCache.set(name, data);
      return data;
    } catch (e) { if (attempt === 3) { packumentCache.set(name, null); return null; } await new Promise((r) => setTimeout(r, 1500 * attempt)); }
  }
}

async function patchSiblings(name, version) {
  if (PATCH_LEVEL === "exact") return [version];
  const pack = await fetchPackument(name);
  if (!pack?.versions) return [version]; // can't reach registry: keep the exact version
  const t = parseVer(version);
  const same = Object.keys(pack.versions).filter((v) => isStable(v)).map((v) => ({ v, p: parseVer(v) }))
    .filter(({ p }) => p.major === t.major && p.minor === t.minor && Number.isFinite(p.patch));
  if (same.length === 0) return [version];
  if (PATCH_LEVEL === "latest") { same.sort((a, b) => b.p.patch - a.p.patch); return [same[0].v]; }
  return same.map((x) => x.v); // all
}

// expand with limited concurrency
const baseEntries = [...base.entries()].map(([k, origin]) => { const at = k.lastIndexOf("@"); return { name: k.slice(0, at), version: k.slice(at + 1), origin }; });
const result = new Map(); // name@version -> origin
let next = 0;
await Promise.all(Array.from({ length: CONC }, async () => {
  while (next < baseEntries.length) {
    const { name, version, origin } = baseEntries[next++];
    const sibs = await patchSiblings(name, version);
    for (const v of sibs) {
      const key = `${name}@${v}`;
      const o = v === version ? origin : "patch-expanded";
      if (!result.has(key) || result.get(key) === "patch-expanded") result.set(key, o);
    }
    console.log(`  ${name}@${version} -> ${sibs.length} version(s)`);
  }
}));

// ---------- write ----------
const rows = [...result.entries()].map(([k, origin]) => { const at = k.lastIndexOf("@"); return { name: k.slice(0, at), version: k.slice(at + 1), origin }; })
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

writeFileSync(join(outDir, "reference-packages.json"), JSON.stringify(rows, null, 2) + "\n");
const cell = (s) => (/[",\r\n]/.test(String(s)) ? `"${String(s).replaceAll('"', '""')}"` : String(s));
writeFileSync(join(outDir, "reference-packages.csv"), "name,version,origin\n" + rows.map((r) => [r.name, r.version, r.origin].map(cell).join(",")).join("\n") + "\n");

const byOrigin = rows.reduce((a, r) => ((a[r.origin] = (a[r.origin] ?? 0) + 1), a), {});
console.log(`\nReference set: ${rows.length} name@version  ->  ${join(outDir, "reference-packages.json")}`);
console.log(`  breakdown: ${Object.entries(byOrigin).map(([k, v]) => `${k}=${v}`).join("  ")}`);
