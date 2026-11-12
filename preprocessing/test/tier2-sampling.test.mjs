import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVer, cmpVer, isStable, stableOf, sampleKept, keptCountForSample, SAMPLE_STRATEGIES, mulberry32, hashStr } from "../tier2/lib/sampling.mjs";

const mkVersions = (majors, minors, patches) => { const out = []; for (let a = 0; a < majors; a++) for (let b = 0; b < minors; b++) for (let c = 0; c < patches; c++) out.push(`${a}.${b}.${c}`); return out; };

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

test("sampleKept: <= threshold takes everything", () => {
  const s = stableOf(mkVersions(1, 1, 10)); // 10 versions
  const k = sampleKept("p", "0.0.5", s, { threshold: 50, perMinorN: 4 });
  assert.equal(k.size, 10);
});

test("minor-window: contiguous window of N+1 per minor, plus observed always kept", () => {
  const s = stableOf(mkVersions(1, 1, 30)); // 0.0.0..0.0.29, one minor
  const k = sampleKept("demo", "0.0.5", s, { strategy: "minor-window", perMinorN: 4, threshold: 10, seed: 42 });
  const kept = [...k].filter((v) => v.startsWith("0.0.")).map((v) => +v.split(".")[2]).sort((a, b) => a - b);
  assert.ok(k.has("0.0.5"), "observed always kept");
  // the window is perMinorN+1 = 5 contiguous patches; observed adds at most 1 more
  assert.ok(kept.length === 5 || kept.length === 6, `5 (observed in window) or 6 (observed outside), got ${kept.length}`);
  // there is a run of 5 consecutive patch numbers (the window)
  const hasRun = kept.some((_, i) => [0, 1, 2, 3, 4].every((d) => kept.includes(kept[i] + d)));
  assert.ok(hasRun, `contiguous window of 5 present: ${kept}`);
});

test("minor-window: small minor lines taken whole", () => {
  const s = stableOf(["2.0.0", "2.0.1", "2.1.0"]); // but >threshold forces sampling
  const k = sampleKept("demo", "2.0.0", s, { strategy: "minor-window", perMinorN: 4, threshold: 2, seed: 1 });
  // 2.0.x has 2 (<=N+1 -> both), 2.1.x has 1 -> all 3 kept
  assert.equal(k.size, 3);
});

test("sampling is reproducible for same seed+name, varies by name", () => {
  const s = stableOf(mkVersions(3, 4, 10)); // 120
  const a = [...sampleKept("pkgA", "1.1.5", s, { perMinorN: 4, threshold: 50 })].sort();
  const b = [...sampleKept("pkgA", "1.1.5", s, { perMinorN: 4, threshold: 50 })].sort();
  const c = [...sampleKept("pkgB", "1.1.5", s, { perMinorN: 4, threshold: 50 })].sort();
  assert.deepEqual(a, b, "same seed+name reproducible");
  assert.notDeepEqual(a, c, "different name -> different sample");
});

test("keptCountForSample sweep is monotonic non-decreasing in N", () => {
  const s = stableOf(mkVersions(3, 4, 10)); // 120, 12 minor groups
  const counts = [1, 2, 3, 4, 6, 8].map((n) => keptCountForSample("popper", "1.1.5", s, n, { strategy: "minor-window", threshold: 50, seed: 42 }));
  for (let i = 1; i < counts.length; i++) assert.ok(counts[i] >= counts[i - 1], `N grows -> count grows (${counts})`);
  assert.ok(counts[counts.length - 1] <= 120);
});

test("minor-adjacent keeps observed + neighbours", () => {
  const s = stableOf(mkVersions(1, 1, 30));
  const k = sampleKept("demo", "0.0.15", s, { strategy: "minor-adjacent", perMinorN: 2, adjacentN: 4, threshold: 10, seed: 7 });
  assert.ok(k.has("0.0.15"), "observed kept");
  // neighbours of observed present
  const near = ["0.0.13", "0.0.14", "0.0.16", "0.0.17"].filter((v) => k.has(v));
  assert.ok(near.length >= 2, "some observed-neighbours kept");
});
