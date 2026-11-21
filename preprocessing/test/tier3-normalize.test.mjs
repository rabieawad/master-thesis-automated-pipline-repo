// Tier 3 · step 00: bundles put through Aletheia's swc call before matching.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as swc from "@swc/core";
import { aletheiaSwc, normalizeBundle, injectedHelpersEnd, ALETHEIA_SWC_OPTIONS } from "../tier3/00_normalize-bundles.mjs";
import { minify } from "../tier2/lib/aletheia-bundler.mjs";
import { extractWithFeatures } from "../tier1/06-extract-functions.mjs";
import * as T3 from "../tier3/lib-pipeline-3.mjs";

const SRC = "module([function(_$__e){var x=function(a,b){if(a){return b+1}else{return b-1}};const f=(q)=>q.map(v=>v*2);class K{m(){return 1}}_$__e.exports={x,f,K}}])";

test("the transform is exactly Aletheia's swc call (tier2 minify), ES5 included", async () => {
  assert.deepEqual(ALETHEIA_SWC_OPTIONS, { jsc: { minify: { compress: { unsafe: true } } }, minify: true, isModule: "unknown" });
  const { code } = await aletheiaSwc(SRC);
  assert.equal(code, await minify(SRC));
  assert.ok(!code.includes("=>") && !/\bclass\s+K\b/.test(code), "arrows and classes are downlevelled");
});

test("the helpers swc injects are found and their functions dropped; the bundle's own code stays", async () => {
  const out = await normalizeBundle(SRC, null, "swc");
  assert.ok(out.injectedEnd > 0 && out.code.startsWith("function _class_call_check"));
  const all = extractWithFeatures(out.code, { minLoc: 0 }).records;
  const kept = all.filter((r) => !(r.start < out.injectedEnd));
  assert.ok(kept.length < all.length);
  assert.ok(kept.every((r) => !/Cannot call a class as a function/.test(r.text)), "no helper left");
  assert.ok(kept.some((r) => /2 \* v|v \* 2/.test(r.text)), "the bundle's own arrow function is kept");
  // a bundle that declares a helper name itself is not cut
  assert.equal(injectedHelpersEnd("function _foo(){}x();", "function _foo(){}x();"), 0);
  assert.equal(injectedHelpersEnd("var a=1;", "var a=1;"), 0);
});

test("the source map is composed with the bundle's own map, so functions still lead to their source file", async () => {
  const orig = "const lib = (a) => a.map((x) => x + 1);\nexport default lib;\n";
  const first = await swc.transform(orig, { filename: "node_modules/.pnpm/lib@1.2.3/node_modules/lib/index.js", sourceMaps: true, minify: true, jsc: { target: "es2020", minify: { mangle: true } } });
  const out = await normalizeBundle(first.code + "\n//# sourceMappingURL=x.map", first.map, "swc");
  assert.ok(out.map && out.map.sources.some((s) => s.includes("lib@1.2.3")), "the composed map points at the original file");
  assert.ok(!out.code.includes("sourceMappingURL=x.map"));
});

