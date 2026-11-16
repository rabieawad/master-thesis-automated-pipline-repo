import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVer, cmpVer, isStable, stableOf } from "../tier2/lib/versions.mjs";

test("parseVer / cmpVer / isStable", () => {
  assert.deepEqual(parseVer("1.2.3"), { major: 1, minor: 2, patch: 3 });
  assert.deepEqual(parseVer("4.5.6-beta.1"), { major: 4, minor: 5, patch: 6 });
  assert.ok(cmpVer(parseVer("1.2.0"), parseVer("1.1.9")) > 0);
  assert.equal(isStable("1.0.0"), true);
  assert.equal(isStable("1.0.0-rc.1"), false);
});

test("stableOf drops prereleases and unparseable", () => {
  const s = stableOf(["1.0.0", "1.0.1-rc.1", "2.0.0", "garbage", "2.1"]);
  assert.deepEqual(s.map((x) => x.v).sort(), ["1.0.0", "2.0.0"]);
});


test("the sampling helpers are gone: every version is considered", async () => {
  const mod = await import("../tier2/lib/versions.mjs");
  for (const gone of ["sampleKept", "keptCountForSample", "SAMPLE_STRATEGIES"]) assert.equal(gone in mod, false, `${gone} removed`);
});
