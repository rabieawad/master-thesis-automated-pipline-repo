import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmp, writeText, read, parseCsv, runNode, hasModule, TIER1, TIER2 } from "./helpers.mjs";

const DEPS_OK = (await Promise.all(["meriyah", "escodegen"].map(hasModule))).every(Boolean);
const skip = DEPS_OK ? false : "function-collector deps (meriyah/escodegen) not installed";

const SMALL = "function small(){ return 1; }";
const BIG = "function big(){\n  let a = 1;\n  let b = 2;\n  let c = 3;\n  let d = 4;\n  let e = 5;\n  let f = 6;\n  let g = 7;\n  let h = 8;\n  return a + b + c + d + e + f + g + h;\n}";

test("tier2 step 04: extracts functions; --min-loc filters out short ones", { skip }, () => {
  const t = tmp(); try {
    const bundles = join(t.dir, "bundles");
    writeText(join(bundles, "fx@1.0.0.js"), `module([(function(_$__e){\n${SMALL}\n${BIG}\n})])`);
    const all = runNode(join(TIER2, "04_extract-functions.mjs"), [bundles, join(t.dir, "o0"), "--min-loc", "0"]);
    assert.equal(all.code, 0, all.stdout);
    const s0 = parseCsv(read(join(t.dir, "o0", "summary.csv")))[0];
    assert.ok(Number(s0.functions_kept) >= 2, `kept ${s0.functions_kept} with min-loc 0`);
    const filt = runNode(join(TIER2, "04_extract-functions.mjs"), [bundles, join(t.dir, "o8"), "--min-loc", "8"]);
    assert.equal(filt.code, 0, filt.stdout);
    const s8 = parseCsv(read(join(t.dir, "o8", "summary.csv")))[0];
    assert.ok(Number(s8.functions_kept) < Number(s0.functions_kept), `min-loc 8 keeps fewer (${s8.functions_kept} < ${s0.functions_kept})`);
  } finally { t.cleanup(); }
});

test("tier1 step 06: extracts functions from a bundle; --min-loc filters", { skip }, () => {
  const t = tmp(); try {
    const bundles = join(t.dir, "bundles");
    // tier1 bundles are plain JS (webpack output); collector measures LOC directly when no .map
    writeText(join(bundles, "fx@1.0.0.min.js"), `${SMALL}\n${BIG}\n`);
    const all = runNode(join(TIER1, "06-extract-functions.mjs"), [bundles, join(t.dir, "o0"), "--min-loc", "0"]);
    assert.equal(all.code, 0, all.stdout);
    const s0 = parseCsv(read(join(t.dir, "o0", "summary.csv")))[0];
    assert.ok(Number(s0.functions_kept) >= 2, `kept ${s0.functions_kept}`);
    const filt = runNode(join(TIER1, "06-extract-functions.mjs"), [bundles, join(t.dir, "o6"), "--min-loc", "6"]);
    assert.equal(filt.code, 0, filt.stdout);
    const s6 = parseCsv(read(join(t.dir, "o6", "summary.csv")))[0];
    assert.ok(Number(s6.functions_kept) <= Number(s0.functions_kept));
  } finally { t.cleanup(); }
});
