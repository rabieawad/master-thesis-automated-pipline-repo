// Acceptance tests for tier 2's STREAMED mode (06_stream-packages.mjs + 07_merge-partials.mjs).
//
// Nothing here touches the network: step 02 is satisfied with a local tarball cache
// (--tgz-cache), whose .tgz files step 02 then skips, exactly as it skips an already
// downloaded package. Everything else runs for real — the same step scripts, as child
// processes, in both modes — so these tests compare real batch output against real
// streamed output.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, copyFileSync, readdirSync, existsSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmp, writeJson, writeText, read, exists, runNode, makeTgz, hasModule, parseCsv, TIER2 } from "./helpers.mjs";

const DEPS_OK = (await Promise.all(["@swc/core", "meriyah", "escodegen", "acorn", "acorn-loose", "acorn-walk", "astring"].map(hasModule))).every(Boolean);
const skip = DEPS_OK ? false : "bundler/collector deps not installed";

const STREAM = join(TIER2, "06_stream-packages.mjs");
const MERGE = join(TIER2, "07_merge-partials.mjs");

// ---------------------------------------------------------------- fixtures
// Three packages, two versions each. `shared` is byte-identical in pkg-a and pkg-b (a function
// shared between two packages); `stable` is identical across both versions of each package
// (a function shared across versions); `vtag` differs per version, so it must stay per-version.
const SHARED = "function shared(list){\n  var out = [];\n  for (var i = 0; i < list.length; i++) out.push(list[i] * 2);\n  return out;\n}";
const STABLE = "function stable(a, b){\n  var total = a + b;\n  if (total > 10) return total - 1;\n  return total + 1;\n}";
const vtag = (v) => `function vtag(){\n  return '${v}';\n}`;

const src = (v) => `${SHARED}\n${STABLE}\n${vtag(v)}\n`;
const PKGS = [
  ["pkg-a", ["1.0.0", "1.1.0"]],
  ["pkg-b", ["2.0.0", "2.1.0"]],
  ["pkg-c", ["0.1.0", "0.2.0"]], // the dependency both groups bundle
];

// A tarball cache + the tier-1 fixture + step 01's output (reference-packages.json), which in
// streamed mode is produced once, globally, before anything is downloaded.
function fixtures(dir) {
  const cache = join(dir, "tgz-cache");
  const rows = [];
  for (const [name, versions] of PKGS) {
    for (const v of versions) {
      makeTgz(join(cache, `${name}@${v}.tgz`), {
        "package.json": JSON.stringify({ name, version: v, main: "index.js" }),
        "index.js": src(v),
      });
      rows.push({ name, version: v, origin: name === "pkg-c" ? "dependency" : "package" });
    }
  }
  const t1 = join(dir, "tier1-out");
  writeJson(join(t1, "04_selected_sample", "selected.json"), [{ name: "pkg-a", version: "1.0.0" }, { name: "pkg-b", version: "2.0.0" }]);
  writeText(join(t1, "05_selected_bundles", "selected_dependencies.csv"),
    'package,bundled_dependencies\n' +
    'pkg-a,"[""pkg-c@0.1.0""]"\n' +
    'pkg-b,"[""pkg-c@0.1.0""]"\n');
  return { cache, t1, rows };
}

const dirsOf = (out) => ({
  OUT: out, D1: join(out, "01_reference_list"), D2: join(out, "02_downloaded_packages"),
  D3: join(out, "03_pseudo_bundles"), D4: join(out, "04_extracted_functions"),
  D5: join(out, "05_deduplicated_functions"), LOGS: join(out, "logs"),
});

// step 01's output, written straight out: the test must not query the registry
function writeRefList(out, rows) {
  const d = dirsOf(out);
  writeJson(join(d.D1, "reference-packages.json"), rows);
  return d;
}

