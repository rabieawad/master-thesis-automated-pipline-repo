import { test } from "node:test";
import assert from "node:assert/strict";
import { basename, join } from "node:path";
import { writeFileSync } from "node:fs";
import * as T2 from "../tier2/lib-pipeline-2.mjs";
import { tmp } from "./helpers.mjs";

const base = (args) => args.map((a) => basename(String(a)));
const scriptOf = (b) => base(b.args).find((a) => a.endsWith(".mjs"));
const flag = (b, f) => { const i = b.args.indexOf(f); return i >= 0 ? String(b.args[i + 1]) : undefined; };

test("version sampling is gone: VERSIONS has no 'sample' and no sampling knobs remain", () => {
  const by = Object.fromEntries(T2.PARAMS.map((p) => [p.key, p]));
  assert.deepEqual(by.VERSIONS.options, ["all", "minor", "latest", "exact"]);
  assert.equal(by.VERSIONS.default, "all");
  for (const k of ["SAMPLE_THRESHOLD", "SAMPLE_STRATEGY", "PER_MINOR_N", "ADJACENT_N", "SEED"]) assert.equal(by[k], undefined, `${k} removed`);
});

test("every setting belongs to a declared group and has a short label and help", () => {
  const groups = new Set(T2.GROUPS.map((g) => g.id));
  for (const p of T2.PARAMS) {
    assert.ok(groups.has(p.group), `${p.key} has a known group`);
    assert.ok(p.label && p.label.length <= 60, `${p.key} has a short label`);
    assert.ok(p.help, `${p.key} has help text`);
  }
});

test("KEEP_ARTIFACTS is a checkbox list of steps, with logs always kept", () => {
  const k = T2.PARAMS.find((p) => p.key === "KEEP_ARTIFACTS");
  assert.equal(k.type, "multi");
  assert.deepEqual(k.options.map((o) => o.value), ["02", "03", "04", "partials"]);
  assert.ok(k.fixed.some((f) => /log/i.test(f.label)), "logs are listed as always kept");
  assert.equal(k.default, "03", "pseudo-bundles kept by default, nothing else");
  assert.ok(k.fixed.some((f) => /packages\/<package>\.json/.test(f.help)), "the per-package JSON is listed as always kept");
});

test("step 03 (batch) really honours MINIFY=0: the bundler gets UNMINIFIED=1", () => {
  const t = tmp(); try {
    const p = { ...Object.fromEntries(T2.PARAMS.map((x) => [x.key, x.default])), outDir: t.dir, INPUT_DIR: t.dir };
    assert.equal(T2.buildCommand("03", { ...p, MINIFY: "0" }).env.UNMINIFIED, "1");
    assert.equal(T2.buildCommand("03", { ...p, MINIFY: "1" }).env.UNMINIFIED, undefined);
  } finally { t.cleanup(); }
});

test("stepDirs maps 01..05", () => {
  const t = tmp(); try {
    const sd = T2.stepDirs(t.dir);
    assert.ok(sd["01"][0].endsWith("01_reference_list"));
    assert.ok(sd["04"][0].endsWith("04_extracted_functions"));
    assert.ok(sd["05"][0].endsWith("05_deduplicated_functions"));
  } finally { t.cleanup(); }
});

test("a project saved with the removed VERSIONS=sample now runs as all", () => {
  const t = tmp(); try {
    const p = { ...Object.fromEntries(T2.PARAMS.map((x) => [x.key, x.default])), outDir: t.dir, INPUT_DIR: t.dir, VERSIONS: "sample" };
    assert.equal(flag(T2.buildCommand("01", p), "--versions"), "all");
    assert.equal(flag(T2.buildCommand("preview", p), "--versions"), "all");
  } finally { t.cleanup(); }
});

