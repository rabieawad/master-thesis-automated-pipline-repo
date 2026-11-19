// Tier 1, optional step after bundling: ask Claude to REPAIR the packages the automatic
// bundler failed on, then bundle them again with the UNCHANGED bundler.
//
// Claude never writes a bundle and never touches the bundler or its webpack config. For each
// failed package it gets a private workspace holding that package's files and one job:
// make the unchanged 03-bundle-and-sbom.mjs succeed by repairing the PACKAGE (e.g. fetch a
// dependency the install left out, stub a native/optional module webpack cannot read),
// keeping the change as small as possible. When Claude is done, this script re-runs the
// unchanged bundler on the repaired package itself; only a bundle that THIS run produces is
// accepted. So every bundle, source map and SBOM still comes from the same faithful webpack
// configuration — what differs is that the input was repaired, and that is recorded.
//
// Usage:
//   node 07-claude-repair-bundles.mjs <packagesDir> <bundleOutRoot> \
//        [--max 20] [--max-turns 40] [--budget-usd 2] [--timeout-min 20] [--model NAME] [--claude-bin claude]
// Env passed straight to the bundler (same as the bundling step): UNMINIFIED, HEAP_MB.
//
// Reads  <bundleOutRoot>/summary.json        (written by the bundling step)
// Writes <bundleOutRoot>/bundles|sbom|modules/<key>...   for every package that was repaired
//        <bundleOutRoot>/summary.json / .csv  failed entries replaced by the repaired result,
//                                             marked  "bundledBy": "claude-repair"
//        <bundleOutRoot>/claude_repair/report.json / report.csv   one row per attempt
//        <bundleOutRoot>/claude_repair/<folder>/   repair.json (the standardized record: outcome,
//                                             category, cause, evidence, changes + Claude's free
//                                             explanation), REPAIR.json (Claude's own report),
//                                             changes.json (every file added/changed/removed),
//                                             changed-files/ (copies of added/changed files),
//                                             claude.log, bundle.log
// The repaired package's full working copy is deleted afterwards; the original download in
// <packagesDir> is never modified, so original + changed-files reproduces the repair.
//
// Safe to re-run: packages already repaired (their SBOM exists) are skipped.

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync, statSync, copyFileSync, cpSync, chmodSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CATEGORIES, CATEGORY_NAMES, categorizeError, resultLine } from "./lib/failures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLER = join(HERE, "03-bundle-and-sbom.mjs");

const args = process.argv.slice(2);
const opt = (name, fb) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fb; };
const VALUE_FLAGS = ["--max", "--max-turns", "--budget-usd", "--timeout-min", "--model", "--claude-bin"];
const positional = args.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.includes(args[i - 1]));

const packagesDir = resolve(positional[0] ?? "packages");
const outRoot = resolve(positional[1] ?? "bundles");
const MAX = Number(opt("--max", process.env.CLAUDE_MAX_PACKAGES ?? 20));
const MAX_TURNS = String(Number(opt("--max-turns", process.env.CLAUDE_MAX_TURNS ?? 40)));
const BUDGET = String(opt("--budget-usd", process.env.CLAUDE_BUDGET_USD ?? "") ?? "").trim();
const TIMEOUT_MIN = Number(opt("--timeout-min", process.env.CLAUDE_TIMEOUT_MIN ?? 20));
const MODEL = String(opt("--model", process.env.CLAUDE_MODEL ?? "") ?? "").trim();
const CLAUDE_BIN = String(opt("--claude-bin", process.env.CLAUDE_BIN ?? "claude") || "claude");

