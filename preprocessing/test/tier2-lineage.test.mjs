import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { analyzePackage, matchVariants, diffTokens, editKind, tokens, mask, markerSpace, hasMarker } from "../tier2/lib/lineage.mjs";

const STEP = join(dirname(fileURLToPath(import.meta.url)), "..", "tier2", "08_link-edits.mjs");
const fn = (id, textNorm, versions, extra = {}) => ({
  id, signature: "function|BlockStatement|false|false|1|false|0|false", textNorm, text: textNorm,
  strings: [], properties: [], globals: [], trivial: false,
  occurrences: Object.fromEntries(versions.map(([v, p]) => [v, [p]])), first: versions[0][0], ...extra,
});
const V = ["1.0.0", "1.1.0", "1.2.0", "2.0.0", "2.1.0", "3.0.0"];
// a package with a known history:
//   "keep"   unchanged in every version (an anchor)
//   b1 → b2  1.1.0: a call is ADDED          b2 → b3  1.2.0: toLowerCase REPLACED by toUpperCase
//   b3 → b2  2.0.0: REVERTED back to b2       b2 stays until 2.1.0, then the function is REMOVED
//   "gap"    present in 1.0.0–1.1.0, absent in 1.2.0, back in 2.0.0 (REAPPEARED), to the end
//   "other"  unrelated new code in 2.0.0, must not be linked to anything
const DOC = {
  package: "demo", versions: V, settings: {}, summary: {},
  functions: [
    fn("keep", "{ return v0.map(function (v1) { return v1 * 2; }); }", V.map((v) => [v, 0])),
    fn("b1", "{ if (v0) { return v0.trim().toLowerCase(); } return ''; }", [["1.0.0", 1]]),
    fn("b2", "{ if (v0) { v1(v0); return v0.trim().toLowerCase(); } return ''; }", [["1.1.0", 1], ["2.0.0", 1], ["2.1.0", 1]]),
    fn("b3", "{ if (v0) { v1(v0); return v0.trim().toUpperCase(); } return ''; }", [["1.2.0", 1]]),
    fn("gap", "{ throw new Error('legacy api ' + v0 + ' is going away soon'); }", [["1.0.0", 2], ["1.1.0", 2], ["2.0.0", 2], ["2.1.0", 2], ["3.0.0", 2]]),
    fn("other", "{ var v0 = new Map(); for (var v1 in v2) v0.set(v1, v2[v1]); return v0; }", [["2.0.0", 3]]),
    fn("tiny1", "{ return v0; }", [["1.0.0", 4]], { trivial: true }),
    fn("tiny2", "{ return v1; }", [["1.1.0", 4]], { trivial: true }),
  ],
  version_index: {},
};
const k = (a, b) => editKind(diffTokens(tokens(a).map(mask), tokens(b).map(mask))).kind;

test("edit kinds: one kind, or a combination", () => {
  assert.equal(k("{ f(v0); }", "{ f(v0); g(v0); }"), "added");
  assert.equal(k("{ f(v0); g(v0); }", "{ f(v0); }"), "removed");
  assert.equal(k("{ return v0.toLowerCase(); }", "{ return v0.toUpperCase(); }"), "replaced");
  assert.equal(k("{ a(v0); b(v0); }", "{ c(v0); b(v0); d(v0); }"), "mixed");
  assert.equal(k("{ v0(v1, v2); }", "{ v0(v2, v1); }"), "variables_only", "only the numbering differs");
  assert.deepEqual(editKind(diffTokens(tokens("{ a(v0); b(v0); }").map(mask), tokens("{ c(v0); b(v0); d(v0); }").map(mask))).parts, { added: 1, removed: 0, replaced: 1 });
  assert.equal(editKind(null).kind, "too_large");
});

test("history: born, edited, reverted, removed and reappeared, in version order", () => {
  const r = analyzePackage(DOC);
  const L = r.lineages.find((l) => l.lineage === "b1");
  assert.deepEqual(L.variants.map((v) => v.id), ["b1", "b2", "b3"]);
  assert.equal(L.born, "1.0.0"); assert.equal(L.last_seen, "2.1.0"); assert.equal(L.status, "removed");
  assert.deepEqual(L.events.map((e) => [e.version, e.type, e.kind ?? ""]), [
    ["1.0.0", "born", ""], ["1.1.0", "edited", "added"], ["1.2.0", "edited", "replaced"], ["2.0.0", "reverted", "replaced"], ["3.0.0", "removed", ""]]);
  assert.deepEqual(L.events[2].changes, [{ type: "replaced", before: "toLowerCase", after: "toUpperCase", context: "v0 . trim ( ) ." .split(" ").slice(-3).join(" ") }]);
  const G = r.lineages.find((l) => l.lineage === "gap");
  assert.deepEqual(G.events.map((e) => [e.version, e.type]), [["1.0.0", "born"], ["1.2.0", "removed"], ["2.0.0", "reappeared"]]);
  assert.equal(G.status, "alive");
  assert.equal(r.index.other, "other", "unrelated new code is not linked");
  assert.equal(r.index.b3, "b1"); assert.equal(r.index.tiny2, "tiny2", "trivial functions are not linked by default");
  assert.equal(analyzePackage(DOC, { includeTrivial: true }).index.tiny2, "tiny1");
});

