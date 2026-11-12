import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmp, writeJson, writeText, read, parseCsv, runNode, TIER2 } from "./helpers.mjs";

const SCRIPT = join(TIER2, "01_build-list.mjs");

// tier-1 output fixture: 3 packages; side-channel bundles es-errors + object-inspect
function t1(dir) {
  writeJson(join(dir, "04_selected_sample", "selected.json"), [
    { name: "side-channel", version: "1.1.1" }, { name: "ms", version: "2.1.3" }, { name: "es-errors", version: "1.3.0" },
  ]);
  writeText(join(dir, "05_selected_bundles", "selected_dependencies.csv"),
    'package,bundled_dependencies\n' +
    'side-channel,"[""es-errors@1.3.0"",""object-inspect@1.13.4""]"\n' +
    'ms,[]\nes-errors,[]\n');
}
const namesIn = (out) => parseCsv(read(join(out, "reference-packages.csv"))).map((r) => `${r.name}@${r.version}`).sort();

test("default: all packages + their bundled deps (exact mode, offline)", () => {
  const t = tmp(); try {
    t1(join(t.dir, "in")); const out = join(t.dir, "out");
    const r = runNode(SCRIPT, [join(t.dir, "in"), out, "--versions", "exact"]);
    assert.equal(r.code, 0, r.stdout);
    assert.deepEqual(namesIn(out), ["es-errors@1.3.0", "ms@2.1.3", "object-inspect@1.13.4", "side-channel@1.1.1"]);
  } finally { t.cleanup(); }
});

test("selection withDeps:false drops a package's bundled deps", () => {
  const t = tmp(); try {
    t1(join(t.dir, "in")); const out = join(t.dir, "out");
    writeJson(join(out, "selection.json"), { "side-channel": { include: true, withDeps: false } });
    const r = runNode(SCRIPT, [join(t.dir, "in"), out, "--versions", "exact", "--selection", join(out, "selection.json")]);
    assert.equal(r.code, 0, r.stdout);
    // object-inspect (only via side-channel's deps) is gone; es-errors stays (it's its own package)
    assert.deepEqual(namesIn(out), ["es-errors@1.3.0", "ms@2.1.3", "side-channel@1.1.1"]);
  } finally { t.cleanup(); }
});

test("excluded package still appears when another included package bundles it", () => {
  const t = tmp(); try {
    t1(join(t.dir, "in")); const out = join(t.dir, "out");
    writeJson(join(out, "selection.json"), { "es-errors": { include: false, withDeps: true }, "side-channel": { include: true, withDeps: true } });
    const r = runNode(SCRIPT, [join(t.dir, "in"), out, "--versions", "exact", "--selection", join(out, "selection.json")]);
    assert.equal(r.code, 0, r.stdout);
    const names = namesIn(out);
    assert.ok(names.includes("es-errors@1.3.0"), "es-errors kept as side-channel's dependency");
    // it's no longer a 'package' origin, but still present
  } finally { t.cleanup(); }
});

test("--no-package excludes the packages themselves, keeps deps", () => {
  const t = tmp(); try {
    t1(join(t.dir, "in")); const out = join(t.dir, "out");
    const r = runNode(SCRIPT, [join(t.dir, "in"), out, "--versions", "exact", "--no-package"]);
    assert.equal(r.code, 0, r.stdout);
    const rows = parseCsv(read(join(out, "reference-packages.csv")));
    assert.ok(rows.every((x) => x.origin !== "package"), "no package-origin rows");
    assert.ok(rows.some((x) => x.name === "object-inspect"), "deps still present");
  } finally { t.cleanup(); }
});
