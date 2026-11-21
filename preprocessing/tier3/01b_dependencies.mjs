// Tier 3 · step 01b: the declared dependencies of every indexed package, from the npm registry.
//
// For each package in the index and each of its versions, `dependencies`, `peerDependencies` and
// `optionalDependencies` (the abbreviated packument). Used by step 02's
// dependency confirmation (a small package a detected package depends on needs less evidence) and
// ownership (code a package shares with one of its dependencies is the dependency's).
// The registry is public metadata, not the bundles' SBOMs: no ground truth is read.
//
// Usage: node 01b_dependencies.mjs <index dir> [--conc 8] [--force]
// Writes <index dir>/dependencies.json  { "<package>": { "<version>": { dependencies: { "<dep>": "<range>" }, peerDependencies: {…}, optionalDependencies: {…} } } }

import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const dir = argv.find((a) => !a.startsWith("--"));
if (!dir) { console.error("usage: node 01b_dependencies.mjs <index dir> [--conc 8] [--force]"); process.exit(2); }
const conc = Number(argv[argv.indexOf("--conc") + 1]) || 8, force = argv.includes("--force");
const out = join(resolve(dir), "dependencies.json");
const meta = JSON.parse(readFileSync(join(resolve(dir), "meta.json"), "utf8"));
const names = meta.packages.map((p) => p.name);
const prev = !force && existsSync(out) ? Object.fromEntries(Object.entries(JSON.parse(readFileSync(out, "utf8"))).filter(([, v]) => !Array.isArray(v) && Object.values(v).every((e) => !Array.isArray(e) && Object.values(e).every((l) => !Array.isArray(l))))) : {};
const todo = names.filter((n) => !(n in prev));
const REG = process.env.NPM_REGISTRY || "https://registry.npmjs.org";

async function deps(name) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${REG}/${name.replace("/", "%2f")}`, { headers: { accept: "application/vnd.npm.install-v1+json" } });
      if (r.status === 404) return {};
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json(), out = {};
      for (const [ver, v] of Object.entries(j.versions ?? {})) {
        const e = {};
        for (const k of ["dependencies", "peerDependencies", "optionalDependencies"]) { const l = Object.entries(v[k] ?? {}).filter(([d]) => d !== name).sort(); if (l.length) e[k] = Object.fromEntries(l); }
        if (Object.keys(e).length) out[ver] = e;
      }
      return out;
    } catch (e) { if (attempt === 2) throw e; await new Promise((res) => setTimeout(res, 1000 * (attempt + 1))); }
  }
}

const result = { ...prev };
let i = 0, failed = 0;
await Promise.all(Array.from({ length: conc }, async () => {
  while (i < todo.length) {
    const n = todo[i++];
    try { result[n] = await deps(n); } catch (e) { failed++; console.log(`FAIL ${n}: ${e.message}`); }
  }
}));
writeFileSync(out + ".tmp", JSON.stringify(result, null, 1)); renameSync(out + ".tmp", out);
console.log(`RESULT | dependencies of ${Object.keys(result).length} packages (${todo.length - failed} fetched, ${failed} failed) → ${out}`);
if (failed) process.exit(1);
