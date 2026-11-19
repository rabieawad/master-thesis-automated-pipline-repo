// Tier 3 libraries: sketches and LSH, the package/version decision, source maps, evaluation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sketch, similarity, LSH, BINS } from "../tier3/lib/sketch.mjs";
import { infer, DEFAULTS } from "../tier3/lib/detect.mjs";
import { toFlatRanges, rangeIndices, inRanges } from "../tier3/lib/index.mjs";
import { decodeMappings, packageOfSource, attributeFunctions } from "../tier3/lib/sourcemap.mjs";
import { truthFromSbom, evaluateBundle, summarize, analyzeFunctions, summarizeFunctions } from "../tier3/lib/evaluate.mjs";

// ---------------------------------------------------------------- sketches
const A = "{ var v0 = v1 . length ; for ( var v2 = 0 ; v2 < v0 ; v2 ++ ) { if ( v1 [ v2 ] === v3 ) return v2 ; } return - 1 ; }";
const A2 = "{ var v0 = v1 . length ; for ( var v2 = 0 ; v2 < v0 ; v2 ++ ) { if ( v1 [ v2 ] == v3 ) return v2 ; } return - 1 ; }"; // === → ==
const B = "{ return fetch ( v0 , { method : 'POST' , body : JSON . stringify ( v1 ) } ) . then ( function ( v2 ) { return v2 . json ( ) ; } ) ; }";

test("sketch: the same code has similarity 1, renumbered locals too; an edit lowers it a little, other code a lot", () => {
  assert.equal(similarity(sketch(A).sig, sketch(A).sig), 1);
  assert.equal(similarity(sketch(A).sig, sketch(A.replace(/v3/g, "v7")).sig), 1, "local names are masked");
  const near = similarity(sketch(A).sig, sketch(A2).sig), far = similarity(sketch(A).sig, sketch(B).sig);
  assert.ok(near >= 0.6 && near < 1, `one-token edit: ${near}`);
  assert.ok(far < 0.2, `unrelated: ${far}`);
  assert.equal(sketch(A).sig.length, BINS);
  assert.ok(sketch(A).ntok > 30);
});

test("LSH finds the same and the slightly edited function, with 1 or 2 shared bands, and not unrelated code", () => {
  const lsh = new LSH();
  lsh.add(0, sketch(A).sig); lsh.add(1, sketch(B).sig);
  for (const minBands of [1, 2]) {
    const c = [...lsh.candidates(sketch(A2).sig, minBands)];
    assert.ok(c.includes(0), `near duplicate found with minBands ${minBands}`);
    assert.ok(!c.includes(1), "unrelated code is no candidate");
  }
  // the counting buffer is reset between calls
  assert.deepEqual([...lsh.candidates(sketch(B).sig, 2)], [1]);
  assert.deepEqual([...lsh.candidates(sketch(B).sig, 2)], [1]);
});

test("flat version ranges", () => {
  const f = toFlatRanges([5, 1, 2, 3, 7, 8]);
  assert.deepEqual(f, [1, 3, 5, 5, 7, 8]);
  assert.deepEqual([...rangeIndices(f)], [1, 2, 3, 5, 7, 8]);
  assert.ok(inRanges(f, 2) && inRanges(f, 8) && !inRanges(f, 4) && !inRanges(f, 0));
});

