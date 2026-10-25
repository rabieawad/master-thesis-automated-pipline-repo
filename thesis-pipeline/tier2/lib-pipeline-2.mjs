// Shared definitions for the SECOND (reference) pipeline: parameters, steps,
// output layout and the exact command each step runs. Imported by server2.mjs
// (web panel) and wizard2.mjs (interactive CLI). The steps 01..04 scripts and
// run-pipeline-2.sh keep working on their own without this file.

import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdirSync } from "node:fs";

export const HERE = dirname(fileURLToPath(import.meta.url));

export const PARAMS = [
  { key: "INPUT_DIR", label: "First pipeline's output folder (its 04_/05_ folders live here)", type: "text", default: "" },
  { key: "VERSIONS", label: "Which versions to download per package (all = every major/minor/patch; sample = cap big histories)", type: "select", options: ["all", "sample", "minor", "latest", "exact"], default: "all" },
  { key: "SAMPLE_THRESHOLD", label: "VERSIONS=sample: take all if a package has ≤ this many versions, else sample", type: "number", default: "50" },
  { key: "ADJACENT_N", label: "VERSIONS=sample: neighbours of the observed version to always keep", type: "number", default: "4" },
  { key: "PER_MINOR_N", label: "VERSIONS=sample: patches taken per major.minor group (lower = caps harder)", type: "number", default: "4" },
  { key: "SEED", label: "VERSIONS=sample: random seed (reproducible sampling)", type: "number", default: "42" },
  { key: "INCLUDE_PACKAGE", label: "Include the packages themselves (not just their dependencies)", type: "bool", default: "1" },
  { key: "CONC", label: "Parallel registry queries / downloads (steps 01-02)", type: "number", default: "6" },
  { key: "BUNDLE_CONC", label: "Packages pseudo-bundled at once (step 03)", type: "number", default: "4" },
  { key: "MINIFY", label: "Minify the pseudo-bundles (step 03; off = correct LOC in step 04)", type: "bool", default: "0" },
  { key: "MIN_LOC", label: "Keep only functions with LOC >= this (step 04; 0 = keep all, 6 = paper filter)", type: "number", default: "0" },
];
export const DEFAULTS = Object.fromEntries(PARAMS.map((p) => [p.key, p.default]));

export const STEPS = [
  { id: "all", label: "Whole reference pipeline (01 → 04)" },
  { id: "setup", label: "Setup: install bundler + collector deps" },
  { id: "01", label: "01 · Build reference list (+ version expansion)" },
  { id: "02", label: "02 · Download packages (npm pack)" },
  { id: "03", label: "03 · Pseudo-bundle (package's own code)" },
  { id: "04", label: "04 · Extract functions" },
];

export function dirs(outRoot) {
  const OUT = outRoot ? resolve(outRoot) : join(HERE, "output2");
  return {
    OUT,
    D1: join(OUT, "01_reference_list"),
    D2: join(OUT, "02_downloaded_packages"),
    D3: join(OUT, "03_pseudo_bundles"),
    D4: join(OUT, "04_extracted_functions"),
    LOGS: join(OUT, "logs"),
  };
}

export function buildCommand(step, p) {
  const d = dirs(p.outDir);
  for (const dir of Object.values(d)) mkdirSync(dir, { recursive: true });
  const node = process.execPath;

  switch (step) {
    case "all":
      return {
        cmd: "bash", args: [join(HERE, "run-pipeline-2.sh")], cwd: HERE,
        env: {
          INPUT_DIR: p.INPUT_DIR, VERSIONS: p.VERSIONS, INCLUDE_PACKAGE: p.INCLUDE_PACKAGE,
          SAMPLE_THRESHOLD: p.SAMPLE_THRESHOLD, ADJACENT_N: p.ADJACENT_N, PER_MINOR_N: p.PER_MINOR_N, SEED: p.SEED,
          CONC: p.CONC, BUNDLE_CONC: p.BUNDLE_CONC, MINIFY: p.MINIFY, MIN_LOC: p.MIN_LOC,
        },
      };
    case "setup":
      return { cmd: "npm", args: ["install", "--no-save", "--no-audit", "--no-fund", "@swc/core", "acorn", "acorn-loose", "acorn-walk", "astring", "meriyah@6.0.6", "escodegen@2.1.0"], cwd: HERE, env: {} };
    case "01": {
      const a = [join(HERE, "01_build-list.mjs"), p.INPUT_DIR || ".", d.D1, "--versions", p.VERSIONS, "--conc", p.CONC];
      if (p.SAMPLE_THRESHOLD != null) a.push("--sample-threshold", p.SAMPLE_THRESHOLD);
      if (p.ADJACENT_N != null) a.push("--adjacent-n", p.ADJACENT_N);
      if (p.PER_MINOR_N != null) a.push("--per-minor-n", p.PER_MINOR_N);
      if (p.SEED != null) a.push("--seed", p.SEED);
      if (String(p.INCLUDE_PACKAGE) === "0") a.push("--no-package");
      return { cmd: node, args: a, cwd: HERE, env: {} };
    }
    case "02":
      return { cmd: node, args: [join(HERE, "02_download.mjs"), join(d.D1, "reference-packages.json"), d.D2, p.CONC], cwd: HERE, env: {} };
    case "03":
      return { cmd: node, args: [join(HERE, "03_pseudo-bundle.mjs"), d.D2, d.D3, p.BUNDLE_CONC], cwd: HERE, env: { MINIFY: p.MINIFY } };
    case "04":
      return { cmd: node, args: [join(HERE, "04_extract-functions.mjs"), join(d.D3, "bundles"), d.D4, "--min-loc", p.MIN_LOC], cwd: HERE, env: {} };
    default:
      throw new Error(`unknown step: ${step}`);
  }
}
