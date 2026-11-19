import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync, readdirSync, copyFileSync } from "node:fs";
import { tmp, writeJson, writeText, runNode, hasModule, TIER1 } from "./helpers.mjs";

const skip = !(await hasModule("webpack")) && "webpack not installed";
const STREAM = join(TIER1, "08-stream-packages.mjs");
const BUNDLER = join(TIER1, "03-bundle-and-sbom.mjs");

// A tier-1 download as step 02 leaves it: <folder>.tgz of holder package.json + node_modules,
// and a <folder>.meta.json sidecar. Placed in the packages folder, the driver uses it instead of
// downloading (so this test needs no network).
function download(D2, name, version, files, extraDeps = {}) {
  const t = tmp("dl"); try {
    writeJson(join(t.dir, "package.json"), { name: "holder", version: "1.0.0", private: true, dependencies: { [name]: version } });
    for (const [rel, content] of Object.entries(files)) writeText(join(t.dir, "node_modules", name, rel), content);
    for (const [dep, depFiles] of Object.entries(extraDeps)) for (const [rel, content] of Object.entries(depFiles)) writeText(join(t.dir, "node_modules", dep, rel), content);
    mkdirSync(D2, { recursive: true });
    const folder = name.replace(/^@/, "").replace("/", "__");
    execFileSync("tar", ["-czf", join(D2, `${folder}.tgz`), "-C", t.dir, "."]);
    writeJson(join(D2, `${folder}.meta.json`), { name, version });
  } finally { t.cleanup(); }
}
function fixtures(dir) {
  const D2 = join(dir, "packages");
  download(D2, "good-lib", "1.0.0", { "package.json": JSON.stringify({ name: "good-lib", version: "1.0.0", main: "index.js" }), "index.js": "module.exports = function add(a, b) { return a + b; };\n" });
  download(D2, "font-only", "2.0.0", { "package.json": JSON.stringify({ name: "font-only", version: "2.0.0", main: "index.css" }), "index.css": "@font-face { font-family: X; src: url(x.woff2); }\n" });
  download(D2, "no-entry", "3.0.0", { "package.json": JSON.stringify({ name: "no-entry", version: "3.0.0" }), "README.md": "icons only\n" });
  download(D2, "broken-pkg", "1.0.0", { "package.json": JSON.stringify({ name: "broken-pkg", version: "1.0.0", main: "index.js", dependencies: { "left-out": "^2.0.0" } }), "index.js": 'const pad = require("left-out");\nmodule.exports = (n) => pad("hi " + n, 9);\n' });
  const list = join(dir, "list.json");
  writeJson(list, ["good-lib", "font-only", "no-entry", "broken-pkg"].map((name, i) => ({ rank: i + 1, name })));
  return { D2, D3: join(dir, "bundles"), list };
}
function fakeClaude(dir) {
  const f = join(dir, "claude");
  writeFileSync(f, `#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then echo fake; exit 0; fi
mkdir -p pkg/node_modules/left-out
echo '{"name":"left-out","version":"2.0.0","main":"index.js"}' > pkg/node_modules/left-out/package.json
echo 'module.exports = (s, n) => String(s).padStart(n);' > pkg/node_modules/left-out/index.js
cat > REPAIR.json <<'J'
{"outcome":"repaired","category":"missing_dependency","cause":"left-out was never installed.","evidence":"Can't resolve 'left-out'",
 "changes":[{"file":"pkg/node_modules/left-out/index.js","action":"added","reason":"missing"}],"still_represents_package":"own files unchanged","explanation":"Added the missing dependency."}
J
echo '{"type":"result","num_turns":2,"total_cost_usd":0}'
`);
  chmodSync(f, 0o755);
  return f;
}
const lines = (r) => r.stdout.split("\n").filter((l) => /RESULT \|/.test(l)).map((l) => l.replace(/^\[\d+\/\d+\] /, ""));

