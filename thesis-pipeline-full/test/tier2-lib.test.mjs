import { test } from "node:test";
import assert from "node:assert/strict";
import { basename, join } from "node:path";
import { writeFileSync } from "node:fs";
import * as T2 from "../tier2/lib-pipeline-2.mjs";
import { tmp } from "./helpers.mjs";

const base = (args) => args.map((a) => basename(String(a)));
const scriptOf = (b) => base(b.args).find((a) => a.endsWith(".mjs"));
const flag = (b, f) => { const i = b.args.indexOf(f); return i >= 0 ? String(b.args[i + 1]) : undefined; };

test("PARAMS include SAMPLE_STRATEGY (default minor-window) and sampling knobs", () => {
  const by = Object.fromEntries(T2.PARAMS.map((p) => [p.key, p]));
  assert.equal(by.SAMPLE_STRATEGY.default, "minor-window");
  assert.deepEqual(by.SAMPLE_STRATEGY.options, ["minor-window", "minor-adjacent"]);
  assert.ok(by.PER_MINOR_N && by.SAMPLE_THRESHOLD && by.SEED);
});

test("stepDirs maps 01..04", () => {
  const t = tmp(); try {
    const sd = T2.stepDirs(t.dir);
    assert.ok(sd["01"][0].endsWith("01_reference_list"));
    assert.ok(sd["04"][0].endsWith("04_extracted_functions"));
  } finally { t.cleanup(); }
});

test("buildCommand 01 passes versions + sampling + strategy flags", () => {
  const t = tmp(); try {
    const p = { ...Object.fromEntries(T2.PARAMS.map((x) => [x.key, x.default])), outDir: t.dir, INPUT_DIR: t.dir, VERSIONS: "sample" };
    const b = T2.buildCommand("01", p);
    assert.equal(scriptOf(b), "01_build-list.mjs");
    assert.equal(flag(b, "--versions"), "sample");
    assert.equal(flag(b, "--sample-strategy"), "minor-window");
    assert.equal(flag(b, "--per-minor-n"), String(p.PER_MINOR_N));
  } finally { t.cleanup(); }
});

test("preview step runs 01_build-list with --preview", () => {
  const t = tmp(); try {
    const p = { ...Object.fromEntries(T2.PARAMS.map((x) => [x.key, x.default])), outDir: t.dir, INPUT_DIR: t.dir };
    const b = T2.buildCommand("preview", p);
    assert.equal(scriptOf(b), "01_build-list.mjs");
    assert.ok(b.args.includes("--preview"));
  } finally { t.cleanup(); }
});

test("buildCommand passes --selection only when selection.json exists in output root", () => {
  const t = tmp(); try {
    const p = { ...Object.fromEntries(T2.PARAMS.map((x) => [x.key, x.default])), outDir: t.dir, INPUT_DIR: t.dir };
    const without = T2.buildCommand("01", p);
    assert.equal(without.args.includes("--selection"), false);
    writeFileSync(join(t.dir, "selection.json"), JSON.stringify({ ms: { include: false, withDeps: true } }));
    const withSel = T2.buildCommand("01", p);
    assert.ok(withSel.args.includes("--selection"), "selection.json present -> --selection passed");
  } finally { t.cleanup(); }
});

test("steps 02/03/04 map to the right scripts", () => {
  const t = tmp(); try {
    const p = { ...Object.fromEntries(T2.PARAMS.map((x) => [x.key, x.default])), outDir: t.dir, INPUT_DIR: t.dir };
    assert.equal(scriptOf(T2.buildCommand("02", p)), "02_download.mjs");
    assert.equal(scriptOf(T2.buildCommand("03", p)), "03_pseudo-bundle.mjs");
    assert.equal(scriptOf(T2.buildCommand("04", p)), "04_extract-functions.mjs");
  } finally { t.cleanup(); }
});
