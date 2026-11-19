// Tier 3 · step 02: detect which packages, and which versions of them, are inside each bundle.
//
// For every tier-1 functions file (<bundle>.functions.json, from tier 1's step 06) it matches the
// bundle's functions against the index of step 01 and decides packages and versions in each
// mode (exact, approx, approx+lineage — see lib/detect.mjs). When the bundle's SBOM is there
// (tier 1's 05_selected_bundles/sbom) the detections are also checked against it, and when its
// source map is there (05_selected_bundles/bundles) every bundle function's true package is read
// from the map, which explains each error (see lib/evaluate.mjs).
//
// Writes, per bundle:
//   <outDir>/bundles/<bundle>.json   { bundle, settings, stats, modes: { <mode>: { detections,
//                                      evaluation? } }, truth?, sourceMap? }
//   detections[i] = { name, best, range, rangeSize, versionsIndexed, evidence, coverage,
//                     ownFunctions, sharedFunctions, functions, exactFunctions, lineageFunctions,
//                     confidence, explains: [bundle function index…], shares: […] }
//
// Usage:
//   node 02_detect.mjs --index <01 index dir> --functions <tier1 06_extracted_functions> --out <dir>
//        [--bundles <tier1 05_selected_bundles/bundles>] [--sbom <tier1 05_selected_bundles/sbom>]
//        [--modes exact,approx,approx+lineage] [--opts '{"minSim":0.5,…}'] [--no-evaluate]
//        [--only <bundle>,<bundle>] [--force]
//
// Safe to run again: a bundle whose result was written with the same settings and index is
// skipped; --force redoes every bundle.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { loadIndex } from "./lib/index.mjs";
import { prepareBundle, matchBundle, infer, MODES, DEFAULTS } from "./lib/detect.mjs";
import { truthFromSbom, evaluateBundle, analyzeFunctions } from "./lib/evaluate.mjs";
import { attributeFunctions } from "./lib/sourcemap.mjs";

const argv = process.argv.slice(2);
const opt = (name, dflt = null) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : dflt; };
const has = (name) => argv.includes(name);
const INDEX = opt("--index"), FUNCS = opt("--functions"), OUT = opt("--out");
if (!INDEX || !FUNCS || !OUT) {
  console.error("usage: node 02_detect.mjs --index <dir> --functions <dir> --out <dir> [--bundles <dir>] [--sbom <dir>] [--modes …] [--opts json] [--no-evaluate] [--only a,b] [--force]");
  process.exit(2);
}
const BUNDLES = opt("--bundles") ? resolve(opt("--bundles")) : null, SBOM = opt("--sbom") ? resolve(opt("--sbom")) : null;
const modes = String(opt("--modes", MODES.join(","))).split(",").map((s) => s.trim()).filter(Boolean);
for (const m of modes) if (!MODES.includes(m)) { console.error(`unknown mode ${m} (modes: ${MODES.join(", ")})`); process.exit(2); }
let userOpts = {};
try { userOpts = JSON.parse(opt("--opts", "{}")); } catch (e) { console.error(`--opts is not JSON: ${e.message}`); process.exit(2); }
for (const k of Object.keys(userOpts)) if (!(k in DEFAULTS)) { console.error(`unknown option ${k} (options: ${Object.keys(DEFAULTS).join(", ")})`); process.exit(2); }
const evaluate = !has("--no-evaluate"), force = has("--force");
const only = opt("--only") ? new Set(opt("--only").split(",").map((s) => s.trim())) : null;

const outDir = resolve(OUT), perBundle = join(outDir, "bundles");
mkdirSync(perBundle, { recursive: true });
const funcDir = resolve(FUNCS);
if (!existsSync(funcDir)) { console.error(`no functions folder ${funcDir}: run tier 1 first`); process.exit(1); }
const files = readdirSync(funcDir).filter((f) => f.endsWith(".functions.json")).sort()
  .filter((f) => !only || only.has(f.slice(0, -".functions.json".length)));
if (!files.length) { console.error(`no *.functions.json in ${funcDir}`); process.exit(1); }

