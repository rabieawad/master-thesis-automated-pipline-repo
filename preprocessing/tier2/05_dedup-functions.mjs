// Reference pipeline, step 05: deduplicate functions across versions.
//
// Reads step 04's <name>@<version>.functions.json files and collapses every function
// instance into ONE record per distinct function, keeping a map of which package
// versions (as contiguous version intervals) each one appears in. The unique records
// are what you embed; the maps assign each function back to its versions.
//
// Identity = sha256(signature + body)[:24], exact string match, no fuzziness:
//   body       normalized (default): textNorm (bundle-declared names renamed v0, v1, …)
//              exact               : raw text
//              (falls back to hashNorm / hash / rawText when step 04 ran with
//               --no-text / --no-norm or a function was unprintable)
//   signature  kind, bodyType, async, generator, param count / rest / defaults /
//              destructured — `text` is only the body, so `function(a){}` and
//              `function(a,b){}` would otherwise collide. FunctionDeclaration and
//              FunctionExpression count as one kind unless --strict-type (a bundler
//              choice, not a code change); arrow functions stay distinct.
//
// Usage:
//   node 05_dedup-functions.mjs [functionsDir=extracted-functions] [outDir=deduplicated-functions] \
//        [--mode normalized|exact] [--strict-type] [--trivial-nodes 6] [--near 0.85] [--near-min-nodes 20]
//
// Writes:
//   unique_functions.jsonl  one line per distinct function (text = most common raw variant)
//   occurrences.csv         function_id, package, version, count, indices
//   version_index.json      "pkg@ver" -> [function_id per original index]  (rebuild any version)
//   near_duplicates.csv     only with --near: pairs of DIFFERENT functions with token-shingle
//                           Jaccard >= threshold (lineage; never merged)
//   summary.json            counts

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

// ------------------------------------------------------------------ versions
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/;
export function cmpVersion(a, b) {
  const ma = SEMVER.exec(a), mb = SEMVER.exec(b);
  if (!ma || !mb) return ma ? -1 : mb ? 1 : a < b ? -1 : a > b ? 1 : 0; // unparseable last
  for (let i = 1; i <= 3; i++) { const d = Number(ma[i]) - Number(mb[i]); if (d) return d; }
  const pa = ma[4], pb = mb[4];
  if (pa === pb) return 0;
  if (pa === undefined) return 1;  // release > prerelease
  if (pb === undefined) return -1;
  const xa = pa.split("."), xb = pb.split(".");
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1;
    if (xb[i] === undefined) return 1;
    const na = /^\d+$/.test(xa[i]), nb = /^\d+$/.test(xb[i]);
    if (na && nb) { const d = Number(xa[i]) - Number(xb[i]); if (d) return d; }
    else if (na !== nb) return na ? -1 : 1;
    else if (xa[i] !== xb[i]) return xa[i] < xb[i] ? -1 : 1;
  }
  return 0;
}

// Collapse the versions a function appears in into contiguous runs over the package's
// known (sorted) version list -> [["7.20.0","7.25.0"], ["8.1.0","8.1.0"]]
export function toRanges(present, allSorted) {
  const pos = new Map(allSorted.map((v, i) => [v, i]));
  const idx = present.map((v) => pos.get(v)).sort((a, b) => a - b);
  const out = [];
  let start = idx[0], prev = idx[0];
  for (const i of idx.slice(1)) {
    if (i !== prev + 1) { out.push([allSorted[start], allSorted[prev]]); start = i; }
    prev = i;
  }
  out.push([allSorted[start], allSorted[prev]]);
  return out;
}

// ------------------------------------------------------------------ identity
const SAME_KIND = { FunctionDeclaration: "function", FunctionExpression: "function" };
export function signature(fn, strictType = false) {
  const p = fn.params || {};
  const t = strictType ? fn.type : (SAME_KIND[fn.type] ?? fn.type);
  return [t, fn.bodyType, fn.async, fn.generator, p.count, p.rest, p.defaults, p.destructured].map(String).join("|");
}

