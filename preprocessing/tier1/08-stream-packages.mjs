// Tier 1, STREAMED: one package at a time, keeping only what is needed.
//
// For each package in the list:
//   1. download it with its dependencies      02-download-with-deps.mjs   (unchanged)
//   2. check it can be bundled at all          lib/bundleable.mjs          (webpack's own resolver)
//   3. bundle it and write its SBOM            03-bundle-and-sbom.mjs      (unchanged, faithful)
//   4. move the bundle, source map, SBOM and modules report into the bundle folder,
//      then DELETE the download and every working file
// so at any moment only the packages being worked on are on disk.
// With --claude, a package the bundler fails on is POSTPONED: its download is parked in
// <packagesDir>/_postponed/<folder>/ and the stream moves on. Once every package has been
// streamed, Claude repairs the postponed ones (07-claude-repair-bundles.mjs, unchanged), one
// after another, and each parked download is deleted when its repair is done.
//
// Kept:    <bundleOutRoot>/bundles/*.min.js(.map), sbom/, modules/   — the test bed
//          <bundleOutRoot>/summary.json / .csv / manifest.jsonl        — same format as step 03
//          <bundleOutRoot>/claude_repair/<folder>/ + report.json/.csv — Claude's standardized reports
//          <bundleOutRoot>/stream/records/<folder>.json  one record per package (its done marker)
//          <bundleOutRoot>/stream/results.csv            one standard row per package
//          <bundleOutRoot>/stream/logs/<folder>/          the logs of each step for that package
//          <packagesDir>/download-results.json           same format as step 02
//          <packagesDir>/_postponed/<folder>/            only while a failed package waits for Claude
// Deleted: the downloaded .tgz (unless --keep downloads), the unpacked package, pnpm's cache.
//
// Every package ends with one standard line:
//   RESULT | <name>@<version> | <outcome> | <category> | <cause or details>
// outcome: bundled | bundled_without_missing_deps | repaired_by_claude | skipped_not_bundleable | bundle_failed | download_failed
//          | skipped_no_dependencies; category: see lib/failures.mjs.
//
// Usage:
//   node 08-stream-packages.mjs <list.json> <packagesDir> <bundleOutRoot>
//        [--conc 4] [--bundle-conc 1] [--limit all] [--keep downloads] [--no-check] [--work-dir DIR]
//        [--claude] [--max 20] [--max-turns 40] [--timeout-min 20] [--budget-usd X] [--model M] [--claude-bin claude]
// Env passed on unchanged: ONLY_WITH_DEPS (download), UNMINIFIED / HEAP_MB (bundler), PM.
// Safe to stop and re-run: finished packages (with a record) are skipped.

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, renameSync, readdirSync, cpSync, createWriteStream } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkBundleable } from "./lib/bundleable.mjs";
import { categorizeError, resultLine } from "./lib/failures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (n, fb) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : fb; };
const VALUE_FLAGS = ["--work-dir", "--conc", "--bundle-conc", "--limit", "--keep", "--max", "--max-turns", "--timeout-min", "--budget-usd", "--model", "--claude-bin"];
const positional = args.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.includes(args[i - 1]));
const listPath = resolve(positional[0] ?? "list.json");
const D2 = resolve(positional[1] ?? "packages");
const D3 = resolve(positional[2] ?? "bundles");
const CONC = Math.max(1, Number(opt("--conc", 4)) || 4);
const BUNDLE_CONC = Math.max(1, Number(opt("--bundle-conc", 1)) || 1);
const LIMIT = opt("--limit", "all") === "all" ? Infinity : Number(opt("--limit"));
const KEEP = new Set(String(opt("--keep", "")).split(",").map((s) => s.trim()).filter(Boolean));
const CHECK = !args.includes("--no-check");
const CLAUDE = args.includes("--claude");
const CLAUDE_MAX = Math.max(0, Number(opt("--max", 20)) || 0);
const claudeArgs = ["--max", "1"];
for (const f of ["--max-turns", "--timeout-min", "--budget-usd", "--model", "--claude-bin"]) if (opt(f) != null && opt(f) !== "") claudeArgs.push(f, opt(f));