// A real batch run, offline: the .tgz files are pre-placed in 02_downloaded_packages, so
// step 02 skips every download and steps 03/04/05 run exactly as they always do.
function runBatch(out, rows, cache, extra = {}) {
  const d = writeRefList(out, rows);
  mkdirSync(d.D2, { recursive: true });
  for (const f of readdirSync(cache)) copyFileSync(join(cache, f), join(d.D2, f));
  const env = { ...process.env, ...(extra.env ?? {}) };
  let r = runNode(join(TIER2, "02_download.mjs"), [join(d.D1, "reference-packages.json"), d.D2, "2"], { env });
  assert.equal(r.code, 0, r.stdout);
  r = runNode(join(TIER2, "03_pseudo-bundle.mjs"), [d.D2, d.D3, "2"], { env: { ...env, UNMINIFIED: String(env.MINIFY ?? "0") === "0" ? "1" : "" } });
  assert.equal(r.code, 0, r.stdout);
  r = runNode(join(TIER2, "04_extract-functions.mjs"), [join(d.D3, "bundles"), d.D4, "--min-loc", extra.minLoc ?? "0"], { env });
  assert.equal(r.code, 0, r.stdout);
  r = runNode(join(TIER2, "05_dedup-functions.mjs"), [d.D4, d.D5, ...(extra.dedupArgs ?? [])], { env });
  assert.equal(r.code, 0, r.stdout);
  return d;
}

function runStream(out, rows, cache, t1, { keep = "", env = {}, mergeArgs = [], streamArgs = [] } = {}) {
  const d = writeRefList(out, rows);
  const r = runNode(STREAM, [out, "--input", t1, "--conc", "2", "--bundle-conc", "2", "--min-loc", "0",
    "--keep", keep, "--tgz-cache", cache, ...streamArgs], { env: { ...process.env, MINIFY: "0", ...env } });
  assert.equal(r.code, 0, r.stdout);
  return { d, stream: r.stdout, merge: null };
}
function runMerge(d, { keep = "", args = [] } = {}) {
  const keepPartials = keep.split(",").map((s) => s.trim()).some((s) => s === "partials" || s === "all");
  const triv = args.includes("--trivial-nodes") ? [] : ["--trivial-nodes", "6"];
  const r = runNode(MERGE, [d.D5, ...triv, ...(keepPartials ? ["--keep-partials"] : []), ...args]);
  assert.equal(r.code, 0, r.stdout);
  return r.stdout;
}

const SAME_FILES = ["unique_functions.jsonl", "occurrences.csv", "version_index.json"];
function assertIdentical(dBatch, dStream) {
  for (const f of SAME_FILES) {
    const a = readFileSync(join(dBatch.D5, f));
    const b = readFileSync(join(dStream.D5, f));
    assert.ok(a.equals(b), `${f} differs between batch and streamed mode`);
  }
  const strip = (p) => { const s = JSON.parse(read(join(p, "summary.json"))); delete s.seconds; delete s.streamed; return s; };
  assert.deepEqual(strip(dStream.D5), strip(dBatch.D5), "summary.json differs (ignoring seconds/streamed)");
  assert.equal(JSON.parse(read(join(dStream.D5, "summary.json"))).streamed, true, 'streamed summary carries "streamed": true');
}

// ---------------------------------------------------------------- 1. equivalence
test("streamed mode produces byte-identical step-05 output to batch mode", { skip, timeout: 600_000 }, () => {
  const t = tmp("stream-eq"); try {
    const { cache, t1, rows } = fixtures(t.dir);
    const dB = runBatch(join(t.dir, "batch"), rows, cache);
    const { d: dS } = runStream(join(t.dir, "streamed"), rows, cache, t1);
    runMerge(dS);
    assertIdentical(dB, dS);

    // the fixtures really do exercise sharing, or the comparison would prove little
    const U = read(join(dS.D5, "unique_functions.jsonl")).trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(U.some((u) => Object.keys(u.packages).length > 1), "a function is shared between two packages");
    assert.ok(U.some((u) => Object.values(u.packages).some((p) => p.n_versions > 1)), "a function is shared across versions");
    assert.ok(U.some((u) => u.n_versions === 1 && /'1\.0\.0'/.test(u.text ?? "")), "a per-version function stays per-version");
  } finally { t.cleanup(); }
});

