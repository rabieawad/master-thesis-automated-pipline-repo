// The tier-3 search index, built once from the tier-2 reference dataset.
//
//   <index>/meta.json        settings, packages (name, file key, versions, non-trivial functions
//                            per version, which records belong to them)
//   <index>/records.json     one entry per non-trivial reference function and package, as
//                            parallel arrays: id (the tier-2 fingerprint), pkg, versions (index
//                            ranges into the package's version list), lineage, ntok, nodes
//   <index>/sigs.bin         the MinHash signature of every record (BINS uint32 each)
//   <index>/lineages/<key>.json   per package, the lineages that have markers:
//                            { <lineage>: { v: [[variantId, [a, b, …]]], m: [[code, [variantIds]]] } }
//
// Trivial functions (fewer than trivial_nodes syntax nodes) are left out: they look alike
// across packages and carry no evidence.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { canonicalRequire } from "./modules.mjs";
import { isPackageFile, keyOfPackageFile, readJsonFile } from "../../tier2/lib/json-gz.mjs";
import { sketch, BINS, BANDS, ROWS, SHINGLE, LSH } from "./sketch.mjs";

export const INDEX_VERSION = 1;

const writeAtomic = (file, data) => { writeFileSync(file + ".tmp", data); renameSync(file + ".tmp", file); };

// [indices] -> flat ranges [a1, b1, a2, b2, …]
export function toFlatRanges(idx) {
  const s = [...idx].sort((a, b) => a - b), out = [];
  for (const i of s) { if (out.length && out[out.length - 1] === i - 1) out[out.length - 1] = i; else out.push(i, i); }
  return out;
}
export function* rangeIndices(flat) { for (let k = 0; k < flat.length; k += 2) for (let i = flat[k]; i <= flat[k + 1]; i++) yield i; }
export const inRanges = (flat, i) => { for (let k = 0; k < flat.length; k += 2) if (i >= flat[k] && i <= flat[k + 1]) return true; return false; };

// A fingerprint of the tier-2 files an index is built from (names, sizes, modification times),
// so step 01 can tell whether its index is still up to date.
export function sourceSignature(dedupDir) {
  const h = createHash("sha256");
  for (const sub of ["packages", "lineages"]) {
    const d = join(dedupDir, sub); if (!existsSync(d)) { h.update(`${sub}:none\n`); continue; }
    for (const f of readdirSync(d).filter((x) => x.endsWith(".json") || x.endsWith(".json.gz")).sort()) { const st = statSync(join(d, f)); h.update(`${sub}/${f}:${st.size}:${Math.round(st.mtimeMs)}\n`); }
  }
  return h.digest("hex").slice(0, 24);
}