const t0 = Date.now();
const ix = loadIndex(resolve(INDEX));
console.log(`index: ${ix.N} functions of ${ix.P} packages (built ${ix.meta.built_at}), loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
const opts = { ...DEFAULTS, ...userOpts };
// bump CODE when the detection or evaluation logic changes, so earlier results are redone
const CODE = 6;
const settings = { code: CODE, modes, opts, evaluate, index: { built_at: ix.meta.built_at, source_signature: ix.meta.source_signature ?? null, records: ix.N } };
const settingsHash = createHash("sha256").update(JSON.stringify(settings)).digest("hex").slice(0, 16);
const indexed = new Map(ix.meta.packages.map((p) => [p.name, p.versions]));
const names = ix.meta.packages.map((p) => p.name);
const writeAtomic = (f, data) => { writeFileSync(f + ".tmp", data); renameSync(f + ".tmp", f); };
const pct = (x) => (x == null ? "–" : x.toFixed(2));

let done = 0, skipped = 0, failed = 0;
for (const [i, f] of files.entries()) {
  const key = f.slice(0, -".functions.json".length), outFile = join(perBundle, `${key}.json`), t1 = Date.now();
  const tag = `[${i + 1}/${files.length}] ${key}`;
  if (!force && existsSync(outFile)) {
    try { if (JSON.parse(readFileSync(outFile, "utf8")).settingsHash === settingsHash) { skipped++; console.log(`${tag} | already done`); continue; } } catch {}
  }
  try {
    const doc = JSON.parse(readFileSync(join(funcDir, f), "utf8"));
    const fns = matchBundle(ix, prepareBundle(doc, ix.meta.tier2_settings), opts);
    const stats = {
      functions: doc.functions?.length ?? 0, nonTrivial: fns.length,
      exactMatched: fns.filter((x) => x.exactPkgs.size).length,
      approxMatched: fns.filter((x) => !x.exactPkgs.size && x.byPkg.size).length,
      unmatched: fns.filter((x) => !x.byPkg.size).length,
    };
    const result = { bundle: key, settingsHash, settings, stats, modes: {} };
    // ground truth, when tier 1 left the SBOM (and the source map) of this bundle
    const sbomFile = SBOM && join(SBOM, `${key}.cdx.json`);
    const truth = evaluate && sbomFile && existsSync(sbomFile) ? truthFromSbom(JSON.parse(readFileSync(sbomFile, "utf8"))) : null;
    let attribution = null;
    const mapFile = BUNDLES && join(BUNDLES, `${key}.min.js.map`), codeFile = BUNDLES && join(BUNDLES, `${key}.min.js`);
    if (truth && mapFile && existsSync(mapFile) && existsSync(codeFile)) {
      try { attribution = attributeFunctions(readFileSync(codeFile, "utf8"), JSON.parse(readFileSync(mapFile, "utf8")), doc.functions ?? []); }
      catch (e) { console.log(`${tag} | source map not usable: ${e.message}`); }
    }
    if (truth) result.truth = truth;
    if (attribution) {
      const by = {}; for (const fn of fns) { const s = attribution.get(fn.k); const n = s ? s.name : "(no package)"; by[n] = (by[n] ?? 0) + 1; }
      result.sourceMap = { nonTrivialFunctionsByPackage: by };
    }
    const brief = [];
    for (const m of modes) {
      const detections = infer(ix, fns, m, opts), entry = { detections };
      if (truth) {
        const rows = evaluateBundle(detections, truth, indexed);
        entry.evaluation = { rows, functions: attribution ? analyzeFunctions(rows, detections, attribution, fns, names, m, opts.minSim) : null };
        const tp = rows.filter((r) => r.status === "TP").length, fp = rows.filter((r) => r.status === "FP").length, fn = rows.filter((r) => r.status === "FN").length;
        brief.push(`${m}: ${detections.length} packages, P ${pct(tp + fp ? tp / (tp + fp) : null)} R ${pct(tp + fn ? tp / (tp + fn) : null)}`);
      } else brief.push(`${m}: ${detections.length} packages`);
      result.modes[m] = entry;
    }
    writeAtomic(outFile, JSON.stringify(result));
    done++;
    console.log(`${tag} | ${stats.nonTrivial} non-trivial functions (${stats.exactMatched} exact, ${stats.approxMatched} approximate, ${stats.unmatched} unmatched) | ${brief.join(" | ")} | ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  } catch (e) {
    failed++;
    console.log(`${tag} | ERROR ${e.message}`);
  }
}
console.log(`RESULT | ${done} bundles detected, ${skipped} already done, ${failed} failed | ${((Date.now() - t0) / 1000).toFixed(0)}s`);
if (failed && !done && !skipped) process.exit(1);
