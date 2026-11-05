import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmp, writeJson, writeText } from "./helpers.mjs";
import { fileSelector } from "../tier2/lib/file-selector.mjs";

const allInside = (files, dir) => files.every((f) => f.startsWith(dir));

test("nested stub package.json no longer wins: picks the real root entry, no escape", async () => {
  const t = tmp(); try {
    const pkg = join(t.dir, "pkg");
    // root manifest -> dist/index.js ; nested bundle/ stub -> ../dist/esm5/bundle.js (escapes if picked)
    writeJson(join(pkg, "package.json"), { name: "@acme/pkg", version: "1.0.0", browser: "dist/index.js" });
    writeJson(join(pkg, "bundle", "package.json"), { name: "@acme/pkg/bundle", browser: "../dist/esm5/bundle.js" });
    writeText(join(pkg, "dist", "index.js"), "export const a = 1;\n");
    writeText(join(pkg, "dist", "esm5", "bundle.js"), "export const b = 2;\n");
    const r = await fileSelector(pkg, () => {});
    assert.ok(allInside(r.files, pkg), `all files inside package: ${r.files}`);
    assert.ok(r.files.some((f) => f.endsWith(`${"dist"}/index.js`) || f.endsWith("dist\\index.js")), "root entry chosen");
    assert.equal(r.files.some((f) => f.includes("02_downloaded") || f.includes("..")), false);
  } finally { t.cleanup(); }
});

test("resilience: missing declared entry falls back to real files, never returns a non-existent path", async () => {
  const t = tmp(); try {
    const pkg = join(t.dir, "pkg");
    writeJson(join(pkg, "package.json"), { name: "brokenentry", version: "1.0.0", browser: "dist/does-not-exist.js" });
    writeText(join(pkg, "dist", "real.js"), "module.exports = 1;\n");
    const r = await fileSelector(pkg, () => {});
    assert.ok(allInside(r.files, pkg));
    assert.ok(r.files.length >= 1, "fell back to a real file");
    assert.ok(r.files.every((f) => !f.includes("does-not-exist")), "never returns the missing declared entry");
  } finally { t.cleanup(); }
});

test("imported non-JS (CSS) is excluded — only JS/JSON reaches the bundler", async () => {
  const t = tmp(); try {
    const pkg = join(t.dir, "pkg");
    writeJson(join(pkg, "package.json"), { name: "withcss", version: "1.0.0", module: "index.js" });
    writeText(join(pkg, "index.js"), 'import "./photoswipe.css";\nexport function f(){ return 1; }\n');
    writeText(join(pkg, "photoswipe.css"), ".pswp { color: #000; }\n");
    const r = await fileSelector(pkg, () => {});
    assert.ok(r.files.every((f) => /\.(c|m)?jsx?$|\.json$/i.test(f)), `only code files: ${r.files}`);
    assert.ok(!r.files.some((f) => f.endsWith(".css")), "css excluded");
    assert.ok(r.files.some((f) => f.endsWith("index.js")), "js entry kept");
  } finally { t.cleanup(); }
});

test("simple single-manifest package resolves its string entry", async () => {
  const t = tmp(); try {
    const pkg = join(t.dir, "pkg");
    writeJson(join(pkg, "package.json"), { name: "simple", version: "1.0.0", main: "index.js" });
    writeText(join(pkg, "index.js"), "module.exports = 42;\n");
    const r = await fileSelector(pkg, () => {});
    assert.ok(allInside(r.files, pkg));
    assert.ok(r.files.some((f) => f.endsWith("index.js")));
  } finally { t.cleanup(); }
});
