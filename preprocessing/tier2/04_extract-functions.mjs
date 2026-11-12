// Reference pipeline, step 04: extract functions from each reference pseudo-bundle.
//
// Uses the exact same collector + feature extractor as the first pipeline's step 06
// (imported via ./lib/function-collector.mjs, which re-exports it), so the two
// datasets line up field-for-field. Because the reference pseudo-bundle is kept
// un-minified (step 03 default), each function's LOC is the real pre-minification
// line count measured directly on it — no source map needed.
//
// Usage:
//   node 04_extract-functions.mjs [bundlesDir=pseudo-bundles/bundles] [outDir=extracted-functions] \
//        [--min-loc 0] [--no-text] [--no-norm]
//   --min-loc N  keep only functions with LOC >= N (0 = keep all, 6 = the paper's library filter)
//   --no-text    omit the function source (text / textNorm) from the JSON
//   --no-norm    omit the name-normalised text / hash (textNorm / hashNorm)
//
// Writes <name>@<version>.functions.json (version: 2) per bundle + summary.csv.
// Empty bundles (EMPTY) and bundles with no functions (NO_FUNCTIONS) are listed in
// summary.csv instead of writing an empty file.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { extractWithFeatures } from "./lib/function-collector.mjs";

const args = process.argv.slice(2);
const opt = (name, fb) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fb; };
const minLoc = Number(opt("--min-loc", 0));
const includeText = !args.includes("--no-text");
const includeNorm = !args.includes("--no-norm");
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--min-loc");
const bundlesDir = resolve(positional[0] ?? "pseudo-bundles/bundles");
const outDir = resolve(positional[1] ?? "extracted-functions");

if (!existsSync(bundlesDir)) { console.error(`Bundles folder not found: ${bundlesDir}  (run step 03 first)`); process.exit(1); }
mkdirSync(outDir, { recursive: true });

const files = readdirSync(bundlesDir).filter((f) => f.endsWith(".js")).sort();
const cell = (s) => (/[",\r\n]/.test(String(s)) ? `"${String(s).replaceAll('"', '""')}"` : String(s));
const rows = [];
const started = Date.now();

for (const [i, file] of files.entries()) {
  const key = file.slice(0, -".js".length);
  const code = readFileSync(join(bundlesDir, file), "utf8");
  let line;
  if (!code.trim()) {
    rows.push([key, "EMPTY", "", "", "", 0, "empty bundle"]);
    console.log(`[${i + 1}/${files.length}] EMPTY ${key}`);
    continue;
  }
  try {
    const { records, stats } = extractWithFeatures(code, { minLoc, includeText, includeNorm });
    if (records.length === 0) {
      // Parsed fine but held no functions: list it in summary.csv instead of writing an empty file.
      rows.push([key, "NO_FUNCTIONS", stats.kept, stats.total, stats.skippedMinLoc, stats.bytes, ""]);
      line = `NO_FUNCTIONS ${key}  (0 of ${stats.total})`;
    } else {
      writeFileSync(join(outDir, `${key}.functions.json`), JSON.stringify({ bundle: file, version: 2, stats, functions: records }));
      rows.push([key, "ok", stats.kept, stats.total, stats.skippedMinLoc, stats.bytes, ""]);
      line = `ok    ${key}  (${stats.kept} functions kept of ${stats.total}${stats.unprintable ? `, ${stats.unprintable} kept as rawText` : ""})`;
    }
  } catch (e) {
    rows.push([key, "FAIL", "", "", "", Buffer.byteLength(code), String(e.message).slice(0, 200)]);
    line = `FAIL  ${key}  -> ${String(e.message).slice(0, 200)}`;
  }
  console.log(`[${i + 1}/${files.length}] ${line}  (${((Date.now() - started) / 60000).toFixed(1)} min)`);
}

writeFileSync(join(outDir, "summary.csv"), "bundle,status,functions_kept,units_total,skipped_too_short,bundle_bytes,error\n" + rows.map((r) => r.map(cell).join(",")).join("\n") + "\n");
const bad = rows.filter((r) => r[1] !== "ok").length;
console.log(`\nDone. ok=${rows.length - bad}  empty/failed/no-functions=${bad}  (see ${join(outDir, "summary.csv")})`);