const REPAIR = join(outRoot, "claude_repair");
const summaryPath = join(outRoot, "summary.json");
const bundleKey = (name, version) => `${name.replace("/", "+")}@${version}`;
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const cell = (s) => (/[",\r\n]/.test(String(s ?? "")) ? `"${String(s ?? "").replaceAll('"', '""')}"` : String(s ?? ""));

if (!existsSync(summaryPath)) { console.error(`No ${summaryPath} — run the bundling step first.`); process.exit(1); }
mkdirSync(REPAIR, { recursive: true });

const summary = readJson(summaryPath);
const reportPath = join(REPAIR, "report.json");
const report = existsSync(reportPath) ? readJson(reportPath) : [];
const failed = summary.filter((r) => r && r.ok === false && r.folder && !/^no package metadata/.test(r.error ?? ""));

console.log(`bundling summary : ${summaryPath}`);
console.log(`failed packages  : ${failed.length}`);
if (!failed.length) { console.log("Nothing to repair — every package bundled."); writeReport(); process.exit(0); }

// Claude Code must be installed and signed in (it is the `claude` command).
const ver = spawnSync(CLAUDE_BIN, ["--version"], { encoding: "utf8" });
if (ver.error || ver.status !== 0) {
  console.error(`\nCould not run "${CLAUDE_BIN} --version". Install Claude Code (npm i -g @anthropic-ai/claude-code), sign in once by running "claude",`);
  console.error(`or point the "Claude command" setting at it. Then run this step again.`);
  process.exit(1);
}
console.log(`claude           : ${ver.stdout.trim()}   (max ${MAX} package(s), ${MAX_TURNS} turns each${BUDGET ? `, $${BUDGET} each` : ""}, ${TIMEOUT_MIN} min each${MODEL ? `, model ${MODEL}` : ""})\n`);

// ------------------------------------------------------------------ helpers
// The bundler's environment, exactly as the bundling step had it.
const bundlerEnv = Object.fromEntries(["UNMINIFIED", "HEAP_MB"].filter((k) => process.env[k] != null && process.env[k] !== "").map((k) => [k, process.env[k]]));

function metaOf(folder) {
  try { const m = readJson(join(packagesDir, `${folder}.meta.json`)); if (m?.name) return m; } catch {}
  return null;
}

// path -> sha1 for every file under dir (to report what Claude changed)
function fingerprint(dir) {
  const out = new Map();
  const walk = (d) => {
    let ents = []; try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile()) { try { out.set(relative(dir, f), createHash("sha1").update(readFileSync(f)).digest("hex")); } catch {} }
    }
  };
  walk(dir);
  return out;
}

function writeTryScript(ws, folder) {
  const envLine = Object.entries(bundlerEnv).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ");
  const sh = `#!/usr/bin/env bash
# Re-bundle the package in ./pkg with the UNCHANGED tier-1 bundler. Prints BUNDLE_OK or BUNDLE_FAILED.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
rm -rf "$HERE/staging"; mkdir -p "$HERE/staging/packages" "$HERE/staging/out"
tar -czf "$HERE/staging/packages/${folder}.tgz" -C "$HERE/pkg" .
cp "$HERE/meta.json" "$HERE/staging/packages/${folder}.meta.json"
${envLine} ${JSON.stringify(process.execPath)} ${JSON.stringify(BUNDLER)} "$HERE/staging/packages" "$HERE/staging/out" 1 > "$HERE/bundle.log" 2>&1
${JSON.stringify(process.execPath)} -e '
const s = JSON.parse(require("fs").readFileSync(process.argv[1] + "/staging/out/summary.json", "utf8"))[0] || {};
if (s.ok) console.log("BUNDLE_OK  " + (s.dependenciesInBundle ?? "?") + " dependencies bundled, " + s.bundleBytes + " bytes");
else console.log("BUNDLE_FAILED  " + (s.error || "see bundle.log"));
' "$HERE" 2>/dev/null || echo "BUNDLE_FAILED  (no summary — see bundle.log)"
`;
  const p = join(ws, "try-bundle.sh");
  writeFileSync(p, sh);
  chmodSync(p, 0o755);
}

