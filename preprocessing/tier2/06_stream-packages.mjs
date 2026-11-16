// Reference pipeline, STREAMED steps 02-05a: work through the tier-1 groups one package
// at a time, so only ONE package's intermediate files exist on disk at any moment.
//
// WHY: batch mode runs each step over ALL packages, so every .tgz, every pseudo-bundle and
// every per-version functions.json is on disk at the same time — hundreds of GB for a big
// reference set. Only the final per-package function collection is actually needed.
//
// WHAT IT DOES (nothing is reimplemented: steps 02/03/04 run as child processes, exactly as
// lib-pipeline-2.mjs invokes them, and the "collect" half of step 05 is imported from it):
//
//   step 01 has already fixed every package's version list in reference-packages.json.
//   for each GROUP (a tier-1 selected package + its bundled dependencies, in CSV order):
//     for each tier-2 PACKAGE of that group not already done:
//       _work/<pkgKey>/list.json   <- that package's rows of reference-packages.json
//       02_download      -> _work/<pkgKey>/02/*.tgz     (+ size and sha512 integrity recorded)
//       03_pseudo-bundle -> _work/<pkgKey>/03/bundles/*.js
//       04_extract       -> _work/<pkgKey>/04/*.functions.json
//       collect()        -> 05_deduplicated_functions/partials/<pkgKey>.state.json   (atomic)
//                           05_deduplicated_functions/versions/<pkgKey>.csv
//       keep what --keep asks for (moved into the normal batch locations), delete the rest
//     write 05_deduplicated_functions/groups/<groupKey>.json  (members + done/failed/reused)
//
// The unit of storage and dedup is the PACKAGE, not the group: a dependency shared by two
// groups (tslib, ms, ...) is processed once and "reused" afterwards. A package's partial
// existing means that package is DONE — that is the whole resume protocol.
//
// 07_merge-partials.mjs then merges the partials into the normal step-05 outputs.
//
// Usage:
//   node 06_stream-packages.mjs <outRoot> --input <tier1OutputDir|selected_dependencies.csv> \
//        [--conc 6] [--bundle-conc 4] [--min-loc 0] [--mode normalized|exact] [--strict-type] \
//        [--keep ""|02,03,04,partials|all] [--no-package] [--tgz-cache DIR]
// Env: MINIFY (0 = un-minified bundles), TAR_TIMEOUT_MIN, INCLUDE_PACKAGE=0, TGZ_CACHE
//
// --tgz-cache DIR: a folder of already-downloaded <name>@<version>.tgz files (named exactly as
// step 02 names them). A matching tarball is linked into the package's work dir before step 02
// runs, which then skips that download — for offline re-runs and for the tests, which must not
// hit the registry. Nothing else changes: step 02 still runs and still handles everything else.

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, renameSync, readdirSync, statSync, copyFileSync, linkSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { collect, packageDocument } from "./05_dedup-functions.mjs";
import { dirs } from "./lib-pipeline-2.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------------ args
const args = process.argv.slice(2);
const opt = (name, fb) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fb; };
const VALUE_FLAGS = ["--input", "--conc", "--bundle-conc", "--min-loc", "--mode", "--identity", "--keep", "--tgz-cache", "--trivial-nodes"];
const positional = args.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.includes(args[i - 1]));