test("streams each package: bundles what can be bundled, skips what cannot, repairs with Claude, deletes the downloads", { skip, timeout: 300_000 }, () => {
  const t = tmp(); try {
    const { D2, D3, list } = fixtures(t.dir);
    const r = runNode(STREAM, [list, D2, D3, "--conc", "2", "--claude", "--claude-bin", fakeClaude(t.dir)]);
    assert.equal(r.code, 0, r.stdout);
    const res = lines(r).sort();
    assert.match(res.find((l) => l.includes("good-lib")), /RESULT \| good-lib@1\.0\.0 \| bundled \| - \| 0 dependencies bundled/);
    assert.match(res.find((l) => l.includes("font-only")), /RESULT \| font-only@2\.0\.0 \| skipped_not_bundleable \| stylesheet_only \| its entry is a \.css file/);
    assert.match(res.find((l) => l.includes("no-entry")), /RESULT \| no-entry@3\.0\.0 \| skipped_not_bundleable \| no_js_entry \| webpack cannot resolve 'no-entry'/);
    // the failed package is postponed, and Claude repairs it only after every package was streamed
    const all = lines(r), broken = all.map((l, i) => [l, i]).filter(([l]) => l.includes("broken-pkg"));
    assert.equal(broken.length, 2, all.join("\n"));
    assert.match(broken[0][0], /RESULT \| broken-pkg@1\.0\.0 \| bundle_failed \| missing_dependency \| postponed for Claude repair/);
    assert.match(broken[1][0], /RESULT \| broken-pkg@1\.0\.0 \| repaired_by_claude \| missing_dependency \| 1 dependencies bundled/);
    assert.equal(broken[1][1], all.length - 1, "Claude's result comes last, after all other packages");
    assert.ok(r.stdout.indexOf("Claude repair of 1 postponed package(s)") > r.stdout.lastIndexOf("good-lib@1.0.0 | bundled"));

    // only results are kept: bundles + maps + SBOMs + modules, records, logs; downloads are gone
    assert.deepEqual(readdirSync(D2).sort(), ["download-results.json"], "nothing but the download summary is left");
    assert.deepEqual(readdirSync(join(D3, "bundles")).sort(), ["broken-pkg@1.0.0.min.js", "broken-pkg@1.0.0.min.js.map", "good-lib@1.0.0.min.js", "good-lib@1.0.0.min.js.map"]);
    assert.deepEqual(readdirSync(join(D3, "sbom")).sort(), ["broken-pkg@1.0.0.cdx.json", "good-lib@1.0.0.cdx.json"]);
    assert.ok(existsSync(join(D3, "claude_repair", "broken-pkg", "repair.json")), "Claude's standardized report is kept");
    assert.match(readFileSync(join(D3, "claude_repair", "report.csv"), "utf8"), /broken-pkg,broken-pkg,1\.0\.0,repaired,missing_dependency,/);
    assert.ok(existsSync(join(D3, "stream", "logs", "broken-pkg", "07_claude_repair.log")));

    // summary.json in step 03's format, so selection and collect work unchanged
    const summary = JSON.parse(readFileSync(join(D3, "summary.json"), "utf8"));
    assert.deepEqual(summary.map((s) => [s.name, s.ok]), [["broken-pkg", true], ["font-only", false], ["good-lib", true], ["no-entry", false]]);
    assert.equal(summary.find((s) => s.name === "good-lib").outFile, join(D3, "bundles", "good-lib@1.0.0.min.js"));
    assert.equal(summary.find((s) => s.name === "broken-pkg").bundledBy, "claude-repair");
    assert.equal(summary.find((s) => s.name === "font-only").skippedBy, "check");
    assert.match(readFileSync(join(D3, "summary.csv"), "utf8"), /^package,version,ok,dependencies_bundled,bundle_bytes,source_map_bytes,error\n/);
    const rows = readFileSync(join(D3, "stream", "results.csv"), "utf8").trim().split("\n");
    assert.equal(rows[0], "rank,package,version,outcome,category,cause,dependencies_bundled,bundle_bytes,checked_entry");
    assert.equal(rows.length, 5);
  } finally { t.cleanup(); }
});

test("a streamed bundle is byte-identical to the batch bundler's bundle of the same download", { skip, timeout: 300_000 }, () => {
  const t = tmp(); try {
    const { D2, D3, list } = fixtures(t.dir);
    const B2 = join(t.dir, "batch-packages"); mkdirSync(B2);
    for (const f of ["good-lib.tgz", "good-lib.meta.json"]) copyFileSync(join(D2, f), join(B2, f));
    runNode(BUNDLER, [B2, join(t.dir, "batch"), "1"]);
    runNode(STREAM, [list, D2, D3]);
    for (const f of ["bundles/good-lib@1.0.0.min.js", "bundles/good-lib@1.0.0.min.js.map", "modules/good-lib@1.0.0.json"])
      assert.deepEqual(readFileSync(join(D3, f)), readFileSync(join(t.dir, "batch", f)), `${f} identical`);
    // SBOMs differ only in the serial number and timestamp every run writes
    const norm = (p) => { const j = JSON.parse(readFileSync(p, "utf8")); delete j.serialNumber; delete j.metadata.timestamp; return j; };
    assert.deepEqual(norm(join(D3, "sbom", "good-lib@1.0.0.cdx.json")), norm(join(t.dir, "batch", "sbom", "good-lib@1.0.0.cdx.json")));
  } finally { t.cleanup(); }
});

