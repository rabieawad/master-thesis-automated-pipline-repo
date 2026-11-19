// Shared definitions for the first pipeline: parameters, steps, output layout and
// the exact command each step runs. Imported by both server.mjs (web panel) and
// wizard.mjs (interactive CLI). The 01..06 scripts and run-pipeline.sh do not
// depend on this file and keep working on their own.

import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdirSync } from "node:fs";

export const HERE = dirname(fileURLToPath(import.meta.url));

// Every setting. `group` decides where it appears in the settings panel, `label` is the short
// name and `help` the one-line explanation shown under it. `modes` (optional) restricts a
// setting to those tier-1 modes; absent = shown in both. `when` (optional) shows a setting
// only while another one has a given value.
export const GROUPS = [
  { id: "mode", title: "Mode", help: "Streamed or batch, and how the sample is chosen" },
  { id: "source", title: "Package source", help: "Which popular packages are crawled and downloaded" },
  { id: "selection", title: "Sample selection", help: "Which packages end up in the test bed" },
  { id: "bundling", title: "Bundling", help: "How the real bundles are built" },
  { id: "claude", title: "Claude repair", help: "Let Claude repair packages the bundler failed on" },
  { id: "functions", title: "Function extraction", help: "Which functions are kept from the bundles" },
  { id: "performance", title: "Performance", help: "Parallel work" },
];
export const PARAMS = [
  { key: "STREAM", group: "mode", label: "Streamed (one package at a time)", help: "Each package: download → check it can be bundled → bundle + SBOM → delete the download. Packages that fail are postponed, and Claude (if on) repairs them after all packages are done. Only bundles, SBOMs, functions, reports and logs stay on disk. Off = batch: every download is kept until you delete it.", type: "bool", default: "1" },
  { key: "KEEP_ARTIFACTS", group: "mode", label: "Also keep", help: "In streamed mode the downloads are deleted as soon as each package is bundled. Tick to keep them.", type: "multi",
    options: [{ value: "downloads", label: "Downloaded packages", help: "02_downloaded_packages/*.tgz — each holds a package with all its dependencies (large)" }],
    fixed: [{ label: "Bundles and source maps", help: "the test bed — always kept" }, { label: "SBOMs and module reports", help: "always kept" }, { label: "Extracted functions", help: "always kept" }, { label: "Logs, per-package results, Claude's reports", help: "always kept" }],
    default: "", when: { STREAM: "1" } },
  { key: "PACK_OUTPUTS", group: "mode", label: "Pack outputs into .tgz when a run ends", help: "Each step's per-package files (bundles, source maps, SBOMs, functions, kept downloads…) go into one .tgz per kind, e.g. 03_bundles_minified/bundles.tgz. Logs, lists, summaries and reports stay as plain files. They are unpacked automatically before the next run.", type: "bool", default: "1" },
  { key: "MODE", group: "mode", label: "Mode", help: "expensive: download and bundle ALL crawled packages, then pick the sample. cheap: pick the sample from registry metadata first, then download and bundle only the sample.", type: "select", options: ["expensive", "cheap"], default: "expensive" },
  { key: "TOP_N", group: "source", label: "Top packages to crawl", help: "How many of jsDelivr's most-used packages are listed (step 01).", type: "number", default: "1500" },
  { key: "PERIOD", group: "source", label: "Popularity period", help: "jsDelivr statistics period used to rank packages (step 01).", type: "select", options: ["day", "week", "month", "year"], default: "month" },
  { key: "DOWNLOAD_LIMIT", group: "source", label: "Packages to download", help: "'all' or a number (step 02). Cheap mode downloads only the sample, so this is ignored there.", type: "text", default: "all", modes: ["expensive"] },
  { key: "INCLUDE_ZERO_DEP", group: "source", label: "Include packages without dependencies", help: "Also download and bundle packages that have no dependencies.", type: "bool", default: "1", modes: ["expensive"] },
  { key: "SAMPLE_N", group: "selection", label: "Packages to pick", help: "Size of the sample. Ignored when a dependency distribution is set.", type: "number", default: "40" },
  { key: "DEP_BASIS", group: "selection", label: "Count dependencies by", help: "landed: estimated to end up in the bundle. runtime: declared minus build tools and @types. declared: raw package.json.", type: "select", options: ["landed", "runtime", "declared"], default: "landed", modes: ["cheap"] },
  { key: "DEP_DIST", group: "selection", label: "Dependency-count distribution", help: "e.g. 0:3,2-5:3,8-15:5 = 3 packages with 0 deps, 3 with 2–5, 5 with 8–15. Blank = use min/max and the count above.", type: "text", default: "", modes: ["cheap"] },
  { key: "MIN_DEPS", group: "selection", label: "Minimum dependencies", help: "0 allows packages without dependencies. Ignored when a distribution is set.", type: "number", default: "0" },
  { key: "MAX_DEPS", group: "selection", label: "Maximum dependencies", help: "Ignored when a distribution is set.", type: "number", default: "20" },
  { key: "SEED", group: "selection", label: "Random seed", help: "Same seed, same sample.", type: "number", default: "42" },
  { key: "SKIP_MISSING_DEPS", group: "source", label: "Leave out dependencies that don't exist on npm", help: "Off = faithful to Aletheia: a package whose dependency is not on npm cannot be installed. On = install it without those dependencies (pnpm overrides) and label it bundled_without_missing_deps, with the names left out, so it can be reported separately.", type: "bool", default: "0" },
  { key: "CHECK_BUNDLEABLE", group: "bundling", label: "Check each package can be bundled first", help: "Asks webpack's own resolver what the bundler's entry would load, and skips packages webpack cannot bundle (no JavaScript entry, or a stylesheet entry) without bundling them or calling Claude. Streamed mode only.", type: "bool", default: "1", when: { STREAM: "1" } },
  { key: "WORK_DIR", group: "bundling", label: "Temporary folder for bundling", help: "Where each package is unpacked and bundled (thousands of small files, deleted after each package). Blank = inside the downloads folder. Use a folder on a fast local disk (e.g. /tmp) if the output drive gives I/O errors. Streamed mode only.", type: "text", default: "", when: { STREAM: "1" } },
  { key: "MINIFY", group: "bundling", label: "Minify bundles", help: "On = faithful to Aletheia (webpack minimize: true). Off = the un-minified thesis variant.", type: "bool", default: "1" },
  { key: "CLAUDE_REPAIR", group: "claude", label: "Repair failed packages with Claude", help: "After all packages are bundled, Claude repairs the failed ones (never the bundler), then the unchanged bundler runs again. Needs Claude Code installed and signed in.", type: "bool", default: "0" },
  { key: "CLAUDE_MAX_PACKAGES", group: "claude", label: "Packages per run", help: "At most this many failed packages are tried per run; run the step again for the rest.", type: "number", default: "20", when: { CLAUDE_REPAIR: "1" } },
  { key: "CLAUDE_MAX_TURNS", group: "claude", label: "Turns per package", help: "Claude stops after this many steps on one package.", type: "number", default: "40", when: { CLAUDE_REPAIR: "1" } },
  { key: "CLAUDE_BUDGET_USD", group: "claude", label: "Spending cap per package (USD)", help: "Blank = no cap.", type: "text", default: "", when: { CLAUDE_REPAIR: "1" } },
  { key: "CLAUDE_TIMEOUT_MIN", group: "claude", label: "Time limit per package (minutes)", help: "Claude is stopped after this long.", type: "number", default: "20", when: { CLAUDE_REPAIR: "1" } },
  { key: "CLAUDE_MODEL", group: "claude", label: "Model", help: "Blank = Claude Code's default model.", type: "text", default: "", when: { CLAUDE_REPAIR: "1" } },
  { key: "CLAUDE_BIN", group: "claude", label: "Claude command", help: "The Claude Code command or its full path.", type: "text", default: "claude", when: { CLAUDE_REPAIR: "1" } },
  { key: "MIN_LOC", group: "functions", label: "Minimum lines of code", help: "Keep only functions with at least this many lines (step 06). 0 = keep all.", type: "number", default: "0" },
  { key: "CONC", group: "performance", label: "Parallel downloads", help: "Packages downloaded at once.", type: "number", default: "4" },
  { key: "BUNDLE_CONC", group: "performance", label: "Packages bundled at once", help: "Each bundle runs in its own process; raise only with plenty of memory.", type: "number", default: "1" },
];
export const DEFAULTS = Object.fromEntries(PARAMS.map((p) => [p.key, p.default]));

