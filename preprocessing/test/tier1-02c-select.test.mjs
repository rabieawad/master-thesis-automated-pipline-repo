import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmp, writeJson, read, parseCsv, runNode, TIER1 } from "./helpers.mjs";

const SCRIPT = join(TIER1, "02c-select.mjs");

// metadata.json with a spread of estimated-landed counts
function fixture(dir) {
  const counts = [0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15];
  const packages = counts.map((c, i) => ({
    rank: i + 1, name: `pkg-${i}-c${c}`, latest: "1.0.0",
    declaredDepCount: c + 2, declaredDeps: [], runtimeDepCount: c, runtimeDeps: [],
    estimatedLandedCount: c, excludedToolingTypes: [], likelyPreBundled: false, fileCount: 10, unpackedSize: 1000,
  }));
  writeJson(join(dir, "metadata.json"), { packages });
  return counts;
}

test("flat selection within [min,max] on landed basis", () => {
  const t = tmp(); try {
    fixture(t.dir); const out = join(t.dir, "out");
    const r = runNode(SCRIPT, [t.dir, out, "--basis", "landed", "--n", "5", "--min", "2", "--max", "5", "--seed", "42"]);
    assert.equal(r.code, 0, r.stdout);
    const rows = parseCsv(read(join(out, "selected.csv")));
    assert.equal(rows.length, 5);
    for (const row of rows) { const v = Number(row.estimated_landed); assert.ok(v >= 2 && v <= 5, `${row.name} landed=${v}`); }
  } finally { t.cleanup(); }
});

test("bucket distribution 0:3,2-5:3,8-15:5 yields exactly that shape", () => {
  const t = tmp(); try {
    fixture(t.dir); const out = join(t.dir, "out");
    const r = runNode(SCRIPT, [t.dir, out, "--basis", "landed", "--dist", "0:3,2-5:3,8-15:5", "--seed", "42"]);
    assert.equal(r.code, 0, r.stdout);
    const rows = parseCsv(read(join(out, "selected.csv")));
    const n = (lo, hi) => rows.filter((x) => Number(x.estimated_landed) >= lo && Number(x.estimated_landed) <= hi).length;
    assert.equal(rows.length, 11);
    assert.equal(n(0, 0), 3); assert.equal(n(2, 5), 3); assert.equal(n(8, 15), 5);
  } finally { t.cleanup(); }
});

test("seed reproducibility: same seed -> same picks", () => {
  const t = tmp(); try {
    fixture(t.dir);
    runNode(SCRIPT, [t.dir, join(t.dir, "a"), "--n", "6", "--min", "0", "--max", "15", "--seed", "7"]);
    runNode(SCRIPT, [t.dir, join(t.dir, "b"), "--n", "6", "--min", "0", "--max", "15", "--seed", "7"]);
    assert.equal(read(join(t.dir, "a", "selected.csv")), read(join(t.dir, "b", "selected.csv")));
  } finally { t.cleanup(); }
});

test("basis=declared differs from basis=landed (ga4mp-style tooling inflation)", () => {
  const t = tmp(); try {
    // one package whose declared >> landed
    writeJson(join(t.dir, "metadata.json"), { packages: [
      { rank: 1, name: "ga4mp", latest: "1.0.0", declaredDepCount: 9, declaredDeps: [], runtimeDepCount: 0, runtimeDeps: [], estimatedLandedCount: 0 },
      { rank: 2, name: "real", latest: "1.0.0", declaredDepCount: 3, declaredDeps: [], runtimeDepCount: 3, runtimeDeps: [], estimatedLandedCount: 3 },
    ] });
    // landed basis, max 0 -> only ga4mp qualifies
    const rLanded = runNode(SCRIPT, [t.dir, join(t.dir, "L"), "--basis", "landed", "--n", "5", "--min", "0", "--max", "0"]);
    assert.equal(rLanded.code, 0, rLanded.stdout);
    const landed = parseCsv(read(join(t.dir, "L", "selected.csv")));
    assert.deepEqual(landed.map((x) => x.name), ["ga4mp"]);
    // declared basis, max 0 -> nobody qualifies (ga4mp declares 9)
    const rDecl = runNode(SCRIPT, [t.dir, join(t.dir, "D"), "--basis", "declared", "--n", "5", "--min", "0", "--max", "0"]);
    assert.equal(rDecl.code, 0, rDecl.stdout);
    const decl = parseCsv(read(join(t.dir, "D", "selected.csv")));
    assert.equal(decl.length, 0);
  } finally { t.cleanup(); }
});