const outRoot = resolve(positional[0] ?? "output2");
const INPUT = resolve(opt("--input", process.env.INPUT_DIR ?? "."));
const CONC = String(Number(opt("--conc", process.env.CONC ?? 6)));
const BUNDLE_CONC = String(Number(opt("--bundle-conc", process.env.BUNDLE_CONC ?? 4)));
const MIN_LOC = String(Number(opt("--min-loc", process.env.MIN_LOC ?? 0)));
const TRIVIAL_NODES = Number(opt("--trivial-nodes", process.env.TRIVIAL_NODES ?? 6));
const MODE = String(opt("--mode", process.env.DEDUP_MODE ?? "normalized")).toLowerCase();
const STRICT_TYPE = args.includes("--strict-type") || String(process.env.DEDUP_STRICT_TYPE ?? "0") === "1";
const INCLUDE_PACKAGE = !args.includes("--no-package") && process.env.INCLUDE_PACKAGE !== "0";
const MINIFY = String(process.env.MINIFY ?? "0");
const TGZ_CACHE = opt("--tgz-cache", process.env.TGZ_CACHE ?? "") ? resolve(opt("--tgz-cache", process.env.TGZ_CACHE)) : null;

if (!["normalized", "exact"].includes(MODE)) { console.error(`--mode must be normalized or exact (got ${MODE})`); process.exit(1); }
const IDENTITY = String(opt("--identity", process.env.DEDUP_IDENTITY ?? "string")).toLowerCase();
if (!["hash", "string"].includes(IDENTITY)) { console.error(`--identity must be hash or string (got ${IDENTITY})`); process.exit(1); }

// --keep: which intermediate artifacts survive. "" = keep nothing, "all" = keep everything.
const KEEP_RAW = String(opt("--keep", process.env.KEEP_ARTIFACTS ?? "")).trim();
const keepSet = new Set(KEEP_RAW.split(",").map((s) => s.trim()).filter(Boolean));
const KEEP_ALL = keepSet.has("all");
const keeps = (what) => KEEP_ALL || keepSet.has(what);
const UNKNOWN_KEEP = [...keepSet].filter((k) => !["02", "03", "04", "partials", "all"].includes(k));
if (UNKNOWN_KEEP.length) console.warn(`!! ignoring unknown --keep value(s): ${UNKNOWN_KEEP.join(", ")}  (use 02, 03, 04, partials or all)`);

const d = dirs(outRoot);
const WORK = join(d.OUT, "_work");
const PARTIALS = join(d.D5, "partials");
const VERSIONS_DIR = join(d.D5, "versions");
const GROUPS = join(d.D5, "groups");
const STREAM_LOGS = join(d.LOGS, "stream");
for (const p of [d.D1, d.D2, d.D3, d.D4, d.D5, d.LOGS, PARTIALS, VERSIONS_DIR, GROUPS, STREAM_LOGS]) mkdirSync(p, { recursive: true });

const refList = join(d.D1, "reference-packages.json");
if (!existsSync(refList)) { console.error(`Reference list not found: ${refList}  (run step 01 first)`); process.exit(1); }

// ------------------------------------------------------------------ helpers
const cell = (s) => (/[",\r\n]/.test(String(s ?? "")) ? `"${String(s ?? "").replaceAll('"', '""')}"` : String(s ?? ""));
// exactly how step 02 names its files, so a package's key matches its .tgz / bundle / json
const keyOf = (name) => name.replace("/", "+");

// the same CSV parser (and column detection) step 01 uses
function parseLine(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) { const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c; }
  out.push(cur); return out;
}
function findFile(...c) { for (const x of c) if (existsSync(x)) return x; return null; }

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path); // same filesystem: the rename is atomic, so a partial is never half-written
}
function moveInto(from, toDir) {
  mkdirSync(toDir, { recursive: true });
  const to = join(toDir, basename(from));
  try { renameSync(from, to); } catch { copyFileSync(from, to); rmSync(from, { force: true }); } // cross-device fallback
}
function readJsonOr(path, fb) { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fb; } }
function readCsvOr(path) {
  try {
    const lines = readFileSync(path, "utf8").split(/\r?\n/).filter((l) => l.length);
    const header = parseLine(lines[0]);
    return lines.slice(1).map((l) => { const c = parseLine(l); const r = {}; header.forEach((h, i) => (r[h] = c[i])); return r; });
  } catch { return []; }
}