// Build the index from a tier-2 dedup folder (the one holding packages/ and lineages/).
export function buildIndex(dedupDir, outDir, { log = () => {}, canonicalRequire: canon = false } = {}) {
  const PKG = join(dedupDir, "packages"), LIN = join(dedupDir, "lineages");
  if (!existsSync(PKG)) throw new Error(`no per-package files in ${PKG} (tier 2 must run in streamed mode)`);
  mkdirSync(join(outDir, "lineages"), { recursive: true });
  const files = readdirSync(PKG).filter(isPackageFile).sort();
  const packages = [], rec = { id: [], pkg: [], versions: [], lineage: [], ntok: [], nodes: [] };
  const sigChunks = []; let n = 0, settings = null, lineageFiles = 0;
  for (const [pi, f] of files.entries()) {
    const key = keyOfPackageFile(f), t0 = Date.now();
    const doc = readJsonFile(join(PKG, f));
    settings = settings ?? doc.settings;
    const vIndex = new Map(doc.versions.map((v, i) => [v, i]));
    const nonTrivial = new Array(doc.versions.length).fill(0);
    const start = n;
    for (const fn of doc.functions) {
      const vs = Object.keys(fn.occurrences ?? {}).map((v) => vIndex.get(v)).filter((i) => i != null);
      if (fn.trivial || !vs.length) continue;
      for (const i of vs) nonTrivial[i]++;
      // canonical require (option): require('./x') and require(12) become require(0), on both sides
      let text = fn.textNorm ?? fn.text ?? "", id = fn.id;
      if (canon && fn.keyedOn === "textNorm" && text.includes("require(")) {
        text = canonicalRequire(text);
        id = createHash("sha256").update(fn.signature + "\0textNorm\0" + text).digest("hex").slice(0, 24);
      }
      const { sig, ntok } = sketch(text);
      rec.id.push(id); rec.pkg.push(pi); rec.versions.push(toFlatRanges(vs)); rec.lineage.push(fn.lineage ?? null);
      rec.ntok.push(ntok); rec.nodes.push(fn.metrics?.nodes ?? 0); sigChunks.push(sig); n++;
    }
    // lineage markers, compact: only lineages with markers (≥ 2 variants)
    let hasLineages = false;
    if (existsSync(join(LIN, `${key}.json`))) {
      const L = JSON.parse(readFileSync(join(LIN, `${key}.json`), "utf8")), out = {};
      for (const l of L.lineages) {
        if (!l.markers?.length) continue;
        out[l.lineage] = {
          v: l.variants.map((v) => [v.id, toFlatRanges(v.versions.flatMap(([a, b]) => { const i = vIndex.get(a), j = vIndex.get(b); const r = []; for (let x = i; x <= j; x++) r.push(x); return r; }))]),
          m: l.markers.map((m) => [m.code, m.variants]),
        };
      }
      writeAtomic(join(outDir, "lineages", `${key}.json`), JSON.stringify(out));
      hasLineages = true; lineageFiles++;
    }
    packages.push({ name: doc.package, key, versions: doc.versions, nonTrivial, start, end: n, hasLineages });
    log(`[${pi + 1}/${files.length}] ${doc.package}: ${n - start} functions, ${doc.versions.length} versions${hasLineages ? ", lineages" : ""}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
  const sigs = new Uint32Array(n * BINS);
  sigChunks.forEach((s, i) => sigs.set(s, i * BINS));
  writeAtomic(join(outDir, "sigs.bin"), Buffer.from(sigs.buffer));
  writeAtomic(join(outDir, "records.json"), JSON.stringify(rec));
  const meta = { index_version: INDEX_VERSION, built_at: new Date().toISOString(), source: dedupDir, source_signature: sourceSignature(dedupDir),
    sketch: { bins: BINS, bands: BANDS, rows: ROWS, shingle: SHINGLE }, tier2_settings: settings,
    records: n, packages, lineage_files: lineageFiles, canonical_require: !!canon };
  writeAtomic(join(outDir, "meta.json"), JSON.stringify(meta));
  return meta;
}

// Load an index into memory, with the lookups detection needs.
export function loadIndex(dir) {
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
  if (meta.index_version !== INDEX_VERSION) throw new Error(`index ${dir} has version ${meta.index_version}; rebuild it (step 01)`);
  const rec = JSON.parse(readFileSync(join(dir, "records.json"), "utf8"));
  const buf = readFileSync(join(dir, "sigs.bin"));
  const sigs = new Uint32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const N = meta.records, byId = new Map(), lsh = new LSH();
  for (let i = 0; i < N; i++) {
    const l = byId.get(rec.id[i]); if (l) l.push(i); else byId.set(rec.id[i], [i]);
    lsh.add(i, sigs.subarray(i * BINS, (i + 1) * BINS));
  }
  // how many packages hold each function id (for specificity)
  const pkgsOfId = new Map(); for (const [id, l] of byId) pkgsOfId.set(id, new Set(l.map((i) => rec.pkg[i])).size);
  const lineageCache = new Map();
  const lineagesOf = (pi) => {
    if (!lineageCache.has(pi)) {
      const p = meta.packages[pi]; let L = {};
      if (p.hasLineages) try { L = JSON.parse(readFileSync(join(dir, "lineages", p.key + ".json"), "utf8")); } catch {}
      lineageCache.set(pi, L);
    }
    return lineageCache.get(pi);
  };
  const sigOf = (i) => sigs.subarray(i * BINS, (i + 1) * BINS);
  // declared dependencies (step 01b, optional): package index -> Map(version -> { dependencies,
  // peerDependencies, optionalDependencies: package indices, ranges: Map(package index -> semver range) })
  const deps = new Map();
  const depFile = join(dir, "dependencies.json");
  if (existsSync(depFile)) {
    const byName = new Map(meta.packages.map((p, i) => [p.name, i]));
    for (const [n, perVersion] of Object.entries(JSON.parse(readFileSync(depFile, "utf8")))) {
      const i = byName.get(n); if (i == null || Array.isArray(perVersion)) continue;
      const m = new Map();
      for (const [v, e] of Object.entries(perVersion)) {
        if (Array.isArray(e)) continue; // an older format
        // kinds[k] = package indices; ranges: package index -> declared semver range (any kind)
        const kinds = { ranges: new Map() };
        for (const [k, l] of Object.entries(e)) {
          const entries = Array.isArray(l) ? l.map((d) => [d, "*"]) : Object.entries(l);
          kinds[k] = []; for (const [d, r] of entries) { const i = byName.get(d); if (i == null) continue; kinds[k].push(i); if (!kinds.ranges.has(i)) kinds.ranges.set(i, r); }
        }
        m.set(v, kinds);
      }
      deps.set(i, m);
    }
  }
  return { meta, rec, sigs, sigOf, byId, lsh, pkgsOfId, lineagesOf, deps, N, P: meta.packages.length };
}
