// Tier 3 · step 01: build the search index from the tier-2 reference dataset.
//
// Reads tier 2's 05_deduplicated_functions/packages/<package>.json (and lineages/<package>.json
// when the lineage step ran) and writes the index tier 3 searches (see lib/index.mjs):
//   <outDir>/meta.json, records.json, sigs.bin, lineages/<package>.json
//
// Usage:
//   node 01_build-index.mjs <tier2 05_deduplicated_functions> <outDir> [--force]
//
// Safe to run again: an index built from the same tier-2 files (same names, sizes and
// modification times) is kept; --force rebuilds it anyway.

import { existsSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildIndex, sourceSignature, INDEX_VERSION } from "./lib/index.mjs";

const args = process.argv.slice(2);
const pos = args.filter((a) => !a.startsWith("--"));
const force = args.includes("--force");
if (pos.length < 2) { console.error("usage: node 01_build-index.mjs <tier2 05_deduplicated_functions> <outDir> [--force]"); process.exit(2); }
const src = resolve(pos[0]), out = resolve(pos[1]);

if (!existsSync(join(src, "packages"))) {
  console.error(`no per-package files in ${join(src, "packages")}: run tier 2 (streamed mode) first`);
  process.exit(1);
}

const sig = sourceSignature(src);
const metaFile = join(out, "meta.json");
if (!force && existsSync(metaFile)) {
  try {
    const m = JSON.parse(readFileSync(metaFile, "utf8"));
    if (m.index_version === INDEX_VERSION && m.source_signature === sig) {
      console.log(`index is up to date (${m.records} functions of ${m.packages.length} packages, built ${m.built_at}); --force rebuilds it`);
      process.exit(0);
    }
    console.log("the tier-2 files changed since the index was built: rebuilding");
  } catch { console.log("the existing index cannot be read: rebuilding"); }
}

rmSync(join(out, "lineages"), { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const t0 = Date.now();
const meta = buildIndex(src, out, { log: (s) => console.log(s) });
const lin = meta.packages.filter((p) => p.hasLineages).length;
console.log(`RESULT | index built | ${meta.records} non-trivial functions | ${meta.packages.length} packages (${lin} with lineages) | ${((Date.now() - t0) / 1000).toFixed(0)}s`);
