// Reference pipeline, streamed step 06: function lineages — the history of every function of
// each package across its versions, and the code markers that tell its variants apart.
// See lib/lineage.mjs for the method. Not part of Aletheia or Debun.
//
// Writes, per package:
//   lineages/<pkg>.json   { package, settings, source, summary, function_index, lineages: [
//                           { lineage, born, last_seen, status, variants, events,
//                             markers, identify } ] }
// and adds only this to existing files:
//   packages/<pkg>.json      every function: "lineage" (the id of its lineage's first variant)
//   unique_functions.jsonl   each record's "packages.<pkg>" entry: "lineage"
// (Fields an earlier version of this step put in packages/<pkg>.json — "edit",
// "lineage_info" — are moved out: they live in the lineage file now.)
//
// Resumable: a package whose lineage file was made with the same settings from the same
// package file is skipped.
//
// Usage:
//   node 08_link-edits.mjs [dedupDir=05_deduplicated_functions] [--min-similarity 0.5]
//        [--include-trivial] [--max-rule 3]

import { readFileSync, writeFileSync, renameSync, readdirSync, existsSync, mkdirSync, statSync, createReadStream, createWriteStream } from "node:fs";
import { isPackageFile, keyOfPackageFile, readJsonFile, writeJsonFile } from "./lib/json-gz.mjs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { analyzePackage } from "./lib/lineage.mjs";

const args = process.argv.slice(2);
const VALUE_FLAGS = ["--min-similarity", "--max-rule"];
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const positional = args.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.includes(args[i - 1]));
const D5 = resolve(positional[0] ?? "05_deduplicated_functions");
const PKG = join(D5, "packages"), LIN = join(D5, "lineages");
const settings = {
  min_similarity: Number(opt("--min-similarity", "0.5")), include_trivial: args.includes("--include-trivial"),
  max_rule: Number(opt("--max-rule", "3")), method: "anchored-token-v2",
  marker_test: "tokens of textNorm (v0, v1, … masked to v), space separated; a marker is present when \" \" + marker + \" \" occurs in \" \" + tokens + \" \"",
};
if (!(settings.min_similarity > 0 && settings.min_similarity <= 1)) { console.error("--min-similarity must be in (0, 1]"); process.exit(2); }
if (!(settings.max_rule >= 1)) { console.error("--max-rule must be ≥ 1"); process.exit(2); }
if (!existsSync(PKG)) { console.error(`no per-package files in ${PKG}: this step needs streamed tier 2 (its stream step writes packages/<package>.json)`); process.exit(1); }
mkdirSync(LIN, { recursive: true });

const files = readdirSync(PKG).filter(isPackageFile).sort();
console.log(`packages    : ${PKG}  (${files.length} file(s))`);
console.log(`lineages    : ${LIN}`);
console.log(`settings    : min similarity ${settings.min_similarity}, trivial functions ${settings.include_trivial ? "included" : "left out"}, at most ${settings.max_rule} markers per rule\n`);

const writeAtomic = (file, text) => { writeFileSync(file + ".tmp", text); renameSync(file + ".tmp", file); };
const sameSettings = (a) => JSON.stringify(a) === JSON.stringify(settings);
const total = { lineages: 0, edited_lineages: 0, events: {}, edit_kinds: {}, variants_in_edited_lineages: 0, variants_unique: 0, markers: 0 };
const add = (into, from) => { for (const [k, v] of Object.entries(from)) into[k] = typeof v === "object" ? add(into[k] ?? {}, v) : (into[k] ?? 0) + v; return into; };
const lineageOf = new Map(); // `${pkgKey}\0${id}` -> lineage, for unique_functions.jsonl
let done = 0, skipped = 0, failed = 0;

