import { test } from "node:test";
import assert from "node:assert/strict";
import { basename } from "node:path";
import { tmp } from "./helpers.mjs";
import { TIERS, stepDirsForTier, buildTierCommand, tierOutput, tierMode, activeStepIds, allStepIds } from "../lib-project.mjs";

test("TIERS expose both pipelines with numbered step ids", () => {
  assert.deepEqual(TIERS.tier1.stepIds, ["01", "02", "03", "04", "05", "06"]);
  assert.deepEqual(TIERS.tier2.stepIds, ["01", "02", "03", "04", "05"]);
});

test("stepDirsForTier: tier1 mode-aware, tier2 monotonic", () => {
  const proj = { slug: "p", tier1: { params: { MODE: "cheap" } }, tier2: { params: {} } };
  const t1 = stepDirsForTier(proj, "tier1");
  assert.ok(t1["02"][0].endsWith("04_selected_sample"), "cheap tier1 step 02 owns selection dir");
  const t1e = stepDirsForTier({ ...proj, tier1: { params: { MODE: "expensive" } } }, "tier1");
  assert.ok(t1e["02"][0].endsWith("02_downloaded_packages"));
  const t2 = stepDirsForTier(proj, "tier2");
  assert.ok(t2["03"][0].endsWith("03_pseudo_bundles"));
});

test("buildTierCommand auto-wires tier2 INPUT_DIR to tier1 output", () => {
  const proj = { slug: "p", tier1: { params: {} }, tier2: { params: { VERSIONS: "exact" } } };
  const built = buildTierCommand(proj, "tier2", "01");
  const t1out = tierOutput(proj, "tier1");
  assert.ok(built.args.includes(t1out), "tier2 step 01 receives tier1 output dir as input");
  assert.ok(built.args.map((a) => basename(String(a))).includes("01_build-list.mjs"));
});

test("tier2 steps are mode-aware: batch keeps 01-05, streamed is 01/06/07", () => {
  const batch = { slug: "p", tier1: { params: {} }, tier2: { params: { STREAM: "0" } } };
  const streamed = { slug: "p", tier1: { params: {} }, tier2: { params: { STREAM: "1" } } };
  assert.equal(tierMode(batch, "tier2"), "batch");
  assert.equal(tierMode(streamed, "tier2"), "streamed");
  assert.deepEqual(activeStepIds(batch, "tier2"), ["01", "02", "03", "04", "05"]);
  assert.deepEqual(activeStepIds(streamed, "tier2"), ["01", "06", "07"]);
  // a project saved before streamed mode existed has no STREAM key and stays batch
  assert.deepEqual(activeStepIds({ slug: "p", tier1: { params: {} }, tier2: { params: {} } }, "tier2"), ["01", "02", "03", "04", "05"]);
  // project state is kept for every id, so switching mode never loses a row
  assert.deepEqual(allStepIds("tier2"), ["01", "02", "03", "04", "05", "06", "07"]);
  assert.deepEqual(activeStepIds({ slug: "p", tier1: { params: { MODE: "cheap" } }, tier2: { params: {} } }, "tier1"), TIERS.tier1.stepIds);
});

test("stepDirsForTier follows tier2's mode", () => {
  const streamed = { slug: "p", tier1: { params: {} }, tier2: { params: { STREAM: "1" } } };
  const sd = stepDirsForTier(streamed, "tier2");
  assert.deepEqual(Object.keys(sd), ["01", "06", "07"]);
  assert.ok(sd["06"].some((p) => String(p).endsWith("_work")));
});

test("buildTierCommand builds the streamed steps for tier2", () => {
  const proj = { slug: "p", tier1: { params: {} }, tier2: { params: { STREAM: "1", KEEP_ARTIFACTS: "", DEDUP_MODE: "normalized", TRIVIAL_NODES: "6", NEAR_THRESHOLD: "0" } } };
  const b6 = buildTierCommand(proj, "tier2", "06");
  assert.ok(b6.args.map((a) => basename(String(a))).includes("06_stream-packages.mjs"));
  assert.ok(b6.args.includes(tierOutput(proj, "tier1")), "the driver reads tier 1's groups CSV");
  const b7 = buildTierCommand(proj, "tier2", "07");
  assert.ok(b7.args.map((a) => basename(String(a))).includes("07_merge-partials.mjs"));
});

import { cleanStepOutputs, tierView, protectedDirsForTier } from "../lib-project.mjs";
import { mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as T1lib from "../tier1/lib-pipeline.mjs";

test("a clean re-run never deletes tier-1 bundles: they are moved to _archived_bundles", () => {
  const t = tmp(); try {
    const proj = { slug: "p", tier1: { params: {}, externalOutput: t.dir }, tier2: { params: {} } };
    const d = T1lib.dirs(t.dir);
    for (const f of [join(d.D3, "bundles", "a@1.0.0.min.js"), join(d.D5, "bundles", "a@1.0.0.min.js"), join(d.D4, "selected.json"), join(d.D3, "claude_repair", "report.json")]) {
      mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, "x");
    }
    assert.deepEqual(protectedDirsForTier(proj, "tier1"), [d.D3, d.D5]);
    // the Claude work folder inside the bundles is cleared alone, the bundles stay put
    let r = cleanStepOutputs(proj, "tier1", ["07"]);
    assert.equal(existsSync(join(d.D3, "claude_repair")), false);
    assert.ok(existsSync(join(d.D3, "bundles", "a@1.0.0.min.js")));
    // redo from 03: bundles archived, ordinary step output deleted
    r = cleanStepOutputs(proj, "tier1", ["03", "04", "05", "06"], new Date("2026-11-14T10:00:00Z"));
    assert.equal(r.archived.length, 2);
    assert.ok(r.deleted.some((x) => x.endsWith("04_selected_sample")));
    const arch = join(t.dir, "_archived_bundles", "2026-11-14T10-00-00-000Z");
    assert.ok(existsSync(join(arch, "03_bundles_minified", "bundles", "a@1.0.0.min.js")));
    assert.ok(existsSync(join(arch, "05_selected_bundles", "bundles", "a@1.0.0.min.js")));
    assert.equal(existsSync(d.D3), false, "the step starts from an empty folder");
    // tier 2 has nothing protected
    assert.deepEqual(protectedDirsForTier(proj, "tier2"), []);
  } finally { t.cleanup(); }
});

test("tierView lists the steps a project runs, with the numbers users know", () => {
  const p = { slug: "p", tier1: { params: { CLAUDE_REPAIR: "1" }, steps: { "03": { status: "done" } } }, tier2: { params: { STREAM: "1" }, steps: {} } };
  const v1 = tierView(p, "tier1");
  assert.deepEqual(v1.steps.map((s) => s.num), ["01", "02", "03", "03b", "04", "05", "06"]);
  assert.equal(v1.steps.find((s) => s.id === "03").status, "done");
  assert.equal(v1.steps.find((s) => s.id === "07").status, "pending");
  const v2 = tierView(p, "tier2");
  assert.equal(v2.mode, "streamed");
  assert.deepEqual(v2.steps.map((s) => s.num), ["01", "02–05", "05"]);
  assert.match(v2.steps[1].label, /^Stream packages/);
});