// ---------------------------------------------------------------- decisions, on a hand-made index
// pkgs: [{ name, versions, fns: [[versionIndex…], …], lineage?: [...] }]; every function is one record
function mockIndex(pkgs, lineages = {}) {
  const packages = [], rec = { pkg: [], versions: [], lineage: [] };
  let n = 0;
  pkgs.forEach((p, pi) => {
    const start = n, nonTrivial = p.versions.map(() => 0);
    p.fns.forEach((vs, j) => { for (const v of vs) nonTrivial[v]++; rec.pkg.push(pi); rec.versions.push(toFlatRanges(vs)); rec.lineage.push(p.lineage?.[j] ?? null); n++; });
    packages.push({ name: p.name, versions: p.versions, nonTrivial, start, end: n, hasLineages: !!lineages[pi] });
  });
  return { meta: { packages }, rec, P: pkgs.length, N: n, lineagesOf: (pi) => lineages[pi] ?? {} };
}
const recOf = (ix, name, j) => ix.meta.packages.find((p) => p.name === name).start + j;
// a matched bundle function: matches = [[record, similarity, exact]]
function fn(ix, k, matches, { ntok = 60, code = "" } = {}) {
  const byPkg = new Map(), exactPkgs = new Set();
  for (const [i, sim, exact] of matches) {
    const p = ix.rec.pkg[i]; let e = byPkg.get(p); if (!e) { e = { best: 0, cand: [] }; byPkg.set(p, e); }
    e.cand.push([i, sim, !!exact]); if (sim > e.best) e.best = sim; if (exact) exactPkgs.add(p);
  }
  for (const e of byPkg.values()) e.recs = e.cand.filter(([, s]) => s >= e.best - DEFAULTS.bestDelta);
  return { k, ntok, code, byPkg, exactPkgs };
}
const names = (det) => det.map((d) => d.name).sort();
// filler packages, so specificity behaves as in a real index (P large)
const fillers = (n) => Array.from({ length: n }, (_, i) => ({ name: `filler-${i}`, versions: ["1.0.0"], fns: [[0]] }));

test("a package whose functions are in the bundle is found, with its version range", () => {
  const ix = mockIndex([{ name: "lib", versions: ["1.0.0", "1.1.0", "2.0.0"], fns: [[0, 1, 2], [0, 1, 2], [1, 2], [1], [0, 1, 2], [2]] }, ...fillers(50)]);
  const fns = [0, 1, 2, 3, 4].map((j) => fn(ix, j, [[recOf(ix, "lib", j), 1, true]]));
  const [d] = infer(ix, fns, "exact");
  assert.equal(d.name, "lib");
  assert.equal(d.best, "1.1.0", "function 3 exists only in 1.1.0");
  assert.deepEqual(d.range, [["1.1.0", "1.1.0"]]);
  assert.equal(d.exactFunctions, 5);
  assert.ok(d.coverage > 0.99, "all of 1.1.0's functions are matched");
  assert.deepEqual(d.explains.sort(), [0, 1, 2, 3, 4]);
});

test("a prebuilt mega-bundle that holds a copy of a library does not take the library's functions", () => {
  // carrier = lib's 10 functions + 90 of its own
  const ix = mockIndex([
    { name: "lib", versions: ["1.0.0"], fns: Array.from({ length: 10 }, () => [0]) },
    { name: "carrier", versions: ["1.0.0"], fns: Array.from({ length: 100 }, () => [0]) },
    ...fillers(50),
  ]);
  // the bundle holds lib, plus three functions that only the carrier has (generic code)
  const fns = [...Array.from({ length: 10 }, (_, j) => fn(ix, j, [[recOf(ix, "lib", j), 1, true], [recOf(ix, "carrier", j), 1, true]])),
    ...[10, 11, 12].map((j) => fn(ix, j, [[recOf(ix, "carrier", j), 1, true]]))];
  for (const m of ["exact", "approx"]) assert.deepEqual(names(infer(ix, fns, m)), ["lib"], m);
  // ordered by evidence alone (orderPower 0), the carrier has more evidence, goes first and wins
  assert.deepEqual(names(infer(ix, fns, "exact", { orderPower: 0, shareCoverage: Infinity })), ["carrier"]);
});