test("buildCommand 01 passes --versions and no sampling flags", () => {
  const t = tmp(); try {
    const p = { ...Object.fromEntries(T2.PARAMS.map((x) => [x.key, x.default])), outDir: t.dir, INPUT_DIR: t.dir };
    const b = T2.buildCommand("01", p);
    assert.equal(scriptOf(b), "01_build-list.mjs");
    assert.equal(flag(b, "--versions"), "all");
    for (const f of ["--sample-strategy", "--per-minor-n", "--sample-threshold", "--adjacent-n", "--seed"]) assert.equal(b.args.includes(f), false, `${f} not passed`);
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

test("steps 02/03/04/05 map to the right scripts", () => {
  const t = tmp(); try {
    const p = { ...Object.fromEntries(T2.PARAMS.map((x) => [x.key, x.default])), outDir: t.dir, INPUT_DIR: t.dir };
    assert.equal(scriptOf(T2.buildCommand("02", p)), "02_download.mjs");
    assert.equal(scriptOf(T2.buildCommand("03", p)), "03_pseudo-bundle.mjs");
    assert.equal(scriptOf(T2.buildCommand("04", p)), "04_extract-functions.mjs");
    assert.equal(scriptOf(T2.buildCommand("05", p)), "05_dedup-functions.mjs");
  } finally { t.cleanup(); }
});

test("buildCommand 05 reads step 04 output, writes 05_, and passes dedup flags", () => {
  const t = tmp(); try {
    const p = { ...Object.fromEntries(T2.PARAMS.map((x) => [x.key, x.default])), outDir: t.dir, INPUT_DIR: t.dir };
    const def = T2.buildCommand("05", p);
    assert.ok(String(def.args[0]).endsWith("05_dedup-functions.mjs"), "script is args[0] (server preflight)");
    assert.ok(String(def.args[1]).endsWith("04_extracted_functions"));
    assert.ok(String(def.args[2]).endsWith("05_deduplicated_functions"));
    assert.equal(flag(def, "--mode"), "normalized");
    assert.equal(flag(def, "--trivial-nodes"), "6");
    assert.equal(def.args.includes("--strict-type"), false);
    assert.equal(def.args.includes("--near"), false, "NEAR_THRESHOLD=0 -> no near pass");
    assert.match(def.env.NODE_OPTIONS, /max-old-space-size/);
    const on = T2.buildCommand("05", { ...p, DEDUP_MODE: "exact", DEDUP_STRICT_TYPE: "1", NEAR_THRESHOLD: "0.85" });
    assert.equal(flag(on, "--mode"), "exact");
    assert.ok(on.args.includes("--strict-type"));
    assert.equal(flag(on, "--near"), "0.85");
  } finally { t.cleanup(); }
});

// ---------------------------------------------------------------- streamed mode
test("PARAMS include STREAM (default on) and KEEP_ARTIFACTS (streamed-only)", () => {
  const by = Object.fromEntries(T2.PARAMS.map((p) => [p.key, p]));
  assert.equal(by.STREAM.type, "bool");
  assert.equal(by.STREAM.default, "1");
  assert.equal(by.KEEP_ARTIFACTS.default, "03", "pseudo-bundles kept by default");
  assert.deepEqual(by.KEEP_ARTIFACTS.modes, ["streamed"], "hidden in batch mode");
});

test("modeOf: STREAM=1 is streamed, 0 is batch, absent stays batch (old projects)", () => {
  assert.equal(T2.modeOf({ STREAM: "1" }), "streamed");
  assert.equal(T2.modeOf({ STREAM: "0" }), "batch");
  assert.equal(T2.modeOf({}), "batch");
});

test("step ids and labels are mode-aware: batch 01-05, streamed 01/06/07", () => {
  assert.deepEqual(T2.stepIdsFor("batch"), ["01", "02", "03", "04", "05"]);
  assert.deepEqual(T2.stepIdsFor("streamed"), ["01", "06", "07"]);
  assert.match(T2.STEP_LABELS.streamed["06"], /^02–05 · Stream packages/);
  assert.match(T2.STEP_LABELS.streamed["07"], /^05 · Merge/);
  assert.equal(T2.STEP_LABELS.batch["05"], T2.STEPS.find((s) => s.id === "05").label);
  for (const id of ["06", "07"]) assert.ok(T2.STEPS.some((s) => s.id === id), `STEPS carries ${id}`);
});

test("stepDirs: streamed step 06 owns the per-package output, 07 only its own files", () => {
  const t = tmp(); try {
    const sd = T2.stepDirs(t.dir, "streamed");
    assert.deepEqual(Object.keys(sd), ["01", "06", "07"]);
    const owns06 = sd["06"].map((p) => String(p));
    for (const frag of ["02_downloaded_packages", "03_pseudo_bundles", "04_extracted_functions", "_work", "partials", "versions", "groups"])
      assert.ok(owns06.some((p) => p.includes(frag)), `step 06 owns ${frag}`);
    assert.ok(sd["07"].every((p) => String(p).includes("05_deduplicated_functions")));
    assert.ok(sd["07"].some((p) => String(p).endsWith("unique_functions.jsonl")));
    assert.equal(sd["07"].some((p) => String(p).endsWith("partials")), false, "the merge must not wipe the partials it reads");
    // batch mode is untouched, with or without the explicit mode
    assert.deepEqual(Object.keys(T2.stepDirs(t.dir, "batch")), ["01", "02", "03", "04", "05"]);
    assert.deepEqual(Object.keys(T2.stepDirs(t.dir)), ["01", "02", "03", "04", "05"]);
  } finally { t.cleanup(); }
});

test("buildCommand 06/07 run the streamed scripts with the right flags", () => {
  const t = tmp(); try {
    const p = { ...Object.fromEntries(T2.PARAMS.map((x) => [x.key, x.default])), outDir: t.dir, INPUT_DIR: t.dir };
    const b6 = T2.buildCommand("06", p);
    assert.equal(scriptOf(b6), "06_stream-packages.mjs");
    assert.ok(String(b6.args[1]).endsWith(t.dir), "the output root is the first positional");
    assert.equal(flag(b6, "--input"), t.dir);
    assert.equal(flag(b6, "--min-loc"), String(p.MIN_LOC));
    assert.equal(flag(b6, "--mode"), "normalized");
    assert.equal(flag(b6, "--keep"), "03");
    assert.equal(flag(b6, "--trivial-nodes"), "6", "the per-package JSON flags trivial functions the same way");
    assert.equal(b6.args.includes("--strict-type"), false);
    assert.equal(b6.env.MINIFY, p.MINIFY, "MINIFY is passed through and translated inside the driver");

    const b7 = T2.buildCommand("07", p);
    assert.equal(scriptOf(b7), "07_merge-partials.mjs");
    assert.ok(String(b7.args[1]).endsWith("05_deduplicated_functions"));
    assert.equal(flag(b7, "--trivial-nodes"), "6");
    assert.equal(b7.args.includes("--near"), false);
    assert.equal(b7.args.includes("--keep-partials"), false);
    assert.match(b7.env.NODE_OPTIONS, /max-old-space-size=6144/, "the merge keeps step 05's heap setting");

    const on = { ...p, DEDUP_STRICT_TYPE: "1", INCLUDE_PACKAGE: "0", NEAR_THRESHOLD: "0.85", KEEP_ARTIFACTS: "03,partials" };
    const b6b = T2.buildCommand("06", on);
    assert.ok(b6b.args.includes("--strict-type") && b6b.args.includes("--no-package"));
    assert.equal(flag(b6b, "--keep"), "03,partials");
    const b7b = T2.buildCommand("07", on);
    assert.equal(flag(b7b, "--near"), "0.85");
    assert.ok(b7b.args.includes("--keep-partials"), "KEEP_ARTIFACTS listing partials keeps them");
  } finally { t.cleanup(); }
});

test("step 'all' passes STREAM and KEEP_ARTIFACTS to run-pipeline-2.sh", () => {
  const t = tmp(); try {
    const p = { ...Object.fromEntries(T2.PARAMS.map((x) => [x.key, x.default])), outDir: t.dir, INPUT_DIR: t.dir, KEEP_ARTIFACTS: "02" };
    const b = T2.buildCommand("all", p);
    assert.equal(b.env.STREAM, "1");
    assert.equal(b.env.KEEP_ARTIFACTS, "02");
  } finally { t.cleanup(); }
});

test("DEDUP_IDENTITY defaults to the string comparison and reaches steps 05 and 06", () => {
  const t = tmp(); try {
    const by = Object.fromEntries(T2.PARAMS.map((p) => [p.key, p]));
    assert.equal(by.DEDUP_IDENTITY.default, "string");
    assert.deepEqual(by.DEDUP_IDENTITY.options, ["string", "hash"]);
    const p = { ...Object.fromEntries(T2.PARAMS.map((x) => [x.key, x.default])), outDir: t.dir, INPUT_DIR: t.dir };
    assert.equal(flag(T2.buildCommand("05", p), "--identity"), "string");
    assert.equal(flag(T2.buildCommand("06", p), "--identity"), "string");
    assert.equal(flag(T2.buildCommand("05", { ...p, DEDUP_IDENTITY: "hash" }), "--identity"), "hash");
    assert.equal(flag(T2.buildCommand("06", { ...p, DEDUP_IDENTITY: "hash" }), "--identity"), "hash");
    assert.equal(T2.buildCommand("all", p).env.DEDUP_IDENTITY, "string");
  } finally { t.cleanup(); }
});