test("pipeline: step 00 only when normalisation is on, and step 02 then reads its output", () => {
  assert.deepEqual(T3.stepIdsFor({}), ["01", "02", "03"]);
  assert.deepEqual(T3.stepIdsFor({ NORMALIZE: "off" }), ["01", "02", "03"]);
  assert.deepEqual(T3.stepIdsFor({ NORMALIZE: "swc" }), ["00", "01", "02", "03"]);
  assert.deepEqual(T3.stepIdsFor({ NORMALIZE: "swc+modules", DEPENDENCIES: "1" }), ["00", "01", "01b", "02", "03"]);
  const m = { ...T3.DEFAULTS, NORMALIZE: "swc+modules", CANONICAL_REQUIRE: "1", DEP_CONFIRM: "1", MIN_UNIQUE: "1", MIN_EXACT: "2", DEP_RANGES: "override", outDir: "/tmp/t3-pipe-test", TIER1_OUTPUT: "/tmp/t1", TIER2_OUTPUT: "/tmp/t2" };
  assert.ok(T3.buildCommand("00", m).args.includes("--modules"));
  assert.ok(T3.buildCommand("01", m).args.includes("--canonical-require"));
  assert.ok(T3.buildCommand("01b", m).args[0].endsWith("01b_dependencies.mjs"));
  const om = T3.detectOptions(m);
  assert.equal(om.depConfirm, true); assert.equal(om.depFromConfirmed, true); assert.equal(om.minUnique, 1); assert.equal(om.minExact, 2); assert.equal(om.depRanges, "override");
  const p = { ...T3.DEFAULTS, NORMALIZE: "swc", ALGORITHM: "independent", SIZE_AWARE: "1", MIN_VERSION_SHARE: "0.1", outDir: "/tmp/t3-pipe-test", TIER1_OUTPUT: "/tmp/t1", TIER2_OUTPUT: "/tmp/t2" };
  const c2 = T3.buildCommand("02", p).args;
  assert.equal(c2[c2.indexOf("--functions") + 1], "/tmp/t3-pipe-test/00_normalized/functions");
  assert.equal(c2[c2.indexOf("--bundles") + 1], "/tmp/t3-pipe-test/00_normalized/bundles");
  assert.deepEqual(JSON.parse(c2[c2.indexOf("--opts") + 1]), { ...T3.detectOptions(p) });
  assert.equal(T3.detectOptions(p).algorithm, "independent"); assert.equal(T3.detectOptions(p).sizeAware, true); assert.equal(T3.detectOptions(p).minVersionShare, 0.1);
  const c0 = T3.buildCommand("00", p).args;
  assert.ok(c0[0].endsWith("00_normalize-bundles.mjs") && c0.includes("/tmp/t1/05_selected_bundles/bundles"));
  const off = T3.buildCommand("02", { ...p, NORMALIZE: "off" }).args;
  assert.equal(off[off.indexOf("--functions") + 1], "/tmp/t1/06_extracted_functions");
});

// ---------------------------------------------------------------- module wrappers, canonical require
import { rewriteWrapper, canonicalRequire, isModuleWrapper } from "../tier3/lib/modules.mjs";

test("a webpack module wrapper becomes Aletheia's wrapper: same fingerprint text once require is canonical", async () => {
  const re = rewriteWrapper(`function(e,t,r){"use strict";var n=r(656);if(n)try{n([],"length")}catch(e){n=null}e.exports=n}`);
  assert.equal(re, `(function(_$__e){"use strict";var n=require(656);if(n)try{n([],"length")}catch(e){n=null}module.exports=n})`);
  const bundle = extractWithFeatures(re, { minLoc: 0 }).records.find((x) => x.depth === 0);
  const ref = extractWithFeatures(await minify(`module([function(_$__e){'use strict';var $g=require('./gOPD');if($g){try{$g([],'length')}catch(e){$g=null}}module.exports=$g;}])`), { minLoc: 0 }).records.find((x) => x.params.count === 1);
  assert.equal(canonicalRequire(bundle.textNorm), canonicalRequire(ref.textNorm));
  assert.equal(bundle.params.count, ref.params.count);
});

test("module wrapper rewrite: shadowing, property names and shorthand are respected; odd shapes are left alone", () => {
  const re = rewriteWrapper(`function(e,t,n){var a={e:1,t};function f(e){return e.t}t.x=a.e;n.d(t,{});e.exports=f}`);
  assert.equal(re, `(function(_$__e){var a={e:1,t: exports};function f(e){return e.t}exports.x=a.e;require.d(exports,{});module.exports=f})`);
  assert.equal(rewriteWrapper(`function(e,t,r){return module}`), null, "the body already uses a free target name");
  assert.equal(rewriteWrapper(`function({a}){}`), null);
  assert.ok(isModuleWrapper({ context: "property", propName: "656", params: { count: 3 } }));
  assert.ok(!isModuleWrapper({ context: "property", propName: "foo", params: { count: 3 } }));
  assert.equal(canonicalRequire(`var a = require('./x'), b = require(12), c = require("y");`), `var a = require(0), b = require(0), c = require(0);`);
});