test("each streamed package gets its own JSON file with its functions, consistent with the merged file", { skip, timeout: 600_000 }, () => {
  const t = tmp("stream-pkgjson"); try {
    const { cache, t1, rows } = fixtures(t.dir);
    const { d } = runStream(join(t.dir, "streamed"), rows, cache, t1);
    runMerge(d);
    const pdir = join(d.D5, "packages");
    const pkgs = [...new Set(rows.map((r) => r.name))];
    const merged = new Map(read(join(d.D5, "unique_functions.jsonl")).trim().split("\n").map((l) => JSON.parse(l)).map((u) => [u.id, u]));
    for (const name of pkgs) {
      const f = join(pdir, `${name.replace("/", "+")}.json`);
      assert.ok(exists(f), `packages/${name}.json exists`);
      const doc = JSON.parse(read(f));
      assert.equal(doc.package, name);
      assert.deepEqual(doc.versions, rows.filter((r) => r.name === name).map((r) => r.version).sort());
      assert.ok(doc.functions.length > 0 && doc.summary.unique_functions === doc.functions.length);
      for (const fn of doc.functions) {
        const m = merged.get(fn.id);
        assert.ok(m, "every package function is in the merged file under the same id");
        assert.equal(fn.text, m.packages[name] && fn.text, "same text");
        assert.deepEqual([fn.first, fn.last, fn.ranges], [m.packages[name].first, m.packages[name].last, m.packages[name].ranges], "same version ranges as in the merged file");
        assert.equal(Object.keys(fn.occurrences).length, m.packages[name].n_versions);
      }
      for (const [v, ids] of Object.entries(doc.version_index)) assert.ok(ids.every((id) => doc.functions.some((fn) => fn.id === id && v in fn.occurrences)));
    }
    assert.equal(exists(join(d.D5, "partials")), false, "partials are gone after the merge, the package files stay");
  } finally { t.cleanup(); }
});

test("streamed mode matches batch mode with --strict-type, exact identity and a near pass", { skip, timeout: 600_000 }, () => {
  const t = tmp("stream-eq2"); try {
    const { cache, t1, rows } = fixtures(t.dir);
    const dedupArgs = ["--mode", "exact", "--strict-type", "--trivial-nodes", "4", "--near", "0.6"];
    const dB = runBatch(join(t.dir, "batch"), rows, cache, { dedupArgs });
    const { d: dS } = runStream(join(t.dir, "streamed"), rows, cache, t1, { streamArgs: ["--mode", "exact", "--strict-type"] });
    runMerge(dS, { args: ["--trivial-nodes", "4", "--near", "0.6"] });
    assertIdentical(dB, dS);
    assert.ok(exists(join(dS.D5, "near_duplicates.csv")));
    const a = readFileSync(join(dB.D5, "near_duplicates.csv")), b = readFileSync(join(dS.D5, "near_duplicates.csv"));
    assert.ok(a.equals(b), "near_duplicates.csv differs");
  } finally { t.cleanup(); }
});

test("merge rejects partials whose identity settings disagree", { skip: false }, () => {
  const t = tmp("stream-mix"); try {
    const d5 = join(t.dir, "05");
    writeJson(join(d5, "partials", "a.state.json"), { stateVersion: 1, mode: "normalized", strictType: false, files: 0, firstFile: "a@1.0.0.functions.json", total: 0, pkgVersions: [], uniq: [], occ: [], rawVariants: [], rawText: [], parents: [], versionIndex: [] });
    writeJson(join(d5, "partials", "b.state.json"), { stateVersion: 1, mode: "exact", strictType: false, files: 0, firstFile: "b@1.0.0.functions.json", total: 0, pkgVersions: [], uniq: [], occ: [], rawVariants: [], rawText: [], parents: [], versionIndex: [] });
    const r = runNode(MERGE, [d5]);
    assert.notEqual(r.code, 0);
    assert.match(r.stdout, /disagree on identity settings/);
  } finally { t.cleanup(); }
});

// ---------------------------------------------------------------- 2. shared dependency
test("a dependency in two groups is processed once and marked reused in the second group", { skip, timeout: 600_000 }, () => {
  const t = tmp("stream-reuse"); try {
    const { cache, t1, rows } = fixtures(t.dir);
    const { d, stream } = runStream(join(t.dir, "out"), rows, cache, t1);
    const manifest = (g) => JSON.parse(read(join(d.D5, "groups", `${g}.json`)));
    const statusIn = (g, pkg) => manifest(g).members.find((m) => m.package === pkg)?.status;

    assert.equal(statusIn("pkg-a", "pkg-c"), "done", "pkg-c is collected in the first group that needs it");
    assert.equal(statusIn("pkg-b", "pkg-c"), "reused", "pkg-c is reused, not redone, in the second group");
    assert.equal(statusIn("pkg-a", "pkg-a"), "done");
    assert.equal(statusIn("pkg-b", "pkg-b"), "done");
    assert.equal(manifest("pkg-b").anchor, "pkg-b");
    assert.equal(manifest("pkg-b").counts.reused, 1);
    assert.equal((stream.match(/^\s+done\s+pkg-c/gm) || []).length, 1, "pkg-c is processed exactly once");

    // one partial per PACKAGE (the unit of storage and dedup), not per group
    assert.deepEqual(readdirSync(join(d.D5, "partials")).sort(), ["pkg-a.state.json", "pkg-b.state.json", "pkg-c.state.json"]);

    // per-version records survive the deletion of the intermediates
    const v = parseCsv(read(join(d.D5, "versions", "pkg-c.csv")));
    assert.deepEqual(v.map((r) => r.version), ["0.1.0", "0.2.0"]);
    for (const row of v) {
      assert.equal(row.status, "ok");
      assert.ok(Number(row.tgz_bytes) > 0, "tgz size recorded");
      assert.match(row.tgz_integrity, /^sha512-[A-Za-z0-9+/]+=*$/, "npm-style sha512 integrity recorded");
      assert.ok(Number(row.bundle_bytes) > 0);
      assert.ok(Number(row.functions_kept) >= 3);
    }
    // the step logs are kept (step 03's holds the file-selector warnings)
    for (const s of ["02_download.log", "03_pseudobundle.log", "04_extract_functions.log"])
      assert.ok(exists(join(d.LOGS, "stream", "pkg-c", s)), `kept log ${s}`);
  } finally { t.cleanup(); }
});