// Step labels differ by MODE (same 6 slots, different meaning).
export const STEP_LABELS = {
  expensive: {
    "01": "01 · Crawl top packages",
    "02": "02 · Download with dependencies",
    "03": "03 · Bundle + source map + SBOM",
    "04": "04 · Select sample (from bundled deps)",
    "05": "05 · Collect selected bundles",
    "06": "06 · Extract functions",
    "07": "03b · Claude repair of failed bundles",
    "08": "02–03 · Stream packages (download → check → bundle → delete; Claude on failures at the end)",
  },
  cheap: {
    "01": "01 · Crawl + dependency/version metadata",
    "02": "02 · Select sample (from metadata)",
    "03": "03 · Download the sample",
    "04": "04 · Bundle the sample + SBOM",
    "05": "05 · Collect selected bundles",
    "06": "06 · Extract functions",
    "07": "04b · Claude repair of failed bundles",
    "08": "03–04 · Stream the sample (download → check → bundle → delete; Claude on failures at the end)",
  },
};

// The numbered steps a project runs, in order. The optional Claude repair step ("07") sits
// right after the bundling step: 03 in expensive mode, 04 in cheap mode.
// Streamed mode ("08") replaces download + bundle (+ the Claude step, which runs inside it):
// expensive 01 → 08 → 04 → 05 → 06; cheap 01 → 02 → 08 → 05 → 06. A project saved before
// streamed mode existed has no STREAM key and stays in batch mode.
export const ALL_STEP_IDS = ["01", "02", "03", "04", "05", "06", "07", "08"];
export function stepIdsFor(params = {}) {
  const mode = String(params.MODE ?? "expensive").toLowerCase() === "cheap" ? "cheap" : "expensive";
  if (String(params.STREAM ?? "0") === "1") return mode === "cheap" ? ["01", "02", "08", "05", "06"] : ["01", "08", "04", "05", "06"];
  const base = ["01", "02", "03", "04", "05", "06"];
  if (String(params.CLAUDE_REPAIR ?? "0") !== "1") return base;
  const after = mode === "cheap" ? "04" : "03";
  const i = base.indexOf(after) + 1;
  return [...base.slice(0, i), "07", ...base.slice(i)];
}