test("code shared with a package chosen before (a UMD build holding its dependency) is still found when the bundle covers it", () => {
  // umd's reference = its own 20 functions + a copy of dep's 8
  const ix = mockIndex([
    { name: "umd", versions: ["1.0.0"], fns: Array.from({ length: 28 }, () => [0]) },
    { name: "dep", versions: ["1.0.0"], fns: Array.from({ length: 8 }, () => [0]) },
    ...fillers(50),
  ]);
  const fns = [
    ...Array.from({ length: 20 }, (_, j) => fn(ix, j, [[recOf(ix, "umd", j), 1, true]])),
    ...Array.from({ length: 8 }, (_, j) => fn(ix, 20 + j, [[recOf(ix, "umd", 20 + j), 1, true], [recOf(ix, "dep", j), 1, true]])),
  ];
  const det = infer(ix, fns, "exact");
  assert.deepEqual(names(det), ["dep", "umd"]);
  const dep = det.find((d) => d.name === "dep");
  assert.equal(dep.sharedFunctions, 8); assert.equal(dep.shares.length, 8); assert.equal(dep.explains.length, 0);
  assert.deepEqual(names(infer(ix, fns, "exact", { shareCoverage: Infinity })), ["umd"], "sharing off");
});

test("a small package is found from high coverage even below the minimum evidence", () => {
  const ix = mockIndex([{ name: "tiny", versions: ["1.0.0"], fns: [[0], [0], [0]] }, ...fillers(50)]);
  const fns = [0, 1].map((j) => fn(ix, j, [[recOf(ix, "tiny", j), 1, true]], { ntok: 20 })); // size weight 0.5 → evidence 1.0
  const [d] = infer(ix, fns, "exact");
  assert.equal(d?.name, "tiny");
  assert.ok(d.evidence < DEFAULTS.minEvidence);
  assert.deepEqual(infer(ix, fns, "exact", { smallCoverage: 2 }), [], "small path off");
});

test("functions found in more than maxShared packages give no evidence", () => {
  // 31 packages share the same 4 helper functions
  const sharers = Array.from({ length: 31 }, (_, i) => ({ name: `uses-helpers-${i}`, versions: ["1.0.0"], fns: [[0], [0], [0], [0]] }));
  const ix = mockIndex([...sharers, ...fillers(170)]);
  const fns = [0, 1, 2, 3].map((j) => fn(ix, j, sharers.map((s) => [recOf(ix, s.name, j), 1, true])));
  assert.deepEqual(infer(ix, fns, "exact"), []);
  assert.equal(infer(ix, fns, "exact", { maxShared: 1000, shareCoverage: Infinity }).length, 1, "with the limit off one of them explains the helpers");
});

test("approximate matches: below minSim they are ignored, exact mode ignores them, a better match wins the function", () => {
  const ix = mockIndex([
    { name: "good", versions: ["1.0.0"], fns: [[0], [0], [0], [0]] },
    { name: "similar", versions: ["1.0.0"], fns: [[0], [0], [0], [0]] },
    ...fillers(50),
  ]);
  const fns = [0, 1, 2, 3].map((j) => fn(ix, j, [[recOf(ix, "good", j), 0.9, false], [recOf(ix, "similar", j), 0.7, false]]));
  assert.deepEqual(names(infer(ix, fns, "approx")), ["good"]);
  assert.deepEqual(infer(ix, fns, "exact"), []);
  assert.deepEqual(infer(ix, fns, "approx", { minSim: 0.95 }), []);
});

test("versions: among equal scores the newest is reported; parsimony picks the oldest; a range spans the ties", () => {
  // f0 and f1 in every version; f2 only in 1.2.0 and not bundled
  const ix = mockIndex([{ name: "v", versions: ["1.0.0", "1.1.0", "1.2.0"], fns: [[0, 1, 2], [0, 1, 2], [2]] }, ...fillers(50)]);
  const fns = [0, 1].map((j) => fn(ix, j, [[recOf(ix, "v", j), 1, true]]));
  const [d] = infer(ix, fns, "exact");
  assert.equal(d.best, "1.2.0"); assert.equal(d.rangeSize, 3); assert.deepEqual(d.range, [["1.0.0", "1.2.0"]]);
  assert.equal(infer(ix, fns, "exact", { versionMethod: "vote", versionPick: "parsimony" })[0].best, "1.0.0");
  assert.equal(infer(ix, fns, "exact", { versionMethod: "vote" })[0].best, "1.2.0");
});

