import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { packOutputs, unpackOutputs } from "../lib-pack.mjs";

function put(root, files) { for (const [f, c] of Object.entries(files)) { mkdirSync(join(root, f, ".."), { recursive: true }); writeFileSync(join(root, f), c); } }
function tree(root) {
  const out = {};
  const walk = (d) => { for (const n of readdirSync(d, { withFileTypes: true })) { const p = join(d, n.name); if (n.isDirectory()) walk(p); else out[relative(root, p)] = readFileSync(p, "utf8"); } };
  walk(root); return out;
}

const TIER1 = {
  "01_top1500_package_list/top.json": "[]",
  "02_downloaded_packages/acorn.tgz": "TGZ", "02_downloaded_packages/acorn.meta.json": "{}", "02_downloaded_packages/download-results.json": "[]", "02_downloaded_packages/dependency-check.json": "{}",
  "03_bundles_minified/bundles/acorn@8.min.js": "code", "03_bundles_minified/bundles/acorn@8.min.js.map": "map",
  "03_bundles_minified/sbom/acorn@8.cdx.json": "sbom", "03_bundles_minified/modules/acorn@8.json": "mods",
  "03_bundles_minified/summary.json": "[]", "03_bundles_minified/summary.csv": "h", "03_bundles_minified/manifest.jsonl": "",
  "03_bundles_minified/claude_repair/broken/repair.json": "{}", "03_bundles_minified/claude_repair/broken/pkg/node_modules/x/index.js": "x",
  "03_bundles_minified/claude_repair/report.csv": "csv", "03_bundles_minified/claude_repair/report.json": "[]",
  "03_bundles_minified/stream/records/acorn.json": "{}", "03_bundles_minified/stream/logs/acorn/03_bundle.log": "log", "03_bundles_minified/stream/results.csv": "r",
  "04_selected_sample/selected.json": "[]",
  "05_selected_bundles/bundles/acorn@8.min.js": "code", "05_selected_bundles/selected_dependencies.csv": "c",
  "06_extracted_functions/acorn@8.functions.json": "{}", "06_extracted_functions/summary.csv": "s",
  "logs/03.log": "log",
};

test("tier 1: per-package files go into .tgz, logs and small files stay, unpack restores everything", () => {
  const dir = mkdtempSync(join(tmpdir(), "pack-")); try {
    put(dir, TIER1);
    const packed = packOutputs("tier1", dir).map((p) => relative(dir, p.archive)).sort();
    assert.deepEqual(packed, [
      "02_downloaded_packages/packages.tgz",
      "03_bundles_minified/bundles.tgz", "03_bundles_minified/claude_repair/workspaces.tgz", "03_bundles_minified/modules.tgz",
      "03_bundles_minified/sbom.tgz", "03_bundles_minified/stream/records.tgz",
      "05_selected_bundles/bundles.tgz", "06_extracted_functions/functions.tgz",
    ]);
    const after = Object.keys(tree(dir)).sort();
    assert.deepEqual(after.filter((f) => !f.endsWith(".tgz")), [
      "01_top1500_package_list/top.json",
      "02_downloaded_packages/dependency-check.json", "02_downloaded_packages/download-results.json",
      "03_bundles_minified/claude_repair/report.csv", "03_bundles_minified/claude_repair/report.json",
      "03_bundles_minified/manifest.jsonl",
      "03_bundles_minified/stream/logs/acorn/03_bundle.log", "03_bundles_minified/stream/results.csv",
      "03_bundles_minified/summary.csv", "03_bundles_minified/summary.json",
      "04_selected_sample/selected.json",
      "05_selected_bundles/selected_dependencies.csv",
      "06_extracted_functions/summary.csv",
      "logs/03.log",
    ], "only logs and small files are left as plain files");
    assert.equal(unpackOutputs("tier1", dir).length, 8);
    assert.deepEqual(tree(dir), TIER1, "unpacking gives back exactly the original files");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("packing again merges new files into the existing archive", () => {
  const dir = mkdtempSync(join(tmpdir(), "pack-")); try {
    put(dir, { "06_extracted_functions/a.functions.json": "A" });
    packOutputs("tier1", dir);
    put(dir, { "06_extracted_functions/b.functions.json": "B" });
    packOutputs("tier1", dir);
    unpackOutputs("tier1", dir);
    assert.deepEqual(tree(dir), { "06_extracted_functions/a.functions.json": "A", "06_extracted_functions/b.functions.json": "B" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("tier 2: pseudo-bundles, function files and packages/<package>.json are packed; the merged dataset stays", () => {
  const dir = mkdtempSync(join(tmpdir(), "pack-")); try {
    const files = {
      "01_reference_list/reference-packages.json": "[]",
      "02_downloaded_packages/acorn@8.0.0.tgz": "T", "02_downloaded_packages/download-results.json": "[]",
      "03_pseudo_bundles/bundles/acorn@8.0.0.js": "b", "03_pseudo_bundles/bundle-results.json": "[]",
      "04_extracted_functions/acorn@8.0.0.functions.json": "f", "04_extracted_functions/summary.csv": "s",
      "05_deduplicated_functions/packages/acorn.json": "p", "05_deduplicated_functions/lineages/acorn.json": "l", "05_deduplicated_functions/partials/acorn.json": "q",
      "05_deduplicated_functions/versions/acorn.csv": "v", "05_deduplicated_functions/groups/g.json": "g",
      "05_deduplicated_functions/unique_functions.jsonl": "u", "05_deduplicated_functions/summary.json": "{}",
      "logs/stream/acorn.log": "log",
    };
    put(dir, files);
    assert.equal(packOutputs("tier2", dir).length, 8);
    assert.ok(existsSync(join(dir, "05_deduplicated_functions/packages.tgz")));
    assert.ok(!existsSync(join(dir, "05_deduplicated_functions/packages")));
    assert.ok(existsSync(join(dir, "05_deduplicated_functions/unique_functions.jsonl")));
    assert.ok(existsSync(join(dir, "logs/stream/acorn.log")));
    unpackOutputs("tier2", dir);
    assert.deepEqual(tree(dir), files);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("nothing to pack leaves the folder untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "pack-")); try {
    put(dir, { "logs/01.log": "x", "04_selected_sample/selected.json": "[]" });
    assert.deepEqual(packOutputs("tier1", dir), []);
    assert.deepEqual(tree(dir), { "logs/01.log": "x", "04_selected_sample/selected.json": "[]" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