export const STEPS = [
  { id: "all", label: "Whole pipeline (01 → 06)" },
  { id: "setup", label: "Setup: install the pipeline's tools at their locked versions (npm ci)" },
  ...ALL_STEP_IDS.map((id) => ({ id, label: STEP_LABELS.expensive[id] })),
];

export function dirs(outRoot) {
  const OUT = outRoot ? resolve(outRoot) : join(HERE, "output");
  return {
    OUT,
    D1: join(OUT, "01_top1500_package_list"),
    D2: join(OUT, "02_downloaded_packages"),
    D3: join(OUT, "03_bundles_minified"),
    D4: join(OUT, "04_selected_sample"),
    D5: join(OUT, "05_selected_bundles"),
    D6: join(OUT, "06_extracted_functions"),
    LOGS: join(OUT, "logs"),
  };
}

// Which output directory each step OWNS (what to wipe on a clean re-run from a step).
// The physical dir per step differs between modes (cheap reorders download/bundle).
export function stepDirs(outRoot, mode = "expensive") {
  const d = dirs(outRoot);
  // step 07 (Claude repair) owns only its own work folder; the bundles it adds live in the
  // bundling step's folder, which is protected (see protectedDirs)
  const repair = join(d.D3, "claude_repair");
  if (String(mode).toLowerCase() === "cheap")
    return { "01": [d.D1], "02": [d.D4], "03": [d.D2], "04": [d.D3], "05": [d.D5], "06": [d.D6], "07": [repair], "08": [d.D2, d.D3] };
  return { "01": [d.D1], "02": [d.D2], "03": [d.D3], "04": [d.D4], "05": [d.D5], "06": [d.D6], "07": [repair], "08": [d.D2, d.D3] };
}

// Folders that hold the real bundles: the test bed. They are NEVER deleted — a clean re-run
// moves them aside into <output>/_archived_bundles/<time>/ instead (see lib-project.mjs).
export function protectedDirs(outRoot) {
  const d = dirs(outRoot);
  return [d.D3, d.D5];
}

// The bundler only reads UNMINIFIED=1 (MINIFY was passed but never read), so translate here.
// leave out dependencies that do not exist on npm (a labelled deviation; off by default)
const skipMissing = (p) => (String(p.SKIP_MISSING_DEPS ?? "0") === "1" ? { SKIP_MISSING_DEPS: "1" } : {});
const bundlerEnv = (p) => (String(p.MINIFY ?? "1") === "0" ? { UNMINIFIED: "1" } : {});

