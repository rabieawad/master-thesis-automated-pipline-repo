import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmp, read, exists, runNode, makeTgz, hasModule, TIER2 } from "./helpers.mjs";

const DEPS_OK = (await Promise.all(["@swc/core", "meriyah", "acorn-walk", "astring", "acorn-loose"].map(hasModule))).every(Boolean);
const skip = DEPS_OK ? false : "bundler deps not installed";
const SCRIPT = join(TIER2, "03_pseudo-bundle.mjs");

test("pseudo-bundles a normal package and a nested-stub package; no failures, exports kept", { skip }, () => {
  const t = tmp(); try {
    const pkgs = join(t.dir, "pkgs");
    makeTgz(join(pkgs, "fx@1.0.0.tgz"), {
      "package.json": JSON.stringify({ name: "fx", version: "1.0.0", module: "index.js" }),
      "index.js": "export function keepMe(){ return 7; }\nexport default 1;\n",
    });
    // nested-stub package (firestore-like): stub browser points ../dist -> used to escape & FAIL
    makeTgz(join(pkgs, "nst@1.0.0.tgz"), {
      "package.json": JSON.stringify({ name: "nst", version: "1.0.0", browser: "dist/index.js" }),
      "bundle/package.json": JSON.stringify({ name: "nst/bundle", browser: "../dist/esm5/bundle.js" }),
      "dist/index.js": "export const hi = 1;\n",
      "dist/esm5/bundle.js": "export const bye = 2;\n",
    });
    const r = runNode(SCRIPT, [pkgs, join(t.dir, "out"), "2"], { env: { ...process.env, MINIFY: "0" } });
    assert.equal(r.code, 0, r.stdout);
    const results = JSON.parse(read(join(t.dir, "out", "bundle-results.json")));
    const failed = results.filter((x) => !x.ok);
    assert.equal(failed.length, 0, "no failures: " + JSON.stringify(failed));
    // fx bundle keeps the exported function (Fix B) and is wrapped
    const fx = read(join(t.dir, "out", "bundles", "fx@1.0.0.js"));
    assert.ok(fx.startsWith("module(["), "module wrapper");
    assert.ok(fx.includes("function keepMe"), "exported fn kept");
    assert.ok(exists(join(t.dir, "out", "bundles", "nst@1.0.0.js")), "nested-stub package bundled, not failed");
  } finally { t.cleanup(); }
});

test("package importing CSS bundles with MINIFY on (no CSS fed to swc)", { skip }, () => {
  const t = tmp(); try {
    const pkgs = join(t.dir, "pkgs");
    makeTgz(join(pkgs, "withcss@1.0.0.tgz"), {
      "package.json": JSON.stringify({ name: "withcss", version: "1.0.0", module: "index.js" }),
      "index.js": 'import "./style.css";\nexport function f(){ return 1 + 2; }\n',
      "style.css": ".pswp { color: #000; --x: 1px; }\n",
    });
    const r = runNode(SCRIPT, [pkgs, join(t.dir, "out"), "1"], { env: { ...process.env, MINIFY: "1" } });
    assert.equal(r.code, 0, r.stdout);
    const results = JSON.parse(read(join(t.dir, "out", "bundle-results.json")));
    assert.equal(results.filter((x) => !x.ok).length, 0, "no failures: " + r.stdout);
    const js = read(join(t.dir, "out", "bundles", "withcss@1.0.0.js"));
    assert.ok(!js.includes(".pswp {"), "CSS not in bundle");
  } finally { t.cleanup(); }
});

test("skip-if-exists: re-running does not rebuild", { skip }, () => {
  const t = tmp(); try {
    const pkgs = join(t.dir, "pkgs");
    makeTgz(join(pkgs, "fx@1.0.0.tgz"), { "package.json": JSON.stringify({ name: "fx", version: "1.0.0", module: "index.js" }), "index.js": "export const a = 1;\n" });
    runNode(SCRIPT, [pkgs, join(t.dir, "out"), "1"], { env: { ...process.env, MINIFY: "0" } });
    const r2 = runNode(SCRIPT, [pkgs, join(t.dir, "out"), "1"], { env: { ...process.env, MINIFY: "0" } });
    assert.match(r2.stdout, /skip/i, "second run skips the already-bundled package");
  } finally { t.cleanup(); }
});
