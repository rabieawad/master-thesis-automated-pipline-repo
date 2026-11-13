import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmp, writeJson, writeText, read, parseCsv, runNode, hasModule, TIER2 } from "./helpers.mjs";
import { identity, signature, toRanges, cmpVersion, dedup } from "../tier2/05_dedup-functions.mjs";

// minimal step-04 style record
const P0 = { count: 0, rest: false, defaults: 0, destructured: false };
const fn = (o) => ({ index: 0, type: "FunctionDeclaration", bodyType: "BlockStatement", async: false, generator: false,
  params: { ...P0, ...(o.params || {}) }, parentIndex: -1, metrics: { nodes: 30 }, ...o,
  ...(o.params ? { params: { ...P0, ...o.params } } : {}) });
const file = (fns) => ({ bundle: "x.js", version: 2, stats: {}, functions: fns.map((f, i) => ({ ...f, index: i })) });

const A = { text: "{ var arr = 1; return arr + 2; }", textNorm: "{ var v0 = 1; return v0 + 2; }", hash: "a1" };
const A_RENAMED = { text: "{ var a = 1; return a + 2; }", textNorm: "{ var v0 = 1; return v0 + 2; }", hash: "a2" };
const A_EDITED = { text: "{ var arr = 1; return arr + 3; }", textNorm: "{ var v0 = 1; return v0 + 3; }", hash: "a3" };

test("cmpVersion: semver order, prerelease before release", () => {
  const v = ["1.10.0", "1.2.0", "1.2.0-rc.1", "0.9.9", "1.2.0-beta.2", "1.2.0-beta.10"];
  assert.deepEqual([...v].sort(cmpVersion), ["0.9.9", "1.2.0-beta.2", "1.2.0-beta.10", "1.2.0-rc.1", "1.2.0", "1.10.0"]);
});

test("toRanges collapses contiguous runs over the known version list, keeps gaps", () => {
  const all = ["1.0.0", "1.1.0", "1.2.0", "1.3.0", "2.0.0"];
  assert.deepEqual(toRanges(["1.1.0", "1.0.0", "1.2.0"], all), [["1.0.0", "1.2.0"]]);
  assert.deepEqual(toRanges(["1.0.0", "1.3.0", "2.0.0"], all), [["1.0.0", "1.0.0"], ["1.3.0", "2.0.0"]]);
});

test("identity: normalized merges local renames, exact does not; edits never merge", () => {
  assert.equal(identity(fn(A)), identity(fn(A_RENAMED)));
  assert.notEqual(identity(fn(A), "exact"), identity(fn(A_RENAMED), "exact"));
  assert.notEqual(identity(fn(A)), identity(fn(A_EDITED)));
});

test("identity: signature is part of the key (params, async, arrow); decl/expr merge unless strict", () => {
  assert.notEqual(identity(fn(A)), identity(fn({ ...A, params: { count: 1 } })));
  assert.notEqual(identity(fn(A)), identity(fn({ ...A, async: true })));
  assert.notEqual(identity(fn(A)), identity(fn({ ...A, type: "ArrowFunctionExpression" })));
  const expr = fn({ ...A, type: "FunctionExpression" });
  assert.equal(identity(fn(A)), identity(expr));
  assert.notEqual(identity(fn(A), "normalized", true), identity(expr, "normalized", true));
  assert.equal(signature(fn(A)), signature(expr));
});

test("identity: falls back to hashNorm without text; unkeyed functions never merge", () => {
  const noText = fn({ hashNorm: "deadbeef", hash: "h" });
  assert.equal(identity(noText), identity(fn({ hashNorm: "deadbeef", hash: "other" })));
  assert.notEqual(identity(noText), identity(fn({ textNorm: "deadbeef" })), "a hash never equals literal text");
  const bare = fn({});
  assert.notEqual(identity(bare, "normalized", false, "x@1#0"), identity(bare, "normalized", false, "x@1#1"));
});

