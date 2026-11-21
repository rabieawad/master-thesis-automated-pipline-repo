// Tier 3 on real examples: tier 2's reference for copy-to-clipboard, toggle-selection,
// throttle-debounce and eventemitter3, and tier 1's real webpack bundles of them (functions,
// bundle + source map, SBOM) — see test/fixtures/tier3/README.md. A made-up "fake-carrier"
// package holds a copy of all four (like a prebuilt mega-bundle) and must never be detected.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, utimesSync, rmSync, statSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join, dirname, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT, tmp, runNode, parseCsv } from "./helpers.mjs";
import { attributeFunctions } from "../tier3/lib/sourcemap.mjs";
import * as T3 from "../tier3/lib-pipeline-3.mjs";
import { packOutputs, unpackOutputs } from "../lib-pack.mjs";
// lib-project reads PROJECTS_DIR when it is loaded: point it at a temporary folder first, so
// building a command (which creates the project's output folders) never touches projects/
const PROJECTS = tmp("t3projects");
process.env.PROJECTS_DIR = PROJECTS.dir;
const { TIERS, TIER_KEYS, buildTierCommand, stepDirsForTier, tierOutput, TIER3_INPUT_ARCHIVES } = await import("../lib-project.mjs");

const FIX = join(ROOT, "test", "fixtures", "tier3");
const S1 = join(ROOT, "tier3", "01_build-index.mjs"), S2 = join(ROOT, "tier3", "02_detect.mjs"), S3 = join(ROOT, "tier3", "03_report.mjs");
const BUNDLES = ["copy-to-clipboard@3.3.3", "copy-to-clipboard@4.0.2", "eventemitter3@5.0.4", "throttle-debounce@3.0.1", "throttle-debounce@5.0.2"];
let T, T1, T2, OUT;

// unpack the gzipped fixtures into tier1/ and tier2/ output folders, and add the carrier
before(() => {
  T = tmp("t3real"); T1 = join(T.dir, "tier1"); T2 = join(T.dir, "tier2"); OUT = join(T.dir, "tier3");
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  for (const f of walk(FIX).filter((x) => x.endsWith(".gz"))) {
    const to = join(T.dir, relative(FIX, f)).slice(0, -3);
    mkdirSync(dirname(to), { recursive: true }); writeFileSync(to, gunzipSync(readFileSync(f)));
  }
  const P = join(T2, "05_deduplicated_functions", "packages"), fns = [];
  let settings;
  for (const f of readdirSync(P)) { const d = JSON.parse(readFileSync(join(P, f), "utf8")); settings = d.settings; for (const x of d.functions) fns.push({ ...x, occurrences: { "1.0.0": [0] }, lineage: null }); }
  writeFileSync(join(P, "fake-carrier.json"), JSON.stringify({ package: "fake-carrier", versions: ["1.0.0"], settings, functions: fns }));
});
after(() => { T.cleanup(); PROJECTS.cleanup(); });

const detectArgs = (out, extra = []) => ["--index", join(OUT, "01_index"), "--functions", join(T1, "06_extracted_functions"), "--out", out,
  "--bundles", join(T1, "05_selected_bundles", "bundles"), "--sbom", join(T1, "05_selected_bundles", "sbom"), ...extra];
const result = (out, key) => JSON.parse(readFileSync(join(out, "bundles", `${key}.json`), "utf8"));

test("step 01 builds the index from tier 2's files, keeps it while they are unchanged, rebuilds when they change", () => {
  const r = runNode(S1, [join(T2, "05_deduplicated_functions"), join(OUT, "01_index")]);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /RESULT \| index built \| \d+ non-trivial functions \| 5 packages \(3 with lineages\)/);
  const meta = JSON.parse(readFileSync(join(OUT, "01_index", "meta.json"), "utf8"));
  assert.deepEqual(meta.packages.map((p) => p.name).sort(), ["copy-to-clipboard", "eventemitter3", "fake-carrier", "throttle-debounce", "toggle-selection"]);
  const tog = meta.packages.find((p) => p.name === "toggle-selection");
  assert.equal(tog.versions.length, 9); assert.ok(tog.hasLineages);
  assert.ok(tog.nonTrivial.every((n) => n >= 1));
  assert.ok(existsSync(join(OUT, "01_index", "sigs.bin")) && existsSync(join(OUT, "01_index", "lineages", "toggle-selection.json")));
  assert.match(runNode(S1, [join(T2, "05_deduplicated_functions"), join(OUT, "01_index")]).stdout, /index is up to date/);
  // a tier-2 file changed → rebuilt
  const f = join(T2, "05_deduplicated_functions", "packages", "toggle-selection.json"), t = new Date(Date.now() + 5000);
  utimesSync(f, t, t);
  assert.match(runNode(S1, [join(T2, "05_deduplicated_functions"), join(OUT, "01_index")]).stdout, /changed since the index was built: rebuilding[\s\S]*RESULT \| index built/);
  assert.match(runNode(S1, [join(T2, "05_deduplicated_functions"), join(OUT, "01_index"), "--force"]).stdout, /RESULT \| index built/);
  assert.notEqual(runNode(S1, [join(T.dir, "nowhere"), join(T.dir, "x")]).code, 0, "no tier-2 output");
});

