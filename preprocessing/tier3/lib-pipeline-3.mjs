// Shared definitions for the THIRD pipeline (detection): parameters, steps, output layout and
// the exact command each step runs. Imported by lib-project.mjs (web panel). The 01..03 scripts
// keep working on their own without this file.
//
// Tier 3 reads tier 1's test bed (the bundles' extracted functions, SBOMs and source maps) and
// tier 2's reference dataset, and decides which packages and versions are in each bundle.
// Nothing here is part of Aletheia or Debun.

import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdirSync } from "node:fs";

export const HERE = dirname(fileURLToPath(import.meta.url));

export const GROUPS = [
  { id: "outputs", title: "Outputs", help: "What is computed and how it is stored" },
  { id: "matching", title: "Matching", help: "When a bundle function counts as a reference function" },
  { id: "decision", title: "Packages", help: "When a package counts as being in the bundle" },
  { id: "versions", title: "Versions", help: "How the version (range) is decided" },
];
export const MODE_OPTIONS = [
  { value: "exact", label: "exact", help: "exact fingerprint matches only" },
  { value: "approx", label: "approx", help: "exact + approximate (MinHash) matches" },
  { value: "approx+lineage", label: "approx+lineage", help: "approx, with tier 2's lineage markers deciding the versions of approximate matches" },
];
export const PARAMS = [
  { key: "PACK_OUTPUTS", group: "outputs", label: "Pack outputs into .tgz when a run ends", help: "The per-bundle detection files go into 02_detections/bundles.tgz; the index, the report and the CSVs stay as plain files. Unpacked automatically before the next run.", type: "bool", default: "1" },
  { key: "MODES", group: "outputs", label: "Detection modes", help: "Computed from the same matches, so they can be compared.", type: "multi", options: MODE_OPTIONS, default: "exact,approx,approx+lineage" },
  { key: "EVALUATE", group: "outputs", label: "Evaluate against the SBOMs", help: "Check every detection against the bundle's SBOM, and use its source map to explain each miss and false detection. Off = detections only (e.g. for bundles without ground truth).", type: "bool", default: "1" },
  { key: "MIN_SIM", group: "matching", label: "Minimum similarity of an approximate match", help: "Estimated Jaccard similarity of the code's 3-token shingles, 0–1. 0.5 by default.", type: "number", default: "0.5" },
  { key: "MIN_BANDS", group: "matching", label: "Candidate filter (LSH bands)", help: "A reference function is compared only when it shares this many of the 21 MinHash bands. 2 is 4× faster than 1 and lost 0.03 % of the matches on the test bed.", type: "number", default: "2" },
  { key: "MAX_SHARED", group: "matching", label: "Ignore functions found in more packages than", help: "Babel/TypeScript helpers and webpack's runtime appear in hundreds of packages and prove nothing. 30 by default.", type: "number", default: "30" },
  { key: "MIN_EVIDENCE", group: "decision", label: "Minimum evidence", help: "Sum over the package's unexplained matches of similarity × specificity × size. 1.5 by default.", type: "number", default: "1.5" },
  { key: "MIN_FUNCTIONS", group: "decision", label: "Minimum matched functions", help: "2 by default.", type: "number", default: "2" },
  { key: "MIN_COVERAGE", group: "decision", label: "Minimum coverage", help: "Share of the package's own functions (at its best version) the bundle must match. 0.05 by default.", type: "number", default: "0.05" },
  { key: "SMALL_COVERAGE", group: "decision", label: "Coverage that accepts a small package", help: "A package with a handful of functions can't reach the minimum evidence; it is accepted when the bundle covers this share of it. 0.5 by default.", type: "number", default: "0.5" },
  { key: "SHARE_COVERAGE", group: "decision", label: "Coverage for code shared with another package", help: "When an earlier package's reference holds a copy of this package's code (a UMD build with its dependencies), this package is still found at this coverage. Above 1 = off. 0.5 by default.", type: "number", default: "0.5" },
  { key: "VERSION_METHOD", group: "versions", label: "How the version is decided", help: "intersect: every function of the package is consistent with a set of versions; the package's version is their intersection (one version = exact, several = a range). vote: each version scores the evidence of the functions consistent with it.", type: "select", options: ["intersect", "vote"], default: "intersect" },
  { key: "VERSION_FALLBACK", group: "versions", label: "When the functions contradict each other", help: "intersect only. most: the versions consistent with the most functions, the others listed as conflicts. union: every function's versions together (wide). The union is always written too.", type: "select", options: ["most", "union"], default: "most" },
  { key: "VERSION_TOLERANCE", group: "versions", label: "Version range tolerance (vote)", help: "Versions whose score is within this share of the best form the reported range. 0.03 by default.", type: "number", default: "0.03" },
  { key: "VERSION_PICK", group: "versions", label: "Reported version (vote)", help: "latest: the best-scoring version, the newest among equals. parsimony: the version with the fewest of its own functions missing (biased to old versions when only part of a package is bundled).", type: "select", options: ["latest", "parsimony"], default: "latest" },
];
export const DEFAULTS = Object.fromEntries(PARAMS.map((p) => [p.key, p.default]));

