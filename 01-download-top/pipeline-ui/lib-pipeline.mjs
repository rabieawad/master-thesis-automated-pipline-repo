// Shared definitions for the first pipeline: parameters, steps, output layout and
// the exact command each step runs. Imported by both server.mjs (web panel) and
// wizard.mjs (interactive CLI). The 01..06 scripts and run-pipeline.sh do not
// depend on this file and keep working on their own.

import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdirSync } from "node:fs";

export const HERE = dirname(fileURLToPath(import.meta.url));

// Every knob, with the NEW defaults (zero-dep included; stage-04 min = 0).
export const PARAMS = [
  { key: "TOP_N", label: "How many top packages to crawl (step 01)", type: "number", default: "1500" },
  { key: "PERIOD", label: "jsDelivr stats period (step 01)", type: "select", options: ["day", "week", "month", "year"], default: "month" },
  { key: "DOWNLOAD_LIMIT", label: "How many packages to download (step 02; 'all' or a number)", type: "text", default: "all" },
  { key: "INCLUDE_ZERO_DEP", label: "Include packages with no dependencies (download + bundle)", type: "bool", default: "1" },
  { key: "CONC", label: "Parallel downloads (step 02)", type: "number", default: "4" },
  { key: "BUNDLE_CONC", label: "Packages bundled at once (step 03)", type: "number", default: "1" },
  { key: "MINIFY", label: "Minify bundles (step 03)", type: "bool", default: "1" },
  { key: "SAMPLE_N", label: "How many packages to pick (step 04)", type: "number", default: "40" },
  { key: "MIN_DEPS", label: "Min bundled dependencies to allow (step 04; 0 = allow zero-dep)", type: "number", default: "0" },
  { key: "MAX_DEPS", label: "Max bundled dependencies to allow (step 04)", type: "number", default: "20" },
  { key: "SEED", label: "Random seed for the selection (step 04)", type: "number", default: "42" },
  { key: "MIN_LOC", label: "Keep only functions with >= this many lines (step 06; 0 = keep all)", type: "number", default: "0" },
];
export const DEFAULTS = Object.fromEntries(PARAMS.map((p) => [p.key, p.default]));

export const STEPS = [
  { id: "all", label: "Whole pipeline (01 → 06)" },
  { id: "setup", label: "Setup: install webpack / meriyah / escodegen" },
  { id: "01", label: "01 · Crawl top packages" },
  { id: "02", label: "02 · Download with dependencies" },
  { id: "03", label: "03 · Bundle + source map + SBOM" },
  { id: "04", label: "04 · Select sample" },
  { id: "05", label: "05 · Collect selected bundles" },
  { id: "06", label: "06 · Extract functions" },
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

// Returns { cmd, args, cwd, env } for a step. Mirrors run-pipeline.sh exactly.
export function buildCommand(step, p) {
  const d = dirs(p.outDir);
  for (const dir of Object.values(d)) mkdirSync(dir, { recursive: true });
  const node = process.execPath;
  const onlyWithDeps = String(p.INCLUDE_ZERO_DEP) === "0" ? "1" : "0";

  switch (step) {
    case "all":
      return {
        cmd: "bash", args: [join(HERE, "run-pipeline.sh")], cwd: HERE,
        env: {
          TOP_N: p.TOP_N, PERIOD: p.PERIOD, DOWNLOAD_LIMIT: p.DOWNLOAD_LIMIT,
          INCLUDE_ZERO_DEP: p.INCLUDE_ZERO_DEP, CONC: p.CONC, BUNDLE_CONC: p.BUNDLE_CONC,
          MINIFY: p.MINIFY, SAMPLE_N: p.SAMPLE_N, MIN_DEPS: p.MIN_DEPS, MAX_DEPS: p.MAX_DEPS,
          SEED: p.SEED, MIN_LOC: p.MIN_LOC,
        },
      };
    case "setup":
      return { cmd: "npm", args: ["install", "--no-save", "--no-audit", "--no-fund", "webpack", "meriyah@6.0.6", "escodegen@2.1.0"], cwd: HERE, env: {} };
    case "01":
      return { cmd: node, args: [join(HERE, "01-1500-jsdeliver.mjs"), p.TOP_N, p.PERIOD], cwd: d.D1, env: {} };
    case "02":
      return { cmd: node, args: [join(HERE, "02-download-with-deps.mjs"), join(d.D1, "jsdelivr-top.json"), d.D2, p.CONC, p.DOWNLOAD_LIMIT], cwd: HERE, env: { ONLY_WITH_DEPS: onlyWithDeps } };
    case "03":
      return { cmd: node, args: [join(HERE, "03-bundle-and-sbom.mjs"), d.D2, d.D3, p.BUNDLE_CONC], cwd: HERE, env: { MINIFY: p.MINIFY } };
    case "04":
      return { cmd: node, args: [join(HERE, "04-select-sample40.mjs"), join(d.D3, "summary.json"), "--n", p.SAMPLE_N, "--min", p.MIN_DEPS, "--max", p.MAX_DEPS, "--seed", p.SEED, "--out", join(d.D4, "selected"), "--packages-dir", d.D2, "--copy-to", join(d.D4, "sample")], cwd: HERE, env: {} };
    case "05":
      return { cmd: node, args: [join(HERE, "05-collect-selected-bundles.mjs"), join(d.D4, "selected.json"), d.D3, d.D5], cwd: HERE, env: {} };
    case "06":
      return { cmd: node, args: [join(HERE, "06-extract-functions.mjs"), join(d.D5, "bundles"), d.D6, "--min-loc", p.MIN_LOC], cwd: HERE, env: {} };
    default:
      throw new Error(`unknown step: ${step}`);
  }
}
