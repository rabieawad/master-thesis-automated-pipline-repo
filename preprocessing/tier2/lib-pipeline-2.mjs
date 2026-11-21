// Shared definitions for the SECOND (reference) pipeline: parameters, steps,
// output layout and the exact command each step runs. Imported by server2.mjs
// (web panel) and wizard2.mjs (interactive CLI). The steps 01..05 scripts and
// run-pipeline-2.sh keep working on their own without this file.

import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

export const HERE = dirname(fileURLToPath(import.meta.url));

// Every setting. `group` decides where it appears in the settings panel, `label` is the short
// name and `help` the one-line explanation shown under it. `modes` restricts a setting to
// batch or streamed mode. KEEP_ARTIFACTS is a "multi" setting: a list of checkboxes, stored as
// a comma list ("02,04"); `fixed` lists what is always kept and cannot be unticked.
export const GROUPS = [
  { id: "mode", title: "Mode & disk", help: "Streamed or batch, and which intermediate files to keep" },
  { id: "packages", title: "Packages & versions", help: "Which packages and which of their versions are indexed" },
  { id: "extraction", title: "Pseudo-bundling & extraction", help: "How each version is bundled and which functions are kept" },
  { id: "dedup", title: "Deduplication", help: "When two functions count as the same" },
  { id: "lineage", title: "Function lineages", help: "Linking the edited versions of each function across versions" },
  { id: "performance", title: "Performance", help: "Parallel work" },
];
export const KEEP_OPTIONS = [
  { value: "02", label: "Downloaded tarballs", help: "02_downloaded_packages/*.tgz" },
  { value: "03", label: "Pseudo-bundles", help: "03_pseudo_bundles/bundles/*.js" },
  { value: "04", label: "Per-version function files", help: "04_extracted_functions/*.functions.json" },
  { value: "partials", label: "Per-package partial results", help: "lets the merge be re-run with other trivial / near-duplicate settings" },
];
export const PARAMS = [
  { key: "INPUT_DIR", group: "packages", label: "Tier-1 output folder", help: "Set automatically in a project.", type: "text", default: "" },
  { key: "STREAM", group: "mode", label: "Streamed mode", help: "One package at a time: download → bundle → extract → collect, keeping only its final function collection. Off = batch mode, where every intermediate file of every package is on disk at once.", type: "bool", default: "1" },
  { key: "PACK_OUTPUTS", group: "mode", label: "Pack outputs into .tgz when a run ends", help: "Each step's per-package files (pseudo-bundles, function files, packages/<package>.json, kept downloads…) go into one .tgz per kind, e.g. 05_deduplicated_functions/packages.tgz. Logs, lists, summaries and the merged dataset stay as plain files. They are unpacked automatically before the next run.", type: "bool", default: "1" },
  { key: "KEEP_ARTIFACTS", group: "mode", label: "Keep these intermediate files", help: "Ticked steps keep all their files; unticked ones are deleted as soon as each package is done.", type: "multi", options: KEEP_OPTIONS, fixed: [{ label: "Each package's function collection", help: "packages/<package>.json — always kept" }, { label: "Logs", help: "always kept" }, { label: "Per-version records and group manifests", help: "always kept" }], default: "03", modes: ["streamed"] },
  { key: "VERSIONS", group: "packages", label: "Versions per package", help: "all = every published stable version (Aletheia's full index). minor = patches of the observed major.minor. latest = newest only. exact = the observed version only.", type: "select", options: ["all", "minor", "latest", "exact"], default: "all" },
  { key: "INCLUDE_PACKAGE", group: "packages", label: "Include the selected packages themselves", help: "Off = index only their dependencies.", type: "bool", default: "1" },
  { key: "KEEP_EXPORTS", group: "extraction", label: "Keep exported code (not in the original)", help: "The original Aletheia pseudo-bundler removes every export statement together with the exported declaration, so ES-module packages lose most of their code. On = keep it, reachable through _$__e.exports. Off = faithful.", type: "bool", default: "0" },
  { key: "MINIFY", group: "extraction", label: "Minify pseudo-bundles", help: "On = faithful to Aletheia (swc). Off = un-minified, so line counts in function extraction are real.", type: "bool", default: "0" },
  { key: "MIN_LOC", group: "extraction", label: "Minimum lines of code", help: "Keep only functions with at least this many lines. 0 = keep all; 6 = the Debun paper's filter.", type: "number", default: "0" },
  { key: "DEDUP_MODE", group: "dedup", label: "Compare bodies as", help: "normalized: locals renamed v0, v1, … so a renamed variable still matches. exact: raw body text.", type: "select", options: ["normalized", "exact"], default: "normalized" },
  { key: "DEDUP_IDENTITY", group: "dedup", label: "Identity check", help: "string: keep each function's full key and stop on any id collision. hash: compare the truncated sha256 ids only.", type: "select", options: ["string", "hash"], default: "string" },
  { key: "DEDUP_STRICT_TYPE", group: "dedup", label: "Keep declarations and expressions apart", help: "On: `function f(){}` and `f = function(){}` with the same body stay two records.", type: "bool", default: "0" },
  { key: "LINK_EDITS", group: "lineage", label: "Function lineages (history + markers)", help: "Adds a step after the merge: within each package, the edited versions of each function are linked into a lineage. lineages/<package>.json gets each lineage's history (born, edited, reverted, removed, reappeared, with the code changes), checked code markers and a rule per variant for version detection; packages/<package>.json gets only a lineage tag per function. Streamed mode only.", type: "bool", default: "1", when: { STREAM: "1" } },
  { key: "LINK_MIN_SIMILARITY", group: "lineage", label: "Minimum similarity for a link", help: "0–1. Higher = fewer, safer links; lower = more links, more false ones. 0.5 by default.", type: "number", default: "0.5", when: { STREAM: "1" } },
  { key: "LINK_TRIVIAL", group: "lineage", label: "Link trivial functions too", help: "Off: tiny functions (see Trivial below) are never linked, because they look alike and would create false links.", type: "bool", default: "0", when: { STREAM: "1" } },
  { key: "LINK_MAX_RULE", group: "lineage", label: "Markers per variant rule (at most)", help: "How many markers a rule may combine to tell a variant from its siblings. 3 by default.", type: "number", default: "3", when: { STREAM: "1" } },
  { key: "TRIVIAL_NODES", group: "dedup", label: "Trivial below (AST nodes)", help: "Functions smaller than this are flagged trivial, e.g. `{}` or `{ return v0; }`.", type: "number", default: "6" },
  { key: "NEAR_THRESHOLD", group: "dedup", label: "List near-duplicates from (Jaccard)", help: "e.g. 0.85 lists pairs at least that similar; they are never merged. 0 = off.", type: "number", default: "0" },
  { key: "CONC", group: "performance", label: "Parallel registry queries and downloads", help: "Used by the version list and the downloads.", type: "number", default: "6" },
  { key: "BUNDLE_CONC", group: "performance", label: "Versions pseudo-bundled at once", help: "Within one package in streamed mode.", type: "number", default: "4" },
];
export const DEFAULTS = Object.fromEntries(PARAMS.map((p) => [p.key, p.default]));