export const STEP_LABELS = {
  "01": "01 · Build the search index (from tier 2)",
  "02": "02 · Detect packages and versions in the bundles",
  "03": "03 · Report (metrics against the SBOMs)",
};
export const STEP_IDS = ["01", "02", "03"];
export const ALL_STEP_IDS = STEP_IDS;
export const stepIdsFor = () => STEP_IDS;
export const STEPS = [
  { id: "all", label: "Whole detection pipeline" },
  { id: "setup", label: "Setup: install the pipeline's dependencies" },
  ...STEP_IDS.map((id) => ({ id, label: STEP_LABELS[id] })),
];

export function dirs(outRoot) {
  const OUT = outRoot ? resolve(outRoot) : join(HERE, "output3");
  return { OUT, D1: join(OUT, "01_index"), D2: join(OUT, "02_detections"), D3: join(OUT, "03_report"), LOGS: join(OUT, "logs") };
}
export function stepDirs(outRoot) {
  const d = dirs(outRoot);
  return { "01": [d.D1], "02": [d.D2], "03": [d.D3] };
}

// The tier-1 and tier-2 folders tier 3 reads.
export function inputs(tier1Out, tier2Out) {
  const t1 = resolve(tier1Out), t2 = resolve(tier2Out);
  return {
    functions: join(t1, "06_extracted_functions"),
    bundles: join(t1, "05_selected_bundles", "bundles"),
    sbom: join(t1, "05_selected_bundles", "sbom"),
    reference: join(t2, "05_deduplicated_functions"),
  };
}

// detection options from the settings (empty = the library default)
export function detectOptions(p) {
  const num = (k) => (p[k] == null || String(p[k]).trim() === "" || !Number.isFinite(Number(p[k])) ? undefined : Number(p[k]));
  const o = {
    minSim: num("MIN_SIM"), minBands: num("MIN_BANDS"), maxShared: num("MAX_SHARED"), minEvidence: num("MIN_EVIDENCE"), minFunctions: num("MIN_FUNCTIONS"),
    minCoverage: num("MIN_COVERAGE"), smallCoverage: num("SMALL_COVERAGE"), shareCoverage: num("SHARE_COVERAGE"), versionTolerance: num("VERSION_TOLERANCE"),
    versionPick: ["latest", "parsimony"].includes(String(p.VERSION_PICK)) ? String(p.VERSION_PICK) : undefined,
    versionMethod: ["intersect", "vote"].includes(String(p.VERSION_METHOD)) ? String(p.VERSION_METHOD) : undefined,
    versionFallback: ["most", "union"].includes(String(p.VERSION_FALLBACK)) ? String(p.VERSION_FALLBACK) : undefined,
  };
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

export function buildCommand(step, p) {
  const d = dirs(p.outDir);
  for (const dir of Object.values(d)) mkdirSync(dir, { recursive: true });
  const node = process.execPath, inp = inputs(p.TIER1_OUTPUT, p.TIER2_OUTPUT);
  const heap = { NODE_OPTIONS: "--max-old-space-size=8192" };
  const modes = String(p.MODES ?? DEFAULTS.MODES).split(",").map((s) => s.trim()).filter(Boolean);
  const cmd = {
    "01": [join(HERE, "01_build-index.mjs"), inp.reference, d.D1],
    "02": [join(HERE, "02_detect.mjs"), "--index", d.D1, "--functions", inp.functions, "--out", d.D2, "--bundles", inp.bundles, "--sbom", inp.sbom,
      "--modes", (modes.length ? modes : ["approx+lineage"]).join(","), "--opts", JSON.stringify(detectOptions(p)), ...(String(p.EVALUATE ?? "1") === "0" ? ["--no-evaluate"] : [])],
    "03": [join(HERE, "03_report.mjs"), d.D2, d.D3],
  };
  switch (step) {
    case "setup": return { cmd: "npm", args: ["ci", "--no-audit", "--no-fund"], cwd: dirname(HERE), env: {} };
    case "all": {
      const q = (a) => `'${String(a).replace(/'/g, `'\\''`)}'`;
      return { cmd: "bash", args: ["-c", STEP_IDS.map((id) => [node, ...cmd[id]].map(q).join(" ")).join(" && ")], cwd: HERE, env: heap };
    }
    case "01": case "02": case "03": return { cmd: node, args: cmd[step], cwd: HERE, env: heap };
    default: throw new Error(`unknown step: ${step}`);
  }
}
