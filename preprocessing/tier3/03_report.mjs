// Tier 3 · step 03: the evaluation report — every bundle's detections in one place, and how well
// they match the ground truth.
//
// Reads <02 out>/bundles/<bundle>.json and writes:
//   <outDir>/detections.csv   one row per bundle, mode and detected package
//   <outDir>/evaluation.csv   one row per bundle, mode and package of the truth or detected
//                             (TP / FP / FN / not indexed, version found, why it went wrong)
//   <outDir>/summary.json     the metrics per mode
//   <outDir>/report.md        the same, readable: metrics, error reasons, per-bundle table, examples
//
// Usage:
//   node 03_report.mjs <02 out dir> <outDir>

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { summarize, summarizeFunctions } from "./lib/evaluate.mjs";

const [inArg, outArg] = process.argv.slice(2);
if (!inArg || !outArg) { console.error("usage: node 03_report.mjs <02 out dir> <outDir>"); process.exit(2); }
const inDir = join(resolve(inArg), "bundles"), outDir = resolve(outArg);
if (!existsSync(inDir)) { console.error(`no detections in ${inDir}: run step 02 first`); process.exit(1); }
mkdirSync(outDir, { recursive: true });
const writeAtomic = (f, data) => { writeFileSync(f + ".tmp", data); renameSync(f + ".tmp", f); };
const csvCell = (v) => { const s = v == null ? "" : Array.isArray(v) ? v.join(" ") : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csv = (head, rows) => [head.join(","), ...rows.map((r) => head.map((h) => csvCell(r[h])).join(","))].join("\n") + "\n";
const rangeText = (range) => (range ?? []).map(([a, b]) => (a === b ? a : `${a}–${b}`)).join(", ");

const results = [];
for (const f of readdirSync(inDir).filter((x) => x.endsWith(".json")).sort()) {
  try { results.push(JSON.parse(readFileSync(join(inDir, f), "utf8"))); } catch (e) { console.log(`skipped ${f}: ${e.message}`); }
}
if (!results.length) { console.error(`no bundle results in ${inDir}`); process.exit(1); }
const modes = [...new Set(results.flatMap((r) => Object.keys(r.modes ?? {})))];
const withTruth = results.filter((r) => r.truth);

// ---- CSVs ----
const detRows = [], evalRows = [];
for (const r of results) for (const m of modes) {
  const e = r.modes[m]; if (!e) continue;
  for (const d of e.detections) detRows.push({ bundle: r.bundle, mode: m, package: d.name, best: d.best, range: rangeText(d.range), rangeSize: d.rangeSize, versionsIndexed: d.versionsIndexed,
    evidence: d.evidence, coverage: d.coverage, ownFunctions: d.ownFunctions, sharedFunctions: d.sharedFunctions ?? 0, functions: d.functions, exactFunctions: d.exactFunctions, lineageFunctions: d.lineageFunctions, confidence: d.confidence });
  for (const x of e.evaluation?.rows ?? []) evalRows.push({ bundle: r.bundle, mode: m, package: x.name, root: x.root ? 1 : 0, truth: x.truth, status: x.status, reason: x.reason ?? "",
    best: x.best, range: x.range, rangeSize: x.rangeSize, exact: x.status === "TP" ? (x.exact ? 1 : 0) : "", inRange: x.status === "TP" ? (x.inRange ? 1 : 0) : "",
    bundledFunctions: x.bundledFunctions ?? "", matchableFunctions: x.matchableFunctions ?? "", codeFrom: x.codeFrom ?? "", codeFile: x.codeFile ?? "" });
}
writeAtomic(join(outDir, "detections.csv"), csv(["bundle", "mode", "package", "best", "range", "rangeSize", "versionsIndexed", "evidence", "coverage", "ownFunctions", "sharedFunctions", "functions", "exactFunctions", "lineageFunctions", "confidence"], detRows));
if (evalRows.length) writeAtomic(join(outDir, "evaluation.csv"), csv(["bundle", "mode", "package", "root", "truth", "status", "reason", "best", "range", "rangeSize", "exact", "inRange", "bundledFunctions", "matchableFunctions", "codeFrom", "codeFile"], evalRows));

// ---- summary ----
const stats = results.reduce((a, r) => { for (const k in r.stats) a[k] = (a[k] ?? 0) + r.stats[k]; return a; }, {});
const summary = {
  bundles: results.length, bundlesWithTruth: withTruth.length, bundlesWithSourceMap: withTruth.filter((r) => r.sourceMap).length,
  functions: stats, settings: results[0].settings, modes: {},
};
for (const m of modes) {
  const rows = withTruth.flatMap((r) => (r.modes[m]?.evaluation?.rows ?? []).map((x) => ({ bundle: r.bundle, ...x })));
  const counts = withTruth.map((r) => r.modes[m]?.evaluation?.functions).filter(Boolean);
  // intersection method: how often a package's functions agree on its versions
  const agree = { consistent: 0, contradicting: 0, consistentTruthInside: 0, contradictingTruthInside: 0, consistentSingle: 0, consistentSingleRight: 0 };
  for (const r of withTruth) for (const x of r.modes[m]?.evaluation?.rows ?? []) {
    if (x.status !== "TP" || !x.versionIndexed) continue;
    const d = r.modes[m].detections.find((y) => y.name === x.name); if (d?.consistent == null) continue;
    if (d.consistent) { agree.consistent++; if (x.inRange) agree.consistentTruthInside++; if (d.rangeSize === 1) { agree.consistentSingle++; if (x.exact) agree.consistentSingleRight++; } }
    else { agree.contradicting++; if (x.inRange) agree.contradictingTruthInside++; }
  }
  summary.modes[m] = {
    detections: results.reduce((a, r) => a + (r.modes[m]?.detections.length ?? 0), 0),
    ...(agree.consistent + agree.contradicting ? { versionAgreement: agree } : {}),
    ...(rows.length ? summarize(rows) : {}),
    ...(counts.length ? summarizeFunctions(rows, counts) : {}),
  };
}
writeAtomic(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));