// ---------------------------------------------------------------- 3. KEEP_ARTIFACTS
test('KEEP_ARTIFACTS="" leaves no intermediate files; "03" leaves only the bundles', { skip, timeout: 600_000 }, () => {
  const t = tmp("stream-keep"); try {
    const { cache, t1, rows } = fixtures(t.dir);
    const tgzs = (d) => (existsSync(d.D2) ? readdirSync(d.D2).filter((f) => f.endsWith(".tgz")) : []);
    const bundles = (d) => (existsSync(join(d.D3, "bundles")) ? readdirSync(join(d.D3, "bundles")).filter((f) => f.endsWith(".js")) : []);
    const fnJson = (d) => (existsSync(d.D4) ? readdirSync(d.D4).filter((f) => f.endsWith(".functions.json")) : []);

    const { d: dNone } = runStream(join(t.dir, "none"), rows, cache, t1, { keep: "" });
    runMerge(dNone, { keep: "" });
    assert.deepEqual(tgzs(dNone), [], "no .tgz kept");
    assert.deepEqual(bundles(dNone), [], "no pseudo-bundle kept");
    assert.deepEqual(fnJson(dNone), [], "no per-version functions.json kept");
    assert.equal(exists(join(dNone.OUT, "_work")), false, "work dir removed");
    assert.equal(exists(join(dNone.D5, "partials")), false, "partials deleted by the merge");
    assert.ok(exists(join(dNone.D5, "unique_functions.jsonl")), "the final collection is what survives");

    const { d: d03 } = runStream(join(t.dir, "b03"), rows, cache, t1, { keep: "03" });
    runMerge(d03, { keep: "03" });
    assert.deepEqual(tgzs(d03), []);
    assert.deepEqual(fnJson(d03), []);
    assert.deepEqual(bundles(d03).sort(), ["pkg-a@1.0.0.js", "pkg-a@1.1.0.js", "pkg-b@2.0.0.js", "pkg-b@2.1.0.js", "pkg-c@0.1.0.js", "pkg-c@0.2.0.js"]);

    const { d: dAll } = runStream(join(t.dir, "all"), rows, cache, t1, { keep: "all" });
    runMerge(dAll, { keep: "all" });
    assert.equal(tgzs(dAll).length, 6, "all .tgz kept");
    assert.equal(bundles(dAll).length, 6);
    assert.equal(fnJson(dAll).length, 6);
    assert.equal(readdirSync(join(dAll.D5, "partials")).length, 3, "partials kept, so they can be re-finalized");

    // kept partials can be re-finalized with a different TRIVIAL_NODES, with no re-download
    const before = JSON.parse(read(join(dAll.D5, "summary.json")));
    runMerge(dAll, { keep: "all", args: ["--trivial-nodes", "999"] });
    const after = JSON.parse(read(join(dAll.D5, "summary.json")));
    assert.equal(before.unique_functions, after.unique_functions, "identity is unchanged by re-finalizing");
    assert.equal(after.unique_non_trivial, 0, "TRIVIAL_NODES applies in the merge, not in the partials");
  } finally { t.cleanup(); }
});