// Run one of the existing step scripts as a child process, teeing its output to a kept log.
function runStep(script, scriptArgs, env, logFile) {
  const r = spawnSync(process.execPath, [join(HERE, script), ...scriptArgs], {
    cwd: HERE, env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 256 * 1024 * 1024,
  });
  const text = (r.stdout ?? "") + (r.stderr ?? "");
  try { mkdirSync(dirname(logFile), { recursive: true }); writeFileSync(logFile, `$ node ${script} ${scriptArgs.join(" ")}\n\n${text}`); } catch {}
  return { code: r.status ?? 1, text };
}

// ------------------------------------------------------------------ groups (work order)
const depsCsv = INPUT.endsWith(".csv") ? INPUT
  : findFile(join(INPUT, "05_selected_bundles", "selected_dependencies.csv"), join(INPUT, "selected_dependencies.csv"));
if (!depsCsv) { console.error(`Could not find selected_dependencies.csv under ${INPUT}`); process.exit(1); }

// every package the reference list holds, keyed the way step 02 names files
const refRows = JSON.parse(readFileSync(refList, "utf8"));
const rowsByKey = new Map();
for (const row of refRows) {
  const k = keyOf(row.name);
  if (!rowsByKey.has(k)) rowsByKey.set(k, []);
  rowsByKey.get(k).push(row);
}

// groups in CSV order: the selected package (if INCLUDE_PACKAGE) + its bundled deps,
// keeping only names the reference list actually holds (so step 01's selection.json
// toggles and INCLUDE_PACKAGE are honoured automatically).
const csvLines = readFileSync(depsCsv, "utf8").split(/\r?\n/).filter((l) => l.length);
const csvHeader = parseLine(csvLines[0]);
const depCol = csvHeader.findIndex((h) => /depend/i.test(h));
const pkgCol = csvHeader.findIndex((h) => /^package$|name/i.test(h));

const groups = [];
for (const line of csvLines.slice(1)) {
  const cells = parseLine(line);
  const anchor = cells[pkgCol >= 0 ? pkgCol : 0];
  if (!anchor) continue;
  const members = [];
  const add = (name) => { const k = keyOf(name); if (rowsByKey.has(k) && !members.includes(k)) members.push(k); };
  if (INCLUDE_PACKAGE) add(anchor);
  let deps = []; try { deps = JSON.parse(cells[depCol >= 0 ? depCol : 1] || "[]"); } catch {}
  for (const dep of deps) { const at = String(dep).lastIndexOf("@"); if (at > 0) add(String(dep).slice(0, at)); }
  groups.push({ groupKey: keyOf(anchor), anchor, members });
}
// Safety net: anything in the reference list no group reaches (step 01 adds packages that are
// in selected.json but not in the CSV). Without this the merged output would miss them and so
// would NOT equal batch mode.
const grouped = new Set(groups.flatMap((g) => g.members));
const ungrouped = [...rowsByKey.keys()].filter((k) => !grouped.has(k)).sort();
if (ungrouped.length) groups.push({ groupKey: "_ungrouped", anchor: null, members: ungrouped });

console.log(`reference list   : ${refList}  (${refRows.length} name@version, ${rowsByKey.size} packages)`);
console.log(`dependencies CSV : ${depsCsv}`);
console.log(`groups           : ${groups.length}${ungrouped.length ? `  (incl. ${ungrouped.length} package(s) in no group)` : ""}`);
console.log(`identity         : mode=${MODE} compare=${IDENTITY} strict-type=${STRICT_TYPE ? 1 : 0}   minify=${MINIFY}   min-loc=${MIN_LOC}`);
console.log(`keep artifacts   : ${KEEP_RAW || "(nothing — delete every intermediate file)"}\n`);