// Tier 2 has two modes. Batch runs each step over ALL packages (steps 01..05). Streamed runs
// step 01 once, then works through the tier-1 groups one package at a time (06) and merges the
// per-package partials at the end (07) — same outputs, a fraction of the disk.
// New projects get STREAM="1" from PARAMS, so streamed is the default for anything created
// from now on. A saved project (or a caller) with no STREAM key at all predates streamed mode,
// so it stays in batch mode and keeps resuming exactly as before.
export const modeOf = (params) => (String(params?.STREAM ?? "") === "1" ? "streamed" : "batch");

// Step labels differ by mode. In streamed mode the label carries the batch step numbers the
// step stands for ("02–05", "05"), because that is what the user knows those stages as.
export const STEP_LABELS = {
  batch: {
    "01": "01 · Build reference list (+ version expansion)",
    "02": "02 · Download packages (npm pack)",
    "03": "03 · Pseudo-bundle (package's own code)",
    "04": "04 · Extract functions",
    "05": "05 · Deduplicate functions across versions",
  },
  streamed: {
    "01": "01 · Build reference list (+ version expansion)",
    "06": "02–05 · Stream packages (download → bundle → extract → collect)",
    "07": "05 · Merge",
    "08": "06 · Function lineages (history + markers)",
  },
};

// Which numbered steps a mode actually runs, in order.
export const STEP_IDS = { batch: ["01", "02", "03", "04", "05"], streamed: ["01", "06", "07", "08"] };
export const ALL_STEP_IDS = ["01", "02", "03", "04", "05", "06", "07", "08"];
// the lineage step ("08") runs in streamed mode unless LINK_EDITS is switched off
export const stepIdsFor = (mode = "batch", params = {}) => {
  const ids = STEP_IDS[mode] ?? STEP_IDS.batch;
  return String(params.LINK_EDITS ?? "1") === "0" ? ids.filter((id) => id !== "08") : ids;
};