// --work-dir: where each package is unpacked and bundled (thousands of small files per
// package). Default: inside the packages folder. Point it at a fast local disk when the output
// lives on a drive that struggles with many small files.
const WORK = opt("--work-dir") ? join(resolve(opt("--work-dir")), `tier1-stream-${createHash("sha1").update(D2).digest("hex").slice(0, 8)}`) : join(D2, "_stream");
const STREAM = join(D3, "stream"), RECORDS = join(STREAM, "records"), LOGS = join(STREAM, "logs"), PARK = join(D2, "_postponed"), TRASH = `${WORK}-undeleted`;
for (const d of [D2, D3, RECORDS, LOGS]) mkdirSync(d, { recursive: true });

// Delete a working folder without ever stopping the run: retry, then move it aside into
// TRASH (deleted again at the end), then give up with a warning. A failed delete is a disk
// problem (e.g. EIO), never a reason to lose the packages still to come.
let undeleted = 0;
function safeRm(p, quiet = false) {
  try { rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); return true; }
  catch (e) {
    const why = `${e.code || e.errno || ""} ${String(e.message).split("\n")[0].slice(0, 120)}`.trim();
    try {
      mkdirSync(TRASH, { recursive: true });
      renameSync(p, join(TRASH, `${basename(p)}-${Date.now()}`));
      if (!quiet) console.log(`  warning: could not delete ${p} (${why}); moved it to ${TRASH}, the run continues`);
    } catch { if (!quiet) console.log(`  warning: could not delete ${p} (${why}); left in place, the run continues`); }
    undeleted++;
    return false;
  }
}
safeRm(WORK); safeRm(TRASH, true); // leftovers of an interrupted run
const folderName = (n) => n.replace(/^@/, "").replace("/", "__");
const bundleKey = (name, version) => `${name.replace("/", "+")}@${version}`;
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const tryJson = (p) => { try { return readJson(p); } catch { return null; } };
// an error as one line, with a failed command's own message (e.g. tar's "Input/output error")
const errText = (e) => `${String(e.stderr ?? "").trim().split("\n").filter(Boolean).at(-1) || String(e.message).split("\n")[0]}`.slice(0, 240);
const writeAtomic = (p, text) => { writeFileSync(p + ".tmp", text); renameSync(p + ".tmp", p); };
const cell = (s) => (/[",\r\n]/.test(String(s ?? "")) ? `"${String(s ?? "").replaceAll('"', '""')}"` : String(s ?? ""));

// Preflight: the tools every package needs. Without them each package would "fail" for a
// reason that has nothing to do with the package, so stop now with one clear message.
{
  const missing = [];
  const has = async (m) => { try { await import(m); return true; } catch { return false; } };
  for (const m of ["webpack", "css-loader", "file-loader", "ts-loader"]) if (!(await has(m))) missing.push(m);
  // webpack's minifier: newer webpack ships "minimizer-webpack-plugin", older "terser-webpack-plugin"
  if (!missing.includes("webpack") && !(await has("minimizer-webpack-plugin")) && !(await has("terser-webpack-plugin"))) missing.push("webpack's minimizer plugin");
  try { execFileSync("tar", ["--version"], { stdio: "ignore" }); } catch { missing.push("tar (command)"); }
  if (!missing.length) {
    const { readFileSync: r } = await import("node:fs"), { createRequire } = await import("node:module");
    try {
      const pj = createRequire(import.meta.url).resolve("webpack/package.json"), v = JSON.parse(r(pj, "utf8")).version;
      let pinned = null; try { pinned = JSON.parse(r(join(dirname(HERE), "package-lock.json"), "utf8")).packages?.["node_modules/webpack"]?.version ?? null; } catch {}
      console.log(`webpack     : ${v}  (${dirname(pj)})`);
      if (pinned && v !== pinned) console.log(`WARNING     : the pipeline pins webpack ${pinned}, but ${v} is used. Delete ${join(HERE, "node_modules")} if it exists, then run \`npm ci\` in ${dirname(HERE)} (or Setup).`);
    } catch {}
  }
  if (missing.length) {
    console.error(`ERROR: missing ${missing.join(", ")}. Install the pipeline's tools once: run \`npm install\` in ${dirname(HERE)} (or the "Setup" step), then Continue.`);
    process.exit(1);
  }
}

const list = readJson(listPath).slice(0, LIMIT);
// A record means the package is done — unless it ended in an error of the machine rather than
// of the package (download failed, a disk error, a missing tool): those are tried again.
// A bundler crash counts only if the bundler passed its self-test in that run (toolsOk); one
// recorded without it may have been a broken tool install, so it is tried again.
const isRetry = (r) => !!r && (r.retry === true || r.outcome === "download_failed" || /^stream driver error/.test(r.cause ?? "")
  || (r.category === "bundler_crash" && !r.toolsOk));
const retrying = [];
const done = new Set(readdirSync(RECORDS).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5))
  .filter((f) => { const r = tryJson(join(RECORDS, `${f}.json`)); if (isRetry(r)) { retrying.push(f); return false; } return true; }));