// ---------------------------------------------------------------- 4. resume
test("resume: killed mid-run, the rerun skips finished packages and the output is unchanged", { skip, timeout: 900_000 }, async () => {
  const t = tmp("stream-resume"); try {
    const { cache, t1, rows } = fixtures(t.dir);

    // reference run, uninterrupted
    const { d: dRef } = runStream(join(t.dir, "ref"), rows, cache, t1, { keep: "" });
    runMerge(dRef, { keep: "" });

    // interrupted run: kill as soon as the first package's partial appears
    const out = join(t.dir, "killed");
    const d = writeRefList(out, rows);
    const partials = join(d.D5, "partials");
    const child = spawn(process.execPath, [STREAM, out, "--input", t1, "--conc", "2", "--bundle-conc", "2", "--keep", "", "--tgz-cache", cache],
      { env: { ...process.env, MINIFY: "0" }, stdio: "ignore" });
    const seen = await new Promise((resolve) => {
      let exited = false;
      child.on("exit", () => (exited = true));
      const iv = setInterval(() => {
        const n = existsSync(partials) ? readdirSync(partials).filter((f) => f.endsWith(".state.json")).length : 0;
        if (n >= 1 || exited) { clearInterval(iv); child.kill("SIGKILL"); resolve(n); }
      }, 25);
    });
    await new Promise((r) => child.on("close", r).on("exit", r));
    assert.ok(seen >= 1, "at least one package was finished before the kill");
    const afterKill = readdirSync(partials).filter((f) => f.endsWith(".state.json"));

    // a leftover work dir from the kill must be discarded, not trusted
    mkdirSync(join(out, "_work", "pkg-b", "04"), { recursive: true });
    writeFileSync(join(out, "_work", "pkg-b", "04", "pkg-b@2.0.0.functions.json"), '{"functions":[{"text":"{ junk }"}]}');

    const rerun = runNode(STREAM, [out, "--input", t1, "--conc", "2", "--bundle-conc", "2", "--keep", "", "--tgz-cache", cache],
      { env: { ...process.env, MINIFY: "0" } });
    assert.equal(rerun.code, 0, rerun.stdout);
    assert.match(rerun.stdout, /resume: discarding \d+ leftover work dir/);
    assert.equal(exists(join(out, "_work")), false, "work dirs are gone when the run finishes");
    assert.match(rerun.stdout, new RegExp(`resume: ${afterKill.length} package\\(s\\) already have a partial`));
    for (const p of afterKill) {
      const pkg = p.slice(0, -".state.json".length);
      assert.match(rerun.stdout, new RegExp(`reuse\\s+${pkg}`), `${pkg} is skipped, not redone`);
    }
    runMerge({ D5: d.D5 }, { keep: "" });

    for (const f of SAME_FILES) {
      assert.ok(readFileSync(join(d.D5, f)).equals(readFileSync(join(dRef.D5, f))), `${f} differs from the uninterrupted run`);
    }
    const strip = (p) => { const s = JSON.parse(read(join(p, "summary.json"))); delete s.seconds; return s; };
    assert.deepEqual(strip(d.D5), strip(dRef.D5));

    // once the outputs are there and no partials remain, both streamed steps say so and stop
    const again = runNode(STREAM, [out, "--input", t1, "--tgz-cache", cache], { env: { ...process.env, MINIFY: "0" } });
    assert.equal(again.code, 0, again.stdout);
    assert.match(again.stdout, /already complete/);
    const againMerge = runNode(MERGE, [d.D5]);
    assert.equal(againMerge.code, 0, againMerge.stdout);
    assert.match(againMerge.stdout, /already complete/);
  } finally { t.cleanup(); }
});

// ---------------------------------------------------------------- 5. MINIFY=0
test("MINIFY=0 really produces un-minified bundles in streamed mode (step 03 reads UNMINIFIED)", { skip, timeout: 600_000 }, () => {
  const t = tmp("stream-minify"); try {
    const { cache, t1, rows } = fixtures(t.dir);
    const bundleOf = (d) => read(join(d.D3, "bundles", "pkg-a@1.0.0.js"));

    const { d: dUn } = runStream(join(t.dir, "unmin"), rows, cache, t1, { keep: "03", env: { MINIFY: "0" } });
    const un = bundleOf(dUn);
    assert.match(un, /function shared\(list\)/, "original names and formatting survive");
    assert.ok(un.split("\n").length > 5, "the un-minified bundle keeps its line structure");

    const { d: dMin } = runStream(join(t.dir, "min"), rows, cache, t1, { keep: "03", env: { MINIFY: "1" } });
    const min = bundleOf(dMin);
    assert.ok(min.length < un.length, `MINIFY=1 is smaller (${min.length} < ${un.length})`);
    assert.doesNotMatch(min, /function shared\(list\)/, "MINIFY=1 mangles/compresses the source");

    // LOC measured on the un-minified bundle is the real pre-minification line count
    const { d: dLoc } = runStream(join(t.dir, "loc"), rows, cache, t1, { keep: "04", env: { MINIFY: "0" } });
    const fns = JSON.parse(read(join(dLoc.D4, "pkg-a@1.0.0.functions.json"))).functions;
    assert.ok(fns.some((f) => (f.loc ?? 0) >= 4), "a multi-line function reports a multi-line LOC");
  } finally { t.cleanup(); }
});