test("re-running skips finished packages; --keep downloads keeps the tarballs; --no-check bundles everything", { skip, timeout: 300_000 }, () => {
  const t = tmp(); try {
    const { D2, D3, list } = fixtures(t.dir);
    runNode(STREAM, [list, D2, D3, "--keep", "downloads"]);
    assert.ok(existsSync(join(D2, "good-lib.tgz")) && existsSync(join(D2, "font-only.tgz")), "downloads kept when asked");
    const again = runNode(STREAM, [list, D2, D3]);
    assert.match(again.stdout, /\(4 package\(s\); 4 already done\)/);
    assert.equal(lines(again).length, 0, "nothing processed twice");
    assert.equal(JSON.parse(readFileSync(join(D3, "summary.json"), "utf8")).length, 4, "summary rebuilt from the records");

    const t2 = tmp(); try {
      const f = fixtures(t2.dir);
      const r = runNode(STREAM, [f.list, f.D2, f.D3, "--no-check"]);
      assert.match(lines(r).find((l) => l.includes("font-only")), /\| bundle_failed \| stylesheet_only \|/, "without the check it is bundled and fails, categorized the same");
    } finally { t2.cleanup(); }
  } finally { t.cleanup(); }
});

test("postponed packages wait for Claude across runs, then their parked download is deleted", { skip, timeout: 300_000 }, () => {
  const t = tmp(); try {
    const { D2, D3, list } = fixtures(t.dir);
    // first run: Claude allowed for 0 packages, so broken-pkg stays postponed
    let r = runNode(STREAM, [list, D2, D3, "--claude", "--max", "0", "--claude-bin", fakeClaude(t.dir)]);
    assert.equal(r.code, 0, r.stdout);
    assert.ok(existsSync(join(D2, "_postponed", "broken-pkg", "packages", "broken-pkg.tgz")), "the download is parked");
    assert.equal(JSON.parse(readFileSync(join(D3, "stream", "records", "broken-pkg.json"), "utf8")).claude_pending, true);
    // second run: nothing is streamed again; Claude repairs the parked package
    r = runNode(STREAM, [list, D2, D3, "--claude", "--claude-bin", fakeClaude(t.dir)]);
    assert.equal(r.code, 0, r.stdout);
    assert.deepEqual(lines(r).map((l) => l.split(" | ").slice(1, 3).join(" ")), ["broken-pkg@1.0.0 repaired_by_claude"]);
    assert.ok(!existsSync(join(D2, "_postponed")), "parked downloads are deleted after the repair");
    const rec = JSON.parse(readFileSync(join(D3, "stream", "records", "broken-pkg.json"), "utf8"));
    assert.equal(rec.claude_pending, undefined); assert.equal(rec.outcome, "repaired_by_claude");
  } finally { t.cleanup(); }
});

test("--work-dir puts the temporary folder elsewhere (another disk too) and leaves it empty", { skip, timeout: 300_000 }, () => {
  const t = tmp(); try {
    const { D2, D3, list } = fixtures(t.dir);
    const W = existsSync("/dev/shm") ? mkdtempSync(join("/dev/shm", "wd-")) : join(t.dir, "elsewhere");
    try {
      const r = runNode(STREAM, [list, D2, D3, "--work-dir", W, "--keep", "downloads", "--claude", "--claude-bin", fakeClaude(t.dir)]);
      assert.equal(r.code, 0, r.stdout);
      assert.match(r.stdout, new RegExp(`working in  : ${W.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/tier1-stream-`));
      assert.deepEqual(lines(r).filter((l) => / \| (bundled|repaired_by_claude) \| /.test(l)).map((l) => l.split(" | ")[1]).sort(), ["broken-pkg@1.0.0", "good-lib@1.0.0"]);
      assert.ok(existsSync(join(D2, "good-lib.tgz")), "kept downloads are moved back across disks");
      assert.ok(!existsSync(join(D2, "_stream")), "nothing is unpacked in the downloads folder");
      assert.deepEqual(readdirSync(W), [], "the temporary folder is cleaned up");
    } finally { rmSync(W, { recursive: true, force: true }); }
  } finally { t.cleanup(); }
});