// ------------------------------------------------------------------ resume
// Leftover work dirs are from a killed run: a half-finished package is redone from scratch.
if (existsSync(WORK)) {
  const left = readdirSync(WORK);
  if (left.length) console.log(`resume: discarding ${left.length} leftover work dir(s) from an interrupted run: ${left.slice(0, 8).join(", ")}${left.length > 8 ? ", ..." : ""}`);
  rmSync(WORK, { recursive: true, force: true });
}
mkdirSync(WORK, { recursive: true });

const partialOf = (pkgKey) => join(PARTIALS, `${pkgKey}.state.json`);
const PACKAGES_DIR = join(d.D5, "packages");
mkdirSync(PACKAGES_DIR, { recursive: true });
const packageJsonOf = (pkgKey) => join(PACKAGES_DIR, `${pkgKey}.json`);
const done = new Set(readdirSync(PARTIALS).filter((f) => f.endsWith(".state.json")).map((f) => f.slice(0, -".state.json".length)));
const FINAL_FILES = ["unique_functions.jsonl", "occurrences.csv", "version_index.json", "summary.json"];
const finalExists = FINAL_FILES.every((f) => existsSync(join(d.D5, f)));
if (done.size) console.log(`resume: ${done.size} package(s) already have a partial — skipping them\n`);
else if (finalExists) {
  // the merge step deletes the partials when the user did not ask to keep them
  console.log(`already complete: ${d.D5} holds the final step-05 outputs and no partials remain. Nothing to do.`);
  console.log(`(to redo, delete ${d.D5} or re-run this step with a clean output folder)`);
  process.exit(0);
}