test("markers are checked facts, and every variant gets a rule that tells it apart", () => {
  const L = analyzePackage(DOC).lineages.find((l) => l.lineage === "b1");
  for (const m of L.markers) {
    for (const v of L.variants) {
      const code = DOC.functions.find((f) => f.id === v.id).textNorm;
      assert.equal(hasMarker(markerSpace(code), m.code), m.variants.includes(v.id), `${m.code} on ${v.id}`);
    }
  }
  const upper = L.markers.find((m) => m.code.includes("toUpperCase"));
  assert.deepEqual(upper.variants, ["b3"]); assert.deepEqual(upper.present, [["1.2.0", "1.2.0"]]);
  assert.deepEqual(upper.absent, [["1.0.0", "1.1.0"], ["2.0.0", "2.1.0"]], "absent where the lineage exists without it");
  for (const v of L.variants) assert.equal(L.identify[v.id].unique, true, v.id);
  assert.ok(L.identify.b3.contains.some((c) => c.includes("toUpperCase")));
  assert.ok(L.identify.b1.contains.length + L.identify.b1.lacks.length >= 1, "b1 has a rule: what it contains or lacks");
});

test("the matcher finds the right variant and versions from code alone, also when it is not exact", () => {
  const L = analyzePackage(DOC).lineages.find((l) => l.lineage === "b1");
  for (const f of DOC.functions.filter((x) => ["b1", "b2", "b3"].includes(x.id))) assert.deepEqual(matchVariants(L, f.textNorm).exact, [f.id]);
  // different local numbering: the same variant
  assert.deepEqual(matchVariants(L, "{ if (v5) { v9(v5); return v5.trim().toUpperCase(); } return ''; }").exact, ["b3"]);
  // close but not identical code: no exact match, b3 ranked first
  const r = matchVariants(L, "{ if (v0) { v1(v0); log(v0); return v0.trim().toUpperCase(); } return ''; }");
  assert.equal(r.ranked[0].id, "b3");
});

test("the step writes lineages/<pkg>.json, keeps only the tag in the package file, is resumable, and tags the merged file", () => {
  const dir = mkdtempSync(join(tmpdir(), "lin-")); try {
    const D5 = join(dir, "05"); mkdirSync(join(D5, "packages"), { recursive: true });
    // as an earlier version of the step left it: edit + lineage_info in the package file
    const old = JSON.parse(JSON.stringify(DOC)); old.functions[2].edit = { kind: "added" }; old.functions[2].lineage = "x"; old.lineage_info = {};
    writeFileSync(join(D5, "packages", "demo.json"), JSON.stringify(old, null, 1));
    const line = (id, extra) => JSON.stringify({ id, text: "x", packages: { demo: { n_versions: 1 }, ...extra } });
    writeFileSync(join(D5, "unique_functions.jsonl"), line("b3", { other: { n_versions: 1 } }) + "\n" + line("keep") + "\n");
    let r = spawnSync(process.execPath, [STEP, D5], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const doc = JSON.parse(readFileSync(join(D5, "packages", "demo.json"), "utf8"));
    assert.equal(doc.lineage_info, undefined); assert.ok(doc.functions.every((f) => f.edit === undefined), "edit records moved out");
    assert.equal(doc.functions.find((f) => f.id === "b3").lineage, "b1");
    const strip = JSON.parse(JSON.stringify(doc)); for (const f of strip.functions) delete f.lineage;
    assert.equal(JSON.stringify(strip, null, 1), JSON.stringify(DOC, null, 1), "apart from the tag the package file is as before");
    const lin = JSON.parse(readFileSync(join(D5, "lineages", "demo.json"), "utf8"));
    assert.equal(lin.function_index.b3, "b1"); assert.equal(lin.lineages.find((l) => l.lineage === "b1").events.length, 5);
    assert.equal(lin.source.file, "packages/demo.json");
    const merged = readFileSync(join(D5, "unique_functions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(merged[0].packages.demo.lineage, "b1"); assert.equal(merged[0].packages.other.lineage, undefined);
    r = spawnSync(process.execPath, [STEP, D5], { encoding: "utf8" });
    assert.match(r.stdout, /0 linked now, 1 already linked/);
    r = spawnSync(process.execPath, [STEP, D5, "--min-similarity", "0.99"], { encoding: "utf8" });
    assert.match(r.stdout, /1 linked now/);
    assert.equal(JSON.parse(readFileSync(join(D5, "lineages", "demo.json"), "utf8")).summary.edited_lineages, 0, "other settings recompute");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
