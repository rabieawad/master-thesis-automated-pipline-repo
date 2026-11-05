import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmp, writeJson, read, parseCsv, runNode, TIER1 } from "./helpers.mjs";

const SCRIPT = join(TIER1, "04-select-sample40.mjs");

test("selects ok packages within [min,max] bundled-dep range, seeded", () => {
  const t = tmp(); try {
    const summary = [];
    for (let i = 0; i < 15; i++) summary.push({ ok: true, name: `p${i}`, version: "1.0.0", folder: `p${i}`, dependenciesInBundle: i, bundleBytes: 100 + i });
    summary.push({ ok: false, name: "failed", version: "1.0.0", folder: "failed", error: "boom" });
    const sumPath = join(t.dir, "summary.json"); writeJson(sumPath, summary);
    const out = join(t.dir, "selected");
    const r = runNode(SCRIPT, [sumPath, "--n", "5", "--min", "3", "--max", "10", "--seed", "42", "--out", out]);
    assert.equal(r.code, 0, r.stdout);
    const rows = parseCsv(read(out + ".csv"));
    assert.equal(rows.length, 5);
    for (const row of rows) { const d = Number(row.dependencies ?? row.dependenciesInBundle ?? row.dependencies_in_bundle ?? row[Object.keys(row)[3]]); assert.ok(d >= 3 && d <= 10); }
    // reproducible
    const out2 = join(t.dir, "selected2");
    runNode(SCRIPT, [sumPath, "--n", "5", "--min", "3", "--max", "10", "--seed", "42", "--out", out2]);
    assert.equal(read(out + ".json"), read(out2 + ".json"));
  } finally { t.cleanup(); }
});

test("failed/out-of-range packages are excluded", () => {
  const t = tmp(); try {
    const summary = [
      { ok: true, name: "a", version: "1.0.0", folder: "a", dependenciesInBundle: 0 }, // below min
      { ok: true, name: "b", version: "1.0.0", folder: "b", dependenciesInBundle: 5 },
      { ok: false, name: "c", version: "1.0.0", folder: "c", dependenciesInBundle: 5 }, // failed
    ];
    const sumPath = join(t.dir, "summary.json"); writeJson(sumPath, summary);
    const out = join(t.dir, "sel");
    const r = runNode(SCRIPT, [sumPath, "--n", "40", "--min", "1", "--max", "20", "--seed", "1", "--out", out]);
    assert.equal(r.code, 0, r.stdout);
    const rows = parseCsv(read(out + ".csv"));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, "b");
  } finally { t.cleanup(); }
});