// Which field holds the body to compare, in order of preference for each mode.
export function bodyOf(fn, mode) {
  const order = mode === "exact"
    ? [["text", fn.text], ["rawText", fn.rawText], ["hash", fn.hash]]
    : [["textNorm", fn.textNorm], ["hashNorm", fn.hashNorm], ["text", fn.text], ["rawText", fn.rawText], ["hash", fn.hash]];
  for (const [src, v] of order) if (v != null) return { src, body: v };
  return null;
}

export function identity(fn, mode = "normalized", strictType = false, fallbackKey = "") {
  const b = bodyOf(fn, mode);
  const h = createHash("sha256");
  h.update(signature(fn, strictType)); h.update("\0");
  // the source tag keeps e.g. a hashNorm from ever equalling a literal textNorm
  if (b) { h.update(b.src); h.update("\0"); h.update(b.body); }
  else { h.update("unkeyed\0" + fallbackKey); } // nothing comparable: never merged
  return h.digest("hex").slice(0, 24);
}

// ------------------------------------------------------------------ near-duplicates (MinHash LSH)
const TOKEN = /[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`[^`]*`|\S/g;
function shingles(text, k = 4) {
  const t = text.match(TOKEN) || [];
  if (t.length < k) return new Set([t.join(" ")]);
  const s = new Set();
  for (let i = 0; i + k <= t.length; i++) s.add(t.slice(i, i + k).join(" "));
  return s;
}
const fmix32 = (h) => { h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return h >>> 0; };
const fnv = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

export function nearDuplicates(items, threshold, { bands = 16, rows = 4 } = {}) {
  // items: [{ id, text }]
  const nperm = bands * rows;
  const seeds = Array.from({ length: nperm }, (_, i) => fmix32(0x9e3779b9 * (i + 1)));
  const sets = [], sigs = [];
  for (const it of items) {
    const s = shingles(it.text);
    const hs = [...s].map(fnv);
    const sig = new Uint32Array(nperm).fill(0xffffffff);
    for (const h of hs) for (let j = 0; j < nperm; j++) { const v = fmix32(h ^ seeds[j]); if (v < sig[j]) sig[j] = v; }
    sets.push(s); sigs.push(sig);
  }
  const buckets = new Map();
  sigs.forEach((sig, i) => {
    for (let b = 0; b < bands; b++) {
      const key = b + ":" + Array.from(sig.subarray(b * rows, (b + 1) * rows)).join(",");
      let arr = buckets.get(key); if (!arr) buckets.set(key, (arr = [])); arr.push(i);
    }
  });
  const cand = new Set();
  for (const m of buckets.values()) {
    if (m.length < 2 || m.length >= 500) continue;
    for (let x = 0; x < m.length; x++) for (let y = x + 1; y < m.length; y++) cand.add(m[x] * 1e7 + m[y]);
  }
  const pairs = [];
  for (const c of cand) {
    const i = Math.floor(c / 1e7), j = c % 1e7;
    const a = sets[i], b = sets[j];
    let inter = 0; for (const x of a) if (b.has(x)) inter++;
    const jac = inter / (a.size + b.size - inter);
    if (jac >= threshold) pairs.push([items[i].id, items[j].id, Math.round(jac * 1e4) / 1e4]);
  }
  pairs.sort((p, q) => q[2] - p[2] || (p[0] < q[0] ? -1 : 1));
  return { pairs, considered: items.length, candidates: cand.size };
}

// ------------------------------------------------------------------ main
export function dedup(functionsDir, outDir, opts = {}) {
  const { mode = "normalized", strictType = false, trivialNodes = 6, near = null, nearMinNodes = 20, log = console.log } = opts;
  const t0 = Date.now();
  const files = readdirSync(functionsDir).filter((f) => f.endsWith(".functions.json")).sort();
  if (!files.length) throw new Error(`no *.functions.json files in ${functionsDir}  (run step 04 first)`);

  const pkgVersions = new Map();     // pkg -> [ver]
  const uniq = new Map();            // fid -> record
  const occ = new Map();             // fid -> Map("pkg\0ver" -> [indices])
  const rawVariants = new Map();     // fid -> Map(rawKey -> count)
  const rawText = new Map();         // rawKey -> text
  const parents = new Map();         // fid -> Set(parent fid)
  const versionIndex = {};
  const bodySources = {};
  let total = 0;

  for (const [n, file] of files.entries()) {
    const key = file.slice(0, -".functions.json".length);
    const at = key.lastIndexOf("@");
    if (at <= 0) { log(`skip (name not pkg@ver): ${file}`); continue; }
    const pkg = key.slice(0, at), ver = key.slice(at + 1);
    if (!pkgVersions.has(pkg)) pkgVersions.set(pkg, []);
    pkgVersions.get(pkg).push(ver);
    const fns = JSON.parse(readFileSync(join(functionsDir, file), "utf8")).functions || [];
    const fids = fns.map((fn, i) => identity(fn, mode, strictType, `${key}#${i}`));
    versionIndex[key] = fids;
    fns.forEach((fn, i) => {
      const fid = fids[i];
      total++;
      if (!uniq.has(fid)) {
        const metrics = fn.metrics || {};
        const b = bodyOf(fn, mode);
        bodySources[b?.src ?? "none"] = (bodySources[b?.src ?? "none"] || 0) + 1;
        uniq.set(fid, {
          id: fid, signature: signature(fn, strictType), type: fn.type, context: fn.context,
          params: fn.params, async: fn.async, generator: fn.generator, loc: fn.loc, metrics,
          strings: fn.strings, properties: fn.properties, globals: fn.globals,
          textNorm: fn.textNorm ?? null, keyedOn: b?.src ?? "none",
          trivial: (metrics.nodes ?? 99) < trivialNodes,
        });
        occ.set(fid, new Map()); rawVariants.set(fid, new Map()); parents.set(fid, new Set());
      }
      const ok = pkg + "\0" + ver;
      const o = occ.get(fid); if (!o.has(ok)) o.set(ok, []); o.get(ok).push(fn.index ?? i);
      const raw = fn.text ?? fn.rawText ?? null;
      const rk = fn.hash ?? (raw != null ? createHash("sha256").update(raw).digest("hex").slice(0, 16) : "none");
      const rv = rawVariants.get(fid); rv.set(rk, (rv.get(rk) || 0) + 1);
      if (!rawText.has(rk)) rawText.set(rk, raw);
      const pi = fn.parentIndex;
      if (pi != null && pi >= 0 && pi < fids.length) parents.get(fid).add(fids[pi]);
    });
    if ((n + 1) % 100 === 0 || n + 1 === files.length) log(`[${n + 1}/${files.length}] read  (${uniq.size} unique of ${total} so far)`);
  }

  for (const v of pkgVersions.values()) v.sort(cmpVersion);

  for (const [fid, u] of uniq) {
    const byPkg = new Map();
    for (const k of occ.get(fid).keys()) { const [p, v] = k.split("\0"); if (!byPkg.has(p)) byPkg.set(p, []); byPkg.get(p).push(v); }
    const packages = {};
    for (const p of [...byPkg.keys()].sort()) {
      const vers = byPkg.get(p).sort(cmpVersion);
      packages[p] = { n_versions: vers.length, first: vers[0], last: vers.at(-1), ranges: toRanges(vers, pkgVersions.get(p)) };
    }
    let top = null, best = -1;
    for (const [rk, c] of rawVariants.get(fid)) if (c > best) { best = c; top = rk; }
    u.text = rawText.get(top);            // most common real-name variant: best for embedding
    u.raw_variants = rawVariants.get(fid).size;
    u.n_occurrences = [...occ.get(fid).values()].reduce((s, a) => s + a.length, 0);
    u.n_versions = occ.get(fid).size;
    u.packages = packages;
    u.parent_ids = [...parents.get(fid)].sort();
  }

  mkdirSync(outDir, { recursive: true });
  const order = [...uniq.values()].sort((a, b) => b.n_versions - a.n_versions || (a.id < b.id ? -1 : 1));
  writeFileSync(join(outDir, "unique_functions.jsonl"), order.map((u) => JSON.stringify(u)).join("\n") + "\n");

  const cell = (s) => (/[",\r\n]/.test(String(s)) ? `"${String(s).replaceAll('"', '""')}"` : String(s));
  const lines = ["function_id,package,version,count,indices"];
  for (const u of order) {
    const entries = [...occ.get(u.id)].map(([k, idx]) => [...k.split("\0"), idx])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : cmpVersion(a[1], b[1])));
    for (const [p, v, idx] of entries) lines.push([u.id, p, v, idx.length, idx.join(" ")].map(cell).join(","));
  }
  writeFileSync(join(outDir, "occurrences.csv"), lines.join("\n") + "\n");
  writeFileSync(join(outDir, "version_index.json"), JSON.stringify(versionIndex));

  const summary = {
    mode, strictType, files: files.length,
    packages: Object.fromEntries([...pkgVersions].map(([p, v]) => [p, v.length])),
    function_instances: total,
    unique_functions: uniq.size,
    unique_non_trivial: order.filter((u) => !u.trivial).length,
    dedup_ratio: Math.round((total / Math.max(1, uniq.size)) * 10) / 10,
    in_one_version_only: order.filter((u) => u.n_versions === 1).length,
    with_gaps: order.filter((u) => Object.values(u.packages).some((p) => p.ranges.length > 1)).length,
    shared_across_packages: order.filter((u) => Object.keys(u.packages).length > 1).length,
    keyed_on: bodySources,
  };

  if (near != null) {
    const items = order.filter((u) => !u.trivial && (u.metrics?.nodes ?? 0) >= nearMinNodes && (u.textNorm ?? u.text) != null)
      .map((u) => ({ id: u.id, text: u.textNorm ?? u.text }));
    const { pairs, considered, candidates } = nearDuplicates(items, near);
    const seen = (u) => Object.entries(u.packages).map(([p, d]) => `${p} ${d.first}..${d.last}`).join("; ");
    const nl = ["id_a,id_b,jaccard,a_seen,b_seen", ...pairs.map(([a, b, j]) => [a, b, j, seen(uniq.get(a)), seen(uniq.get(b))].map(cell).join(","))];
    writeFileSync(join(outDir, "near_duplicates.csv"), nl.join("\n") + "\n");
    summary.near = { threshold: near, considered, lsh_candidates: candidates, pairs: pairs.length };
  }

  summary.seconds = Math.round((Date.now() - t0) / 100) / 10;
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  return summary;
}