test("versions by intersection: one version when the functions pin it, a range when they don't, the most-agreed versions when they contradict", () => {
  // versions 1.0.0 … 1.4.0; a in all, b in 1.1.0–1.3.0, c in 1.2.0–1.4.0, d only in 1.4.0 (contradicts b)
  const ix = mockIndex([{ name: "x", versions: ["1.0.0", "1.1.0", "1.2.0", "1.3.0", "1.4.0"], fns: [[0, 1, 2, 3, 4], [1, 2, 3], [2, 3, 4], [4]] }, ...fillers(50)]);
  const at = (js) => js.map((j) => fn(ix, j, [[recOf(ix, "x", j), 1, true]]));
  const r1 = infer(ix, at([0, 1, 2]), "exact")[0];        // {1.2.0, 1.3.0}: a range, the newest as the guess
  assert.deepEqual(r1.range, [["1.2.0", "1.3.0"]]); assert.equal(r1.best, "1.3.0"); assert.equal(r1.consistent, true); assert.deepEqual(r1.conflictFunctions, []);
  const r2 = infer(ix, at([1, 3]), "exact")[0];           // b ∩ d = ∅ → contradiction
  assert.equal(r2.consistent, false);
  assert.equal(r2.rangeSize, 4, "most: each of 1.1.0–1.4.0 agrees with one of the two functions");
  assert.deepEqual(r2.unionRange, [["1.1.0", "1.4.0"]]);
  const r3 = infer(ix, at([0, 1, 2, 3]), "exact")[0];     // a, b, c, d: 1.2.0, 1.3.0 and 1.4.0 each agree with 3 of the 4
  assert.equal(r3.consistent, false); assert.deepEqual(r3.range, [["1.2.0", "1.4.0"]]); assert.equal(r3.best, "1.4.0");
  assert.deepEqual(r3.conflictFunctions, [1], "b does not contain 1.4.0");
  const r4 = infer(ix, at([0, 1, 2, 3]), "exact", { versionFallback: "union" })[0];
  assert.deepEqual(r4.range, [["1.0.0", "1.4.0"]], "union: every function's versions");
  // pinned to one version: c ∩ d = {1.4.0}
  const r5 = infer(ix, at([2, 3]), "exact")[0];
  assert.equal(r5.consistent, true); assert.deepEqual(r5.range, [["1.4.0", "1.4.0"]]); assert.equal(r5.unionRange, undefined);
});

test("versions: only a package's own code votes — not another chosen package's code, and a package that is not in the bundle blocks nothing", () => {
  // app 1.0.0's prebuilt build held a copy of dep's function g; app 2.0.0 does not.
  // h is app 2.0.0's code, and a carrier (not in the bundle) holds a closer copy of it.
  const ix = mockIndex([
    { name: "app", versions: ["1.0.0", "2.0.0"], fns: [[0, 1], [0, 1], [1], [0]] }, // f0, f1, h, g
    { name: "dep", versions: ["1.0.0"], fns: [[0], [0], [0]] },                    // g, d1, d2
    { name: "carrier", versions: ["1.0.0"], fns: Array.from({ length: 100 }, () => [0]) },
    ...fillers(50),
  ]);
  const r = (n, j) => recOf(ix, n, j);
  const fns = [
    fn(ix, 0, [[r("app", 0), 1, true]]), fn(ix, 1, [[r("app", 1), 1, true]]),
    fn(ix, 2, [[r("app", 2), 0.85, false], [r("carrier", 0), 0.95, false]]),       // h
    fn(ix, 3, [[r("app", 3), 1, true], [r("dep", 0), 1, true]]),                   // g, dep's code
    fn(ix, 4, [[r("dep", 1), 1, true]]), fn(ix, 5, [[r("dep", 2), 1, true]]),
  ];
  const app = (o) => infer(ix, fns, "approx", o).find((d) => d.name === "app");
  assert.deepEqual(names(infer(ix, fns, "approx")), ["app", "dep"]);
  assert.equal(app().best, "2.0.0"); assert.deepEqual(app().range, [["2.0.0", "2.0.0"]]);
  // the old rule — every function that matches app votes — lets dep's g pull app to 1.0.0 (vote)
  // or makes the functions contradict (intersection)
  assert.equal(app({ versionVotes: "all", versionMethod: "vote" }).best, "1.0.0");
  assert.equal(app({ versionVotes: "all" }).consistent, false);
  assert.equal(app().consistent, true);
});

