import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmp, writeJson, writeText, read, parseCsv, runNode, hasModule, TIER2 } from "./helpers.mjs";
import { readdirSync, mkdirSync, copyFileSync } from "node:fs";
import { identity, signature, toRanges, cmpVersion, dedup, collect, mergeStates, finalize, emptyState, STATE_VERSION, functionKey, shortId, IDENTITY_MODES } from "../tier2/05_dedup-functions.mjs";

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

// ------------------------------------------------- collect / mergeStates / finalize
// The streamed pipeline collects one package at a time, saves the state as JSON and merges
// the partials later. Merging them in ascending first-filename order must reproduce batch
// mode exactly, because batch reads all files in sorted order and all of one package's
// files are contiguous in that order.
const roundTrip = (state) => JSON.parse(JSON.stringify(state)); // as a partial on disk would be

function splitByPackage(t, inDir) {
  const dirs = new Map();
  for (const f of readdirSync(inDir).filter((x) => x.endsWith(".functions.json"))) {
    const key = f.slice(0, -".functions.json".length);
    const at = key.lastIndexOf("@");
    const pkg = at > 0 ? key.slice(0, at) : "_odd";
    if (!dirs.has(pkg)) { const d = join(t.dir, "split", pkg); mkdirSync(d, { recursive: true }); dirs.set(pkg, d); }
    copyFileSync(join(inDir, f), join(dirs.get(pkg), f));
  }
  return [...dirs.values()];
}

test("collect produces a JSON-serializable state with the documented fields", () => {
  const t = tmp(); try {
    const inDir = join(t.dir, "in");
    writeJson(join(inDir, "pkg@1.0.0.functions.json"), file([fn(A)]));
    writeJson(join(inDir, "pkg@1.1.0.functions.json"), file([fn(A_RENAMED)]));
    const st = collect(inDir, { log: () => {} });
    assert.equal(st.stateVersion, STATE_VERSION);
    assert.deepEqual(Object.keys(st).sort(), ["files", "firstFile", "identity", "keys", "mode", "occ", "pkgVersions", "parents", "rawText", "rawVariants", "stateVersion", "strictType", "total", "uniq", "versionIndex"].sort());
    assert.equal(st.identity, "string", "exact string comparison is the default");
    assert.equal(st.keys.length, st.uniq.length, "one exact key recorded per distinct function");
    assert.deepEqual(collect(inDir, { log: () => {}, identity: "hash" }).keys, [], "no key table in hash mode");
    assert.equal(st.files, 2);
    assert.equal(st.firstFile, "pkg@1.0.0.functions.json", "the smallest filename key, for merge ordering");
    assert.equal(st.total, 2);
    assert.equal(st.uniq.length, 1, "the two renamed copies are one function");
    assert.deepEqual(st.pkgVersions, [["pkg", ["1.0.0", "1.1.0"]]]);
    assert.deepEqual(st.versionIndex.map(([k]) => k), ["pkg@1.0.0", "pkg@1.1.0"]);
    // a JSON round-trip only drops keys that were explicitly undefined, which JSON.stringify
    // drops from the output records too, so the written files are unaffected
    const rt = JSON.parse(JSON.stringify(st));
    assert.deepEqual(JSON.parse(JSON.stringify(rt)), rt, "survives a JSON round-trip unchanged");
    assert.deepEqual(rt.versionIndex, st.versionIndex);
    assert.deepEqual(rt.occ, st.occ);
    // TRIVIAL_NODES is NOT baked in: it is applied in finalize
    assert.equal("trivial" in st.uniq[0][1], false);
    // DEDUP_MODE / DEDUP_STRICT_TYPE ARE baked in (identity was computed here)
    assert.equal(st.mode, "normalized"); assert.equal(st.strictType, false);
    assert.equal(collect(inDir, { mode: "exact", log: () => {} }).uniq.length, 2, "exact identity is baked into the partial");
    // an empty package is allowed to produce an empty state, so it still counts as done
    mkdirSync(join(t.dir, "none"), { recursive: true });
    assert.throws(() => collect(join(t.dir, "none"), { log: () => {} }), /no \*\.functions\.json/);
    assert.deepEqual(collect(join(t.dir, "none"), { log: () => {}, allowEmpty: true }), emptyState());
  } finally { t.cleanup(); }
});