// ------------------------------------------------------------------ CLI
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const args = process.argv.slice(2);
  const valued = new Set(["--mode", "--trivial-nodes", "--near", "--near-min-nodes"]);
  const opt = (name, fb) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fb; };
  const positional = args.filter((a, i) => !a.startsWith("--") && !valued.has(args[i - 1]));
  const functionsDir = resolve(positional[0] ?? "extracted-functions");
  const outDir = resolve(positional[1] ?? "deduplicated-functions");
  const mode = opt("--mode", "normalized");
  if (!["normalized", "exact"].includes(mode)) { console.error(`--mode must be normalized or exact (got ${mode})`); process.exit(1); }
  const nearRaw = opt("--near", "");
  const near = nearRaw === "" || Number(nearRaw) <= 0 ? null : Number(nearRaw);
  if (!existsSync(functionsDir)) { console.error(`Functions folder not found: ${functionsDir}  (run step 04 first)`); process.exit(1); }
  try {
    const s = dedup(functionsDir, outDir, {
      mode, strictType: args.includes("--strict-type"),
      trivialNodes: Number(opt("--trivial-nodes", 6)), near, nearMinNodes: Number(opt("--near-min-nodes", 20)),
    });
    console.log(JSON.stringify(s, null, 2));
    console.log(`\nDone. ${s.function_instances} function instances -> ${s.unique_functions} unique (${s.dedup_ratio}x)  (see ${outDir})`);
  } catch (e) { console.error(String(e.message)); process.exit(1); }
}
