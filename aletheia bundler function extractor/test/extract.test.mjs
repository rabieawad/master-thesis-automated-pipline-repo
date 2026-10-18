import test from "node:test";
import assert from "node:assert/strict";
import * as acorn from "acorn";
import * as walk from "acorn-walk";
import { extractFunctions } from "../src/extract-functions.mjs";

const all = (code, o = {}) => extractFunctions(code, { minLoc: 0, verify: true, ...o });

test("DEBUN paper example splits into two functions", () => {
    const { records } = all("function f(x) { var y = x.p; return () => y; }");
    assert.equal(records.length, 2);
    assert.equal(records[0].text, "function f(x) {\n  var y = x.p;\n  return;\n}");
    assert.equal(records[1].text, "() => y");
    assert.equal(records[1].parent, records[0].id);
    assert.deepEqual(records[0].inner, [records[1].id]);
});

test("every function node appears exactly once and parses on its own", () => {
    const code = `function _h(a){return a}module([function(_$__e){
      var o={m(a){return function(){return a}}, get g(){return 1}};
      class A extends B{constructor(){super()} static z(){return ()=>1}}
      _$__e.f=function(){return [function(){},1].map(function(i){return i})};
    }]);`;
    const { records, stats } = all(code);
    const want = new Set();
    walk.full(acorn.parse(code, { ecmaVersion: "latest" }), (n) => {
        if (/^(Function|ArrowFunction)/.test(n.type)) want.add(`${n.start}:${n.end}`);
    });
    assert.deepEqual(new Set(records.filter((r) => r.id !== "top").map((r) => `${r.start}:${r.end}`)), want);
    assert.equal(stats.invalid, 0);
});

test("module wrappers get a file index; code outside them is marked outside", () => {
    const { records } = all("function _h(a){return a}module([function(_$__e){},function(_$__e){_$__e.x=function(){}}]);");
    assert.deepEqual(records.filter((r) => r.kind === "module").map((r) => r.file), [0, 1]);
    assert.equal(records.find((r) => r.name === "_h").outside, true);
    const dropped = extractFunctions("function _h(a){return a}module([function(_$__e){}]);", { minLoc: 0, dropHelpers: true });
    assert.deepEqual(dropped.records.map((r) => r.kind), ["module"]);
});

test("min-loc drops small functions but still collects their inner functions", () => {
    const code = "function big(){var a=1;var b=2;var c=3;var d=4;return function(){return a}}";
    const { records } = extractFunctions(code, { minLoc: 6 });
    assert.equal(records.length, 1);
    assert.equal(records[0].name, "big");
});