// ---------------------------------------------------------------- driver plumbing
test("stream driver: groups come from the CSV in order, honouring INCLUDE_PACKAGE", { skip, timeout: 600_000 }, () => {
  const t = tmp("stream-groups"); try {
    const { cache, t1, rows } = fixtures(t.dir);
    const { d, stream } = runStream(join(t.dir, "out"), rows, cache, t1, { streamArgs: ["--no-package"] });
    // --no-package: the anchors are not members; only the bundled dependency is
    const a = JSON.parse(read(join(d.D5, "groups", "pkg-a.json")));
    assert.deepEqual(a.members.map((m) => m.package), ["pkg-c"]);
    // pkg-a and pkg-b are in the reference list but in no group -> the safety-net group
    const un = JSON.parse(read(join(d.D5, "groups", "_ungrouped.json")));
    assert.deepEqual(un.members.map((m) => m.package).sort(), ["pkg-a", "pkg-b"]);
    assert.ok(stream.indexOf("group 1/3: pkg-a") < stream.indexOf("group 2/3: pkg-b"), "groups run in CSV order");
  } finally { t.cleanup(); }
});

test("stream driver: a package whose download fails is reported failed and keeps no partial", { skip, timeout: 600_000 }, () => {
  const t = tmp("stream-fail"); try {
    const { cache, t1, rows } = fixtures(t.dir);
    // pkg-c has no tarball in the cache and the registry is never reached in these tests,
    // so its download cannot succeed
    for (const f of readdirSync(cache)) if (f.startsWith("pkg-c@")) rmSync(join(cache, f));
    const out = join(t.dir, "out");
    const d = writeRefList(out, rows);
    const r = runNode(STREAM, [out, "--input", t1, "--conc", "2", "--bundle-conc", "2", "--keep", "", "--tgz-cache", cache],
      { env: { ...process.env, MINIFY: "0", npm_config_registry: "http://127.0.0.1:9/" } });
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /FAIL\s+pkg-c/);
    assert.equal(exists(join(d.D5, "partials", "pkg-c.state.json")), false, "a failed package leaves no partial, so a rerun retries it");
    assert.ok(exists(join(d.D5, "partials", "pkg-a.state.json")), "the other packages still finish");
    const g = JSON.parse(read(join(d.D5, "groups", "pkg-a.json")));
    assert.equal(g.members.find((m) => m.package === "pkg-c").status, "failed");
    assert.equal(exists(join(out, "_work", "pkg-c")), false, "the failed package's work dir is cleaned up");
  } finally { t.cleanup(); }
});

// ---------------------------------------------------------------- string comparison, end to end
test("streamed mode with the string comparison matches batch mode, and agrees with hash mode", { skip, timeout: 600_000 }, () => {
  const t = tmp("stream-ident"); try {
    const { cache, t1, rows } = fixtures(t.dir);
    // batch, comparing the function texts string to string (the default)
    const dB = runBatch(join(t.dir, "batch"), rows, cache, { dedupArgs: ["--identity", "string"] });
    const { d: dS } = runStream(join(t.dir, "streamed"), rows, cache, t1, { streamArgs: ["--identity", "string"] });
    runMerge(dS);
    assertIdentical(dB, dS);
    assert.equal(JSON.parse(read(join(dS.D5, "summary.json"))).identity, "string");

    // and the older truncated-hash comparison gives the same answer on this corpus
    const dH = runBatch(join(t.dir, "batch-hash"), rows, cache, { dedupArgs: ["--identity", "hash"] });
    for (const f of SAME_FILES)
      assert.ok(readFileSync(join(dH.D5, f)).equals(readFileSync(join(dB.D5, f))), `${f}: hash and string comparison agree`);
  } finally { t.cleanup(); }
});