test("dedup == finalize(collect) == merge of per-package partials, byte for byte", () => {
  const t = tmp(); try {
    const inDir = join(t.dir, "in");
    const TRIV = { text: "{}", textNorm: "{}", hash: "t", metrics: { nodes: 2 } };
    writeJson(join(inDir, "pkg@1.0.0.functions.json"), file([fn(A), fn(TRIV)]));
    writeJson(join(inDir, "pkg@1.1.0.functions.json"), file([fn(A_RENAMED), fn(TRIV)]));
    writeJson(join(inDir, "pkg@1.2.0.functions.json"), file([fn(A_EDITED)]));
    writeJson(join(inDir, "pkg@1.10.0.functions.json"), file([fn(A), fn(A)]));
    writeJson(join(inDir, "pkg-extra@1.0.0.functions.json"), file([fn(A_RENAMED)]));
    writeJson(join(inDir, "@s+other@0.1.0.functions.json"), file([fn(A), fn(TRIV)]));

    const batchOut = join(t.dir, "batch"), oneShot = join(t.dir, "oneshot"), streamed = join(t.dir, "streamed");
    const sBatch = dedup(inDir, batchOut, { log: () => {} });
    finalize(collect(inDir, { log: () => {} }), oneShot, {});

    const states = splitByPackage(t, inDir).map((d) => roundTrip(collect(d, { log: () => {}, allowEmpty: true })));
    states.sort((a, b) => (a.firstFile < b.firstFile ? -1 : 1)); // the merge step's ordering rule
    const merged = mergeStates(states);
    assert.equal(merged.files, sBatch.files);
    assert.equal(merged.total, sBatch.function_instances);
    const sStream = finalize(merged, streamed, { extra: { streamed: true } });

    for (const f of ["unique_functions.jsonl", "occurrences.csv", "version_index.json"]) {
      assert.equal(read(join(oneShot, f)), read(join(batchOut, f)), `${f}: finalize(collect) == dedup`);
      assert.equal(read(join(streamed, f)), read(join(batchOut, f)), `${f}: merged partials == dedup`);
    }
    const strip = (s) => { const c = { ...s }; delete c.seconds; delete c.streamed; return c; };
    assert.deepEqual(strip(sStream), strip(sBatch), "summary.json matches apart from seconds/streamed");
    assert.equal(sStream.streamed, true);
    assert.ok(sStream.keyed_on.textNorm > 0, "keyed_on is recomputed in finalize from the records");
  } finally { t.cleanup(); }
});

test("mergeStates: first state wins first-seen fields, raw-variant counts sum in insertion order", () => {
  const t = tmp(); try {
    // same function id, different raw spellings: pkg-a sees it once, pkg-b twice ->
    // pkg-b's raw text must win the `text` field, and pkg-a's record must win the rest
    const a = join(t.dir, "a"), b = join(t.dir, "b"), out = join(t.dir, "out");
    writeJson(join(a, "a-pkg@1.0.0.functions.json"), file([fn({ ...A, loc: 11 })]));
    writeJson(join(b, "b-pkg@1.0.0.functions.json"), file([fn({ ...A_RENAMED, loc: 22 })]));
    writeJson(join(b, "b-pkg@1.1.0.functions.json"), file([fn({ ...A_RENAMED, loc: 22 })]));
    const sa = collect(a, { log: () => {} }), sb = collect(b, { log: () => {} });
    finalize(mergeStates([sa, sb]), out, {});
    const U = read(join(out, "unique_functions.jsonl")).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(U.length, 1);
    assert.equal(U[0].loc, 11, "first-seen fields come from the first state");
    assert.equal(U[0].text, A_RENAMED.text, "the most common raw variant wins, counts summed across states");
    assert.equal(U[0].raw_variants, 2);
    assert.equal(U[0].n_occurrences, 3);
    assert.deepEqual(Object.keys(U[0].packages), ["a-pkg", "b-pkg"]);
    // a tie is broken by first-insertion order, i.e. by the state order
    const out2 = join(t.dir, "out2");
    writeJson(join(b, "b-pkg@1.1.0.functions.json"), file([]));
    finalize(mergeStates([sa, collect(b, { log: () => {} })]), out2, {});
    const U2 = JSON.parse(read(join(out2, "unique_functions.jsonl")).trim().split("\n")[0]);
    assert.equal(U2.text, A.text, "1-1 tie goes to the variant inserted first");
  } finally { t.cleanup(); }
});

test("mergeStates refuses a stale state version", () => {
  assert.throws(() => mergeStates([{ ...emptyState(), stateVersion: 99 }]), /stateVersion/);
  assert.throws(() => mergeStates([]), /no states/);
});

// ------------------------------------------------- string-to-string comparison (--identity)
// Identity is normally decided by comparing the signature+body KEYS character by character
// (--identity string, the default). --identity hash compares their truncated sha256 instead.
// The two can only disagree if two different functions share a 24-char id, which `string` mode
// detects and refuses rather than merging away.

