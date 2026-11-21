// Tier 2: KEEP_EXPORTS (not in the original Aletheia) keeps exported code; off, the original drops it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { keepExport } from "../tier2/lib/aletheia-bundler.mjs";
import { parseLoose } from "../tier2/lib/parse-utils.mjs";

const one = (code) => { const ast = parseLoose(code); return keepExport(ast.body.find((n) => /Export/.test(n.type)), code); };

test("keepExport: declarations stay and are reachable through _$__e.exports", () => {
  assert.equal(one(`export function foo(a){return a}`), `function foo(a){return a};_$__e.exports["foo"]=foo;`);
  assert.equal(one(`export const a = 1, {b, c: [d]} = x;`), `const a = 1, {b, c: [d]} = x;;_$__e.exports["a"]=a;_$__e.exports["b"]=b;_$__e.exports["d"]=d;`);
  assert.equal(one(`export default class K {}`), `class K {};_$__e.exports["default"]=K;`);
  assert.equal(one(`export default (x) => x * 2;`), `_$__e.exports["default"]=((x) => x * 2);`);
  assert.equal(one(`const l = 1; export { l as m };`), `_$__e.exports["m"]=l;`);
  assert.equal(one(`export { q } from "./q";`), `_$__e.exports["q"]=require("./q")["q"];`);
  assert.equal(one(`export * from "./all";`), `require("./all");`);
});

test("the faithful default (KEEP_EXPORTS unset) still drops export statements", async () => {
  const { rewriteImports, KEEP_EXPORTS } = await import("../tier2/lib/aletheia-bundler.mjs");
  assert.equal(KEEP_EXPORTS, false);
  assert.equal(rewriteImports(`export function foo(){return 1} var x = 2;`).trim(), `var x = 2;`);
});