// ------------------------------------------------------------------ one package
function processPackage(pkgKey) {
  const rows = rowsByKey.get(pkgKey);
  const work = join(WORK, pkgKey);
  const w02 = join(work, "02"), w03 = join(work, "03"), w04 = join(work, "04");
  const logDir = join(STREAM_LOGS, pkgKey);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(w02, { recursive: true });

  const listFile = join(work, "list.json");
  writeFileSync(listFile, JSON.stringify(rows, null, 2) + "\n");

  // Pre-seed from a local tarball cache, if one was given: step 02 skips a .tgz that is
  // already there, so this needs no change to step 02 and no network.
  if (TGZ_CACHE) for (const row of rows) {
    const f = `${keyOf(row.name)}@${row.version}.tgz`;
    const from = join(TGZ_CACHE, f);
    if (!existsSync(from)) continue;
    try { linkSync(from, join(w02, f)); } catch { copyFileSync(from, join(w02, f)); }
  }

  // (a) download this package's versions
  const r2 = runStep("02_download.mjs", [listFile, w02, CONC], {}, join(logDir, "02_download.log"));
  const dl = readJsonOr(join(w02, "download-results.json"), []);
  const dlByVer = new Map(dl.map((x) => [x.version, x]));

  // (b) size + integrity of every .tgz, BEFORE anything is deleted.
  //     sha512 base64 is exactly npm's dist.integrity format, so a kept dataset can be
  //     checked against the registry later even though the tarball itself is gone.
  const tgz = new Map(); // version -> { bytes, integrity }
  for (const f of readdirSync(w02).filter((f) => f.endsWith(".tgz"))) {
    const at = f.slice(0, -".tgz".length).lastIndexOf("@");
    const ver = at > 0 ? f.slice(0, -".tgz".length).slice(at + 1) : "";
    const buf = readFileSync(join(w02, f));
    tgz.set(ver, { bytes: buf.length, integrity: "sha512-" + createHash("sha512").update(buf).digest("base64"), file: join(w02, f) });
  }
  if (tgz.size === 0) {
    const why = dl.find((x) => !x.ok)?.error ?? `02_download exited ${r2.code}`;
    rmSync(work, { recursive: true, force: true });
    return { status: "failed", error: `no tarball downloaded (${String(why).slice(0, 200)})` };
  }

  // (c) pseudo-bundle. Step 03 only reads UNMINIFIED=1, while the UI/shell pass MINIFY —
  //     translate here rather than touching step 03 (it is checked for faithfulness).
  const r3 = runStep("03_pseudo-bundle.mjs", [w02, w03, BUNDLE_CONC],
    MINIFY === "0" ? { UNMINIFIED: "1" } : {}, join(logDir, "03_pseudobundle.log"));
  const bundles = readJsonOr(join(w03, "bundle-results.json"), []);
  const bundleByKey = new Map(bundles.map((x) => [x.folder, x]));

  // (d) extract functions
  const bundlesDir = join(w03, "bundles");
  const r4 = existsSync(bundlesDir)
    ? runStep("04_extract-functions.mjs", [bundlesDir, w04, "--min-loc", MIN_LOC], {}, join(logDir, "04_extract_functions.log"))
    : { code: 1, text: "" };
  const summaryRows = readCsvOr(join(w04, "summary.csv"));
  const summaryByKey = new Map(summaryRows.map((r) => [r.bundle, r]));

  // (e) collect this package's functions into a partial (the "read" half of step 05)
  let state;
  try {
    state = collect(w04, { mode: MODE, strictType: STRICT_TYPE, identity: IDENTITY, log: () => {}, allowEmpty: true });
  } catch (e) {
    rmSync(work, { recursive: true, force: true });
    return { status: "failed", error: `collect failed: ${String(e.message).slice(0, 200)}` };
  }
  if (r3.code !== 0 && bundles.length === 0) { rmSync(work, { recursive: true, force: true }); return { status: "failed", error: `03_pseudo-bundle exited ${r3.code}` }; }
  if (r4.code !== 0 && state.files === 0) { rmSync(work, { recursive: true, force: true }); return { status: "failed", error: `04_extract-functions exited ${r4.code}` }; }

  // the package's own function collection: one JSON file, always kept
  writeAtomic(packageJsonOf(pkgKey), JSON.stringify(packageDocument(state, { trivialNodes: TRIVIAL_NODES, pkgKey,
    settings: { min_loc: Number(MIN_LOC), minified: MINIFY !== "0" } }), null, 1));
  writeAtomic(partialOf(pkgKey), JSON.stringify(state)); // its existence means: this package is done

  // (f) per-version record: what was downloaded, bundled and extracted — the only trace
  //     left once the intermediate files are gone.
  const vrows = [];
  for (const row of rows) {
    const vkey = `${pkgKey}@${row.version}`;
    const t = tgz.get(row.version);
    const dlr = dlByVer.get(row.version);
    const b = bundleByKey.get(vkey);
    const s = summaryByKey.get(vkey);
    const download = dlr ? (dlr.ok ? (dlr.skipped ? "skip" : "ok") : `error: ${dlr.error ?? ""}`) : (t ? "ok" : "error: not attempted");
    const bundle = b ? (b.ok ? (b.skipped ? "skip" : "ok") : `error: ${b.error ?? ""}`) : (t ? "error: not bundled" : "");
    const status = !t ? "download-failed" : !b || !b.ok ? "bundle-failed" : !s ? "extract-failed" : s.status;
    vrows.push([row.name, row.version, download, t?.bytes ?? "", t?.integrity ?? "", bundle, b?.bytes ?? "", s?.units_total ?? "", s?.functions_kept ?? "", status]);
  }
  writeFileSync(join(VERSIONS_DIR, `${pkgKey}.csv`),
    "package,version,download,tgz_bytes,tgz_integrity,bundle,bundle_bytes,functions_total,functions_kept,status\n" +
    vrows.map((r) => r.map(cell).join(",")).join("\n") + "\n");

  // (g) keep what was asked for, in the normal batch locations; then drop the work dir
  try {
    if (keeps("02")) for (const [, t] of tgz) if (existsSync(t.file)) moveInto(t.file, d.D2);
    if (keeps("03") && existsSync(bundlesDir)) for (const f of readdirSync(bundlesDir).filter((f) => f.endsWith(".js"))) moveInto(join(bundlesDir, f), join(d.D3, "bundles"));
    if (keeps("04") && existsSync(w04)) for (const f of readdirSync(w04).filter((f) => f.endsWith(".functions.json"))) moveInto(join(w04, f), d.D4);
  } catch (e) { console.warn(`  !! keeping artifacts for ${pkgKey} failed: ${String(e.message).slice(0, 200)}`); }
  rmSync(work, { recursive: true, force: true });

  const kept = vrows.filter((r) => r[9] === "ok").length;
  return { status: "done", versions: rows.length, ok_versions: kept, functions: state.total, files: state.files };
}