for (const [i, f] of files.entries()) {
  const file = join(PKG, f), pkgKey = keyOfPackageFile(f), out = join(LIN, `${pkgKey}.json`), t0 = Date.now();
  try {
    const st = statSync(file);
    let prev = null; try { prev = JSON.parse(readFileSync(out, "utf8")); } catch {}
    if (prev && sameSettings(prev.settings) && prev.source?.size === st.size && prev.source?.mtimeMs === st.mtimeMs) {
      for (const [id, l] of Object.entries(prev.function_index)) lineageOf.set(`${pkgKey}\0${id}`, l);
      add(total, prev.summary); skipped++;
      console.log(`[${i + 1}/${files.length}] done  ${prev.package}  (already linked)`);
      continue;
    }
    const doc = readJsonFile(file);
    const r = analyzePackage(doc, { minSimilarity: settings.min_similarity, includeTrivial: settings.include_trivial, maxRule: settings.max_rule });
    // the package file: only the lineage tag per function (and nothing from an older version of this step)
    for (const fn of doc.functions) { delete fn.edit; delete fn.lineage; fn.lineage = r.index[fn.id]; }
    delete doc.lineage_info;
    writeJsonFile(file, doc, file.endsWith(".gz") ? undefined : 1);
    const st2 = statSync(file);
    writeAtomic(out, JSON.stringify({
      package: doc.package, versions: doc.versions.length, settings,
      source: { file: `packages/${f}`, size: st2.size, mtimeMs: st2.mtimeMs },
      summary: r.summary, function_index: r.index, lineages: r.lineages,
    }, null, 1));
    for (const [id, l] of Object.entries(r.index)) lineageOf.set(`${pkgKey}\0${id}`, l);
    add(total, r.summary); done++;
    const s = r.summary;
    console.log(`[${i + 1}/${files.length}] ok    ${doc.package}  ${doc.versions.length} versions, ${doc.functions.length} functions → ${s.edited_lineages} edited lineages, ${s.events.edited + s.events.reverted} edits, ${s.markers} markers, ${s.variants_unique}/${s.variants_in_edited_lineages} variants identifiable  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    failed++;
    console.log(`[${i + 1}/${files.length}] FAIL  ${pkgKey}: ${String(e.message).slice(0, 200)}`);
  }
}

// the merged, cross-package file: the lineage in each record's per-package entry
const U = join(D5, "unique_functions.jsonl");
if (existsSync(U)) {
  const w = createWriteStream(U + ".tmp");
  const rl = createInterface({ input: createReadStream(U), crlfDelay: Infinity });
  let n = 0;
  for await (const line of rl) {
    if (!line) continue;
    const rec = JSON.parse(line);
    for (const p of Object.keys(rec.packages ?? {})) { const l = lineageOf.get(`${p}\0${rec.id}`); if (l) rec.packages[p].lineage = l; }
    if (!w.write(JSON.stringify(rec) + "\n")) await new Promise((res) => w.once("drain", res));
    n++;
  }
  await new Promise((res) => w.end(res));
  renameSync(U + ".tmp", U);
  console.log(`\nunique_functions.jsonl: lineage added to ${n} record(s)`);
} else console.log(`\n(no unique_functions.jsonl — the lineage tags are in packages/ and lineages/)`);

const ek = total.edit_kinds ?? {}, sum = Object.values(ek).reduce((a, b) => a + b, 0) || 1;
console.log(`\nDone. ${files.length} package(s): ${done} linked now, ${skipped} already linked, ${failed} failed`);
console.log(`lineages   : ${total.lineages} (${total.edited_lineages} with edits)`);
console.log(`events     : ${Object.entries(total.events).map(([k, n]) => `${k} ${n}`).join(", ")}`);
console.log(`edit kinds : ${Object.entries(ek).sort((a, b) => b[1] - a[1]).map(([x, n]) => `${x} ${n} (${((100 * n) / sum).toFixed(1)}%)`).join(", ")}`);
console.log(`markers    : ${total.markers}; variants identifiable by markers: ${total.variants_unique} of ${total.variants_in_edited_lineages} (${((100 * total.variants_unique) / (total.variants_in_edited_lineages || 1)).toFixed(1)}%)`);
if (failed) process.exit(1);