test("lineage mode: the markers of a lineage decide which variant an approximate match is", () => {
  // one function with two variants: a (1.0.0, 1.1.0) and b (1.2.0); the marker "useFoo" is only in b
  const lineages = { 0: { L: { v: [["a", [0, 1]], ["b", [2, 2]]], m: [["useFoo", ["b"]]] } } };
  const ix = mockIndex([{ name: "lin", versions: ["1.0.0", "1.1.0", "1.2.0"], fns: [[0, 1], [2], [0, 1, 2], [0, 1, 2]], lineage: ["L", "L", null, null] }, ...fillers(50)], lineages);
  const fns = [
    fn(ix, 0, [[recOf(ix, "lin", 0), 0.8, false]], { code: "{ return useFoo ( v0 ) ; }" }), // looks most like variant a, has b's marker
    fn(ix, 1, [[recOf(ix, "lin", 2), 1, true]]), fn(ix, 2, [[recOf(ix, "lin", 3), 1, true]]),
  ];
  assert.equal(infer(ix, fns, "approx")[0].best, "1.1.0");
  const d = infer(ix, fns, "approx+lineage")[0];
  assert.equal(d.best, "1.2.0"); assert.equal(d.lineageFunctions, 1); assert.deepEqual(d.range, [["1.2.0", "1.2.0"]]);
});

// ---------------------------------------------------------------- source maps
test("source map mappings: columns and sources per generated line, negative deltas", () => {
  // line 1: (0, src 0), (+3, src +1); line 2: (0, src −1 → 0)
  assert.deepEqual(decodeMappings("AAAA,GCAA;ADAA"), [[0, 0, 3, 1], [0, 0]]);
  assert.deepEqual(decodeMappings(""), [[]]);
  assert.throws(() => decodeMappings("A!AA"), /invalid/);
});

test("the package and version of a source path (pnpm, scoped, peers, plain node_modules)", () => {
  assert.deepEqual(packageOfSource("webpack://holder/./node_modules/.pnpm/element-ui@2.15.14_vue@2.7.16/node_modules/element-ui/lib/utils/lodash.js"), { name: "element-ui", version: "2.15.14", file: "lib/utils/lodash.js" });
  assert.deepEqual(packageOfSource("webpack://holder/./node_modules/.pnpm/@emotion+react@11.14.0_react@19.3.1/node_modules/@emotion/react/dist/x.js"), { name: "@emotion/react", version: "11.14.0", file: "dist/x.js" });
  assert.deepEqual(packageOfSource("webpack://holder/./node_modules/qs/lib/index.js"), { name: "qs", version: null, file: "lib/index.js" });
  assert.equal(packageOfSource("webpack://holder/./entry.js"), null);
});