console.log(`list        : ${listPath}  (${list.length} package(s); ${list.filter((p) => done.has(folderName(p.name))).length} already done${retrying.length ? `, ${retrying.length} tried again after a download/disk/tool error` : ""})`);
console.log(`bundles     : ${D3}`);
console.log(`working in  : ${WORK}  (deleted after each package${KEEP.has("downloads") ? "; downloads kept in " + D2 : ""})`);
console.log(`check       : ${CHECK ? "on (webpack's resolver, before bundling)" : "off"}   Claude repair: ${CLAUDE ? `on, after all packages are streamed (at most ${CLAUDE_MAX} package(s) this run)` : "off"}`);
console.log(`parallel    : ${CONC} package(s) at once, ${BUNDLE_CONC} bundling at once\n`);

// ---- small helpers ------------------------------------------------------------------
function runNode(script, scriptArgs, env, logFile, onLine) {
  return new Promise((res) => {
    mkdirSync(dirname(logFile), { recursive: true });
    const log = createWriteStream(logFile);
    log.write(`$ node ${script} ${scriptArgs.join(" ")}\n\n`);
    const p = spawn(process.execPath, [join(HERE, script), ...scriptArgs], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    p.stdout.on("data", (c) => { log.write(c); if (onLine) { buf += c; const ls = buf.split("\n"); buf = ls.pop(); ls.forEach(onLine); } });
    p.stderr.on("data", (c) => log.write(c));
    p.on("close", (code) => { if (onLine && buf) onLine(buf); log.end(); res(code ?? 1); });
    p.on("error", (e) => { log.end(String(e)); res(1); });
  });
}
function semaphore(n) {
  let free = n; const q = [];
  return async (fn) => { if (free === 0) await new Promise((r) => q.push(r)); free--; try { return await fn(); } finally { free++; q.shift()?.(); } };
}
const bundleSlot = semaphore(BUNDLE_CONC);
const bundlerEnv = Object.fromEntries(["UNMINIFIED", "HEAP_MB"].filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
// move a file or folder (across disks too, when --work-dir is on another one)
function moveInto(from, toDir) { mkdirSync(toDir, { recursive: true }); const to = join(toDir, basename(from)); safeRm(to); try { renameSync(from, to); } catch { cpSync(from, to, { recursive: true }); safeRm(from); } return to; }

// ---- one package ----------------------------------------------------------------------
async function streamOne(item) {
  const folder = folderName(item.name);
  const work = join(WORK, folder), pk = join(work, "packages"), out = join(work, "out"), logs = join(LOGS, folder);
  safeRm(work); mkdirSync(pk, { recursive: true });
  const rec = { rank: item.rank, name: item.name, folder, version: null, at: null };
  safeRm(join(PARK, folder)); // streamed again: an older parked download is stale
  try {
    // 1. download (step 02, one package) — or take a download already in the packages folder
    //    (e.g. from an earlier batch run); it is deleted afterwards like any other
    let dl;
    const have = join(D2, `${folder}.tgz`), haveMeta = tryJson(join(D2, `${folder}.meta.json`));
    if (existsSync(have) && haveMeta?.name) {
      for (const f of [`${folder}.tgz`, `${folder}.meta.json`]) moveInto(join(D2, f), pk);
      dl = { rank: item.rank, name: item.name, ok: true, skipped: true, version: haveMeta.version };
    } else {
      writeFileSync(join(work, "list.json"), JSON.stringify([item]));
      await runNode("02-download-with-deps.mjs", [join(work, "list.json"), pk, "1", "all"], { ONLY_WITH_DEPS: process.env.ONLY_WITH_DEPS ?? "0" }, join(logs, "02_download.log"));
      dl = (tryJson(join(pk, "download-results.json")) ?? [])[0] ?? { rank: item.rank, name: item.name, ok: false, error: "download step wrote no result" };
    }
    rec.download = dl;
    if (!dl.ok) { rec.retry = true; return finish(rec, "download_failed", "download_failed", dl.error); }
    if (dl.noDependencies) return finish(rec, "skipped_no_dependencies", "", "no runtime dependencies (excluded, as in batch mode)");
    const meta = tryJson(join(pk, `${folder}.meta.json`)) ?? { name: item.name, version: dl.version };
    rec.version = meta.version;
    const key = bundleKey(meta.name, meta.version), id = `${meta.name}@${meta.version}`;

    // 2. can it be bundled at all?
    if (CHECK) {
      const x = join(work, "check"); mkdirSync(x, { recursive: true });
      execFileSync("tar", ["-xzf", join(pk, `${folder}.tgz`), "-C", x], { stdio: ["ignore", "ignore", "pipe"] });
      rec.check = await checkBundleable(x, meta.name);
      safeRm(x);
      if (!rec.check.bundleable) {
        rec.bundle = { id, folder, name: meta.name, version: meta.version, ok: false, error: `not bundleable: ${rec.check.reason}`, skippedBy: "check", category: rec.check.category };
        return finish(rec, "skipped_not_bundleable", rec.check.category, rec.check.reason);
      }
    }

    // 3. bundle + SBOM (step 03, one package, into a private folder first)
    await bundleSlot(() => runNode("03-bundle-and-sbom.mjs", [pk, out, "1"], bundlerEnv, join(logs, "03_bundle.log")));
    let entry = (tryJson(join(out, "summary.json")) ?? [])[0] ?? { id, folder, name: meta.name, version: meta.version, ok: false, error: "bundler wrote no summary" };

    // 4. bundling failed and Claude is on: park the download, repair it at the end
    if (!entry.ok && CLAUDE) {
      const park = join(PARK, folder);
      safeRm(park); mkdirSync(park, { recursive: true });
      moveInto(pk, park); // -> park/packages
      writeFileSync(join(park, "failed.json"), JSON.stringify(entry, null, 2));
      rec.claude_pending = true;
    }
    return keepResults(rec, entry, out, key, meta.name);
  } catch (e) {
    rec.retry = true; // not the package's fault: try it again on the next run
    return finish(rec, "bundle_failed", "other", `stream driver error: ${errText(e)}`);
  } finally {
    try { if (KEEP.has("downloads")) for (const f of [`${folder}.tgz`, `${folder}.meta.json`]) if (existsSync(join(pk, f))) moveInto(join(pk, f), D2); }
    catch (e) { console.log(`  warning: could not keep the download of ${folder} (${e.code || ""} ${String(e.message).slice(0, 120)})`); }
    safeRm(work);
  }
}

// keep a package's results in the bundle folder, with their final paths, and end its record
function keepResults(rec, entry, out, key, name) {
  for (const sub of ["bundles", "sbom", "modules"]) {
    const from = join(out, sub);
    if (existsSync(from)) for (const f of readdirSync(from)) moveInto(join(from, f), join(D3, sub));
  }
  if (entry.ok) {
    entry.outFile = join(D3, "bundles", `${key}.min.js`);
    if (entry.sourceMapFile) entry.sourceMapFile = join(D3, "bundles", `${key}.min.js.map`);
  }
  rec.bundle = entry;
  if (entry.ok) {
    const left = entry.missingDepsRemoved ?? rec.download?.missingDepsRemoved ?? [];
    const how = entry.bundledBy === "claude-repair" ? "repaired_by_claude" : left.length ? "bundled_without_missing_deps" : "bundled";
    return finish(rec, how, how === "repaired_by_claude" ? rec.claude?.category ?? "" : "",
      `${entry.dependenciesInBundle ?? "?"} dependencies bundled, ${entry.bundleBytes} bytes${left.length ? `; left out ${left.length} dependenc${left.length > 1 ? "ies" : "y"} not on npm: ${left.slice(0, 5).join(", ")}${left.length > 5 ? ", …" : ""}` : ""}`);
  }
  const cat = rec.claude?.category ?? categorizeError(entry.error, name);
  return finish(rec, "bundle_failed", cat, rec.claude_pending ? `postponed for Claude repair — ${entry.error}` : rec.claude?.cause ?? entry.error);
}

let finished = 0, total = list.filter((p) => !done.has(folderName(p.name))).length;
function finish(rec, outcome, category, cause) {
  Object.assign(rec, { toolsOk, outcome, category: category || "", cause: String(cause ?? "").split("\n")[0].slice(0, 300), at: new Date().toISOString() });
  writeAtomic(join(RECORDS, `${rec.folder}.json`), JSON.stringify(rec, null, 2));
  finished++;
  console.log(`[${finished}/${total}] ${resultLine(rec.version ? `${rec.name}@${rec.version}` : rec.name, outcome, category, rec.cause)}`);
  return rec;
}

// ---- self-test: bundle a tiny package with the real, unchanged bundler ------------------
// If the tools are broken (e.g. a damaged node_modules: "x is not a function" inside webpack's
// minifier), every package would fail for that reason. Stop before touching any package.
let toolsOk = false;
{
  const st = join(WORK, "_selftest"), pk = join(st, "packages"), tree = join(st, "tree"), out = join(st, "out"), lib = join(tree, "node_modules", "selftest-pkg");
  safeRm(st); mkdirSync(lib, { recursive: true }); mkdirSync(pk, { recursive: true });
  writeFileSync(join(tree, "package.json"), JSON.stringify({ name: "holder", version: "1.0.0", private: true }));
  writeFileSync(join(lib, "package.json"), JSON.stringify({ name: "selftest-pkg", version: "1.0.0", main: "index.js" }));
  writeFileSync(join(lib, "index.js"), "export function add(a, b) {\n  const s = a + b;\n  return s;\n}\nexport const twice = (x) => add(x, x);\nexport default { add, twice };\n");
  writeFileSync(join(pk, "selftest-pkg.meta.json"), JSON.stringify({ name: "selftest-pkg", version: "1.0.0" }));
  let e = null;
  try {
    execFileSync("tar", ["-czf", join(pk, "selftest-pkg.tgz"), "-C", tree, "."], { stdio: ["ignore", "ignore", "pipe"] });
    await runNode("03-bundle-and-sbom.mjs", [pk, out, "1"], bundlerEnv, join(LOGS, "_selftest", "03_bundle.log"));
    e = (tryJson(join(out, "summary.json")) ?? [])[0] ?? { ok: false, error: "the bundler wrote no result" };
  } catch (err) { e = { ok: false, error: errText(err) }; }
  safeRm(st);
  if (!e.ok) {
    console.error(`ERROR: the bundler fails on a tiny test package, so the problem is the tools or the disk, not the packages:\n  ${String(e.error).split("\n")[0].slice(0, 300)}`);
    console.error(`Fix: delete node_modules in ${dirname(HERE)} (and ${join(HERE, "node_modules")} if it exists), run \`npm ci\` there (or Setup), then Continue.`);
    console.error(`Log: ${join(LOGS, "_selftest", "03_bundle.log")}`);
    process.exit(1);
  }
  toolsOk = true;
  console.log("self-test   : ok (the unchanged bundler bundled a tiny test package)\n");
}

// ---- run ------------------------------------------------------------------------------
const started = Date.now();
const todo = list.filter((p) => !done.has(folderName(p.name)));
let next = 0;
await Promise.all(Array.from({ length: Math.min(CONC, Math.max(1, todo.length)) }, async () => {
  while (next < todo.length) await streamOne(todo[next++]);
}));

safeRm(WORK);

// ---- Claude repair of the postponed packages, now that every package has been streamed ----
// Also picks up packages postponed by an earlier, interrupted run.
const pending = readdirSync(RECORDS).filter((f) => f.endsWith(".json")).map((f) => readJson(join(RECORDS, f)))
  .filter((r) => r.claude_pending && list.some((p) => folderName(p.name) === r.folder)).sort((a, b) => a.rank - b.rank);
if (pending.length && !CLAUDE) console.log(`\n${pending.length} failed package(s) wait for Claude repair in ${PARK} — turn Claude repair on to repair them, or delete that folder.`);
if (pending.length && CLAUDE) {
  const now = pending.slice(0, CLAUDE_MAX);
  console.log(`\n---- Claude repair of ${now.length} postponed package(s)${pending.length > now.length ? ` (${pending.length - now.length} left for a later run)` : ""} ----`);
  finished = 0; total = now.length;
  for (const rec of now) await repairPostponed(rec);
}

async function repairPostponed(rec) {
  const park = join(PARK, rec.folder), pk = join(park, "packages"), failed = tryJson(join(park, "failed.json"));
  if (!existsSync(pk) || !failed) {
    delete rec.claude_pending;
    rec.bundle = rec.bundle ?? failed;
    return finish(rec, "bundle_failed", rec.category, `the parked download is gone (${park}), so Claude could not try it`);
  }
  const meta = tryJson(join(pk, `${rec.folder}.meta.json`)) ?? { name: rec.name, version: rec.version };
  const key = bundleKey(meta.name, meta.version), id = `${meta.name}@${meta.version}`;
  const out = join(WORK, rec.folder, "out");
  safeRm(join(WORK, rec.folder)); mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "summary.json"), JSON.stringify([failed], null, 2)); // what 07 reads: the failed bundling result
  try {
    await runNode("07-claude-repair-bundles.mjs", [pk, out, ...claudeArgs], bundlerEnv, join(LOGS, rec.folder, "07_claude_repair.log"),
      (line) => { if (/^\s+claude \|/.test(line)) console.log(`  ${id} ${line.trim()}`); });
    const entry = (tryJson(join(out, "summary.json")) ?? [])[0] ?? failed;
    rec.claude = (tryJson(join(out, "claude_repair", "report.json")) ?? []).at(-1) ?? null;
    const ws = join(out, "claude_repair", rec.folder);
    if (existsSync(ws)) moveInto(ws, join(D3, "claude_repair"));
    delete rec.claude_pending;
    return keepResults(rec, entry, out, key, meta.name);
  } catch (e) {
    delete rec.claude_pending;
    return finish(rec, "bundle_failed", "other", `stream driver error during Claude repair: ${errText(e)}`);
  } finally {
    try { if (KEEP.has("downloads")) for (const f of [`${rec.folder}.tgz`, `${rec.folder}.meta.json`]) if (existsSync(join(pk, f))) moveInto(join(pk, f), D2); }
    catch (e) { console.log(`  warning: could not keep the download of ${rec.folder} (${e.code || ""} ${String(e.message).slice(0, 120)})`); }
    safeRm(join(WORK, rec.folder));
    if (!rec.claude_pending) safeRm(park);
  }
}
try { if (!readdirSync(PARK).length) safeRm(PARK); } catch {}
safeRm(WORK);
// a second try for what could not be deleted during the run
if (existsSync(TRASH) && !safeRm(TRASH, true)) console.log(`\nwarning: ${undeleted} working folder(s) could not be deleted (disk error); they are in ${TRASH} — delete it by hand, and check the disk.`);
else if (undeleted) console.log(`\nnote: ${undeleted} working folder(s) failed to delete during the run, but were deleted at the end.`);

