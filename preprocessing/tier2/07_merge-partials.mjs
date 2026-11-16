// Reference pipeline, STREAMED step 05b: merge the per-package partials written by
// 06_stream-packages.mjs into the normal step-05 outputs.
//
// Each partial is the "collect" half of step 05 for ONE tier-2 package. Merging them and
// running the "finalize" half produces files BYTE-IDENTICAL to batch step 05 (plus
// "streamed": true in summary.json), because:
//
//   * batch reads <pkg>@<ver>.functions.json files in sorted filename order, and all of one
//     package's files are contiguous in that order — so merging the partials in ascending
//     order of each one's smallest filename key replays exactly the batch traversal;
//   * on merge the first state holding a function id wins its first-seen fields, which is
//     what batch does when it fills a record the first time it meets the id;
//   * raw-variant counts are summed while keeping first-insertion order, so ties in the
//     "most common raw variant" break the same way.
//
// TRIVIAL_NODES and NEAR_THRESHOLD are applied here, not in the partials, so kept partials
// can be re-finalized with different values without re-downloading anything. DEDUP_MODE and
// DEDUP_STRICT_TYPE are baked into the partials (identity is computed while collecting);
// changing those needs a fresh stream run, and a mismatch is rejected loudly.
//
// Usage:
//   node 07_merge-partials.mjs [outDir=05_deduplicated_functions] \
//        [--trivial-nodes 6] [--near 0.85] [--near-min-nodes 20] [--keep-partials]
//
// Writes the usual unique_functions.jsonl, occurrences.csv, version_index.json,
// near_duplicates.csv (with --near) and summary.json, then deletes the partials unless
// --keep-partials was given.

import { readFileSync, readdirSync, existsSync, rmSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { mergeStates, finalize, packageDocument } from "./05_dedup-functions.mjs";

const args = process.argv.slice(2);
const opt = (name, fb) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fb; };
const VALUE_FLAGS = ["--trivial-nodes", "--near", "--near-min-nodes"];
const positional = args.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.includes(args[i - 1]));

const outDir = resolve(positional[0] ?? "deduplicated-functions");
const partialsDir = join(outDir, "partials");
const nearRaw = opt("--near", process.env.NEAR_THRESHOLD ?? "");
const near = nearRaw === "" || Number(nearRaw) <= 0 ? null : Number(nearRaw);
const trivialNodes = Number(opt("--trivial-nodes", process.env.TRIVIAL_NODES ?? 6));
const nearMinNodes = Number(opt("--near-min-nodes", 20));
const keepPartials = args.includes("--keep-partials")
  || String(process.env.KEEP_ARTIFACTS ?? "").split(",").map((s) => s.trim()).some((s) => s === "partials" || s === "all");

const t0 = Date.now();
const FINAL_FILES = ["unique_functions.jsonl", "occurrences.csv", "version_index.json", "summary.json"];
const files = existsSync(partialsDir) ? readdirSync(partialsDir).filter((f) => f.endsWith(".state.json")) : [];

if (!files.length) {
  if (FINAL_FILES.every((f) => existsSync(join(outDir, f)))) {
    console.log(`already complete: no partials left in ${partialsDir} and ${outDir} holds the final outputs. Nothing to do.`);
    process.exit(0);
  }
  console.error(`No partials found in ${partialsDir}  (run the stream step first)`);
  process.exit(1);
}

console.log(`merging ${files.length} package partial(s) from ${partialsDir}`);
const states = [];
for (const f of files) {
  try { states.push(JSON.parse(readFileSync(join(partialsDir, f), "utf8"))); }
  catch (e) { console.error(`unreadable partial ${f}: ${e.message}`); process.exit(1); }
}

// Every package has its own JSON file (written by the stream step); write any that is missing.
{
  const pdir = join(outDir, "packages"); mkdirSync(pdir, { recursive: true });
  let added = 0;
  for (const [i, f] of files.entries()) {
    const pkgKey = f.slice(0, -".state.json".length), out = join(pdir, `${pkgKey}.json`);
    if (existsSync(out)) continue;
    writeFileSync(out + ".tmp", JSON.stringify(packageDocument(states[i], { trivialNodes, pkgKey }), null, 1));
    renameSync(out + ".tmp", out); added++;
  }
  if (added) console.log(`  wrote ${added} missing per-package file(s) to ${pdir}`);
}

// Replay batch mode's file order: ascending smallest-filename key per package.
states.sort((a, b) => (a.firstFile === b.firstFile ? 0 : (a.firstFile ?? "") < (b.firstFile ?? "") ? -1 : 1));

let merged;
try { merged = mergeStates(states); }
catch (e) { console.error(String(e.message)); process.exit(1); }
console.log(`  ${merged.files} functions file(s), ${merged.total} function instances, ${merged.uniq.length} unique`);

const summary = finalize(merged, outDir, { trivialNodes, near, nearMinNodes, extra: { streamed: true }, t0 });
console.log(JSON.stringify(summary, null, 2));

if (keepPartials) {
  console.log(`\nkept the partials in ${partialsDir} (re-run this step to re-finalize with other TRIVIAL_NODES / NEAR_THRESHOLD values)`);
} else {
  rmSync(partialsDir, { recursive: true, force: true });
  console.log(`\ndeleted the partials (KEEP_ARTIFACTS did not list "partials")`);
}
console.log(`\nDone. ${summary.function_instances} function instances -> ${summary.unique_functions} unique (${summary.dedup_ratio}x)  (see ${outDir})`);
