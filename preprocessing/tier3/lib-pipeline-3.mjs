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
  { key: "NORMALIZE", group: "matching", label: "Normalise the bundles first (step 00)", help: "Put every bundle through the same swc call Aletheia uses for the reference (minify, compress.unsafe, ES5) before its functions are extracted, so bundle and reference code have the same shape; the helpers swc injects are dropped and the source map is kept. off = use tier 1's functions as they are. swc2 = two passes.", type: "select", options: ["off", "swc", "swc+modules", "swc2"], default: "off" },
  { key: "CANONICAL_REQUIRE", group: "matching", label: "Canonical require in the index", help: "require('./x') and require(12) read the same on both sides (step 01). Use with NORMALIZE swc+modules, which rewrites webpack's module wrappers into Aletheia's form so files with top-level code (gopd, es-errors…) can match.", type: "bool", default: "0" },
  { key: "DEPENDENCIES", group: "decision", label: "Fetch declared dependencies (step 01b)", help: "Every indexed package's dependencies and their semver ranges per version, from the npm registry (public metadata, not the SBOMs). Needed by the dependency settings below.", type: "bool", default: "0" },
  { key: "DEP_CONFIRM", group: "decision", label: "Dependency confirmation", help: "A package a found package declares as a dependency (at its found versions) is accepted with one exact match — not when the parent's own build already holds its code.", type: "bool", default: "0" },
  { key: "DEP_RANGES", group: "versions", label: "Declared ranges narrow versions", help: "off. restrict: keep only versions a found parent's declared range allows. override: also when the code points to versions outside it.", type: "select", options: ["off", "restrict", "override"], default: "off" },
  { key: "MIN_SIM", group: "matching", label: "Minimum similarity of an approximate match", help: "Estimated Jaccard similarity of the code's 3-token shingles, 0–1. 0.5 by default.", type: "number", default: "0.5" },
  { key: "MIN_BANDS", group: "matching", label: "Candidate filter (LSH bands)", help: "A reference function is compared only when it shares this many of the 21 MinHash bands. 2 is 4× faster than 1 and lost 0.03 % of the matches on the test bed.", type: "number", default: "2" },
  { key: "MAX_SHARED", group: "matching", label: "Ignore functions found in more packages than", help: "Babel/TypeScript helpers and webpack's runtime appear in hundreds of packages and prove nothing. 30 by default.", type: "number", default: "30" },
  { key: "ALGORITHM", group: "decision", label: "Package decision", help: "greedy: packages are accepted one after another and each takes the functions it matches. independent: every package is judged on its own, a function found in several packages counts for each (finds dependencies held in copies, but also the packages holding the copies).", type: "select", options: ["greedy", "independent"], default: "greedy" },
  { key: "SIZE_AWARE", group: "decision", label: "Size-aware requirement", help: "A package needs half the evidence it could ever give (and half its functions) instead of the fixed minimum, so tiny packages need little and large ones the full minimum.", type: "bool", default: "0" },
  { key: "MIN_VERSION_SHARE", group: "decision", label: "Ignore stub versions below this share of the package's median size", help: "Placeholder releases (e.g. @clerk/ui 0.0.1: four functions of webpack runtime) are 'covered' by any webpack bundle. 0 = off, 0.1 = versions under 10 % of the median version are not used for coverage.", type: "number", default: "0" },
  { key: "MIN_UNIQUE", group: "decision", label: "Functions of its own a package needs", help: "Matched functions no other package's reference holds about as well (a package declaring it as a dependency holds copies and doesn't count). 0 = off, 1 recommended.", type: "number", default: "0" },
  { key: "MIN_EXACT", group: "decision", label: "Exact matches a package needs", help: "Approximate look-alikes alone don't count, unless they cover ≥ 30 % of the package. 0 = off.", type: "number", default: "0" },
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
  "00": "00 · Normalise the bundles (swc, as the reference)",
  "01b": "01b · Declared dependencies (npm registry)",
  "01": "01 · Build the search index (from tier 2)",
  "02": "02 · Detect packages and versions in the bundles",
  "03": "03 · Report (metrics against the SBOMs)",
};
export const STEP_IDS = ["01", "02", "03"];
export const ALL_STEP_IDS = ["00", "01", "01b", "02", "03"];
const normalizeOf = (p) => (["swc", "swc+modules", "swc2"].includes(String(p?.NORMALIZE)) ? String(p.NORMALIZE) : null);
export const stepIdsFor = (p = {}) => ALL_STEP_IDS.filter((id) => (id === "00" ? !!normalizeOf(p) : id === "01b" ? String(p.DEPENDENCIES ?? "0") === "1" : true));
export const STEPS = [
  { id: "all", label: "Whole detection pipeline" },
  { id: "setup", label: "Setup: install the pipeline's dependencies" },
  ...ALL_STEP_IDS.map((id) => ({ id, label: STEP_LABELS[id] })),
];