// ---- the usual step-02/03 outputs, rebuilt from every package's record ----------------
const records = readdirSync(RECORDS).filter((f) => f.endsWith(".json")).map((f) => readJson(join(RECORDS, f)))
  .filter((r) => list.some((p) => folderName(p.name) === r.folder));
const results = records.filter((r) => r.bundle).map((r) => r.bundle)
  .sort((a, b) => (a.id ?? a.folder).localeCompare(b.id ?? b.folder));
writeFileSync(join(D3, "summary.json"), JSON.stringify(results, null, 2));
writeFileSync(join(D3, "summary.csv"),
  "package,version,ok,dependencies_bundled,bundle_bytes,source_map_bytes,error\n" +
  results.map((r) => [r.name ?? r.folder, r.version ?? "", r.ok, r.dependenciesInBundle ?? "", r.bundleBytes ?? "", r.sourceMapBytes ?? "", JSON.stringify(r.error ?? "")].join(",")).join("\n"));
writeFileSync(join(D3, "manifest.jsonl"), results.map((r) => JSON.stringify(r)).join("\n") + (results.length ? "\n" : ""));
writeFileSync(join(D2, "download-results.json"), JSON.stringify(records.map((r) => r.download).filter(Boolean).sort((a, b) => a.rank - b.rank), null, 2));
const claudeRows = records.filter((r) => r.claude).map((r) => r.claude);
if (claudeRows.length) {
  mkdirSync(join(D3, "claude_repair"), { recursive: true });
  writeFileSync(join(D3, "claude_repair", "report.json"), JSON.stringify(claudeRows, null, 2) + "\n");
  const cols = ["folder", "name", "version", "outcome", "category", "cause", "original_category", "original_error", "files_changed", "report_valid", "turns", "cost_usd", "note", "explanation"];
  writeFileSync(join(D3, "claude_repair", "report.csv"), cols.join(",") + "\n" + claudeRows.map((r) => cols.map((c) => cell(r[c])).join(",")).join("\n") + "\n");
}
const rcols = ["rank", "package", "version", "outcome", "category", "cause", "dependencies_bundled", "bundle_bytes", "checked_entry"];
writeFileSync(join(STREAM, "results.csv"), rcols.join(",") + "\n" + records.sort((a, b) => a.rank - b.rank).map((r) =>
  [r.rank, r.name, r.version ?? "", r.outcome, r.category, r.cause, r.bundle?.dependenciesInBundle ?? "", r.bundle?.bundleBytes ?? "", r.check ? (r.check.entry === false ? "(empty)" : r.check.entry ?? "") : ""].map(cell).join(",")).join("\n") + "\n");

const by = (k) => records.reduce((m, r) => (r[k] ? ((m[r[k]] = (m[r[k]] || 0) + 1), m) : m), {});
console.log(`\nDone in ${((Date.now() - started) / 60000).toFixed(1)} min. ${records.length} package(s):`);
for (const [o, n] of Object.entries(by("outcome")).sort((a, b) => b[1] - a[1])) console.log(`  ${o.padEnd(26)} ${n}`);
const cats = Object.entries(by("category")).sort((a, b) => b[1] - a[1]);
if (cats.length) { console.log("by category:"); for (const [c, n] of cats) console.log(`  ${c.padEnd(26)} ${n}`); }
console.log(`\nper package: ${join(STREAM, "results.csv")}   summary for the next steps: ${join(D3, "summary.json")}`);