test("each function's package from its first character's mapping", () => {
  const code = "function a(){}\nfunction b(){}function c(){}";
  const map = { sources: ["./node_modules/x/i.js", "./node_modules/.pnpm/y@2.0.0/node_modules/y/j.js"], mappings: "AAAA;ACAA,cAAA" };
  const at = attributeFunctions(code, map, [{ index: 0, start: 0 }, { index: 1, start: 15 }, { index: 2, start: 29 }, { index: 3 }]);
  assert.equal(at.get(0).name, "x");
  assert.equal(at.get(1).name, "y"); assert.equal(at.get(1).version, "2.0.0");
  assert.equal(at.get(2).name, "y", "the segment at column 14 still covers column 14+");
  assert.equal(at.get(3), null, "no position");
});

// ---------------------------------------------------------------- evaluation
const SBOM = { metadata: { component: { name: "root", version: "1.0.0" } }, components: [{ group: "@s", name: "dep", version: "2.0.0" }, { name: "gone", version: "1.0.0" }, { name: "new", version: "3.0.0" }] };

test("truth from an SBOM: the root and every component, scoped names joined", () => {
  const t = truthFromSbom(SBOM);
  assert.deepEqual(t.map((x) => `${x.name}@${x.version}`), ["root@1.0.0", "@s/dep@2.0.0", "gone@1.0.0", "new@3.0.0"]);
  assert.equal(t[0].root, true); assert.equal(t[1].root, false);
});

test("evaluation rows: TP with exact / in-range versions, FP, FN, not indexed; metrics", () => {
  const indexed = new Map([["root", ["0.9.0", "1.0.0", "1.1.0"]], ["@s/dep", ["1.0.0", "2.0.0"]], ["gone", ["1.0.0"]], ["extra", ["1.0.0"]]]);
  const det = [
    { name: "root", best: "1.1.0", range: [["1.0.0", "1.1.0"]], rangeSize: 2 },
    { name: "@s/dep", best: "2.0.0", range: [["2.0.0", "2.0.0"]], rangeSize: 1 },
    { name: "extra", best: "1.0.0", range: [["1.0.0", "1.0.0"]], rangeSize: 1 },
  ];
  const rows = evaluateBundle(det, truthFromSbom(SBOM), indexed);
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.equal(by.root.status, "TP"); assert.equal(by.root.exact, false); assert.equal(by.root.inRange, true); assert.equal(by.root.root, true);
  assert.equal(by["@s/dep"].exact, true);
  assert.equal(by.gone.status, "FN"); assert.equal(by.new.status, "not indexed"); assert.equal(by.extra.status, "FP");
  const s = summarize(rows);
  assert.deepEqual([s.packages.TP, s.packages.FP, s.packages.FN, s.packages.notIndexed], [2, 1, 1, 1]);
  assert.equal(s.packages.precision, 0.667); assert.equal(s.packages.recall, 0.667); assert.equal(s.packages.recallAll, 0.5);
  assert.equal(s.versions.exact, 0.5); assert.equal(s.versions.inRange, 1);
  assert.deepEqual(s.versions.byRole.root, { n: 1, exact: 0, inRange: 1 });
});