test("a disk error while deleting a working folder does not stop the run", { skip, timeout: 300_000 }, () => {
  const t = tmp(); try {
    const { D2, D3, list } = fixtures(t.dir);
    // make deleting good-lib's working folder fail with EIO, like the failing drive did
    const r = runNode(STREAM, [list, D2, D3], { env: { ...process.env, NODE_OPTIONS: `--import ${join(import.meta.dirname, "fixtures", "fail-rm-eio.mjs")}` } });
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /warning: could not delete .*_stream\/good-lib .*moved it to .*-undeleted, the run continues/);
    assert.equal(lines(r).length, 4, "every package still gets its result");
    assert.ok(existsSync(join(D3, "bundles", "good-lib@1.0.0.min.js")), "the bundle is kept");
    assert.match(r.stdout, /working folder\(s\) failed to delete during the run, but were deleted at the end|could not be deleted \(disk error\)/);
  } finally { t.cleanup(); }
});

test("packages that failed for a machine reason (download, disk, missing tool) are tried again on the next run", { skip, timeout: 300_000 }, () => {
  const t = tmp(); try {
    const { D2, D3, list } = fixtures(t.dir);
    let r = runNode(STREAM, [list, D2, D3, "--keep", "downloads"]); // the fixtures cannot be downloaded again
    assert.equal(r.code, 0, r.stdout);
    // as a run with a broken disk / no webpack would have left it
    const f = join(D3, "stream", "records", "good-lib.json");
    writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, "utf8")), outcome: "bundle_failed", category: "other", cause: "stream driver error: Cannot find package 'webpack'" }));
    r = runNode(STREAM, [list, D2, D3]);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /1 tried again after a download\/disk\/tool error/);
    assert.deepEqual(lines(r).map((l) => l.split(" | ").slice(1, 3).join(" ")), ["good-lib@1.0.0 bundled"], "only that package runs again");
  } finally { t.cleanup(); }
});

test("a broken tool install stops the run before any package gets a result", { skip, timeout: 300_000 }, () => {
  const t = tmp(); try {
    const { D2, D3, list } = fixtures(t.dir);
    const r = runNode(STREAM, [list, D2, D3, "--claude", "--claude-bin", fakeClaude(t.dir)],
      { env: { ...process.env, NODE_OPTIONS: `--import ${join(import.meta.dirname, "fixtures", "broken-minimizer.mjs")}` } });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /the bundler fails on a tiny test package, so the problem is the tools or the disk[\s\S]*getImplementationModuleRef/);
    assert.match(r.stdout, /run `npm ci`/);
    assert.deepEqual(readdirSync(join(D3, "stream", "records")), [], "no package was recorded");
    assert.ok(existsSync(join(D2, "good-lib.tgz")), "no download was touched");
  } finally { t.cleanup(); }
});

test("a bundler crash recorded without a passing self-test is tried again", { skip, timeout: 300_000 }, () => {
  const t = tmp(); try {
    const { D2, D3, list } = fixtures(t.dir);
    let r = runNode(STREAM, [list, D2, D3, "--keep", "downloads"]);
    const f = join(D3, "stream", "records", "good-lib.json"), rec = JSON.parse(readFileSync(f, "utf8"));
    assert.equal(rec.toolsOk, true, "records say the self-test passed");
    delete rec.toolsOk; // as written by a run before the self-test existed
    writeFileSync(f, JSON.stringify({ ...rec, outcome: "bundle_failed", category: "bundler_crash", cause: "postponed for Claude repair — crashed: TypeError: getImplementationModuleRef is not a function", claude_pending: true }));
    r = runNode(STREAM, [list, D2, D3]);
    assert.equal(r.code, 0, r.stdout);
    assert.deepEqual(lines(r).map((l) => l.split(" | ").slice(1, 3).join(" ")), ["good-lib@1.0.0 bundled"]);
  } finally { t.cleanup(); }
});
