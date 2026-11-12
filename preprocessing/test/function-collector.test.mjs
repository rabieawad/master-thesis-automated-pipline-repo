import { test } from "node:test";
import assert from "node:assert/strict";
import { hasModule } from "./helpers.mjs";

const DEPS_OK = (await Promise.all(["meriyah", "escodegen", "acorn-loose"].map(hasModule))).every(Boolean);
const skip = DEPS_OK ? false : "collector deps not installed";
const C = DEPS_OK ? await import("../tier2/lib/function-collector.mjs") : null;

test("normal bundle: extracts functions", { skip }, () => {
  const r = C.extractFunctions("module([(function(_$__e){ function f(){ return 1 + 2; } })])");
  assert.ok(r.stats.total >= 1 && r.functions.length >= 1);
});

test("modern JS meriyah may reject is handled (private fields, optional chaining, import.meta)", { skip }, () => {
  const code = "module([(function(_$__e){ class A { #x = 1; getX(){ return this.#x; } } const u = globalThis?.location?.href; function g(){ return A; } })])";
  const r = C.extractFunctions(code); // must not throw
  assert.ok(r.stats.total >= 1, "found functions via tolerant parse");
});

test("non-JS content (CSS that slipped into a bundle) does not throw — best-effort, ~0 functions", { skip }, () => {
  const css = "module([(function(_$__e){ .pswp { color: #000; font-family: 'X'; --y: 1px; } })])";
  const r = C.extractFunctions(css); // acorn-loose recovers; no hard failure
  assert.ok(r && r.stats && typeof r.stats.total === "number");
});

test("stray shebang / '#' mid-bundle does not fail the whole bundle", { skip }, () => {
  const code = "module([(function(_$__e){\n#!/usr/bin/env node\nfunction ok(){ return 42; }\n})])";
  const r = C.extractFunctions(code);
  assert.ok(r.stats.total >= 1);
});
