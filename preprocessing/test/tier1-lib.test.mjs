import { test } from "node:test";
import assert from "node:assert/strict";
import { basename, join } from "node:path";
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

test("STEP_LABELS has both modes with 6 steps each, plus the optional Claude repair step", () => {
  for (const mode of ["expensive", "cheap"]) {
    assert.deepEqual(Object.keys(T1.STEP_LABELS[mode]).sort(), ["01", "02", "03", "04", "05", "06", "07", "08"]);
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

// ---------------------------------------------------------------- Claude repair + bundles
test("Claude repair step 07 sits right after bundling, only when switched on", () => {
  assert.deepEqual(T1.stepIdsFor({}), ["01", "02", "03", "04", "05", "06"]);
  assert.deepEqual(T1.stepIdsFor({ CLAUDE_REPAIR: "1" }), ["01", "02", "03", "07", "04", "05", "06"], "expensive: after 03 (bundle all)");
  assert.deepEqual(T1.stepIdsFor({ MODE: "cheap", CLAUDE_REPAIR: "1" }), ["01", "02", "03", "04", "07", "05", "06"], "cheap: after 04 (bundle sample)");
  assert.match(T1.STEP_LABELS.expensive["07"], /^03b · /);
  assert.match(T1.STEP_LABELS.cheap["07"], /^04b · /);
});

test("buildCommand 07 runs the repair script on the bundling step's folders with the bundler's env", () => {
  const t = tmp(); try {
    const p = { ...T1.DEFAULTS, outDir: t.dir, CLAUDE_REPAIR: "1", CLAUDE_BUDGET_USD: "1.5", CLAUDE_MODEL: "opus" };
    const b = T1.buildCommand("07", p);
    assert.equal(scriptOf(b), "07-claude-repair-bundles.mjs");
    const d = T1.dirs(t.dir);
    assert.equal(b.args[1], d.D2); assert.equal(b.args[2], d.D3);
    assert.equal(flag(b, "--budget-usd"), "1.5"); assert.equal(flag(b, "--model"), "opus");
    assert.equal(flag(b, "--max"), "20"); assert.equal(flag(b, "--claude-bin"), "claude");
    const noCap = T1.buildCommand("07", { ...p, CLAUDE_BUDGET_USD: "", CLAUDE_MODEL: "" });
    assert.equal(noCap.args.includes("--budget-usd"), false); assert.equal(noCap.args.includes("--model"), false);
    // same bundler environment as the bundling step
    assert.deepEqual(T1.buildCommand("07", { ...p, MINIFY: "0" }).env, { UNMINIFIED: "1" });
    assert.equal(T1.buildCommand("03", { ...p, MINIFY: "0" }).env.UNMINIFIED, "1", "MINIFY=0 now reaches the bundler");
    assert.equal(T1.buildCommand("03", p).env.UNMINIFIED, undefined, "default stays minified (faithful)");
  } finally { t.cleanup(); }
});

test("the bundle folders are protected and step 07 owns only its work folder", () => {
  const t = tmp(); try {
    const d = T1.dirs(t.dir);
    assert.deepEqual(T1.protectedDirs(t.dir), [d.D3, d.D5]);
    assert.ok(T1.stepDirs(t.dir)["07"][0].endsWith("claude_repair"));
    assert.ok(T1.stepDirs(t.dir, "cheap")["07"][0].endsWith("claude_repair"));
  } finally { t.cleanup(); }
});

test("every tier-1 setting belongs to a declared group", () => {
  const groups = new Set(T1.GROUPS.map((g) => g.id));
  for (const p of T1.PARAMS) { assert.ok(groups.has(p.group), `${p.key} has a known group`); assert.ok(p.help, `${p.key} has help`); }
});

test("blank Claude numbers fall back to their defaults instead of 0", () => {
  const t = tmp(); try {
    const b = T1.buildCommand("07", { ...T1.DEFAULTS, outDir: t.dir, CLAUDE_MAX_PACKAGES: "", CLAUDE_MAX_TURNS: "0", CLAUDE_TIMEOUT_MIN: "abc", CLAUDE_BIN: " " });
    assert.equal(flag(b, "--max"), "20"); assert.equal(flag(b, "--max-turns"), "40");
    assert.equal(flag(b, "--timeout-min"), "20"); assert.equal(flag(b, "--claude-bin"), "claude");
    assert.equal(flag(T1.buildCommand("07", { ...T1.DEFAULTS, outDir: t.dir, CLAUDE_MAX_PACKAGES: "5" }), "--max"), "5");
  } finally { t.cleanup(); }
});

// ---------------------------------------------------------------- streamed tier 1
test("streamed mode replaces download + bundle (+ Claude) with one step 08; old projects stay batch", () => {
  assert.deepEqual(T1.stepIdsFor({ STREAM: "1" }), ["01", "08", "04", "05", "06"]);
  assert.deepEqual(T1.stepIdsFor({ STREAM: "1", MODE: "cheap", CLAUDE_REPAIR: "1" }), ["01", "02", "08", "05", "06"], "Claude runs inside the stream");
  assert.deepEqual(T1.stepIdsFor({}), ["01", "02", "03", "04", "05", "06"], "no STREAM key = a project from before = batch");
  assert.equal(T1.DEFAULTS.STREAM, "1", "new projects stream");
  assert.match(T1.STEP_LABELS.cheap["08"], /^03–04 · Stream the sample/);
  assert.match(T1.STEP_LABELS.expensive["08"], /^02–03 · Stream packages/);
});

test("buildCommand 08 streams the right list with the right options", () => {
  const t = tmp(); try {
    const d = T1.dirs(t.dir);
    const cheap = T1.buildCommand("08", { ...T1.DEFAULTS, outDir: t.dir, MODE: "cheap", KEEP_ARTIFACTS: "downloads" });
    assert.equal(scriptOf(cheap), "08-stream-packages.mjs");
    assert.deepEqual(cheap.args.slice(1, 4), [join(d.D4, "selected-list.json"), d.D2, d.D3]);
    assert.equal(flag(cheap, "--keep"), "downloads"); assert.equal(flag(cheap, "--limit"), "all");
    assert.equal(cheap.args.includes("--claude"), false); assert.equal(cheap.args.includes("--no-check"), false);
    assert.equal(cheap.env.ONLY_WITH_DEPS, "0");
    const exp = T1.buildCommand("08", { ...T1.DEFAULTS, outDir: t.dir, DOWNLOAD_LIMIT: "300", INCLUDE_ZERO_DEP: "0", CHECK_BUNDLEABLE: "0", CLAUDE_REPAIR: "1", MINIFY: "0" });
    assert.equal(exp.args[1], join(d.D1, "jsdelivr-top.json"));
    assert.equal(flag(exp, "--limit"), "300"); assert.ok(exp.args.includes("--no-check")); assert.ok(exp.args.includes("--claude"));
    assert.equal(exp.env.ONLY_WITH_DEPS, "1"); assert.equal(exp.env.UNMINIFIED, "1");
    // selection no longer asks for the (deleted) downloads in streamed mode; batch still does
    assert.equal(T1.buildCommand("04", { ...T1.DEFAULTS, outDir: t.dir, STREAM: "1" }).args.includes("--copy-to"), false);
    assert.ok(T1.buildCommand("04", { ...T1.DEFAULTS, outDir: t.dir, STREAM: "0" }).args.includes("--copy-to"));
    // a clean redo of step 08 archives the bundles (protected) and deletes the downloads
    assert.deepEqual(T1.stepDirs(t.dir)["08"], [d.D2, d.D3]);
    assert.ok(T1.protectedDirs(t.dir).includes(d.D3));
  } finally { t.cleanup(); }
});

test("SKIP_MISSING_DEPS is off by default and reaches every download when on", () => {
  const L = T1, base = { ...L.DEFAULTS, outDir: "/o" };
  assert.equal(L.DEFAULTS.SKIP_MISSING_DEPS, "0");
  for (const [step, MODE, STREAM] of [["02", "expensive", "0"], ["03", "cheap", "0"], ["08", "expensive", "1"], ["08", "cheap", "1"]]) {
    assert.equal(L.buildCommand(step, { ...base, MODE, STREAM }).env.SKIP_MISSING_DEPS, undefined, `${step} ${MODE}: faithful by default`);
    assert.equal(L.buildCommand(step, { ...base, MODE, STREAM, SKIP_MISSING_DEPS: "1" }).env.SKIP_MISSING_DEPS, "1", `${step} ${MODE}`);
  }
});