test("step 02 finds the bundled packages and their versions in real bundles, and never the carrier", () => {
  const out = join(OUT, "02_detections");
  const r = runNode(S2, detectArgs(out));
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /RESULT \| 5 bundles detected, 0 already done, 0 failed/);
  for (const key of BUNDLES) for (const [m, e] of Object.entries(result(out, key).modes)) assert.ok(!e.detections.some((d) => d.name === "fake-carrier"), `${key} ${m}`);

  // copy-to-clipboard@3.3.3 bundles toggle-selection@1.0.6
  const c3 = result(out, "copy-to-clipboard@3.3.3");
  assert.deepEqual(c3.truth.map((t) => `${t.name}@${t.version}`).sort(), ["copy-to-clipboard@3.3.3", "toggle-selection@1.0.6"]);
  const d3 = c3.modes["approx+lineage"].detections;
  assert.deepEqual(d3.map((d) => d.name).sort(), ["copy-to-clipboard", "toggle-selection"]);
  for (const m of ["approx", "approx+lineage"]) for (const row of c3.modes[m].evaluation.rows) { assert.equal(row.status, "TP"); assert.ok(row.inRange, `${m} ${row.name}: ${row.range}`); }
  for (const m of Object.keys(c3.modes)) for (const d of c3.modes[m].detections) assert.ok(d.best && d.rangeSize > 0, `${m} ${d.name} has a version`);
  assert.equal(d3.find((d) => d.name === "copy-to-clipboard").best, "3.3.3");
  assert.deepEqual(c3.sourceMap.nonTrivialFunctionsByPackage["toggle-selection"] > 0, true);
  // every explained function is a function of the bundle
  const fileFns = JSON.parse(readFileSync(join(T1, "06_extracted_functions", "copy-to-clipboard@3.3.3.functions.json"), "utf8")).functions.map((f) => f.index);
  for (const d of d3) for (const k of [...d.explains, ...d.shares]) assert.ok(fileFns.includes(k));

  // throttle-debounce: the exact version of both bundles; eventemitter3: inside the range
  for (const key of ["throttle-debounce@3.0.1", "throttle-debounce@5.0.2", "eventemitter3@5.0.4"]) {
    const res = result(out, key), [name, version] = key.split("@");
    const [row] = res.modes["approx+lineage"].evaluation.rows;
    assert.equal(row.status, "TP", key); assert.equal(row.name, name); assert.ok(row.inRange, `${key}: ${row.range}`);
    if (name === "throttle-debounce") assert.equal(row.best, version, key);
  }
  // exact matches alone are weaker than approximate ones (webpack's Terser vs tier 2's swc)
  const tp = (m) => BUNDLES.reduce((a, k) => a + result(out, k).modes[m].evaluation.rows.filter((x) => x.status === "TP").length, 0);
  assert.ok(tp("approx") >= tp("exact") && tp("approx") >= 5, `approx ${tp("approx")} exact ${tp("exact")}`);

  // copy-to-clipboard@4.0.2 inlines toggle-selection's code: whatever is detected, the
  // function-level analysis has to explain each error correctly
  const c4 = result(out, "copy-to-clipboard@4.0.2").modes["approx+lineage"].evaluation.rows;
  for (const row of c4) {
    if (row.status === "FN") assert.equal(row.name === "copy-to-clipboard" ? /^(explained by toggle-selection|too little evidence|reference lacks the code)$/.test(row.reason) : true, true, row.reason);
    if (row.status === "FP") { assert.equal(row.name, "toggle-selection"); assert.equal(row.codeFrom, "copy-to-clipboard"); assert.match(row.codeFile, /^copy-to-clipboard\/dist\//); }
  }
});

test("source-map attribution of a real bundle: its own functions and toggle-selection's", () => {
  const dir = join(T1, "05_selected_bundles", "bundles"), key = "copy-to-clipboard@3.3.3";
  const doc = JSON.parse(readFileSync(join(T1, "06_extracted_functions", `${key}.functions.json`), "utf8"));
  const at = attributeFunctions(readFileSync(join(dir, `${key}.min.js`), "utf8"), JSON.parse(readFileSync(join(dir, `${key}.min.js.map`), "utf8")), doc.functions);
  const count = {}; for (const v of at.values()) { const k = v ? `${v.name}@${v.version}` : "(webpack runtime)"; count[k] = (count[k] ?? 0) + 1; }
  assert.deepEqual(count, { "copy-to-clipboard@3.3.3": 4, "toggle-selection@1.0.6": 4, "(webpack runtime)": 10 });
});

test("step 02 is resumable, and redoes the bundles when the settings change; --no-evaluate gives detections only", () => {
  const out = join(OUT, "02_detections");
  assert.match(runNode(S2, detectArgs(out)).stdout, /RESULT \| 0 bundles detected, 5 already done/);
  assert.match(runNode(S2, detectArgs(out, ["--opts", '{"minSim":0.6}'])).stdout, /RESULT \| 5 bundles detected, 0 already done/);
  assert.match(runNode(S2, detectArgs(out)).stdout, /RESULT \| 5 bundles detected/);
  const only = join(T.dir, "only");
  const r = runNode(S2, detectArgs(only, ["--no-evaluate", "--modes", "approx", "--only", "throttle-debounce@5.0.2"]));
  assert.match(r.stdout, /RESULT \| 1 bundles detected/);
  const res = result(only, "throttle-debounce@5.0.2");
  assert.deepEqual(Object.keys(res.modes), ["approx"]); assert.equal(res.truth, undefined); assert.equal(res.modes.approx.evaluation, undefined);
  assert.equal(res.modes.approx.detections[0].name, "throttle-debounce");
  // bad input is refused with a message
  assert.equal(runNode(S2, detectArgs(only, ["--modes", "fuzzy"])).code, 2);
  assert.equal(runNode(S2, detectArgs(only, ["--opts", '{"nope":1}'])).code, 2);
});

test("step 03 writes the report, the summary and both CSVs", () => {
  const r = runNode(S3, [join(OUT, "02_detections"), join(OUT, "03_report")]);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /RESULT \| approx\+lineage \| P \d\.\d{3} R \d\.\d{3} F1/);
  const md = readFileSync(join(OUT, "03_report", "report.md"), "utf8");
  for (const h of ["# Tier 3 · Detection report", "## Packages", "## Versions", "## Functions", "## Why it went wrong", "## Per bundle (approx+lineage)"]) assert.ok(md.includes(h), h);
  assert.match(md, /\| approx\+lineage \| \d+ \| \d+ \| \d+ \|/);
  const s = JSON.parse(readFileSync(join(OUT, "03_report", "summary.json"), "utf8"));
  assert.equal(s.bundles, 5); assert.equal(s.bundlesWithTruth, 5); assert.equal(s.bundlesWithSourceMap, 5);
  assert.ok(s.modes["approx+lineage"].packages.TP >= 5);
  assert.ok(s.modes["approx+lineage"].functions.accuracy > 0.5);
  const ev = parseCsv(readFileSync(join(OUT, "03_report", "evaluation.csv"), "utf8"));
  assert.ok(ev.some((x) => x.bundle === "copy-to-clipboard@3.3.3" && x.package === "toggle-selection" && x.status === "TP" && x.inRange === "1"));
  const det = parseCsv(readFileSync(join(OUT, "03_report", "detections.csv"), "utf8"));
  assert.ok(det.some((x) => x.bundle === "throttle-debounce@5.0.2" && x.mode === "approx+lineage" && x.best === "5.0.2"));
});

