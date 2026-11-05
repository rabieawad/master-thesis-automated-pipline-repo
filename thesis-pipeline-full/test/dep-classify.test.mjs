import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDep, splitDeps, likelyPreBundled, estimateLanded } from "../tier1/lib/dep-classify.mjs";

test("classifyDep: build tooling", () => {
  for (const n of ["@babel/core", "@babel/preset-env", "rollup", "@rollup/plugin-babel", "webpack", "esbuild", "terser", "@swc/core", "vite", "eslint", "jest", "typescript", "postcss", "uglify-js", "rollup-plugin-license"])
    assert.equal(classifyDep(n), "tooling", `${n} should be tooling`);
});

test("classifyDep: @types are type-only", () => {
  for (const n of ["@types/node", "@types/react", "@types/howler"]) assert.equal(classifyDep(n), "types");
});

test("classifyDep: real runtime libs (incl. polyfills that DO land)", () => {
  for (const n of ["preact", "react", "lodash", "tslib", "@swc/helpers", "core-js", "regenerator-runtime", "ms", "debug"])
    assert.equal(classifyDep(n), "runtime", `${n} should be runtime`);
});

test("splitDeps buckets correctly", () => {
  const { tooling, types, runtime } = splitDeps(["@babel/core", "@types/node", "preact", "rollup", "lodash"]);
  assert.deepEqual(tooling.sort(), ["@babel/core", "rollup"]);
  assert.deepEqual(types, ["@types/node"]);
  assert.deepEqual(runtime.sort(), ["lodash", "preact"]);
});

test("likelyPreBundled: few big files + declared deps => true; tiny wrapper => false", () => {
  assert.equal(likelyPreBundled(4, 6, 2_000_000), true);            // one huge dist file
  assert.equal(likelyPreBundled(5, 8, 16_000), false);              // side-channel-like tiny wrapper
  assert.equal(likelyPreBundled(0, 6, 2_000_000), false);           // no runtime deps -> never
  assert.equal(likelyPreBundled(4, null, null), false);             // unknown stats -> don't guess
});

test("estimateLanded: ga4mp (all build tools) => 0", () => {
  const ga4mp = ["@babel/core", "@babel/preset-env", "@rollup/plugin-babel", "rollup", "rollup-plugin-license"];
  const e = estimateLanded({ declaredDeps: ga4mp, fileCount: 12, unpackedSize: 80_000 });
  assert.equal(e.runtimeDepCount, 0);
  assert.equal(e.estimatedLandedCount, 0);
  assert.equal(e.likelyPreBundled, false);
});

test("estimateLanded: normal package keeps runtime deps", () => {
  const e = estimateLanded({ declaredDeps: ["preact", "htm", "@types/node"], fileCount: 30, unpackedSize: 50_000 });
  assert.equal(e.runtimeDepCount, 2);
  assert.equal(e.estimatedLandedCount, 2);
  assert.deepEqual(e.runtime.sort(), ["htm", "preact"]);
});

test("estimateLanded: pre-bundled package => 0 landed despite runtime deps", () => {
  const e = estimateLanded({ declaredDeps: ["hls.js", "dashjs", "lodash", "classnames"], fileCount: 6, unpackedSize: 2_000_000 });
  assert.equal(e.runtimeDepCount, 4);
  assert.equal(e.likelyPreBundled, true);
  assert.equal(e.estimatedLandedCount, 0);
});
