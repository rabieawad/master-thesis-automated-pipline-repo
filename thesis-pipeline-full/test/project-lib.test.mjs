import { test } from "node:test";
import assert from "node:assert/strict";
import { basename } from "node:path";
import { tmp } from "./helpers.mjs";
import { TIERS, stepDirsForTier, buildTierCommand, tierOutput } from "../lib-project.mjs";

test("TIERS expose both pipelines with numbered step ids", () => {
  assert.deepEqual(TIERS.tier1.stepIds, ["01", "02", "03", "04", "05", "06"]);
  assert.deepEqual(TIERS.tier2.stepIds, ["01", "02", "03", "04"]);
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
