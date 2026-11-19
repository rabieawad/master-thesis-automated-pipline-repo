// Parameter sweep for tier 3: match every bundle once, then decide packages and versions with
// several option sets and print the metrics of each — for tuning and sensitivity analysis.
//
// Usage:
//   node tier3/tools/sweep.mjs --index <01_index> --functions <tier1 06_extracted_functions>
//        --bundles <tier1 05_selected_bundles/bundles> --sbom <tier1 05_selected_bundles/sbom>
//        --variants '[{}, {"minSim":0.6}, {"maxShared":50,"shareCoverage":0.7}]'
//        [--modes exact,approx,approx+lineage] [--json out.json]
//
// Each variant is a set of detection options (see DEFAULTS in lib/detect.mjs) on top of the
// defaults. Matching options (minSim, minBands) are applied at the lowest/most permissive value
// of all variants, then each variant filters its own matches.

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadIndex } from "../lib/index.mjs";
import { prepareBundle, matchBundle, infer, MODES } from "../lib/detect.mjs";
import { truthFromSbom, evaluateBundle, summarize, analyzeFunctions, summarizeFunctions } from "../lib/evaluate.mjs";
import { attributeFunctions } from "../lib/sourcemap.mjs";

const argv = process.argv.slice(2);
const opt = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const [INDEX, FUNCS, BUNDLES, SBOM] = ["--index", "--functions", "--bundles", "--sbom"].map((n) => opt(n));
if (!INDEX || !FUNCS || !SBOM) { console.error("usage: node sweep.mjs --index <dir> --functions <dir> --bundles <dir> --sbom <dir> --variants '[{…}]' [--modes …] [--json file]"); process.exit(2); }
const variants = JSON.parse(opt("--variants", "[{}]"));
const modes = String(opt("--modes", MODES.join(","))).split(",");

const ix = loadIndex(resolve(INDEX));
const indexed = new Map(ix.meta.packages.map((p) => [p.name, p.versions]));
const names = ix.meta.packages.map((p) => p.name);
const minSim = Math.min(0.5, ...variants.map((v) => v.minSim ?? 0.5)), minBands = Math.min(2, ...variants.map((v) => v.minBands ?? 2));
const B = [], t0 = Date.now();
for (const f of readdirSync(resolve(FUNCS)).filter((x) => x.endsWith(".functions.json")).sort()) {
  const key = f.slice(0, -".functions.json".length), sbom = join(resolve(SBOM), `${key}.cdx.json`);
  if (!existsSync(sbom)) continue;
  const doc = JSON.parse(readFileSync(join(resolve(FUNCS), f), "utf8"));
  let attribution = null;
  if (BUNDLES && existsSync(join(BUNDLES, `${key}.min.js.map`))) attribution = attributeFunctions(readFileSync(join(BUNDLES, `${key}.min.js`), "utf8"), JSON.parse(readFileSync(join(BUNDLES, `${key}.min.js.map`), "utf8")), doc.functions ?? []);
  B.push({ key, truth: truthFromSbom(JSON.parse(readFileSync(sbom, "utf8"))), attribution, fns: matchBundle(ix, prepareBundle(doc, ix.meta.tier2_settings), { minSim, minBands }) });
}
console.log(`${B.length} bundles matched in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
const f3 = (x) => (x == null ? "  –  " : x.toFixed(3));
const out = [];
console.log("variant".padEnd(48), "mode".padEnd(15), "  P      R      F1   | v.exact inRange | fn.acc  P(code) R(detect)");
for (const v of variants) for (const m of modes) {
  const rows = [], counts = [];
  for (const b of B) {
    const det = infer(ix, b.fns, m, v), ev = evaluateBundle(det, b.truth, indexed);
    if (b.attribution) counts.push(analyzeFunctions(ev, det, b.attribution, b.fns, names, m, v.minSim ?? 0.5));
    rows.push(...ev);
  }
  const s = summarize(rows), sf = counts.length ? summarizeFunctions(rows, counts) : null;
  out.push({ variant: v, mode: m, ...s, ...(sf ?? {}) });
  console.log(JSON.stringify(v).slice(0, 48).padEnd(48), m.padEnd(15), `${f3(s.packages.precision)}  ${f3(s.packages.recall)}  ${f3(s.packages.f1)} |  ${f3(s.versions.exact)}   ${f3(s.versions.inRange)} | ${f3(sf?.functions.accuracy)}  ${f3(sf?.precisionCodePresent)}  ${f3(sf?.recallDetectable)}`);
}
if (opt("--json")) writeFileSync(opt("--json"), JSON.stringify(out, null, 2));