export function dirs(outRoot) {
  const OUT = outRoot ? resolve(outRoot) : join(HERE, "output3");
  return { OUT, D0: join(OUT, "00_normalized"), D1: join(OUT, "01_index"), D2: join(OUT, "02_detections"), D3: join(OUT, "03_report"), LOGS: join(OUT, "logs") };
}
export function stepDirs(outRoot) {
  const d = dirs(outRoot);
  return { "00": [d.D0], "01": [d.D1], "01b": [], "02": [d.D2], "03": [d.D3] };
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
    algorithm: ["greedy", "independent"].includes(String(p.ALGORITHM)) ? String(p.ALGORITHM) : undefined,
    sizeAware: p.SIZE_AWARE == null || String(p.SIZE_AWARE) === "" ? undefined : String(p.SIZE_AWARE) === "1",
    minVersionShare: num("MIN_VERSION_SHARE"),
    minUnique: num("MIN_UNIQUE"), minExact: num("MIN_EXACT"),
    depConfirm: p.DEP_CONFIRM == null || String(p.DEP_CONFIRM) === "" ? undefined : String(p.DEP_CONFIRM) === "1",
    depFromConfirmed: String(p.DEP_CONFIRM ?? "") === "1" ? true : undefined,
    depRanges: ["off", "restrict", "override"].includes(String(p.DEP_RANGES)) ? String(p.DEP_RANGES) : undefined,
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
  const norm = normalizeOf(p);
  // with normalisation, step 02 reads step 00's functions and bundles (with their composed source maps)
  const fnDir = norm ? join(d.D0, "functions") : inp.functions, bundleDir = norm ? join(d.D0, "bundles") : inp.bundles;
  const cmd = {
    "00": [join(HERE, "00_normalize-bundles.mjs"), "--bundles", inp.bundles, "--out", d.D0, "--transform", norm === "swc2" ? "swc2" : "swc", ...(norm === "swc+modules" ? ["--modules"] : [])],
    "01b": [join(HERE, "01b_dependencies.mjs"), d.D1],
    "01": [join(HERE, "01_build-index.mjs"), inp.reference, d.D1, ...(String(p.CANONICAL_REQUIRE ?? "0") === "1" ? ["--canonical-require"] : [])],
    "02": [join(HERE, "02_detect.mjs"), "--index", d.D1, "--functions", fnDir, "--out", d.D2, "--bundles", bundleDir, "--sbom", inp.sbom,
      "--modes", (modes.length ? modes : ["approx+lineage"]).join(","), "--opts", JSON.stringify(detectOptions(p)), ...(String(p.EVALUATE ?? "1") === "0" ? ["--no-evaluate"] : [])],
    "03": [join(HERE, "03_report.mjs"), d.D2, d.D3],
  };
  switch (step) {
    case "setup": return { cmd: "npm", args: ["ci", "--no-audit", "--no-fund"], cwd: dirname(HERE), env: {} };
    case "all": {
      const q = (a) => `'${String(a).replace(/'/g, `'\\''`)}'`;
      return { cmd: "bash", args: ["-c", stepIdsFor(p).map((id) => [node, ...cmd[id]].map(q).join(" ")).join(" && ")], cwd: HERE, env: heap };
    }
    case "00": case "01": case "01b": case "02": case "03": return { cmd: node, args: cmd[step], cwd: HERE, env: heap };
    default: throw new Error(`unknown step: ${step}`);
  }
}