export const STEPS = [
  { id: "all", label: "Whole reference pipeline" },
  { id: "setup", label: "Setup: install bundler + collector deps" },
  ...ALL_STEP_IDS.map((id) => ({ id, label: STEP_LABELS.batch[id] ?? STEP_LABELS.streamed[id] })),
];

export function dirs(outRoot) {
  const OUT = outRoot ? resolve(outRoot) : join(HERE, "output2");
  return {
    OUT,
    D1: join(OUT, "01_reference_list"),
    D2: join(OUT, "02_downloaded_packages"),
    D3: join(OUT, "03_pseudo_bundles"),
    D4: join(OUT, "04_extracted_functions"),
    D5: join(OUT, "05_deduplicated_functions"),
    LOGS: join(OUT, "logs"),
  };
}

// Which output directory each step OWNS (what to wipe on a clean re-run from a step).
// Mode-aware: in streamed mode the stream step owns everything the per-package work produces
// (including the partials, version records and group manifests), while the merge step owns only
// its own final files — wiping the whole 05_ folder there would destroy the partials it reads.
export function stepDirs(outRoot, mode = "batch") {
  const d = dirs(outRoot);
  if (String(mode).toLowerCase() === "streamed") {
    return {
      "01": [d.D1],
      "06": [d.D2, d.D3, d.D4, join(d.OUT, "_work"), join(d.D5, "partials"), join(d.D5, "versions"), join(d.D5, "groups"), join(d.LOGS, "stream")],
      "07": ["unique_functions.jsonl", "occurrences.csv", "version_index.json", "near_duplicates.csv", "summary.json"].map((f) => join(d.D5, f)),
      "08": [join(d.D5, "lineages")], // the lineage files; the tags in packages/ are rewritten on the re-run
    };
  }
  return { "01": [d.D1], "02": [d.D2], "03": [d.D3], "04": [d.D4], "05": [d.D5] };
}

