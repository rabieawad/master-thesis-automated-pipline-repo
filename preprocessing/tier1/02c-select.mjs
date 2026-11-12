// Tier 1, CHEAP MODE, step 02: select the sample from the cheap metadata (from 01c) —
// BEFORE any download. Only the selected sample is then downloaded and bundled, which is
// what makes this mode cheap.
//
// Selection BASIS (what the dep count means) — default "landed":
//   landed   = estimatedLandedCount  (declared minus build-tooling/@types, minus deps of
//              pre-bundled packages). Best metadata estimate of what actually ends up in
//              the bundle. THIS is what matters for "how many packages land".
//   runtime  = runtimeDepCount       (declared minus tooling/@types; ignores pre-bundling)
//   declared = declaredDepCount      (raw package.json dependencies; the old behaviour)
//
// Two selection shapes:
//   (a) flat   : --n 40 --min 0 --max 20   -> N packages whose basis count is in [min,max]
//   (b) buckets: --dist "0:3,2-5:3,8-15:5" -> stratified: 3 packages with 0, 3 with 2..5,
//                5 with 8..15 (ranges are on the basis count; inclusive; seeded; no reuse).
//                When --dist is given it overrides --n/--min/--max.
//
// Usage:
//   node 02c-select.mjs <metadataDir> <outDir> [--basis landed] [--n 40] [--min 0] [--max 20]
//                       [--dist "0:3,2-5:3,8-15:5"] [--seed 42]
//
// Writes selected.json, selected-list.json, selected.csv (now carrying declared / runtime /
// estimated-landed counts and the selection basis).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const VALUE_FLAGS = ["--basis", "--n", "--min", "--max", "--seed", "--dist"];
const opt = (name, fb) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fb; };
const positional = args.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.includes(args[i - 1]));

const metaDir = resolve(positional[0] ?? ".");
const outDir = resolve(positional[1] ?? "04_selected_sample");
const BASIS = (opt("--basis", process.env.DEP_BASIS) ?? "landed").toLowerCase();
const N = Number(opt("--n", process.env.SAMPLE_N) ?? 40);
const MIN = Number(opt("--min", process.env.MIN_DEPS) ?? 0);
const MAX = Number(opt("--max", process.env.MAX_DEPS) ?? 20);
const SEED = Number(opt("--seed", process.env.SEED) ?? 42);
const DIST = opt("--dist", process.env.DEP_DIST) ?? "";
mkdirSync(outDir, { recursive: true });

const metaPath = join(metaDir, "metadata.json");
if (!existsSync(metaPath)) { console.error(`metadata.json not found in ${metaDir} (run cheap step 01 first)`); process.exit(1); }
const meta = JSON.parse(readFileSync(metaPath, "utf8"));

// the count each package is selected on, per the chosen basis (with graceful fallback
// for metadata produced before these fields existed)
const basisCount = (p) => {
  if (BASIS === "declared") return p.declaredDepCount;
  if (BASIS === "runtime") return p.runtimeDepCount ?? p.declaredDepCount;
  return p.estimatedLandedCount ?? p.runtimeDepCount ?? p.declaredDepCount; // landed (default)
};
console.log(`Selection basis: ${BASIS}  (count = ${BASIS === "declared" ? "raw declared deps" : BASIS === "runtime" ? "declared minus tooling/@types" : "estimated deps that LAND in the bundle"})`);

function mulberry32(a) { return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const shuffleSeeded = (arr, rand) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// only packages with a resolvable latest version and a known basis count are eligible
const eligible = meta.packages.filter((p) => p.latest && basisCount(p) != null);

let selected;
if (DIST.trim()) {
  // ---- (b) bucketed / stratified selection ----
  // parse "lo-hi:count" or "n:count" terms
  const buckets = DIST.split(",").map((t) => t.trim()).filter(Boolean).map((term) => {
    const [range, cntRaw] = term.split(":");
    const count = Number(cntRaw);
    let lo, hi;
    if (range.includes("-")) { const [a, b] = range.split("-"); lo = Number(a); hi = Number(b); }
    else { lo = hi = Number(range); }
    if (![lo, hi, count].every(Number.isFinite)) { console.error(`bad --dist term: "${term}" (use lo-hi:count or n:count)`); process.exit(1); }
    return { lo, hi, count };
  });
  const rand = mulberry32(SEED);
  const used = new Set();
  const chosen = [];
  for (const b of buckets) {
    const pool = shuffleSeeded(eligible.filter((p) => !used.has(p.name) && basisCount(p) >= b.lo && basisCount(p) <= b.hi), rand);
    const take = pool.slice(0, b.count);
    for (const p of take) used.add(p.name);
    chosen.push(...take);
    const label = b.lo === b.hi ? `${b.lo}` : `${b.lo}-${b.hi}`;
    console.log(`  bucket ${label} deps: requested ${b.count}, available ${pool.length}, took ${take.length}` + (take.length < b.count ? "  (SHORT)" : ""));
  }
  selected = chosen.sort((a, b) => a.name.localeCompare(b.name));
} else {
  // ---- (a) flat N within [MIN, MAX] ----
  const candidates = eligible.filter((p) => basisCount(p) >= MIN && basisCount(p) <= MAX);
  console.log(`${meta.packages.length} packages, ${candidates.length} with ${MIN}-${MAX} ${BASIS} dependencies (and resolvable latest)`);
  if (candidates.length < N) console.log(`WARNING: only ${candidates.length} candidates, fewer than requested ${N} — taking all`);
  selected = shuffleSeeded(candidates, mulberry32(SEED)).slice(0, N).sort((a, b) => a.name.localeCompare(b.name));
}

const selJson = selected.map((p) => ({
  name: p.name, version: p.latest,
  dependenciesInBundle: basisCount(p),           // the basis count (what selection used)
  estimatedLandedCount: p.estimatedLandedCount ?? null,
  runtimeDepCount: p.runtimeDepCount ?? null,
  declaredDepCount: p.declaredDepCount ?? null,
  likelyPreBundled: p.likelyPreBundled ?? null,
  declaredDeps: p.declaredDeps, runtimeDeps: p.runtimeDeps ?? [],
}));
writeFileSync(join(outDir, "selected.json"), JSON.stringify(selJson, null, 2) + "\n");
writeFileSync(join(outDir, "selected-list.json"), JSON.stringify(selected.map((p, i) => ({ rank: i + 1, name: p.name })), null, 2) + "\n");
const csvCell = (s) => (/[",\r\n]/.test(String(s)) ? `"${String(s).replaceAll('"', '""')}"` : String(s));
writeFileSync(
  join(outDir, "selected.csv"),
  "name,version,basis,selected_count,estimated_landed,runtime_deps,declared_deps,pre_bundled\n" +
    selJson.map((p) => [p.name, p.version, BASIS, p.dependenciesInBundle, p.estimatedLandedCount ?? "", p.runtimeDepCount ?? "", p.declaredDepCount ?? "", p.likelyPreBundled ? "yes" : "no"].map(csvCell).join(",")).join("\n") + "\n",
);

const hist = {};
for (const p of selJson) hist[p.dependenciesInBundle] = (hist[p.dependenciesInBundle] ?? 0) + 1;
console.log(`\nSelected ${selJson.length} package(s) -> ${join(outDir, "selected.json")}`);
console.log(`${BASIS}-count spread: ` + Object.keys(hist).map(Number).sort((a, b) => a - b).map((k) => `${k}:${hist[k]}`).join(" "));
