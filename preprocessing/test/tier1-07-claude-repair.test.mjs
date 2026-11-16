import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { writeFileSync, chmodSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmp, writeJson, writeText, runNode, hasModule, TIER1 } from "./helpers.mjs";

const skip = !(await hasModule("webpack")) && "webpack not installed";
const BUNDLER = join(TIER1, "03-bundle-and-sbom.mjs");
const REPAIR = join(TIER1, "07-claude-repair-bundles.mjs");

// A tier-1 download (wrapper package.json + node_modules, packed as <folder>.tgz with a meta
// sidecar) whose package requires a dependency the install left out, so webpack fails.
function brokenPackage(dir) {
  writeJson(join(dir, "src", "package.json"), { name: "wrap", version: "0.0.0", dependencies: { "broken-pkg": "1.0.0" } });
  writeJson(join(dir, "src", "node_modules", "broken-pkg", "package.json"), { name: "broken-pkg", version: "1.0.0", main: "index.js", dependencies: { "left-out": "^2.0.0" } });
  writeText(join(dir, "src", "node_modules", "broken-pkg", "index.js"), 'const pad = require("left-out");\nmodule.exports = (n) => pad("hello " + n, 20);\n');
  execFileSync("mkdir", ["-p", join(dir, "packages")]);
  execFileSync("tar", ["-czf", join(dir, "packages", "broken-pkg.tgz"), "-C", join(dir, "src"), "."]);
  writeJson(join(dir, "packages", "broken-pkg.meta.json"), { name: "broken-pkg", version: "1.0.0" });
}
// stand-in for the `claude` command
function fakeClaude(dir, name, body) {
  const f = join(dir, name);
  writeFileSync(f, `#!/usr/bin/env bash\nif [ "\${1:-}" = "--version" ]; then echo "fake"; exit 0; fi\n${body}\necho '{"type":"result","num_turns":2,"total_cost_usd":0.05}'\n`);
  chmodSync(f, 0o755);
  return f;
}
const HONEST = `mkdir -p pkg/node_modules/left-out
echo '{"name":"left-out","version":"2.0.0","main":"index.js"}' > pkg/node_modules/left-out/package.json
echo 'module.exports = (s, n) => String(s).padStart(n);' > pkg/node_modules/left-out/index.js
cat > REPAIR.json <<'J'
{"outcome":"repaired","category":"missing_dependency","cause":"left-out@^2.0.0 was required but never installed.",
 "evidence":"Module not found: Error: Can't resolve 'left-out'",
 "changes":[{"file":"pkg/node_modules/left-out/index.js","action":"added","reason":"the missing dependency"},{"file":"pkg/node_modules/left-out/package.json","action":"added","reason":"its manifest"}],
 "still_represents_package":"broken-pkg's own files are unchanged; only its missing dependency was added.",
 "explanation":"I read the bundler log, saw left-out was missing, added it at the requested range and re-ran try-bundle.sh, which printed BUNDLE_OK."}
J`;
const CHEAT = `printf '#!/usr/bin/env bash\\necho BUNDLE_OK\\n' > try-bundle.sh
mkdir -p staging/out && echo '[{"ok":true}]' > staging/out/summary.json`;

test("a package the bundler failed on is repaired, re-bundled by the unchanged bundler, and marked", { skip, timeout: 300_000 }, () => {
  const t = tmp(); try {
    brokenPackage(t.dir);
    const out = join(t.dir, "bundles");
    runNode(BUNDLER, [join(t.dir, "packages"), out, "1"]);
    assert.equal(JSON.parse(readFileSync(join(out, "summary.json"), "utf8"))[0].ok, false, "fails before repair");

    const r = runNode(REPAIR, [join(t.dir, "packages"), out, "--claude-bin", fakeClaude(t.dir, "claude", HONEST)]);
    assert.equal(r.code, 0, r.stdout);
    const s = JSON.parse(readFileSync(join(out, "summary.json"), "utf8"))[0];
    assert.equal(s.ok, true); assert.equal(s.bundledBy, "claude-repair"); assert.match(s.originalError, /left-out/);
    assert.ok(existsSync(join(out, "bundles", "broken-pkg@1.0.0.min.js")));
    assert.ok(existsSync(join(out, "sbom", "broken-pkg@1.0.0.cdx.json")), "the SBOM comes from the bundler itself");
    const changes = JSON.parse(readFileSync(join(out, "claude_repair", "broken-pkg", "changes.json"), "utf8"));
    assert.deepEqual(changes.added, ["node_modules/left-out/index.js", "node_modules/left-out/package.json"]);
    assert.ok(existsSync(join(out, "claude_repair", "broken-pkg", "changed-files", "node_modules", "left-out", "index.js")));
    assert.equal(existsSync(join(out, "claude_repair", "broken-pkg", "pkg")), false, "the large working copy is removed");
    assert.match(readFileSync(join(out, "claude_repair", "report.csv"), "utf8"), /broken-pkg,broken-pkg,1\.0\.0,repaired,missing_dependency,/);
    // the standardized record and log line
    const rec = JSON.parse(readFileSync(join(out, "claude_repair", "broken-pkg", "repair.json"), "utf8"));
    assert.equal(rec.outcome, "repaired"); assert.equal(rec.category, "missing_dependency");
    assert.equal(rec.claude.report_valid, true); assert.match(rec.explanation, /re-ran try-bundle\.sh/);
    assert.equal(rec.original_category, "missing_dependency");
    assert.match(r.stdout, /^RESULT \| broken-pkg@1\.0\.0 \| repaired \| missing_dependency \| left-out@\^2\.0\.0 was required/m);
    assert.match(r.stdout, /^    explanation: I read the bundler log/m);
    assert.match(runNode(REPAIR, [join(t.dir, "packages"), out, "--claude-bin", join(t.dir, "claude")]).stdout, /Nothing to repair/, "re-run skips it");
  } finally { t.cleanup(); }
});

