// Tier 1, STREAMED: one package at a time, keeping only what is needed.
//
// For each package in the list:
//   1. download it with its dependencies      02-download-with-deps.mjs   (unchanged)
//   2. check it can be bundled at all          lib/bundleable.mjs          (webpack's own resolver)
//   3. bundle it and write its SBOM            03-bundle-and-sbom.mjs      (unchanged, faithful)
//   4. if bundling failed and --claude is on:  07-claude-repair-bundles.mjs (unchanged)
//   5. move the bundle, source map, SBOM and modules report into the bundle folder,
//      then DELETE the download and every working file
// so at any moment only the packages being worked on are on disk.
//
// Kept:    <bundleOutRoot>/bundles/*.min.js(.map), sbom/, modules/   — the test bed
//          <bundleOutRoot>/summary.json / .csv / manifest.jsonl        — same format as step 03
//          <bundleOutRoot>/claude_repair/<folder>/ + report.json/.csv — Claude's standardized reports
//          <bundleOutRoot>/stream/records/<folder>.json  one record per package (its done marker)
//          <bundleOutRoot>/stream/results.csv            one standard row per package
//          <bundleOutRoot>/stream/logs/<folder>/          the logs of each step for that package
//          <packagesDir>/download-results.json           same format as step 02
// Deleted: the downloaded .tgz (unless --keep downloads), the unpacked package, pnpm's cache.
//
// Every package ends with one standard line:
//   RESULT | <name>@<version> | <outcome> | <category> | <cause or details>
// outcome: bundled | repaired_by_claude | skipped_not_bundleable | bundle_failed | download_failed
//          | skipped_no_dependencies; category: see lib/failures.mjs.
//
// Usage:
//   node 08-stream-packages.mjs <list.json> <packagesDir> <bundleOutRoot>
//        [--conc 4] [--bundle-conc 1] [--limit all] [--keep downloads] [--no-check]
//        [--claude] [--max 20] [--max-turns 40] [--timeout-min 20] [--budget-usd X] [--model M] [--claude-bin claude]
// Env passed on unchanged: ONLY_WITH_DEPS (download), UNMINIFIED / HEAP_MB (bundler), PM.
// Safe to stop and re-run: finished packages (with a record) are skipped.

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, renameSync, readdirSync, cpSync, createWriteStream } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkBundleable } from "./lib/bundleable.mjs";
import { categorizeError, resultLine } from "./lib/failures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (n, fb) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : fb; };
const VALUE_FLAGS = ["--conc", "--bundle-conc", "--limit", "--keep", "--max", "--max-turns", "--timeout-min", "--budget-usd", "--model", "--claude-bin"];
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

