import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmp, writeText, hasModule } from "./helpers.mjs";

// The vendored §3.3 bundler imports @swc/core + meriyah/acorn/astring at module load.
const DEPS_OK = (await Promise.all(["@swc/core", "meriyah", "acorn-walk", "astring", "acorn-loose"].map(hasModule))).every(Boolean);
const skip = DEPS_OK ? false : "bundler deps not installed (run npm install)";
const B = DEPS_OK ? await import("../tier2/lib/aletheia-bundler.mjs") : null;

test("rewriteImports deletes export statements wholesale (faithful to the original)", { skip }, () => {
  // The original aletheia-preprocessor removes the entire export statement, declaration and all.
  const out = B.rewriteImports("function bigFunction(){ return 1 + 2; }\nexport { bigFunction };\n");
  assert.ok(out.includes("function bigFunction"), "a plain (non-export) declaration survives");
  assert.ok(!/export/.test(out), "the export statement is removed");
});

test("rewriteImports deletes export default (faithful to the original)", { skip }, () => {
  const out = B.rewriteImports("export default 5;\n");
  assert.ok(!out.includes("_$__default"), "the original deletes export default rather than rewriting it");
  assert.ok(!/export/.test(out), out);
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
    writeText(join(pkg, "index.js"), "function keepMe(){ return 7; }\nexport { keepMe };\nexport default 1;\n");
    const r = await B.readDir(pkg, { encoding: "utf8" });
    assert.ok(r.content.startsWith("module(["), "module wrapper");
    assert.ok(r.content.includes("(function(_$__e){"), "per-file module function wrapper");
    assert.ok(r.content.includes("function keepMe"), "non-export declaration survives");
    assert.ok(!/export/.test(r.content), "export statements deleted (faithful to the original)");
  } finally { t.cleanup(); }
});