test("pipeline wiring: tier 3 is a project tier reading tier 1's and tier 2's outputs; the whole tier runs end to end", () => {
  assert.deepEqual(TIER_KEYS, ["tier1", "tier2", "tier3"]);
  assert.deepEqual(TIERS.tier3.stepIdsFor({}), ["01", "02", "03"]);
  const proj = { slug: "p", tier1: { params: {}, externalOutput: T1 }, tier2: { params: {} }, tier3: { params: { MIN_SIM: "0.6", VERSION_PICK: "parsimony", MODES: "approx", EVALUATE: "0" } } };
  const c2 = buildTierCommand(proj, "tier3", "02");
  const arg = (n) => c2.args[c2.args.indexOf(n) + 1];
  assert.equal(arg("--functions"), join(T1, "06_extracted_functions"));
  assert.equal(arg("--sbom"), join(T1, "05_selected_bundles", "sbom"));
  assert.equal(arg("--modes"), "approx");
  assert.deepEqual(JSON.parse(arg("--opts")), { minSim: 0.6, minBands: 2, maxShared: 30, minEvidence: 1.5, minFunctions: 2, minCoverage: 0.05, smallCoverage: 0.5, shareCoverage: 0.5, versionTolerance: 0.03, versionPick: "parsimony", versionMethod: "intersect", versionFallback: "most", algorithm: "greedy", sizeAware: false, minVersionShare: 0, minUnique: 0, minExact: 0, depConfirm: false, depRanges: "off" });
  assert.ok(c2.args.includes("--no-evaluate"));
  const c1 = buildTierCommand(proj, "tier3", "01");
  assert.equal(c1.args[1], join(tierOutput(proj, "tier2"), "05_deduplicated_functions"));
  assert.deepEqual(Object.keys(stepDirsForTier(proj, "tier3")), ["00", "01", "01b", "02", "03"]);
  assert.deepEqual(T3.detectOptions({ MIN_SIM: "", MAX_SHARED: "abc", VERSION_PICK: "oldest" }), {});

  // the "all" command, on the fixture folders
  const out = join(T.dir, "all");
  const all = T3.buildCommand("all", { ...T3.DEFAULTS, outDir: out, TIER1_OUTPUT: T1, TIER2_OUTPUT: T2 });
  const stdout = execFileSync(all.cmd, all.args, { encoding: "utf8", env: { ...process.env, ...all.env } });
  assert.match(stdout, /RESULT \| index built[\s\S]*RESULT \| 5 bundles detected[\s\S]*RESULT \| approx\+lineage/);
  assert.ok(existsSync(join(out, "03_report", "report.md")));

  // packing: tier 3's per-bundle files go into 02_detections/bundles.tgz and come back
  const packed = packOutputs("tier3", out);
  assert.equal(packed.length, 1); assert.ok(!existsSync(join(out, "02_detections", "bundles")));
  assert.ok(existsSync(join(out, "03_report", "report.md")), "the report stays a plain file");
  unpackOutputs("tier3", out);
  assert.equal(readdirSync(join(out, "02_detections", "bundles")).length, 5);
  assert.deepEqual(TIER3_INPUT_ARCHIVES.tier1, ["06_extracted_functions/functions.tgz", "05_selected_bundles/bundles.tgz", "05_selected_bundles/sbom.tgz"]);
});

