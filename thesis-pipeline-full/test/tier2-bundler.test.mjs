import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmp, writeText, hasModule } from "./helpers.mjs";

// The vendored §3.3 bundler imports @swc/core + meriyah/acorn/astring at module load.
const DEPS_OK = (await Promise.all(["@swc/core", "meriyah", "acorn-walk", "astring", "acorn-loose"].map(hasModule))).every(Boolean);
const skip = DEPS_OK ? false : "bundler deps not installed (run npm install)";
const B = DEPS_OK ? await import("../tier2/lib/aletheia-bundler.mjs") : null;

test("rewriteImports keeps exported declarations (Fix B), not delete them", { skip }, () => {
  const out = B.rewriteImports("export function bigFunction(){ return 1 + 2; }\n");
  assert.ok(out.includes("function bigFunction"), "function survives");
  assert.ok(!/^\s*export\s/.test(out), "export keyword stripped");
});

test("rewriteImports: export default -> var _$__default", { skip }, () => {
  const out = B.rewriteImports("export default 5;\n");
  assert.ok(out.includes("_$__default"), out);
});

test("rewriteImports: import -> require (dependency code not inlined)", { skip }, () => {
  const out = B.rewriteImports('import { x } from "somedep";\nx();\n');
  assert.ok(out.includes('require("somedep")') || out.includes("require('somedep')"), out);
});

test("wrapJson wraps JSON as a parenthesised expression", { skip }, () => {
  assert.equal(B.wrapJson('{"a":1}'), '({"a":1})');
  assert.equal(B.wrapJson('﻿{"a":1}'), '({"a":1})'); // strips BOM
});

test("readDir produces a module([ ... ]) with the entry wrapped", { skip }, async () => {
  const t = tmp(); try {
    const pkg = join(t.dir, "pkg");
    writeText(join(pkg, "package.json"), JSON.stringify({ name: "fx", version: "1.0.0", module: "index.js" }));
    writeText(join(pkg, "index.js"), "export function keepMe(){ return 7; }\nexport default 1;\n");
    const r = await B.readDir(pkg, { encoding: "utf8" });
    assert.ok(r.content.startsWith("module(["), "module wrapper");
    assert.ok(r.content.includes("(function(_$__e){"), "per-file module function wrapper");
    assert.ok(r.content.includes("function keepMe"), "exported function kept in bundle");
  } finally { t.cleanup(); }
});