export function buildCommand(step, p) {
  // projects saved while the removed "sample" mode existed now index every version
  if (String(p.VERSIONS ?? "").toLowerCase() === "sample") p = { ...p, VERSIONS: "all" };
  const d = dirs(p.outDir);
  for (const dir of Object.values(d)) mkdirSync(dir, { recursive: true });
  const node = process.execPath;
  // per-package inclusion selection (written by the server to the tier-2 output root)
  const selFile = join(d.OUT, "selection.json");
  const selArgs = existsSync(selFile) ? ["--selection", selFile] : [];

  switch (step) {
    case "all":
      return {
        cmd: "bash", args: [join(HERE, "run-pipeline-2.sh")], cwd: HERE,
        env: {
          INPUT_DIR: p.INPUT_DIR, VERSIONS: p.VERSIONS, INCLUDE_PACKAGE: p.INCLUDE_PACKAGE,
          CONC: p.CONC, BUNDLE_CONC: p.BUNDLE_CONC, MINIFY: p.MINIFY, MIN_LOC: p.MIN_LOC,
          DEDUP_MODE: p.DEDUP_MODE, DEDUP_IDENTITY: p.DEDUP_IDENTITY, DEDUP_STRICT_TYPE: p.DEDUP_STRICT_TYPE, TRIVIAL_NODES: p.TRIVIAL_NODES, NEAR_THRESHOLD: p.NEAR_THRESHOLD,
          STREAM: p.STREAM, KEEP_ARTIFACTS: p.KEEP_ARTIFACTS,
        },
      };
    case "setup":
      // every tool, at the exact versions in package-lock.json (webpack 5.112.2, meriyah 7.0.0, …),
      // installed once at the top of the pipeline where every script finds them
      return { cmd: "npm", args: ["ci", "--no-audit", "--no-fund"], cwd: dirname(HERE), env: {} };
    case "01": {
      const a = [join(HERE, "01_build-list.mjs"), p.INPUT_DIR || ".", d.D1, "--versions", p.VERSIONS, "--conc", p.CONC];
      if (String(p.INCLUDE_PACKAGE) === "0") a.push("--no-package");
      a.push(...selArgs);
      return { cmd: node, args: a, cwd: HERE, env: {} };
    }
    case "preview": {
      // dry-run of step 01: count what WOULD be downloaded for the current settings (+ sweep),
      // without writing the real list or downloading anything.
      const a = [join(HERE, "01_build-list.mjs"), p.INPUT_DIR || ".", d.D1, "--versions", p.VERSIONS, "--conc", p.CONC, "--preview"];
      if (String(p.INCLUDE_PACKAGE) === "0") a.push("--no-package");
      a.push(...selArgs);
      return { cmd: node, args: a, cwd: HERE, env: {} };
    }
    case "02":
      return { cmd: node, args: [join(HERE, "02_download.mjs"), join(d.D1, "reference-packages.json"), d.D2, p.CONC], cwd: HERE, env: {} };
    case "03":
      // step 03 only reads UNMINIFIED=1 (MINIFY was passed but never read), so translate here,
      // exactly as the streamed driver does
      return { cmd: node, args: [join(HERE, "03_pseudo-bundle.mjs"), d.D2, d.D3, p.BUNDLE_CONC], cwd: HERE, env: { MINIFY: p.MINIFY, KEEP_EXPORTS: String(p.KEEP_EXPORTS ?? "0") === "1" ? "1" : "0", ...(String(p.MINIFY) === "0" ? { UNMINIFIED: "1" } : {}) } };
    case "04":
      return { cmd: node, args: [join(HERE, "04_extract-functions.mjs"), join(d.D3, "bundles"), d.D4, "--min-loc", p.MIN_LOC], cwd: HERE, env: {} };
    case "05": {
      // pure Node, no extra deps; holds every unique function in memory, so raise the heap cap
      // (via NODE_OPTIONS so args[0] stays the script for the server's preflight check)
      const a = [join(HERE, "05_dedup-functions.mjs"), d.D4, d.D5, "--mode", p.DEDUP_MODE || "normalized", "--identity", p.DEDUP_IDENTITY || "string"];
      if (String(p.DEDUP_STRICT_TYPE) === "1") a.push("--strict-type");
      if (p.TRIVIAL_NODES != null && p.TRIVIAL_NODES !== "") a.push("--trivial-nodes", p.TRIVIAL_NODES);
      if (Number(p.NEAR_THRESHOLD) > 0) a.push("--near", p.NEAR_THRESHOLD);
      return { cmd: node, args: a, cwd: HERE, env: { NODE_OPTIONS: "--max-old-space-size=6144" } };
    }
    // ----- STREAMED MODE: 06 = steps 02-05a per package, 07 = step 05b (merge) -----
    case "06": {
      const a = [join(HERE, "06_stream-packages.mjs"), d.OUT, "--input", p.INPUT_DIR || ".",
        "--conc", p.CONC, "--bundle-conc", p.BUNDLE_CONC, "--min-loc", p.MIN_LOC,
        "--mode", p.DEDUP_MODE || "normalized", "--identity", p.DEDUP_IDENTITY || "string", "--keep", p.KEEP_ARTIFACTS ?? "",
        "--trivial-nodes", p.TRIVIAL_NODES ?? "6"];
      if (String(p.DEDUP_STRICT_TYPE) === "1") a.push("--strict-type");
      if (String(p.INCLUDE_PACKAGE) === "0") a.push("--no-package");
      // MINIFY is translated to step 03's UNMINIFIED inside the driver (step 03 is untouched)
      return { cmd: node, args: a, cwd: HERE, env: { MINIFY: p.MINIFY, KEEP_EXPORTS: String(p.KEEP_EXPORTS ?? "0") === "1" ? "1" : "0" } };
    }
    case "07": {
      // same 6 GB heap as batch step 05: the merge holds every unique function in memory
      const a = [join(HERE, "07_merge-partials.mjs"), d.D5];
      if (p.TRIVIAL_NODES != null && p.TRIVIAL_NODES !== "") a.push("--trivial-nodes", p.TRIVIAL_NODES);
      if (Number(p.NEAR_THRESHOLD) > 0) a.push("--near", p.NEAR_THRESHOLD);
      const keep = String(p.KEEP_ARTIFACTS ?? "").split(",").map((s) => s.trim());
      if (keep.some((k) => k === "partials" || k === "all")) a.push("--keep-partials");
      return { cmd: node, args: a, cwd: HERE, env: { NODE_OPTIONS: "--max-old-space-size=6144" } };
    }
    case "08": {
      const a = [join(HERE, "08_link-edits.mjs"), d.D5];
      if (p.LINK_MIN_SIMILARITY != null && String(p.LINK_MIN_SIMILARITY) !== "") a.push("--min-similarity", String(p.LINK_MIN_SIMILARITY));
      if (String(p.LINK_TRIVIAL ?? "0") === "1") a.push("--include-trivial");
      if (p.LINK_MAX_RULE != null && String(p.LINK_MAX_RULE) !== "") a.push("--max-rule", String(p.LINK_MAX_RULE));
      return { cmd: node, args: a, cwd: HERE, env: { NODE_OPTIONS: "--max-old-space-size=6144" } };
    }
    default:
      throw new Error(`unknown step: ${step}`);
  }
}