// Returns { cmd, args, cwd, env } for a step. Mirrors run-pipeline.sh exactly.
export function buildCommand(step, p) {
  const d = dirs(p.outDir);
  for (const dir of Object.values(d)) mkdirSync(dir, { recursive: true });
  const node = process.execPath;
  const onlyWithDeps = String(p.INCLUDE_ZERO_DEP) === "0" ? "1" : "0";
  const MODE = (p.MODE ?? "expensive").toLowerCase();

  switch (step) {
    case "all":
      return {
        cmd: "bash", args: [join(HERE, "run-pipeline.sh")], cwd: HERE,
        env: {
          TOP_N: p.TOP_N, PERIOD: p.PERIOD, DOWNLOAD_LIMIT: p.DOWNLOAD_LIMIT,
          INCLUDE_ZERO_DEP: p.INCLUDE_ZERO_DEP, CONC: p.CONC, BUNDLE_CONC: p.BUNDLE_CONC,
          MINIFY: p.MINIFY, SAMPLE_N: p.SAMPLE_N, MIN_DEPS: p.MIN_DEPS, MAX_DEPS: p.MAX_DEPS,
          SEED: p.SEED, MIN_LOC: p.MIN_LOC, DEP_BASIS: p.DEP_BASIS, DEP_DIST: p.DEP_DIST,
          CLAUDE_REPAIR: p.CLAUDE_REPAIR, CLAUDE_MAX_PACKAGES: p.CLAUDE_MAX_PACKAGES, CLAUDE_MAX_TURNS: p.CLAUDE_MAX_TURNS,
          CLAUDE_TIMEOUT_MIN: p.CLAUDE_TIMEOUT_MIN, CLAUDE_BUDGET_USD: p.CLAUDE_BUDGET_USD, CLAUDE_MODEL: p.CLAUDE_MODEL, CLAUDE_BIN: p.CLAUDE_BIN,
        },
      };
    case "setup":
      // every tool, at the exact versions in package-lock.json (webpack 5.112.2, meriyah 7.0.0, …),
      // installed once at the top of the pipeline where every script finds them
      return { cmd: "npm", args: ["ci", "--no-audit", "--no-fund"], cwd: dirname(HERE), env: {} };

    // ----- CHEAP MODE: 01 crawl+metadata, 02 select, 03 download sample, 04 bundle sample -----
    case "01":
      if (MODE === "cheap") return { cmd: node, args: [join(HERE, "01c-crawl-metadata.mjs"), d.D1, p.TOP_N, p.PERIOD, p.CONC], cwd: HERE, env: {} };
      return { cmd: node, args: [join(HERE, "01-1500-jsdeliver.mjs"), p.TOP_N, p.PERIOD], cwd: d.D1, env: {} };
    case "02":
      if (MODE === "cheap") {
        const a = [join(HERE, "02c-select.mjs"), d.D1, d.D4, "--basis", p.DEP_BASIS ?? "landed", "--n", p.SAMPLE_N, "--min", p.MIN_DEPS, "--max", p.MAX_DEPS, "--seed", p.SEED];
        if (p.DEP_DIST && String(p.DEP_DIST).trim()) a.push("--dist", String(p.DEP_DIST).trim());
        return { cmd: node, args: a, cwd: HERE, env: {} };
      }
      return { cmd: node, args: [join(HERE, "02-download-with-deps.mjs"), join(d.D1, "jsdelivr-top.json"), d.D2, p.CONC, p.DOWNLOAD_LIMIT], cwd: HERE, env: { ONLY_WITH_DEPS: onlyWithDeps, ...skipMissing(p) } };
    case "03":
      if (MODE === "cheap") return { cmd: node, args: [join(HERE, "02-download-with-deps.mjs"), join(d.D4, "selected-list.json"), d.D2, p.CONC, "all"], cwd: HERE, env: { ONLY_WITH_DEPS: "0", ...skipMissing(p) } };
      return { cmd: node, args: [join(HERE, "03-bundle-and-sbom.mjs"), d.D2, d.D3, p.BUNDLE_CONC], cwd: HERE, env: { MINIFY: p.MINIFY, ...bundlerEnv(p) } };
    case "04":
      if (MODE === "cheap") return { cmd: node, args: [join(HERE, "03-bundle-and-sbom.mjs"), d.D2, d.D3, p.BUNDLE_CONC], cwd: HERE, env: { MINIFY: p.MINIFY, ...bundlerEnv(p) } };
      {
        const a = [join(HERE, "04-select-sample40.mjs"), join(d.D3, "summary.json"), "--n", p.SAMPLE_N, "--min", p.MIN_DEPS, "--max", p.MAX_DEPS, "--seed", p.SEED, "--out", join(d.D4, "selected")];
        // batch keeps the downloads, so the selected ones are copied aside; streamed mode deleted them
        if (String(p.STREAM ?? "0") !== "1") a.push("--packages-dir", d.D2, "--copy-to", join(d.D4, "sample"));
        return { cmd: node, args: a, cwd: HERE, env: {} };
      }
    case "05":
      return { cmd: node, args: [join(HERE, "05-collect-selected-bundles.mjs"), join(d.D4, "selected.json"), d.D3, d.D5], cwd: HERE, env: {} };
    case "06":
      return { cmd: node, args: [join(HERE, "06-extract-functions.mjs"), join(d.D5, "bundles"), d.D6, "--min-loc", p.MIN_LOC], cwd: HERE, env: {} };
    case "08": {
      // streamed: one package at a time through the unchanged download / bundle / repair scripts
      const cheap = MODE === "cheap";
      const pos = (v, dflt) => (Number(v) > 0 ? String(Number(v)) : dflt);
      const a = [join(HERE, "08-stream-packages.mjs"), cheap ? join(d.D4, "selected-list.json") : join(d.D1, "jsdelivr-top.json"), d.D2, d.D3,
        "--conc", pos(p.CONC, "4"), "--bundle-conc", pos(p.BUNDLE_CONC, "1"), "--limit", cheap ? "all" : String(p.DOWNLOAD_LIMIT || "all"),
        "--keep", String(p.KEEP_ARTIFACTS ?? "")];
      if (String(p.CHECK_BUNDLEABLE ?? "1") === "0") a.push("--no-check");
      if (String(p.WORK_DIR ?? "").trim()) a.push("--work-dir", String(p.WORK_DIR).trim());
      if (String(p.CLAUDE_REPAIR ?? "0") === "1") {
        a.push("--claude", "--max", pos(p.CLAUDE_MAX_PACKAGES, "20"), "--max-turns", pos(p.CLAUDE_MAX_TURNS, "40"),
          "--timeout-min", pos(p.CLAUDE_TIMEOUT_MIN, "20"), "--claude-bin", String(p.CLAUDE_BIN ?? "").trim() || "claude");
        if (String(p.CLAUDE_BUDGET_USD ?? "").trim()) a.push("--budget-usd", String(p.CLAUDE_BUDGET_USD).trim());
        if (String(p.CLAUDE_MODEL ?? "").trim()) a.push("--model", String(p.CLAUDE_MODEL).trim());
      }
      return { cmd: node, args: a, cwd: HERE, env: { ...bundlerEnv(p), ...skipMissing(p), ONLY_WITH_DEPS: cheap ? "0" : onlyWithDeps } };
    }
    case "07": {
      // Claude repair: same packages folder and bundle folder as the bundling step, and the
      // bundler's exact environment, so a repaired bundle is built the same way as the rest
      // a blank or non-positive number falls back to its default (a blank "packages per run"
      // would otherwise become 0 and the step would silently try nothing)
      const pos = (v, dflt) => (Number(v) > 0 ? String(Number(v)) : dflt);
      const a = [join(HERE, "07-claude-repair-bundles.mjs"), d.D2, d.D3,
        "--max", pos(p.CLAUDE_MAX_PACKAGES, "20"), "--max-turns", pos(p.CLAUDE_MAX_TURNS, "40"),
        "--timeout-min", pos(p.CLAUDE_TIMEOUT_MIN, "20"), "--claude-bin", String(p.CLAUDE_BIN ?? "").trim() || "claude"];
      if (String(p.CLAUDE_BUDGET_USD ?? "").trim()) a.push("--budget-usd", String(p.CLAUDE_BUDGET_USD).trim());
      if (String(p.CLAUDE_MODEL ?? "").trim()) a.push("--model", String(p.CLAUDE_MODEL).trim());
      return { cmd: node, args: a, cwd: HERE, env: bundlerEnv(p) };
    }
    default:
      throw new Error(`unknown step: ${step}`);
  }
}