test("dedup end-to-end on fixtures: groups, intervals, gaps, round-trip, CSV, trivial", () => {
  const t = tmp(); try {
    const inDir = join(t.dir, "in"), out = join(t.dir, "out");
    const TRIV = { text: "{}", textNorm: "{}", hash: "t", metrics: { nodes: 2 } };
    writeJson(join(inDir, "pkg@1.0.0.functions.json"), file([fn(A), fn(TRIV)]));
    writeJson(join(inDir, "pkg@1.1.0.functions.json"), file([fn(A_RENAMED), fn(TRIV)]));
    writeJson(join(inDir, "pkg@1.2.0.functions.json"), file([fn(A_EDITED)]));
    writeJson(join(inDir, "pkg@1.10.0.functions.json"), file([fn(A), fn(A)])); // back again, twice
    writeJson(join(inDir, "@s+other@0.1.0.functions.json"), file([fn(A)]));
    const s = dedup(inDir, out, { log: () => {} });
    assert.equal(s.function_instances, 8);
    assert.equal(s.unique_functions, 3); // A (+renamed), A_EDITED, trivial
    const U = read(join(out, "unique_functions.jsonl")).trim().split("\n").map((l) => JSON.parse(l));
    const a = U.find((u) => u.textNorm === A.textNorm);
    assert.equal(a.raw_variants, 2);
    assert.equal(a.text, A.text, "most common raw variant is the representative");
    assert.equal(a.n_occurrences, 5);
    assert.deepEqual(a.packages.pkg.ranges, [["1.0.0", "1.1.0"], ["1.10.0", "1.10.0"]], "1.10.0 sorts after 1.2.0; gap kept");
    assert.deepEqual(Object.keys(a.packages), ["@s+other", "pkg"]);
    assert.equal(U.find((u) => u.textNorm === "{}").trivial, true);
    assert.equal(s.with_gaps, 1);
    assert.equal(s.shared_across_packages, 1);
    // round-trip: every original slot maps to a record with the same textNorm
    const VI = JSON.parse(read(join(out, "version_index.json")));
    const byId = Object.fromEntries(U.map((u) => [u.id, u]));
    assert.deepEqual(VI["pkg@1.2.0"].map((id) => byId[id].textNorm), [A_EDITED.textNorm]);
    assert.equal(VI["pkg@1.10.0"].length, 2);
    const occ = parseCsv(read(join(out, "occurrences.csv")));
    const r = occ.find((x) => x.function_id === a.id && x.version === "1.10.0");
    assert.equal(r.count, "2"); assert.equal(r.indices, "0 1");
  } finally { t.cleanup(); }
});

test("dedup --near lists the edited variant as a near-duplicate, without merging", () => {
  const t = tmp(); try {
    const inDir = join(t.dir, "in"), out = join(t.dir, "out");
    const body = (n) => "{ " + Array.from({ length: 40 }, (_, i) => `v0.call${i}(v1, 'k${i}');`).join(" ") + ` return ${n}; }`;
    writeJson(join(inDir, "pkg@1.0.0.functions.json"), file([fn({ text: body(1), textNorm: body(1), hash: "b1" })]));
    writeJson(join(inDir, "pkg@1.1.0.functions.json"), file([fn({ text: body(2), textNorm: body(2), hash: "b2" })]));
    const s = dedup(inDir, out, { near: 0.85, log: () => {} });
    assert.equal(s.unique_functions, 2, "edited function is still its own record");
    const pairs = parseCsv(read(join(out, "near_duplicates.csv")));
    assert.equal(pairs.length, 1);
    assert.ok(Number(pairs[0].jaccard) >= 0.85);
  } finally { t.cleanup(); }
});

test("05 CLI: missing input dir fails cleanly; bad mode rejected", () => {
  const t = tmp(); try {
    assert.notEqual(runNode(join(TIER2, "05_dedup-functions.mjs"), [join(t.dir, "nope"), join(t.dir, "o")]).code, 0);
    writeJson(join(t.dir, "in", "p@1.0.0.functions.json"), file([fn(A)]));
    assert.notEqual(runNode(join(TIER2, "05_dedup-functions.mjs"), [join(t.dir, "in"), join(t.dir, "o"), "--mode", "fuzzy"]).code, 0);
    const ok = runNode(join(TIER2, "05_dedup-functions.mjs"), [join(t.dir, "in"), join(t.dir, "o"), "--mode", "exact"]);
    assert.equal(ok.code, 0, ok.stdout);
    assert.equal(JSON.parse(read(join(t.dir, "o", "summary.json"))).mode, "exact");
  } finally { t.cleanup(); }
});

// real step 04 output -> step 05 (needs the collector deps)
const DEPS_OK = (await Promise.all(["meriyah", "escodegen"].map(hasModule))).every(Boolean);
test("step 04 -> 05: a function unchanged across versions becomes one record spanning both", { skip: DEPS_OK ? false : "meriyah/escodegen not installed" }, () => {
  const t = tmp(); try {
    const bundles = join(t.dir, "bundles"), d4 = join(t.dir, "d4"), d5 = join(t.dir, "d5");
    const keep = "function keep(list){\n  var out = [];\n  for (var i = 0; i < list.length; i++) out.push(list[i] * 2);\n  return out;\n}";
    writeText(join(bundles, "fx@1.0.0.js"), `module([(function(_$__e){\n${keep}\nfunction v(){ return '1.0.0'; }\n})])`);
    writeText(join(bundles, "fx@1.1.0.js"), `module([(function(_$__e){\n${keep.replaceAll("list", "xs")}\nfunction v(){ return '1.1.0'; }\n})])`);
    const r4 = runNode(join(TIER2, "04_extract-functions.mjs"), [bundles, d4, "--min-loc", "0"]);
    assert.equal(r4.code, 0, r4.stdout);
    const r5 = runNode(join(TIER2, "05_dedup-functions.mjs"), [d4, d5]);
    assert.equal(r5.code, 0, r5.stdout);
    const U = read(join(d5, "unique_functions.jsonl")).trim().split("\n").map((l) => JSON.parse(l));
    const spanning = U.filter((u) => u.packages.fx.n_versions === 2);
    assert.ok(spanning.some((u) => /push/.test(u.text)), "renamed-param `keep` merges across versions");
    assert.ok(U.some((u) => u.n_versions === 1 && /'1\.0\.0'/.test(u.text)), "version-literal function stays per-version");
  } finally { t.cleanup(); }
});