test("faking success (editing the check script) is not accepted", { skip, timeout: 300_000 }, () => {
  const t = tmp(); try {
    brokenPackage(t.dir);
    const out = join(t.dir, "bundles");
    runNode(BUNDLER, [join(t.dir, "packages"), out, "1"]);
    const r = runNode(REPAIR, [join(t.dir, "packages"), out, "--claude-bin", fakeClaude(t.dir, "claude", CHEAT)]);
    assert.match(r.stdout, /^RESULT \| broken-pkg@1\.0\.0 \| not_repaired \| missing_dependency \| no valid report from Claude \(no REPAIR\.json written\)/m);
    assert.equal(JSON.parse(readFileSync(join(out, "summary.json"), "utf8"))[0].ok, false);
    assert.equal(existsSync(join(out, "bundles")) && readdirSync(join(out, "bundles")).length, 0, "no bundle added");
  } finally { t.cleanup(); }
});

test("a missing or malformed REPAIR.json is recorded as such, and a false claim never counts as repaired", { skip, timeout: 300_000 }, () => {
  const t = tmp(); try {
    brokenPackage(t.dir);
    const out = join(t.dir, "bundles");
    runNode(BUNDLER, [join(t.dir, "packages"), out, "1"]);
    // claims success, changes nothing, and gets the category wrong on purpose
    const LIAR = `echo '{"outcome":"repaired","category":"other","cause":"fixed it","changes":[],"explanation":"trust me"}' > REPAIR.json`;
    let r = runNode(REPAIR, [join(t.dir, "packages"), out, "--claude-bin", fakeClaude(t.dir, "claude-liar", LIAR)]);
    let rec = JSON.parse(readFileSync(join(out, "claude_repair", "broken-pkg", "repair.json"), "utf8"));
    assert.equal(rec.outcome, "not_repaired", "the unchanged bundler decides, not the claim");
    assert.ok(rec.notes.some((n) => /reported "repaired"/.test(n)));
    assert.match(r.stdout, /^RESULT \| broken-pkg@1\.0\.0 \| not_repaired \| other \| fixed it/m);
    // no valid JSON at all: the outcome is still recorded, with the automatic category
    r = runNode(REPAIR, [join(t.dir, "packages"), out, "--claude-bin", fakeClaude(t.dir, "claude-sloppy", "echo 'not json' > REPAIR.json")]);
    rec = JSON.parse(readFileSync(join(out, "claude_repair", "broken-pkg", "repair.json"), "utf8"));
    assert.equal(rec.claude.report_valid, false); assert.match(rec.claude.report_problem, /not valid JSON/);
    assert.equal(rec.category, "missing_dependency", "falls back to the category of the original error");
    assert.match(r.stdout, /^RESULT \| broken-pkg@1\.0\.0 \| not_repaired \| missing_dependency \| no valid report from Claude/m);
    const csv = readFileSync(join(out, "claude_repair", "report.csv"), "utf8").trim().split("\n");
    assert.equal(csv[0], "folder,name,version,outcome,category,cause,original_category,original_error,files_changed,report_valid,turns,cost_usd,note");
    assert.equal(csv.filter((l) => l.startsWith("broken-pkg,broken-pkg,")).length, 2, "one row per attempt");
  } finally { t.cleanup(); }
});

test("Claude is asked for the standardized REPAIR.json with the shared category list", () => {
  const src = readFileSync(REPAIR, "utf8");
  assert.match(src, /write \.\/REPAIR\.json \(required, exactly this shape\)/);
  assert.match(src, /"explanation": "your own explanation in your own words/);
  assert.match(src, /CATEGORY_NAMES\.map/, "the category list comes from the shared lib/failures.mjs");
});

test("a missing Claude command stops the step with a clear message", { timeout: 60_000 }, () => {
  const t = tmp(); try {
    writeJson(join(t.dir, "bundles", "summary.json"), [{ folder: "x", name: "x", version: "1.0.0", ok: false, error: "boom" }]);
    const r = runNode(REPAIR, [join(t.dir, "packages"), join(t.dir, "bundles"), "--claude-bin", join(t.dir, "no-such-claude")]);
    assert.notEqual(r.code, 0);
    assert.match(r.stdout, /Install Claude Code/);
  } finally { t.cleanup(); }
});