function taskText(rec) {
  return `# Task: repair one npm package so the unchanged bundler can bundle it

You are helping build a research dataset of real JavaScript bundles. Each package (with all of its
dependencies) is bundled by an automatic, UNCHANGEABLE webpack bundler that must stay faithful to a
published method. It FAILED on this package:

- package: ${rec.name}@${rec.version}
- error:   ${String(rec.error ?? "").replace(/\n/g, " ")}

## What is here
- \`./pkg/\` — the package as it was downloaded: \`pkg/package.json\` is a small wrapper that depends on
  \`${rec.name}\`, and \`pkg/node_modules/\` holds it and its dependencies.
- \`./try-bundle.sh\` — runs the unchanged bundler on \`./pkg\`. It prints \`BUNDLE_OK\` or \`BUNDLE_FAILED\`;
  the full bundler output is in \`./bundle.log\`.

## Your job
Make \`./try-bundle.sh\` print \`BUNDLE_OK\` by repairing the files under \`./pkg/\` only.

Rules — these keep the dataset honest:
1. Never change, copy or replace the bundler, its webpack configuration, or \`try-bundle.sh\`.
2. Keep the change as small as possible. Do not upgrade, downgrade or remove \`${rec.name}\` or any
   dependency that is already installed, and do not rewrite their source code.
3. Allowed: add a dependency the install left out (at the version the requiring package.json asks for),
   or replace a module webpack cannot read (a native addon, a platform-specific optional module) with an
   empty stub. Every stub must be listed in \`changes\` in REPAIR.json.
4. When installing anything, never run package install scripts: always pass \`--ignore-scripts\`. Prefer
   \`npm pack <name>@<version>\` and extracting it into the right \`node_modules\` folder over \`npm install\`,
   which can re-resolve and change the existing tree.
5. Do not run the package's own code.
6. Stay inside this folder.

## When you finish: write ./REPAIR.json (required, exactly this shape)
Every package gets the same report, so results can be compared across packages:

\`\`\`json
{
  "outcome": "repaired" or "not_repaired",
  "category": one of ${CATEGORY_NAMES.map((c) => `"${c}"`).join(", ")},
  "cause": "one sentence: why the bundler failed",
  "evidence": "the decisive error line or file fact, copied verbatim (at most 300 characters)",
  "changes": [ { "file": "pkg/...", "action": "added" | "changed" | "stubbed" | "removed", "reason": "why" } ],
  "still_represents_package": "why the bundle is still ${rec.name}@${rec.version} (only when repaired, else null)",
  "explanation": "brief, in your own words: at most 3 sentences (400 characters) on what you found, what you did, and why it worked or could not"
}
\`\`\`

What the categories mean:
${CATEGORY_NAMES.map((c) => `- \`${c}\`: ${CATEGORIES[c]}`).join("\n")}

\`changes\` is empty when you changed nothing. Write valid JSON only (no comments), then stop.
`;
}

function runClaude(ws, logFile) {
  return new Promise((res) => {
    const a = ["-p", "Read TASK.md in the current folder and do the task it describes.",
      "--output-format", "stream-json", "--verbose",
      "--max-turns", MAX_TURNS,
      "--permission-mode", "acceptEdits",
      "--allowedTools", "Bash,Read,Edit,Write,Glob,Grep"];
    if (BUDGET) a.push("--max-budget-usd", BUDGET);
    if (MODEL) a.push("--model", MODEL);
    const p = spawn(CLAUDE_BIN, a, { cwd: ws, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const log = [];
    let acc = "", result = null, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; p.kill("SIGTERM"); }, TIMEOUT_MIN * 60_000);
    const say = (s) => { console.log(`    claude | ${s}`); };
    p.stdout.on("data", (c) => {
      acc += c.toString();
      const lines = acc.split("\n"); acc = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        log.push(line);
        let e; try { e = JSON.parse(line); } catch { say(line.slice(0, 200)); continue; }
        if (e.type === "assistant") for (const part of e.message?.content ?? []) {
          if (part.type === "text" && part.text?.trim()) say(part.text.trim().split("\n")[0].slice(0, 200));
          else if (part.type === "tool_use") say(`[${part.name}] ${String(part.input?.command ?? part.input?.file_path ?? part.input?.pattern ?? "").slice(0, 160)}`);
        }
        else if (e.type === "result") result = e;
      }
    });
    p.stderr.on("data", (c) => log.push("[stderr] " + c.toString()));
    p.on("error", (e) => { clearTimeout(timer); writeFileSync(logFile, log.join("\n")); res({ error: String(e.message) }); });
    p.on("close", (code) => {
      clearTimeout(timer);
      writeFileSync(logFile, log.join("\n") + "\n");
      res({ code, timedOut, turns: result?.num_turns ?? null, costUsd: result?.total_cost_usd ?? null, subtype: result?.subtype ?? null });
    });
  });
}

