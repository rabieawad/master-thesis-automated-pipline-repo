// Tier 3 evaluation: detections against the ground truth in tier 1's SBOMs.
//
// Ground truth of a bundle = its SBOM's root component + every component (the dependencies whose
// modules are in the bundle), each with its version. A package can only be found if it is in the
// reference index, so recall is reported both against all truth and against truth in the index;
// a version can only be found exactly if that version was indexed.
//
// Package level: TP = detected and in the truth; FP = detected, not in the truth; FN = in the
// truth (and in the index), not detected.
// Version level, for each TP: exact = best version is the true one; inRange = the true version is
// inside the reported range; rangeSize = how many versions the range covers.
//
// Function level (when the bundle's source map is available, see sourcemap.mjs): every bundle
// function's true package. It explains the errors —
//   FN  "no functions in the bundle"   the package's modules hold no non-trivial function
//       "reference lacks the code"      none of its bundled functions matches its reference
//                                       (e.g. tier 2 pseudo-bundled another build of it)
//       "explained by <X>"              most of its matchable functions went to package X
//       "too little evidence"           matchable, but below the acceptance thresholds
//   FP  "vendored copy inside <Q>"      the functions come from a file of package Q that is
//                                       named after the detected package (element-ui ships
//                                       lib/utils/lodash.js): the code is there, the SBOM can't
//                                       know it
//       "embedded in a file of <Q>"     ≥ 80 % of them (at least 3) come from one file of Q, and
//                                       the bundle covers ≥ 50 % of the detected package — a
//                                       prebuilt build that holds a copy (algoliasearch.umd.js
//                                       holds the @algolia clients, quill/dist/quill.js parchment)
//       "holds a copy of <Q>"           the other way round: the detected package covers < 25 % of
//                                       itself, its reference is a prebuilt build holding Q's code
//                                       (mealz-components holds lit)
//       "same code as <Q>"              otherwise: the functions come from package Q (e.g. lodash
//                                       detected for lodash-es: the same code under another name)
//       "shared or generic code"        otherwise
// and gives function attribution accuracy: of the bundle functions a detected package explains,
// the share that really come from that package.

export function truthFromSbom(sbom) {
  const out = [];
  const add = (c) => { if (c?.name && c?.version) out.push({ name: c.group ? `${c.group}/${c.name}` : c.name, version: c.version, root: c === sbom.metadata?.component }); };
  add(sbom.metadata?.component);
  for (const c of sbom.components ?? []) add(c);
  // the same package twice (two versions): keep every version
  return out;
}

const inRangeOf = (range, version, versions) => {
  const i = versions.indexOf(version); if (i < 0) return false;
  return range.some(([a, b]) => { const x = versions.indexOf(a), y = versions.indexOf(b); return i >= x && i <= y; });
};

// detections: [{name, best, range, rangeSize}]; truth: [{name, version}]; indexed: Map(name -> versions[])
export function evaluateBundle(detections, truth, indexed) {
  const truthBy = new Map(), rootOf = new Set();
  for (const t of truth) { if (!truthBy.has(t.name)) truthBy.set(t.name, []); truthBy.get(t.name).push(t.version); if (t.root) rootOf.add(t.name); }
  const det = new Map(detections.map((d) => [d.name, d]));
  const rows = [];
  for (const [name, versions] of truthBy) {
    const d = det.get(name), iv = indexed.get(name);
    const versionIndexed = !!iv && versions.some((v) => iv.includes(v));
    rows.push({ name, truth: versions.join(" | "), root: rootOf.has(name), inIndex: !!iv, versionIndexed, detected: !!d,
      best: d?.best ?? null, range: d ? d.range.map(([a, b]) => (a === b ? a : `${a}–${b}`)).join(", ") : null, rangeSize: d?.rangeSize ?? null,
      exact: !!d && versions.includes(d.best), inRange: !!d && !!iv && versions.some((v) => inRangeOf(d.range, v, iv)), status: d ? "TP" : iv ? "FN" : "not indexed" });
  }
  for (const d of detections) if (!truthBy.has(d.name)) rows.push({ name: d.name, truth: null, root: false, inIndex: true, versionIndexed: false, detected: true, best: d.best,
    range: d.range.map(([a, b]) => (a === b ? a : `${a}–${b}`)).join(", "), rangeSize: d.rangeSize, exact: false, inRange: false, status: "FP" });
  return rows;
}

// micro-averaged metrics over many bundles' rows
export function summarize(allRows) {
  const n = (f) => allRows.filter(f).length;
  const TP = n((r) => r.status === "TP"), FP = n((r) => r.status === "FP"), FN = n((r) => r.status === "FN"), NI = n((r) => r.status === "not indexed");
  const tps = allRows.filter((r) => r.status === "TP"), tpv = tps.filter((r) => r.versionIndexed);
  const ratio = (a, b) => (b ? Math.round((a / b) * 1000) / 1000 : null);
  const sizes = tpv.map((r) => r.rangeSize).sort((a, b) => a - b);
  return {
    packages: { TP, FP, FN, notIndexed: NI, precision: ratio(TP, TP + FP), recall: ratio(TP, TP + FN), recallAll: ratio(TP, TP + FN + NI), f1: ratio(2 * TP, 2 * TP + FP + FN) },
    versions: { tp: tps.length, versionIndexed: tpv.length, exact: ratio(tpv.filter((r) => r.exact).length, tpv.length), inRange: ratio(tpv.filter((r) => r.inRange).length, tpv.length),
      medianRangeSize: sizes.length ? sizes[Math.floor(sizes.length / 2)] : null, meanRangeSize: sizes.length ? Math.round((sizes.reduce((a, b) => a + b, 0) / sizes.length) * 10) / 10 : null,
      byRole: Object.fromEntries([["root", true], ["dependency", false]].map(([k, isRoot]) => {
        const a = tpv.filter((r) => !!r.root === isRoot);
        return [k, { n: a.length, exact: ratio(a.filter((r) => r.exact).length, a.length), inRange: ratio(a.filter((r) => r.inRange).length, a.length) }];
      })) },
  };
}

