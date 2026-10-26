// Tier 1, CHEAP MODE, step 02: select the sample from the cheap metadata (declared
// dependency counts from 01c) — BEFORE any download. Only the selected sample is then
// downloaded and bundled, which is what makes this mode cheap.
//
// Usage:
//   node 02c-select.mjs <metadataDir> <outDir> [--n 40] [--min 0] [--max 20] [--seed 42]
//   (metadataDir is the cheap-01 output folder containing metadata.json)
//
// Writes:
//   <outDir>/selected.json        [{ name, version(latest), dependenciesInBundle(declared), declaredDeps }]
//   <outDir>/selected-list.json   [{ rank, name }]  -> fed to the download step
//   <outDir>/selected.csv         flat view

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const opt = (name, fb) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fb; };
const positional = args.filter((a, i) => !a.startsWith("--") && !["--n", "--min", "--max", "--seed"].includes(args[i - 1]));

const metaDir = resolve(positional[0] ?? ".");
const outDir = resolve(positional[1] ?? "04_selected_sample");
const N = Number(opt("--n", process.env.SAMPLE_N) ?? 40);
const MIN = Number(opt("--min", process.env.MIN_DEPS) ?? 0);
const MAX = Number(opt("--max", process.env.MAX_DEPS) ?? 20);
const SEED = Number(opt("--seed", process.env.SEED) ?? 42);
mkdirSync(outDir, { recursive: true });

const metaPath = join(metaDir, "metadata.json");
if (!existsSync(metaPath)) { console.error(`metadata.json not found in ${metaDir} (run cheap step 01 first)`); process.exit(1); }
const meta = JSON.parse(readFileSync(metaPath, "utf8"));

const candidates = meta.packages.filter((p) => p.declaredDepCount != null && p.latest && p.declaredDepCount >= MIN && p.declaredDepCount <= MAX);
console.log(`${meta.packages.length} packages, ${candidates.length} with ${MIN}-${MAX} declared dependencies (and resolvable latest)`);
if (candidates.length < N) console.log(`WARNING: only ${candidates.length} candidates, fewer than requested ${N} — taking all`);

function mulberry32(a) { return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rand = mulberry32(SEED);
const shuffled = [...candidates];
for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
const selected = shuffled.slice(0, N).sort((a, b) => a.name.localeCompare(b.name));

const selJson = selected.map((p) => ({ name: p.name, version: p.latest, dependenciesInBundle: p.declaredDepCount, declaredDeps: p.declaredDeps }));
writeFileSync(join(outDir, "selected.json"), JSON.stringify(selJson, null, 2) + "\n");
writeFileSync(join(outDir, "selected-list.json"), JSON.stringify(selected.map((p, i) => ({ rank: i + 1, name: p.name })), null, 2) + "\n");
const csvCell = (s) => (/[",\r\n]/.test(String(s)) ? `"${String(s).replaceAll('"', '""')}"` : String(s));
writeFileSync(join(outDir, "selected.csv"), "name,version,declared_dependencies\n" + selJson.map((p) => [p.name, p.version, p.dependenciesInBundle].map(csvCell).join(",")).join("\n") + "\n");

const hist = {};
for (const p of selJson) hist[p.dependenciesInBundle] = (hist[p.dependenciesInBundle] ?? 0) + 1;
console.log(`\nSelected ${selJson.length} package(s) -> ${join(outDir, "selected.json")}`);
console.log("declared-dependency spread: " + Object.keys(hist).map(Number).sort((a, b) => a - b).map((k) => `${k}:${hist[k]}`).join(" "));