// Read and check Claude's REPAIR.json against the required shape. Returns
// { valid, report } or { valid: false, problem }.
const EXPLANATION_MAX = 400;
// one line, at most EXPLANATION_MAX characters (the full text stays in repair.json)
const briefText = (t) => { const x = String(t ?? "").replace(/\s+/g, " ").trim(); return x.length > EXPLANATION_MAX ? x.slice(0, EXPLANATION_MAX - 1) + "…" : x; };
function readReport(file) {
  let r;
  try { r = JSON.parse(readFileSync(file, "utf8")); }
  catch (e) { return { valid: false, problem: existsSync(file) ? `REPAIR.json is not valid JSON: ${e.message.slice(0, 120)}` : "no REPAIR.json written" }; }
  const bad = [];
  if (!["repaired", "not_repaired"].includes(r?.outcome)) bad.push("outcome");
  if (!CATEGORY_NAMES.includes(r?.category)) bad.push("category");
  for (const k of ["cause", "explanation"]) if (typeof r?.[k] !== "string" || !r[k].trim()) bad.push(k);
  if (r?.evidence != null && typeof r.evidence !== "string") bad.push("evidence");
  if (!Array.isArray(r?.changes) || r.changes.some((x) => !x || typeof x.file !== "string" || !["added", "changed", "stubbed", "removed"].includes(x.action))) bad.push("changes");
  if (bad.length) return { valid: false, problem: `REPAIR.json has missing or invalid field(s): ${bad.join(", ")}` };
  return { valid: true, report: { outcome: r.outcome, category: r.category, cause: r.cause.trim(), evidence: String(r.evidence ?? "").slice(0, 300),
    changes: r.changes.map((x) => ({ file: x.file, action: x.action, reason: String(x.reason ?? "") })),
    still_represents_package: r.still_represents_package ?? null, explanation: r.explanation.trim() } };
}

function writeReport() {
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  const cols = ["folder", "name", "version", "outcome", "category", "cause", "original_category", "original_error", "files_changed", "report_valid", "turns", "cost_usd", "note", "explanation"];
  writeFileSync(join(REPAIR, "report.csv"), cols.join(",") + "\n" + report.map((r) => cols.map((c) => cell(r[c])).join(",")).join("\n") + "\n");
}

// summary.json / .csv in exactly the bundling step's format, plus the provenance field
function writeSummary() {
  summary.sort((a, b) => (a.id ?? a.folder).localeCompare(b.id ?? b.folder));
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  writeFileSync(join(outRoot, "summary.csv"),
    "package,version,ok,dependencies_bundled,bundle_bytes,source_map_bytes,error\n" +
    summary.map((r) => [r.name ?? r.folder, r.version ?? "", r.ok, r.dependenciesInBundle ?? "", r.bundleBytes ?? "", r.sourceMapBytes ?? "", JSON.stringify(r.error ?? "")].join(",")).join("\n"));
}

// ------------------------------------------------------------------ main
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
const bundlerHash = sha(BUNDLER); // the bundler must be byte-identical after every Claude session
let attempted = 0, repaired = 0;
const started = Date.now();

