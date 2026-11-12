import { test } from "node:test";
import assert from "node:assert/strict";
import { basename } from "node:path";
import * as T1 from "../tier1/lib-pipeline.mjs";
import { tmp } from "./helpers.mjs";

const base = (args) => args.map((a) => basename(String(a)));
const scriptOf = (built) => base(built.args).find((a) => a.endsWith(".mjs"));
const flag = (built, f) => { const i = built.args.indexOf(f); return i >= 0 ? String(built.args[i + 1]) : undefined; };

test("PARAMS: new cheap params + mode tags", () => {
  const by = Object.fromEntries(T1.PARAMS.map((p) => [p.key, p]));
  assert.ok(by.DEP_BASIS && by.DEP_BASIS.modes.includes("cheap"));
  assert.ok(by.DEP_DIST && by.DEP_DIST.modes.includes("cheap"));
  assert.deepEqual(by.DOWNLOAD_LIMIT.modes, ["expensive"]);
  assert.equal(by.MODE.default, "expensive");
});

test("STEP_LABELS has both modes with 6 steps each", () => {
  for (const mode of ["expensive", "cheap"]) {
    assert.equal(Object.keys(T1.STEP_LABELS[mode]).length, 6);
  }
  assert.match(T1.STEP_LABELS.cheap["02"], /select/i);
  assert.match(T1.STEP_LABELS.expensive["02"], /download/i);
});

test("dirs + stepDirs mode-aware mapping", () => {
  const t = tmp(); try {
    const d = T1.dirs(t.dir);
    assert.ok(d.D1.endsWith("01_top1500_package_list"));
    const exp = T1.stepDirs(t.dir, "expensive"), cheap = T1.stepDirs(t.dir, "cheap");
    assert.ok(exp["02"][0].endsWith("02_downloaded_packages"));
    assert.ok(cheap["02"][0].endsWith("04_selected_sample"), "cheap step 02 owns the selection dir");
    assert.ok(cheap["03"][0].endsWith("02_downloaded_packages"), "cheap step 03 owns downloads");
  } finally { t.cleanup(); }
});

test("buildCommand EXPENSIVE: crawl / download / bundle / select", () => {
  const t = tmp(); try {
    const p = { ...T1.DEFAULTS, MODE: "expensive", outDir: t.dir };
    assert.equal(scriptOf(T1.buildCommand("01", p)), "01-1500-jsdeliver.mjs");
    const s02 = T1.buildCommand("02", p);
    assert.equal(scriptOf(s02), "02-download-with-deps.mjs");
    assert.ok("ONLY_WITH_DEPS" in s02.env);
    assert.equal(scriptOf(T1.buildCommand("03", p)), "03-bundle-and-sbom.mjs");
    assert.equal(scriptOf(T1.buildCommand("04", p)), "04-select-sample40.mjs");
    assert.equal(scriptOf(T1.buildCommand("06", p)), "06-extract-functions.mjs");
  } finally { t.cleanup(); }
});

test("buildCommand CHEAP: crawl+metadata / select / download / bundle", () => {
  const t = tmp(); try {
    const p = { ...T1.DEFAULTS, MODE: "cheap", outDir: t.dir, DEP_BASIS: "landed" };
    assert.equal(scriptOf(T1.buildCommand("01", p)), "01c-crawl-metadata.mjs");
    const s02 = T1.buildCommand("02", p);
    assert.equal(scriptOf(s02), "02c-select.mjs");
    assert.equal(flag(s02, "--basis"), "landed");
    assert.equal(scriptOf(T1.buildCommand("03", p)), "02-download-with-deps.mjs");
    assert.equal(scriptOf(T1.buildCommand("04", p)), "03-bundle-and-sbom.mjs");
  } finally { t.cleanup(); }
});

test("buildCommand CHEAP 02 passes --dist only when set", () => {
  const t = tmp(); try {
    const noDist = T1.buildCommand("02", { ...T1.DEFAULTS, MODE: "cheap", outDir: t.dir, DEP_DIST: "" });
    assert.equal(noDist.args.includes("--dist"), false);
    const withDist = T1.buildCommand("02", { ...T1.DEFAULTS, MODE: "cheap", outDir: t.dir, DEP_DIST: "0:3,2-5:3" });
    assert.equal(flag(withDist, "--dist"), "0:3,2-5:3");
  } finally { t.cleanup(); }
});