// ------------------------------------------------------------------ run
const started = Date.now();
let nPkgs = 0, nFailed = 0, nReused = 0;
const failures = [];

for (const [gi, g] of groups.entries()) {
  const mins = () => ((Date.now() - started) / 60000).toFixed(1);
  console.log(`\n==== group ${gi + 1}/${groups.length}: ${g.anchor ?? "(packages in no group)"}  (${g.members.length} package(s))  (${mins()} min) ====`);
  const manifest = { group: g.groupKey, anchor: g.anchor, members: [], startedAt: new Date().toISOString() };

  for (const pkgKey of g.members) {
    if (done.has(pkgKey)) {
      nReused++;
      manifest.members.push({ package: pkgKey, status: "reused" });
      console.log(`  reuse  ${pkgKey}  (already collected)`);
      continue;
    }
    let r;
    try { r = processPackage(pkgKey); }
    catch (e) { r = { status: "failed", error: String(e.message).slice(0, 300) }; }
    if (r.status === "done") {
      done.add(pkgKey); nPkgs++;
      console.log(`  done   ${pkgKey}  (${r.ok_versions}/${r.versions} versions, ${r.functions} function instances in ${r.files} file(s))`);
    } else {
      nFailed++; failures.push(`${pkgKey}: ${r.error}`);
      console.log(`  FAIL   ${pkgKey}  -> ${r.error}`);
    }
    manifest.members.push({ package: pkgKey, status: r.status, ...(r.error ? { error: r.error } : {}), ...(r.versions ? { versions: r.versions, ok_versions: r.ok_versions, functions: r.functions } : {}) });
  }

  manifest.finishedAt = new Date().toISOString();
  manifest.counts = manifest.members.reduce((a, m) => ((a[m.status] = (a[m.status] ?? 0) + 1), a), {});
  writeAtomic(join(GROUPS, `${g.groupKey}.json`), JSON.stringify(manifest, null, 2) + "\n");
}

rmSync(WORK, { recursive: true, force: true });

console.log(`\nDone. packages collected=${nPkgs}  reused=${nReused}  failed=${nFailed}  (${((Date.now() - started) / 60000).toFixed(1)} min)`);
console.log(`partials  : ${PARTIALS}  (${readdirSync(PARTIALS).filter((f) => f.endsWith(".state.json")).length} file(s))`);
console.log(`versions  : ${VERSIONS_DIR}`);
console.log(`groups    : ${GROUPS}`);
console.log(`logs      : ${STREAM_LOGS}`);
if (failures.length) {
  console.warn(`\n!! ${failures.length} package(s) failed and have NO partial — re-run this step to retry them:`);
  for (const f of failures.slice(0, 20)) console.warn(`   ${f}`);
  if (failures.length > 20) console.warn(`   ... and ${failures.length - 20} more`);
}
console.log(`\nNext: 07_merge-partials.mjs merges the partials into ${d.D5}`);

// Individual package failures do not fail the step (batch mode's 02/03/04 behave the same way:
// they report failures and exit 0, so the pipeline can continue and the run can be retried).
// Nothing collected at all IS a failure.
if (done.size === 0) { console.error(`\nNo package produced a partial — nothing to merge.`); process.exit(1); }