const bare = (name) => name.replace(/^@[^/]+\//, "").toLowerCase();

// Function-level analysis of one bundle in one mode; adds reasons to the rows and returns the
// function counts. attribution: Map(function index -> {name, version, file} | null);
// fns: the matched bundle functions (detect.mjs); names: package index -> name.
export function analyzeFunctions(rows, detections, attribution, fns, names, mode, minSim = 0.5) {
  const owner = new Map(); // function index -> detected package that explains it
  for (const d of detections) for (const k of d.explains ?? []) owner.set(k, d.name);
  const byTruth = new Map(); // package -> { bundled, matchable, explainedBy: {X: n} }
  let attributed = 0, explained = 0, correct = 0;
  for (const f of fns) {
    const src = attribution.get(f.k); if (!src) continue;
    attributed++;
    const o = owner.get(f.k);
    if (o) { explained++; if (o === src.name) correct++; }
    let t = byTruth.get(src.name); if (!t) { t = { bundled: 0, matchable: 0, explainedBy: {} }; byTruth.set(src.name, t); }
    t.bundled++;
    let ok = false;
    for (const [p, e] of f.byPkg) if (names[p] === src.name && (mode === "exact" ? f.exactPkgs.has(p) : e.best >= minSim)) ok = true;
    if (ok) { t.matchable++; if (o && o !== src.name) t.explainedBy[o] = (t.explainedBy[o] ?? 0) + 1; }
  }
  for (const r of rows) {
    const t = byTruth.get(r.name);
    if (r.status === "TP" || r.status === "FN") { r.bundledFunctions = t?.bundled ?? 0; r.matchableFunctions = t?.matchable ?? 0; }
    if (r.status === "FN") {
      const [x, n] = Object.entries(t?.explainedBy ?? {}).sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
      r.reason = !t?.bundled ? "no functions in the bundle" : !t.matchable ? "reference lacks the code"
        : n >= t.matchable / 2 ? `explained by ${x}` : "too little evidence";
    }
    if (r.status === "FP") {
      const d = detections.find((x) => x.name === r.name), from = {}, files = {};
      const accounted = [...(d?.explains ?? []), ...(d?.shares ?? [])];
      for (const k of accounted) { const src = attribution.get(k); const q = src?.name ?? "(no source)"; from[q] = (from[q] ?? 0) + 1; if (src) files[`${q}/${src.file}`] = (files[`${q}/${src.file}`] ?? 0) + 1; }
      const total = accounted.length;
      const [q, n] = Object.entries(from).sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
      const [file, inFile] = Object.entries(files).filter(([f]) => f.startsWith(q + "/")).sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
      r.codeFrom = q; r.codeFromShare = total ? Math.round((n / total) * 1000) / 1000 : 0; r.codeFile = file;
      // vendored: Q's file is named after P, and Q is not itself a variant of P (lodash-es for lodash)
      const vendored = q && q !== "(no source)" && file && !bare(q).includes(bare(r.name)) && file.slice(q.length + 1).toLowerCase().split("/").some((part) => part.replace(/\.[cm]?js$/, "").includes(bare(r.name)));
      const cov = d?.coverage ?? 0, embedded = file && inFile >= 3 && inFile >= 0.8 * total && cov >= 0.5;
      r.reason = n / (total || 1) < 0.5 || !q || q === "(no source)" ? "shared or generic code" : vendored ? `vendored copy inside ${q}`
        : embedded ? `embedded in a file of ${q}` : cov < 0.25 ? `holds a copy of ${q}` : `same code as ${q}`;
    }
  }
  return { attributed, explained, correct };
}

// Totals of the function-level analysis over many bundles.
export function summarizeFunctions(allRows, counts) {
  // reasons without the package they name: "explained by react" → "explained by another package"
  const tally = (status) => { const m = {}; for (const r of allRows) if (r.status === status && r.reason) { const k = r.reason.replace(/ (inside|as|by|of|into) .*/, " $1 another package"); m[k] = (m[k] ?? 0) + 1; } return m; };
  const c = counts.reduce((a, b) => ({ attributed: a.attributed + b.attributed, explained: a.explained + b.explained, correct: a.correct + b.correct }), { attributed: 0, explained: 0, correct: 0 });
  const TP = allRows.filter((r) => r.status === "TP").length, FP = allRows.filter((r) => r.status === "FP").length;
  const FN = allRows.filter((r) => r.status === "FN").length;
  const vendored = allRows.filter((r) => r.status === "FP" && /^(vendored|embedded|compiled into)/.test(r.reason ?? "")).length;
  const undetectable = allRows.filter((r) => r.status === "FN" && /^(no functions|reference lacks)/.test(r.reason ?? "")).length;
  const ratio = (a, b) => (b ? Math.round((a / b) * 1000) / 1000 : null);
  return {
    functions: { ...c, accuracy: ratio(c.correct, c.explained), coverage: ratio(c.explained, c.attributed) },
    fnReasons: tally("FN"), fpReasons: tally("FP"),
    // precision when vendored and embedded copies count as correct (the code is there); recall over the truth
    // whose code can be matched at all
    precisionCodePresent: ratio(TP + vendored, TP + FP), recallDetectable: ratio(TP, TP + FN - undetectable),
  };
}