for (const rec of failed) {
  const folder = rec.folder;
  const meta = metaOf(folder) ?? { name: rec.name, version: rec.version };
  if (!meta.name) { console.log(`skip ${folder}: no name/version metadata`); continue; }
  const key = bundleKey(meta.name, meta.version);
  if (existsSync(join(outRoot, "sbom", `${key}.cdx.json`))) { console.log(`skip ${meta.name}@${meta.version}: already bundled`); continue; }
  if (attempted >= MAX) { console.log(`\nReached the limit of ${MAX} package(s); ${failed.length - attempted} left for a later run.`); break; }
  attempted++;

  const ws = join(REPAIR, folder);
  console.log(`\n[${attempted}/${Math.min(MAX, failed.length)}] ${meta.name}@${meta.version}  — ${String(rec.error ?? "").slice(0, 160)}`);
  rmSync(ws, { recursive: true, force: true });
  mkdirSync(join(ws, "pkg"), { recursive: true });

  // the package exactly as downloaded (the original in packagesDir is never modified)
  const tgz = join(packagesDir, `${folder}.tgz`);
  try {
    if (existsSync(tgz)) execFileSync("tar", ["-xzf", tgz, "-C", join(ws, "pkg")], { stdio: "ignore" });
    else cpSync(join(packagesDir, folder), join(ws, "pkg"), { recursive: true });
  } catch (e) {
    report.push({ folder, name: meta.name, version: meta.version, outcome: "failed", original_error: rec.error, note: `could not unpack: ${e.message}`.slice(0, 300), at: new Date().toISOString() });
    writeReport(); continue;
  }
  writeFileSync(join(ws, "meta.json"), JSON.stringify({ name: meta.name, version: meta.version }));
  writeFileSync(join(ws, "TASK.md"), taskText({ ...rec, name: meta.name, version: meta.version }));
  writeTryScript(ws, folder);

  const before = fingerprint(join(ws, "pkg"));
  const c = await runClaude(ws, join(ws, "claude.log"));
  if (c.error) console.log(`    could not start claude: ${c.error}`);
  else if (c.timedOut) console.log(`    stopped after ${TIMEOUT_MIN} min`);

  // what changed under pkg/
  const after = fingerprint(join(ws, "pkg"));
  const changes = { added: [], changed: [], removed: [] };
  for (const [f, h] of after) { if (!before.has(f)) changes.added.push(f); else if (before.get(f) !== h) changes.changed.push(f); }
  for (const f of before.keys()) if (!after.has(f)) changes.removed.push(f);
  for (const k of Object.keys(changes)) changes[k].sort();
  writeFileSync(join(ws, "changes.json"), JSON.stringify(changes, null, 2) + "\n");
  for (const f of [...changes.added, ...changes.changed]) {
    try { const to = join(ws, "changed-files", f); mkdirSync(dirname(to), { recursive: true }); copyFileSync(join(ws, "pkg", f), to); } catch {}
  }

  // the only accepted proof: THIS run of the unchanged bundler succeeds on the repaired package.
  // The check script and metadata are written again first, so nothing Claude did to them counts.
  if (sha(BUNDLER) !== bundlerHash) {
    console.error(`\n!! ${BUNDLER} changed during the Claude session for ${meta.name}. Stopping: restore it before running again.`);
    report.push({ folder, name: meta.name, version: meta.version, outcome: "aborted", original_error: rec.error, note: "the bundler file was modified", at: new Date().toISOString() });
    writeReport(); process.exit(1);
  }
  rmSync(join(ws, "staging"), { recursive: true, force: true });
  writeFileSync(join(ws, "meta.json"), JSON.stringify({ name: meta.name, version: meta.version }));
  writeTryScript(ws, folder);
  const verify = spawnSync("bash", [join(ws, "try-bundle.sh")], { encoding: "utf8" });
  const okLine = String(verify.stdout ?? "").trim().split("\n").pop() ?? "";
  const staged = (() => { try { return readJson(join(ws, "staging", "out", "summary.json"))[0]; } catch { return null; } })();
  const nChanged = changes.added.length + changes.changed.length + changes.removed.length;
  const claude = readReport(join(ws, "REPAIR.json"));
  const verified = !!(staged?.ok && /^BUNDLE_OK/.test(okLine));
  const id = `${meta.name}@${meta.version}`;
  const originalCategory = categorizeError(rec.error, meta.name);
  // the outcome is what the unchanged bundler proved, never only what Claude claimed
  const outcome = verified ? "repaired" : "not_repaired";
  const category = claude.valid ? claude.report.category : originalCategory;
  const cause = claude.valid ? claude.report.cause : (claude.problem ? `no valid report from Claude (${claude.problem})` : okLine || "bundler still fails");
  const notes = [];
  if (claude.valid && claude.report.outcome !== outcome) notes.push(`Claude reported "${claude.report.outcome}" but the unchanged bundler says "${outcome}"`);
  if (c.timedOut) notes.push(`stopped after ${TIMEOUT_MIN} min`);
  if (claude.valid && claude.report.explanation.length > EXPLANATION_MAX) notes.push(`explanation longer than the ${EXPLANATION_MAX} characters asked`);
  const explanation = claude.valid ? claude.report.explanation : "";
  const row = { folder, name: meta.name, version: meta.version, outcome, category, cause,
    original_category: originalCategory, original_error: rec.error, files_changed: nChanged,
    report_valid: claude.valid, turns: c.turns, cost_usd: c.costUsd, note: notes.join("; "), explanation: briefText(explanation), at: new Date().toISOString() };
  // the standardized record for this package, with Claude's free explanation kept in full
  writeFileSync(join(ws, "repair.json"), JSON.stringify({
    package: meta.name, version: meta.version, outcome, category, cause,
    evidence: claude.valid ? claude.report.evidence : String(rec.error ?? "").slice(0, 300),
    changes: claude.valid ? claude.report.changes : [], files_changed: changes,
    still_represents_package: claude.valid ? claude.report.still_represents_package : null,
    explanation: claude.valid ? claude.report.explanation : null,
    original_error: rec.error, original_category: originalCategory,
    claude: { reported_outcome: claude.valid ? claude.report.outcome : null, report_valid: claude.valid, report_problem: claude.problem ?? null, turns: c.turns, cost_usd: c.costUsd, timed_out: !!c.timedOut },
    notes, at: row.at,
  }, null, 2) + "\n");

  if (staged?.ok && /^BUNDLE_OK/.test(okLine)) {
    for (const [sub, files] of [["bundles", [`${key}.min.js`, `${key}.min.js.map`]], ["sbom", [`${key}.cdx.json`]], ["modules", [`${key}.json`]]]) {
      mkdirSync(join(outRoot, sub), { recursive: true });
      for (const f of files) { const from = join(ws, "staging", "out", sub, f); if (existsSync(from)) copyFileSync(from, join(outRoot, sub, f)); }
    }
    const i = summary.indexOf(rec);
    const fixed = { ...staged, folder, outFile: join(outRoot, "bundles", `${key}.min.js`),
      sourceMapFile: staged.sourceMapBytes ? join(outRoot, "bundles", `${key}.min.js.map`) : undefined,
      bundledBy: "claude-repair", originalError: rec.error, repairFilesChanged: nChanged };
    summary[i] = fixed;
    writeSummary();
    repaired++;
  }
  // the same block for every package, fields always in this order
  const changeList = claude.valid ? claude.report.changes : [];
  console.log(resultLine(id, outcome, category, cause));
  console.log(`    bundler     : ${verified ? okLine.replace(/^BUNDLE_OK\s*/, "") : "still fails"}`);
  console.log(`    changes     : ${changeList.length ? changeList.map((x) => `${x.action} ${x.file}`).join("; ") : "none"} (${nChanged} file(s) differ)`);
  console.log(`    explanation : ${briefText(explanation) || "(none — " + (claude.problem ?? "no report") + ")"}`);
  console.log(`    note        : ${notes.length ? notes.join("; ") : "-"}`);
  console.log(`    record      : claude_repair/${folder}/repair.json`);
  report.push(row);
  writeReport();

  // keep the account and the diff, drop the full working copy (it can be large)
  rmSync(join(ws, "pkg"), { recursive: true, force: true });
  rmSync(join(ws, "staging"), { recursive: true, force: true });
}

writeReport();
console.log(`\nDone. attempted=${attempted}  repaired=${repaired}  still failing=${attempted - repaired}  (${((Date.now() - started) / 60000).toFixed(1)} min)`);
console.log(`report: ${join(REPAIR, "report.csv")}`);
