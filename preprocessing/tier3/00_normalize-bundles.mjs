// Tier 3 · step 00 (optional): bring the bundles closer to the shape of the reference before matching.
//
// Why: the bundles come from webpack + Terser and keep modern syntax; Aletheia's reference (tier 2)
// is its pseudo-bundles put through swc (minify, compress.unsafe, no target, so ES5). The same
// source therefore comes out differently on the two sides — e.g. gopd's code in a bundle matches
// gopd's own reference only at 0.5–0.6, but a Terser-minified copy inside a prebuilt package much
// better. This step puts every bundle through the SAME swc call Aletheia uses for the reference
// (tier2/lib/aletheia-bundler.mjs minify(), options copied unchanged below), keeps a source map
// composed with the bundle's own map (so the evaluation can still tell each function's package),
// and extracts its functions with the same collector tier 1 and tier 2 use. Tier 1, tier 2 and the
// reference are not touched; step 02 then simply reads this step's output instead of tier 1's.
//
// swc's ES5 downlevel INJECTS helper functions (_class_call_check, _create_class, …) at the top of
// the output. They are not the website's code (in the reference they are the same generic helpers in
// every package), so the functions inside them are dropped; --keep-helpers keeps them.
//
// --modules: webpack's module wrappers `function(e, t, r){… r(12) … e.exports = …}` are rewritten
// into Aletheia's `function(_$__e){… require(12) … module.exports = …}` (lib/modules.mjs), so a
// file whose code is top-level (no function of its own) can match the reference's wrapper; use an
// index built with --canonical-require so require('./x') and require(12) read the same.
//
// Transforms (--transform, default swc):
//   swc        Aletheia's swc minify, once
//   swc2       twice (swc's output is not always a fixed point after one pass)
//
// Writes:
//   <out>/bundles/<key>.min.js, <key>.min.js.map   the normalised bundle and its composed source map
//   <out>/functions/<key>.functions.json             its functions (same format as tier 1's step 06)
//   <out>/summary.csv                                per bundle: functions before / after, bytes, errors
//
// Usage:
//   node 00_normalize-bundles.mjs --bundles <tier1 05_selected_bundles/bundles> --out <dir> [--transform swc|swc2] [--keep-helpers] [--modules] [--force]
// Then: node 02_detect.mjs --functions <out>/functions --bundles <out>/bundles --sbom <tier1 …/sbom> …
//
// Safe to run again: a bundle whose output exists with the same transform is skipped.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as swc from "@swc/core";
import { parse } from "meriyah";
import { extractWithFeatures } from "../tier1/06-extract-functions.mjs";
import { canonicalModules } from "./lib/modules.mjs";

// Unchanged from tier2/lib/aletheia-bundler.mjs minify() — the reference's last step.
export const ALETHEIA_SWC_OPTIONS = {
  jsc: { minify: { compress: { unsafe: true } } },
  minify: true,
  isModule: "unknown",
};
export const TRANSFORMS = ["swc", "swc2"];

// One pass of Aletheia's swc call; with a map, the output map is composed with it.
export async function aletheiaSwc(code, map = null) {
  const out = await swc.transform(code, {
    ...ALETHEIA_SWC_OPTIONS,
    ...(map ? { sourceMaps: true, inputSourceMap: typeof map === "string" ? map : JSON.stringify(map) } : {}),
  });
  return { code: out.code, map: out.map ? JSON.parse(out.map) : null };
}