test("packing: only the archives asked for are packed and unpacked (tier 3 borrows tier 1's)", () => {
  const t = tmp("t3pack");
  try {
    const o = t.dir;
    mkdirSync(join(o, "06_extracted_functions"), { recursive: true }); writeFileSync(join(o, "06_extracted_functions", "a.functions.json"), "{}");
    mkdirSync(join(o, "05_selected_bundles", "sbom"), { recursive: true }); writeFileSync(join(o, "05_selected_bundles", "sbom", "a.cdx.json"), "{}");
    mkdirSync(join(o, "02_downloaded_packages"), { recursive: true }); writeFileSync(join(o, "02_downloaded_packages", "x.tgz"), "not really");
    const only = ["06_extracted_functions/functions.tgz"];
    assert.equal(packOutputs("tier1", o, () => {}, only).length, 1);
    assert.ok(existsSync(join(o, "06_extracted_functions", "functions.tgz")));
    assert.ok(existsSync(join(o, "05_selected_bundles", "sbom", "a.cdx.json")), "not asked for: left alone");
    assert.ok(!existsSync(join(o, "02_downloaded_packages", "packages.tgz")));
    assert.deepEqual(unpackOutputs("tier1", o, () => {}, ["05_selected_bundles/sbom.tgz"]), [], "nothing packed there");
    assert.equal(unpackOutputs("tier1", o, () => {}, only).length, 1);
    assert.ok(existsSync(join(o, "06_extracted_functions", "a.functions.json")));
  } finally { t.cleanup(); }
});

test("the parameter sweep tool prints one line per variant and mode", () => {
  const r = runNode(join(ROOT, "tier3", "tools", "sweep.mjs"), ["--index", join(OUT, "01_index"), "--functions", join(T1, "06_extracted_functions"),
    "--bundles", join(T1, "05_selected_bundles", "bundles"), "--sbom", join(T1, "05_selected_bundles", "sbom"), "--modes", "approx", "--variants", '[{},{"minSim":0.7}]']);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /5 bundles matched/);
  assert.equal((r.stdout.match(/^\{.*approx\s+\d\.\d{3}/gm) ?? []).length, 2);
});
