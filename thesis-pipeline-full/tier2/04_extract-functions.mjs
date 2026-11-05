// Reference pipeline, step 04: extract functions from each reference pseudo-bundle.
//
// Same DEBUN function collector as the first pipeline's step 06. Because the
// reference pseudo-bundle is kept un-minified (step 03 default), each function's LOC
// is the real pre-minification line count measured directly on it — no source map
// needed. The output format matches step 06 so the two datasets line up.
//
// Usage:
//   node 04_extract-functions.mjs [bundlesDir=pseudo-bundles/bundles] [outDir=extracted-functions] \
//        [--min-loc 0] [--no-text]
//   --min-loc N  keep only functions with LOC >= N (0 = keep all, 6 = the paper's library filter)
//   --no-text    omit the function source from the JSON
//
// Writes <name>@<version>.functions.json per bundle + summary.csv.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import escodegen from "escodegen";
import { extractFunctions } from "./lib/function-collector.mjs";

const args = process.argv.slice(2);
const opt = (name, fb) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fb; };
const minLoc = Number(opt("--min-loc", 0));
const includeText = !args.includes("--no-text");
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
  try {
    const { functions: kept, stats } = extractFunctions(code, { minLoc });
    let unprintable = 0;
    const out = kept.map((fn, index) => {
      let text = null;
      try { text = escodegen.generate(fn.body); } catch { unprintable++; }
      const rec = { index, id: fn.id, type: fn.body.type, loc: fn.loc, hash: text === null ? null : createHash("sha256").update(text).digest("hex").slice(0, 16) };
      if (includeText) rec.text = text;
      return rec;
    });
    writeFileSync(join(outDir, `${key}.functions.json`), JSON.stringify({ bundle: file, stats: { ...stats, unprintable }, functions: out }, null, 1));
    rows.push([key, "ok", stats.kept, stats.total, stats.skippedMinLoc, Buffer.byteLength(code), ""]);
    line = `ok    ${key}  (${stats.kept} of ${stats.total}${stats.skippedMinLoc ? `, ${stats.skippedMinLoc} too short` : ""})`;
  } catch (e) {
    rows.push([key, "FAIL", "", "", "", Buffer.byteLength(code), String(e.message).slice(0, 200)]);
    line = `FAIL  ${key}  -> ${String(e.message).slice(0, 200)}`;
  }
  console.log(`[${i + 1}/${files.length}] ${line}  (${((Date.now() - started) / 60000).toFixed(1)} min)`);
}

writeFileSync(join(outDir, "summary.csv"), "bundle,status,functions_kept,units_total,skipped_too_short,bundle_bytes,error\n" + rows.map((r) => r.map(cell).join(",")).join("\n") + "\n");
const failed = rows.filter((r) => r[1] === "FAIL").length;
console.log(`\nDone. extracted=${rows.length - failed}  failed=${failed}  (see ${join(outDir, "summary.csv")})`);