export async function normalizeBundle(code, map, transform = "swc") {
  if (!TRANSFORMS.includes(transform)) throw new Error(`unknown transform ${transform} (${TRANSFORMS.join(", ")})`);
  // the bundle's own sourceMappingURL comment would point at the old map
  let cur = { code: code.replace(/\n?\/\/# sourceMappingURL=.*\s*$/, "\n"), map };
  for (let pass = 0; pass < (transform === "swc2" ? 2 : 1); pass++) cur = await aletheiaSwc(cur.code, cur.map);
  return { ...cur, injectedEnd: injectedHelpersEnd(cur.code, code) };
}

// Where the helpers swc injected end: the leading top-level function declarations named like swc
// helpers (_snake_case) that the original bundle does not declare itself. 0 when there are none.
export function injectedHelpersEnd(out, original) {
  let ast;
  try { ast = parse(out, { ranges: true, next: true }); } catch { return 0; }
  let end = 0;
  for (const st of ast.body) {
    const name = st.type === "FunctionDeclaration" ? st.id?.name : null;
    if (!name || !/^_[a-z0-9]+(_[a-z0-9]+)*$/.test(name) || original.includes(`function ${name}(`)) break;
    end = st.end;
  }
  return end;
}

async function cli() {
  const argv = process.argv.slice(2);
  const opt = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
  const BUNDLES = opt("--bundles"), OUT = opt("--out"), transform = opt("--transform", "swc"), force = argv.includes("--force"), keepHelpers = argv.includes("--keep-helpers"), modules = argv.includes("--modules");
  if (!BUNDLES || !OUT) { console.error("usage: node 00_normalize-bundles.mjs --bundles <dir> --out <dir> [--transform swc|swc2] [--force]"); process.exit(2); }
  if (!TRANSFORMS.includes(transform)) { console.error(`unknown transform ${transform} (${TRANSFORMS.join(", ")})`); process.exit(2); }
  const inDir = resolve(BUNDLES), outB = join(resolve(OUT), "bundles"), outF = join(resolve(OUT), "functions");
  mkdirSync(outB, { recursive: true }); mkdirSync(outF, { recursive: true });
  const files = readdirSync(inDir).filter((f) => f.endsWith(".min.js")).sort();
  const rows = [], t0 = Date.now();
  let done = 0, skipped = 0, failed = 0;
  for (const [i, f] of files.entries()) {
    const key = f.slice(0, -".min.js".length), tag = `[${i + 1}/${files.length}] ${key}`;
    const fnFile = join(outF, `${key}.functions.json`);
    if (!force && existsSync(fnFile)) {
      try { const nm = JSON.parse(readFileSync(fnFile, "utf8")).normalized; if (nm?.transform === transform && !!nm.keepHelpers === keepHelpers && !!nm.modules === modules) { skipped++; console.log(`${tag} | already done`); continue; } } catch {}
    }
    try {
      const code = readFileSync(join(inDir, f), "utf8");
      const mapFile = join(inDir, `${f}.map`), map = existsSync(mapFile) ? readFileSync(mapFile, "utf8") : null;
      const before = extractWithFeatures(code, { minLoc: 0 }).records.length;
      const t1 = Date.now();
      const out = await normalizeBundle(code, map, transform);
      const ex = extractWithFeatures(out.code, { minLoc: 0 }), stats = ex.stats;
      const records = keepHelpers ? ex.records : ex.records.filter((r) => !(r.start != null && r.start < out.injectedEnd));
      stats.injectedHelperFunctions = ex.records.length - records.length;
      // --modules: webpack's module wrappers rewritten into Aletheia's form (lib/modules.mjs)
      stats.moduleWrappers = modules ? canonicalModules(out.code, records) : 0;
      writeFileSync(join(outB, f), out.code);
      if (out.map) writeFileSync(join(outB, `${f}.map`), JSON.stringify(out.map));
      writeFileSync(fnFile + ".tmp", JSON.stringify({ bundle: f, version: 2, normalized: { transform, keepHelpers, modules, functionsBefore: before, injectedHelperFunctions: stats.injectedHelperFunctions }, stats, functions: records }));
      renameSync(fnFile + ".tmp", fnFile);
      rows.push([key, "ok", before, records.length, Buffer.byteLength(code), Buffer.byteLength(out.code), ""]);
      done++;
      console.log(`${tag} | ${before} → ${records.length} functions (${stats.injectedHelperFunctions} injected helpers dropped${modules ? `, ${stats.moduleWrappers} module wrappers rewritten` : ""}) | ${(Buffer.byteLength(code) / 1024).toFixed(0)} → ${(Buffer.byteLength(out.code) / 1024).toFixed(0)} KB | ${((Date.now() - t1) / 1000).toFixed(1)}s`);
    } catch (e) {
      failed++; rows.push([key, "FAIL", "", "", "", "", String(e.message).slice(0, 200)]);
      console.log(`${tag} | FAIL ${String(e.message).slice(0, 200)}`);
    }
  }
  const cell = (s) => (/[",\n]/.test(String(s)) ? `"${String(s).replaceAll('"', '""')}"` : String(s));
  writeFileSync(join(resolve(OUT), "summary.csv"), "bundle,status,functions_before,functions_after,bytes_before,bytes_after,error\n" + rows.map((r) => r.map(cell).join(",")).join("\n") + "\n");
  console.log(`RESULT | ${done} bundles normalised (${transform}), ${skipped} already done, ${failed} failed | ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (failed && !done && !skipped) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await cli();