const STREAM = join(D3, "stream"), RECORDS = join(STREAM, "records"), LOGS = join(STREAM, "logs"), WORK = join(D2, "_stream");
for (const d of [D2, D3, RECORDS, LOGS]) mkdirSync(d, { recursive: true });
rmSync(WORK, { recursive: true, force: true }); // leftovers of an interrupted run
const folderName = (n) => n.replace(/^@/, "").replace("/", "__");
const bundleKey = (name, version) => `${name.replace("/", "+")}@${version}`;
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const tryJson = (p) => { try { return readJson(p); } catch { return null; } };
const writeAtomic = (p, text) => { writeFileSync(p + ".tmp", text); renameSync(p + ".tmp", p); };
const cell = (s) => (/[",\r\n]/.test(String(s ?? "")) ? `"${String(s ?? "").replaceAll('"', '""')}"` : String(s ?? ""));

const list = readJson(listPath).slice(0, LIMIT);
const done = new Set(readdirSync(RECORDS).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)));
console.log(`list        : ${listPath}  (${list.length} package(s); ${list.filter((p) => done.has(folderName(p.name))).length} already done)`);
console.log(`bundles     : ${D3}`);
console.log(`working in  : ${WORK}  (deleted after each package${KEEP.has("downloads") ? "; downloads kept in " + D2 : ""})`);
console.log(`check       : ${CHECK ? "on (webpack's resolver, before bundling)" : "off"}   Claude repair: ${CLAUDE ? `on (at most ${CLAUDE_MAX} package(s) this run)` : "off"}`);
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
const bundleSlot = semaphore(BUNDLE_CONC), claudeSlot = semaphore(1);
let claudeUsed = 0;
const bundlerEnv = Object.fromEntries(["UNMINIFIED", "HEAP_MB"].filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
function moveInto(from, toDir) { mkdirSync(toDir, { recursive: true }); const to = join(toDir, from.split("/").pop()); rmSync(to, { recursive: true, force: true }); try { renameSync(from, to); } catch { cpSync(from, to, { recursive: true }); rmSync(from, { recursive: true, force: true }); } return to; }

// ---- one package ----------------------------------------------------------------------
async function streamOne(item) {
  const folder = folderName(item.name);
  const work = join(WORK, folder), pk = join(work, "packages"), out = join(work, "out"), logs = join(LOGS, folder);
  rmSync(work, { recursive: true, force: true }); mkdirSync(pk, { recursive: true });
  const rec = { rank: item.rank, name: item.name, folder, version: null, at: null };
  try {
    // 1. download (step 02, one package) — or take a download already in the packages folder
    //    (e.g. from an earlier batch run); it is deleted afterwards like any other
    let dl;
    const have = join(D2, `${folder}.tgz`), haveMeta = tryJson(join(D2, `${folder}.meta.json`));
    if (existsSync(have) && haveMeta?.name) {
      for (const f of [`${folder}.tgz`, `${folder}.meta.json`]) renameSync(join(D2, f), join(pk, f));
      dl = { rank: item.rank, name: item.name, ok: true, skipped: true, version: haveMeta.version };
    } else {
      writeFileSync(join(work, "list.json"), JSON.stringify([item]));
      await runNode("02-download-with-deps.mjs", [join(work, "list.json"), pk, "1", "all"], { ONLY_WITH_DEPS: process.env.ONLY_WITH_DEPS ?? "0" }, join(logs, "02_download.log"));
      dl = (tryJson(join(pk, "download-results.json")) ?? [])[0] ?? { rank: item.rank, name: item.name, ok: false, error: "download step wrote no result" };
    }
    rec.download = dl;
    if (!dl.ok) return finish(rec, "download_failed", "download_failed", dl.error);
    if (dl.noDependencies) return finish(rec, "skipped_no_dependencies", "", "no runtime dependencies (excluded, as in batch mode)");
    const meta = tryJson(join(pk, `${folder}.meta.json`)) ?? { name: item.name, version: dl.version };
    rec.version = meta.version;
    const key = bundleKey(meta.name, meta.version), id = `${meta.name}@${meta.version}`;

    // 2. can it be bundled at all?
    if (CHECK) {
      const x = join(work, "check"); mkdirSync(x, { recursive: true });
      execFileSync("tar", ["-xzf", join(pk, `${folder}.tgz`), "-C", x], { stdio: "ignore" });
      rec.check = await checkBundleable(x, meta.name);
      rmSync(x, { recursive: true, force: true });
      if (!rec.check.bundleable) {
        rec.bundle = { id, folder, name: meta.name, version: meta.version, ok: false, error: `not bundleable: ${rec.check.reason}`, skippedBy: "check", category: rec.check.category };
        return finish(rec, "skipped_not_bundleable", rec.check.category, rec.check.reason);
      }
    }

    // 3. bundle + SBOM (step 03, one package, into a private folder first)
    await bundleSlot(() => runNode("03-bundle-and-sbom.mjs", [pk, out, "1"], bundlerEnv, join(logs, "03_bundle.log")));
    let entry = (tryJson(join(out, "summary.json")) ?? [])[0] ?? { id, folder, name: meta.name, version: meta.version, ok: false, error: "bundler wrote no summary" };

    // 4. Claude repair, only when bundling failed
    if (!entry.ok && CLAUDE && claudeUsed < CLAUDE_MAX) {
      claudeUsed++;
      await claudeSlot(() => runNode("07-claude-repair-bundles.mjs", [pk, out, ...claudeArgs], bundlerEnv, join(logs, "07_claude_repair.log"),
        (line) => { if (/^\s+claude \|/.test(line)) console.log(`  ${id} ${line.trim()}`); }));
      entry = (tryJson(join(out, "summary.json")) ?? [])[0] ?? entry;
      const reports = tryJson(join(out, "claude_repair", "report.json")) ?? [];
      rec.claude = reports.at(-1) ?? null;
      const ws = join(out, "claude_repair", folder);
      if (existsSync(ws)) moveInto(ws, join(D3, "claude_repair"));
    }

    // 5. keep the results in the bundle folder, with their final paths
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
      const how = entry.bundledBy === "claude-repair" ? "repaired_by_claude" : "bundled";
      return finish(rec, how, how === "repaired_by_claude" ? rec.claude?.category ?? "" : "",
        `${entry.dependenciesInBundle ?? "?"} dependencies bundled, ${entry.bundleBytes} bytes`);
    }
    const cat = rec.claude?.category ?? categorizeError(entry.error, meta.name);
    return finish(rec, "bundle_failed", cat, rec.claude?.cause ?? entry.error);
  } catch (e) {
    return finish(rec, "bundle_failed", "other", `stream driver error: ${String(e.message).slice(0, 200)}`);
  } finally {
    if (KEEP.has("downloads")) for (const f of [`${folder}.tgz`, `${folder}.meta.json`]) if (existsSync(join(pk, f))) moveInto(join(pk, f), D2);
    rmSync(work, { recursive: true, force: true });
  }
}

let finished = 0;
const total = list.filter((p) => !done.has(folderName(p.name))).length;
function finish(rec, outcome, category, cause) {
  Object.assign(rec, { outcome, category: category || "", cause: String(cause ?? "").split("\n")[0].slice(0, 300), at: new Date().toISOString() });
  writeAtomic(join(RECORDS, `${rec.folder}.json`), JSON.stringify(rec, null, 2));
  finished++;
  console.log(`[${finished}/${total}] ${resultLine(rec.version ? `${rec.name}@${rec.version}` : rec.name, outcome, category, rec.cause)}`);
  return rec;
}

// ---- run ------------------------------------------------------------------------------
const started = Date.now();
const todo = list.filter((p) => !done.has(folderName(p.name)));
let next = 0;
await Promise.all(Array.from({ length: Math.min(CONC, Math.max(1, todo.length)) }, async () => {
  while (next < todo.length) await streamOne(todo[next++]);
}));

rmSync(WORK, { recursive: true, force: true });

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
  const cols = ["folder", "name", "version", "outcome", "category", "cause", "original_category", "original_error", "files_changed", "report_valid", "turns", "cost_usd", "note"];
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