test("function-level reasons: why a package was missed and why one was wrongly found", () => {
  const names = ["root", "lodash", "tiny", "helper", "lodash-es", "dep"];
  const P = Object.fromEntries(names.map((n, i) => [n, i]));
  const f = (k, pkgs) => ({ k, byPkg: new Map(pkgs.map(([n, sim]) => [P[n], { best: sim }])), exactPkgs: new Set(pkgs.filter(([, s]) => s === 1).map(([n]) => P[n])) });
  const src = (name, file = "index.js") => ({ name, version: "1.0.0", file });
  const fns = [f(0, [["root", 1]]), f(1, [["lodash", 1]]), f(2, [["lodash", 1]]), f(3, [["tiny", 0.3]]), f(4, [["dep", 1], ["root", 1]]), f(5, [["dep", 1], ["root", 1]]),
    f(6, [["lodash", 1], ["lodash-es", 1]]), f(7, [["lodash", 1], ["lodash-es", 1]]), f(8, [])];
  const attribution = new Map([[0, src("root")], [1, src("root", "lib/utils/lodash.js")], [2, src("root", "lib/utils/lodash.js")], [3, src("tiny")],
    [4, src("dep")], [5, src("dep")], [6, src("lodash-es", "a.js")], [7, src("lodash-es", "b.js")], [8, src("ghost")]]);
  const detections = [{ name: "root", explains: [0, 4, 5], coverage: 0.9 }, { name: "lodash", explains: [1, 2, 6], coverage: 0.6 }];
  const rows = [
    { name: "root", status: "TP" }, { name: "lodash", status: "FP" }, { name: "tiny", status: "FN" }, { name: "dep", status: "FN" },
    { name: "ghost", status: "FN" }, { name: "lodash-es", status: "FN" },
  ];
  const c = analyzeFunctions(rows, detections, attribution, fns, names, "approx");
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.equal(by.tiny.reason, "reference lacks the code", "0.3 < minSim");
  assert.equal(by.dep.reason, "explained by root");
  assert.equal(by.ghost.reason, "reference lacks the code");
  assert.equal(by["lodash-es"].reason, "explained by lodash");
  assert.equal(by.lodash.reason, "vendored copy inside root", "2 of its 3 functions come from root's lib/utils/lodash.js");
  assert.deepEqual(c, { attributed: 9, explained: 6, correct: 1 });
  // a clear vendored copy: all of lodash's functions come from root/lib/utils/lodash.js
  const rows2 = [{ name: "lodash", status: "FP" }];
  analyzeFunctions(rows2, [{ name: "lodash", explains: [1, 2] }], attribution, fns, names, "approx");
  assert.equal(rows2[0].reason, "vendored copy inside root"); assert.equal(rows2[0].codeFile, "root/lib/utils/lodash.js");
  // lodash-es's own file named after lodash is not a vendored copy: lodash-es is lodash
  const rows3 = [{ name: "lodash", status: "FP" }];
  const at3 = new Map([[1, src("lodash-es", "lodash.default.js")], [2, src("lodash-es", "lodash.default.js")]]);
  analyzeFunctions(rows3, [{ name: "lodash", explains: [1, 2], coverage: 0.6 }], at3, fns, names, "approx");
  assert.equal(rows3[0].reason, "same code as lodash-es");
  // the other way round: a detected package that covers little of itself holds a copy of Q
  const rows6 = [{ name: "lodash", status: "FP" }];
  analyzeFunctions(rows6, [{ name: "lodash", explains: [1, 2], coverage: 0.1 }], at3, fns, names, "approx");
  assert.equal(rows6[0].reason, "holds a copy of lodash-es");
  // three of three functions from one prebuilt file of root (not named after the package): embedded
  const rows5 = [{ name: "dep", status: "FP" }];
  const at5 = new Map([[4, src("root", "dist/root.umd.js")], [5, src("root", "dist/root.umd.js")], [0, src("root", "dist/root.umd.js")]]);
  analyzeFunctions(rows5, [{ name: "dep", explains: [0, 4, 5], coverage: 0.9 }], at5, fns, names, "approx");
  assert.equal(rows5[0].reason, "embedded in a file of root"); assert.equal(rows5[0].codeFile, "root/dist/root.umd.js");
  // no function in the bundle at all
  const rows4 = [{ name: "types-only", status: "FN" }];
  analyzeFunctions(rows4, [], attribution, fns, names, "approx");
  assert.equal(rows4[0].reason, "no functions in the bundle");
  const sf = summarizeFunctions([...rows, ...rows2], [c]);
  assert.equal(sf.functions.accuracy, 0.167);
  assert.equal(sf.fnReasons["explained by another package"], 2);
  assert.equal(sf.precisionCodePresent, 1, "1 TP + 2 vendored copies of 3 detections");
  assert.equal(summarize([...rows, ...rows2]).packages.precision, 0.333);
});
