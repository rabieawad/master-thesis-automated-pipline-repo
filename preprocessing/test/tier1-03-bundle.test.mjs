import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmp, writeText, writeJson, read, exists, runNode, hasModule, TIER1 } from "./helpers.mjs";

const DEPS_OK = await hasModule("webpack");
const skip = DEPS_OK ? false : "webpack not installed";
const SCRIPT = join(TIER1, "03-bundle-and-sbom.mjs");

// tier-1 downloads are stored as <folder>.tgz of an INSTALLED tree (node_modules/<name>/...)
// plus a <folder>.meta.json sidecar. Build such a fixture for one tiny package.
function makeInstalledTgz(pkgsDir, folder, name, version, files) {
  const t = tmp("inst"); try {
    const nm = join(t.dir, "node_modules", name);
    for (const [rel, content] of Object.entries(files)) writeText(join(nm, rel), content);
    mkdirSync(pkgsDir, { recursive: true });
    execFileSync("tar", ["-czf", join(pkgsDir, `${folder}.tgz`), "-C", t.dir, "."], { stdio: "ignore" });
    writeJson(join(pkgsDir, `${folder}.meta.json`), { name, version });
  } finally { t.cleanup(); }
}

test("bundles an installed-tree package and writes bundle + sbom + modules + summary", { skip }, () => {
  const t = tmp(); try {
    const pkgs = join(t.dir, "pkgs");
    makeInstalledTgz(pkgs, "fx", "fx", "1.0.0", {
      "package.json": JSON.stringify({ name: "fx", version: "1.0.0", main: "index.js" }),
      "index.js": "module.exports = function(){ return 1 + 2; };\n",
    });
    const r = runNode(SCRIPT, [pkgs, join(t.dir, "out"), "1"], { env: { ...process.env, MINIFY: "0" } });
    assert.equal(r.code, 0, r.stdout);
    const summary = JSON.parse(read(join(t.dir, "out", "summary.json")));
    const fx = summary.find((x) => x.name === "fx");
    assert.ok(fx && fx.ok, "fx bundled ok: " + JSON.stringify(summary));
    assert.ok(exists(join(t.dir, "out", "bundles", "fx@1.0.0.min.js")), "bundle written");
    assert.ok(exists(join(t.dir, "out", "sbom", "fx@1.0.0.cdx.json")), "sbom written");
    assert.ok(exists(join(t.dir, "out", "modules", "fx@1.0.0.json")), "modules report written");
  } finally { t.cleanup(); }
});