// ---- report.md ----
const L = [];
const f3 = (x) => (x == null ? "–" : Number(x).toFixed(3));
const ix = summary.settings?.index ?? {};
L.push("# Tier 3 · Detection report", "");
L.push(`${results.length} bundles (${withTruth.length} with an SBOM, ${summary.bundlesWithSourceMap} with a source map), ${stats.nonTrivial ?? 0} non-trivial bundle functions: ` +
  `${stats.exactMatched ?? 0} matched exactly, ${stats.approxMatched ?? 0} only approximately, ${stats.unmatched ?? 0} not at all. ` +
  `Index: ${ix.records ?? "?"} reference functions, built ${ix.built_at ?? "?"}.`, "");
if (withTruth.length) {
  L.push("## Packages", "", "TP = detected and in the SBOM, FP = detected but not in it, FN = in the SBOM and in the index but not detected. " +
    "*Code-present precision* also counts a detection as right when the source map shows the package's code is in the bundle as a vendored copy. " +
    "*Recall (detectable)* leaves out packages whose bundled code cannot be matched at all (no functions, or tier 2's reference holds other code).", "");
  L.push("| Mode | TP | FP | FN | Not indexed | Precision | Recall | F1 | Code-present precision | Recall (detectable) |", "|---|---|---|---|---|---|---|---|---|---|");
  for (const m of modes) { const s = summary.modes[m], p = s.packages; if (!p) continue;
    L.push(`| ${m} | ${p.TP} | ${p.FP} | ${p.FN} | ${p.notIndexed} | ${f3(p.precision)} | ${f3(p.recall)} | ${f3(p.f1)} | ${f3(s.precisionCodePresent)} | ${f3(s.recallDetectable)} |`); }
  L.push("", "## Versions", "", "For every TP whose true version was indexed: is the reported version the true one (exact), is the true one inside the reported range, and how many versions the range spans.", "");
  L.push("| Mode | TPs | Exact | In range | Median range | Mean range | Exact (root) | Exact (dependency) |", "|---|---|---|---|---|---|---|---|");
  for (const m of modes) { const v = summary.modes[m].versions; if (!v) continue;
    L.push(`| ${m} | ${v.versionIndexed} | ${f3(v.exact)} | ${f3(v.inRange)} | ${v.medianRangeSize ?? "–"} | ${v.meanRangeSize ?? "–"} | ${f3(v.byRole?.root?.exact)} (${v.byRole?.root?.n ?? 0}) | ${f3(v.byRole?.dependency?.exact)} (${v.byRole?.dependency?.n ?? 0}) |`); }
  if (modes.some((m) => summary.modes[m].versionAgreement)) {
    L.push("", "Intersection: for how many of those TPs all of the package's functions agree on a version set (then the range is their intersection), and how often the true version is inside.", "");
    L.push("| Mode | Functions agree | True version inside | Single version (right) | Functions contradict | True version inside |", "|---|---|---|---|---|---|");
    for (const m of modes) { const a = summary.modes[m].versionAgreement; if (!a) continue;
      L.push(`| ${m} | ${a.consistent} | ${a.consistentTruthInside} | ${a.consistentSingle} (${a.consistentSingleRight}) | ${a.contradicting} | ${a.contradictingTruthInside} |`); }
  }
  if (modes.some((m) => summary.modes[m].functions)) {
    L.push("", "## Functions", "", "From the source maps: of the bundle functions a detected package explains, how many really come from it (accuracy), and how many of the functions that come from some package got explained at all (coverage).", "");
    L.push("| Mode | Functions from a package | Explained | Explained by the right package | Accuracy | Coverage |", "|---|---|---|---|---|---|");
    for (const m of modes) { const x = summary.modes[m].functions; if (!x) continue; L.push(`| ${m} | ${x.attributed} | ${x.explained} | ${x.correct} | ${f3(x.accuracy)} | ${f3(x.coverage)} |`); }
    L.push("", "## Why it went wrong", "");
    for (const m of modes) { const s = summary.modes[m]; if (!s.fnReasons) continue;
      const fmt = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("; ") || "none";
      L.push(`- **${m}** — missed: ${fmt(s.fnReasons)}. Wrongly found: ${fmt(s.fpReasons)}.`); }
  }
  const main = modes.includes("approx+lineage") ? "approx+lineage" : modes[modes.length - 1];
  L.push("", `## Per bundle (${main})`, "", "| Bundle | In SBOM | Detected | TP | FP | FN | Version exact |", "|---|---|---|---|---|---|---|");
  for (const r of withTruth) { const rows = r.modes[main]?.evaluation?.rows ?? []; const n = (st) => rows.filter((x) => x.status === st).length;
    const tp = rows.filter((x) => x.status === "TP" && x.versionIndexed);
    L.push(`| ${r.bundle} | ${new Set(r.truth.map((t) => t.name)).size} | ${r.modes[main]?.detections.length ?? 0} | ${n("TP")} | ${n("FP")} | ${n("FN")} | ${tp.length ? `${tp.filter((x) => x.exact).length}/${tp.length}` : "–"} |`); }
  const ex = (st) => withTruth.flatMap((r) => (r.modes[main]?.evaluation?.rows ?? []).filter((x) => x.status === st).map((x) => ({ bundle: r.bundle, ...x })));
  const fps = ex("FP"), fns = ex("FN");
  if (fps.length) { L.push("", `## Wrongly found packages (${main}, first 25)`, "", "| Bundle | Package | Reason | Code from |", "|---|---|---|---|");
    for (const x of fps.slice(0, 25)) L.push(`| ${x.bundle} | ${x.name} | ${x.reason ?? ""} | ${x.codeFile ?? ""} |`); }
  if (fns.length) { L.push("", `## Missed packages (${main}, first 25)`, "", "| Bundle | Package | Reason | Bundled functions | Matchable |", "|---|---|---|---|---|");
    for (const x of fns.slice(0, 25)) L.push(`| ${x.bundle} | ${x.name}@${x.truth} | ${x.reason ?? ""} | ${x.bundledFunctions ?? ""} | ${x.matchableFunctions ?? ""} |`); }
} else {
  const main = modes[modes.length - 1];
  L.push(`No SBOMs: detections only (${main}).`, "", "| Bundle | Packages detected |", "|---|---|");
  for (const r of results) L.push(`| ${r.bundle} | ${(r.modes[main]?.detections ?? []).map((d) => `${d.name}@${d.best}`).join(", ")} |`);
}
writeAtomic(join(outDir, "report.md"), L.join("\n") + "\n");

for (const m of modes) {
  const s = summary.modes[m];
  console.log(`RESULT | ${m.padEnd(14)} | ${s.packages ? `P ${f3(s.packages.precision)} R ${f3(s.packages.recall)} F1 ${f3(s.packages.f1)} | versions exact ${f3(s.versions.exact)} in range ${f3(s.versions.inRange)}` : `${s.detections} detections`}`);
}
console.log(`wrote report.md, summary.json, detections.csv${evalRows.length ? ", evaluation.csv" : ""} to ${outDir}`);