test("functionKey is the exact signature+body string, and identity is its truncated hash", () => {
  const k = functionKey(fn(A));
  assert.equal(k, signature(fn(A)) + "\0textNorm\0" + A.textNorm, "signature, body source tag, body text");
  assert.equal(identity(fn(A)), shortId(k));
  assert.equal(k, functionKey(fn(A_RENAMED)), "a local rename does not change the normalized key");
  assert.notEqual(k, functionKey(fn(A), "exact"), "exact mode keys on the raw text instead");
  assert.notEqual(functionKey(fn(A)), functionKey(fn({ ...A, async: true })), "the signature is part of the key");
  // nothing comparable: the key is per instance, so such functions never merge
  assert.notEqual(functionKey(fn({}), "normalized", false, "x@1#0"), functionKey(fn({}), "normalized", false, "x@1#1"));
  // a hash can never equal a literal body: the source tag keeps them apart
  assert.notEqual(functionKey(fn({ hashNorm: "deadbeef" })), functionKey(fn({ textNorm: "deadbeef" })));
});

test("string and hash comparison give the same output; string records the exact keys", () => {
  const t = tmp(); try {
    const inDir = join(t.dir, "in");
    const TRIV = { text: "{}", textNorm: "{}", hash: "t", metrics: { nodes: 2 } };
    writeJson(join(inDir, "pkg@1.0.0.functions.json"), file([fn(A), fn(TRIV), fn({ hashNorm: "hn1", hash: "z" })]));
    writeJson(join(inDir, "pkg@1.1.0.functions.json"), file([fn(A_RENAMED), fn(TRIV)]));
    writeJson(join(inDir, "pkg@1.2.0.functions.json"), file([fn(A_EDITED), fn({})]));
    writeJson(join(inDir, "other@2.0.0.functions.json"), file([fn(A)]));

    for (const mode of ["normalized", "exact"]) {
      const h = join(t.dir, `h-${mode}`), s = join(t.dir, `s-${mode}`);
      const sh = dedup(inDir, h, { mode, identity: "hash", log: () => {} });
      const ss = dedup(inDir, s, { mode, identity: "string", log: () => {} });
      for (const f of ["unique_functions.jsonl", "occurrences.csv", "version_index.json"])
        assert.equal(read(join(s, f)), read(join(h, f)), `${f} (${mode}): string comparison matches hash comparison`);
      assert.equal(ss.unique_functions, sh.unique_functions);
      assert.equal(sh.identity, "hash");
      assert.equal(ss.identity, "string", "summary.json records which comparison was used");
    }
    // the state carries one exact key per distinct function, which is what the merge compares
    const st = collect(inDir, { log: () => {} });
    assert.equal(st.identity, "string");
    assert.equal(st.keys.length, st.uniq.length);
    for (const [id, key] of st.keys) assert.equal(id, shortId(key), "each key is labelled by its own hash");
    assert.deepEqual(st.keys.map(([id]) => id).sort(), st.uniq.map(([id]) => id).sort());
  } finally { t.cleanup(); }
});

test("identity defaults to the string comparison everywhere", () => {
  const t = tmp(); try {
    const inDir = join(t.dir, "in");
    writeJson(join(inDir, "p@1.0.0.functions.json"), file([fn(A)]));
    assert.equal(collect(inDir, { log: () => {} }).identity, "string");
    assert.equal(dedup(inDir, join(t.dir, "o"), { log: () => {} }).identity, "string");
    const cli = runNode(join(TIER2, "05_dedup-functions.mjs"), [inDir, join(t.dir, "o2")]);
    assert.equal(cli.code, 0, cli.stdout);
    assert.equal(JSON.parse(read(join(t.dir, "o2", "summary.json"))).identity, "string");
    const bad = runNode(join(TIER2, "05_dedup-functions.mjs"), [inDir, join(t.dir, "o3"), "--identity", "fuzzy"]);
    assert.notEqual(bad.code, 0, "an unknown comparison is rejected");
    assert.throws(() => collect(inDir, { log: () => {}, identity: "fuzzy" }), /identity must be/);
  } finally { t.cleanup(); }
});

test("string comparison refuses an id collision instead of merging two different functions", () => {
  // Two states whose SAME id stands for two DIFFERENT keys is exactly what a truncated-hash
  // collision looks like across packages. The string comparison must refuse it, not merge it.
  const mk = (key) => ({ ...emptyState({ identity: "string" }), firstFile: "x@1.0.0.functions.json", keys: [["aaaaaaaaaaaaaaaaaaaaaaaa", key]] });
  assert.throws(() => mergeStates([mk("one"), mk("two")]), /id collision across packages/);
  assert.doesNotThrow(() => mergeStates([mk("same"), mk("same")]), "the same key under the same id is just a match");
  // hash-mode partials carry no key table, so there is nothing to check
  assert.doesNotThrow(() => mergeStates([emptyState({ identity: "hash" }), emptyState({ identity: "hash" })]));
  // mixing the two comparisons in one merge is refused
  assert.throws(() => mergeStates([emptyState({ identity: "string" }), emptyState({ identity: "hash" })]), /disagree on identity settings/);
});
