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
//        [--mode normalized|exact] [--strict-type] [--identity hash|string] \
//        [--trivial-nodes 6] [--near 0.85] [--near-min-nodes 20]
//
//   --identity string  (default) compare the signature+body KEYS character by character. No hash
//                      collision is possible, so "same function" means literally the same string.
//   --identity hash    compare the truncated sha256 ids instead (the older, compact form). Both
//                      give the same answer unless two different functions share a 24-char id.
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

// The FULL comparison key of a function: signature, then the tagged body text itself.
// This is what "same function" means, written out in full rather than hashed:
//   "<signature>\0<bodySource>\0<body text>"
// The source tag keeps e.g. a hashNorm from ever equalling a literal textNorm, and a function
// with nothing comparable gets a per-instance key so it can never merge with anything.
export function functionKey(fn, mode = "normalized", strictType = false, fallbackKey = "") {
  const b = bodyOf(fn, mode);
  return signature(fn, strictType) + "\0" + (b ? b.src + "\0" + b.body : "unkeyed\0" + fallbackKey);
}

export function identity(fn, mode = "normalized", strictType = false, fallbackKey = "") {
  return createHash("sha256").update(functionKey(fn, mode, strictType, fallbackKey)).digest("hex").slice(0, 24);
}

// How two functions are compared:
//   "string" (default) the keys themselves, compared character by character — no collision is
//            possible by construction, which is what the dedup claim in the thesis rests on
//   "hash"   sha256(key) truncated to 24 hex chars (96 bits) — compact, but two different
//            functions could in principle share an id (a collision would silently MERGE them)
// Both label a record with the same 24-char `id`; only the comparison differs. In "string" mode
// an id shared by two DIFFERENT keys is therefore a real collision: it is reported and refused
// instead of being merged away.
export const IDENTITY_MODES = ["hash", "string"];
export const shortId = (key) => createHash("sha256").update(key).digest("hex").slice(0, 24);

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

// ------------------------------------------------------------------ state (collect / merge / finalize)
//
// The reading half of step 05 is `collect()`, which returns a JSON-SERIALIZABLE state.
// `mergeStates()` folds several states into one and `finalize()` writes the output files.
// `dedup()` is still exactly finalize(collect(...)), so batch mode is unchanged; the
// streamed driver (06_stream-packages.mjs) instead calls collect() per package, saves the
// state as a partial, and 07_merge-partials.mjs merges + finalizes them.
//
// Maps/Sets are stored as arrays of entries so insertion order survives JSON (the order
// decides ties in the "most common raw variant", and the version_index key order).
// DEDUP_MODE / DEDUP_STRICT_TYPE are baked into a state (identity is computed in collect);
// TRIVIAL_NODES and NEAR_THRESHOLD are applied in finalize, so kept partials can be
// re-finalized with different values.

export const STATE_VERSION = 1;

export function emptyState({ mode = "normalized", strictType = false, identity: idMode = "string" } = {}) {
  return {
    stateVersion: STATE_VERSION, mode, strictType, identity: idMode,
    files: 0, firstFile: null, total: 0,
    pkgVersions: [], uniq: [], occ: [], rawVariants: [], rawText: [], parents: [], versionIndex: [],
    // "string" identity only: the exact comparison key behind each id, so partials can be
    // merged with the same character-by-character comparison and a collision across two
    // packages is still caught. Empty in "hash" mode.
    keys: [],
  };
}

// Read every <pkg>@<ver>.functions.json in `functionsDir` into a state.
// opts: { mode, strictType, log, allowEmpty }  (allowEmpty: no files -> empty state instead of throwing)
export function collect(functionsDir, opts = {}) {
  const { mode = "normalized", strictType = false, log = console.log, allowEmpty = false, identity: idMode = "string" } = opts;
  if (!IDENTITY_MODES.includes(idMode)) throw new Error(`identity must be ${IDENTITY_MODES.join(" or ")} (got ${idMode})`);
  const files = readdirSync(functionsDir).filter((f) => f.endsWith(".functions.json")).sort();
  if (!files.length) {
    if (allowEmpty) return emptyState({ mode, strictType, identity: idMode });
    throw new Error(`no *.functions.json files in ${functionsDir}  (run step 04 first)`);
  }

  const pkgVersions = new Map();     // pkg -> [ver]
  const uniq = new Map();            // fid -> record
  const occ = new Map();             // fid -> Map("pkg\0ver" -> [indices])
  const rawVariants = new Map();     // fid -> Map(rawKey -> count)
  const rawText = new Map();         // rawKey -> text
  const parents = new Map();         // fid -> Set(parent fid)
  const versionIndex = new Map();
  const keyById = new Map();         // id -> the exact key it stands for ("string" identity)
  let total = 0;

  // In "hash" mode the id IS the comparison: two functions are the same iff their truncated
  // hashes match. In "string" mode the keys are compared directly and the id is only a label,
  // so the same id arriving for a DIFFERENT key is a genuine collision, not a match.
  const idFor = idMode === "string"
    ? (key) => {
        const id = shortId(key);
        const seen = keyById.get(id);
        if (seen === undefined) keyById.set(id, key);
        else if (seen !== key) throw new Error(
          `id collision: two DIFFERENT functions hash to the same 24-char id ${id}. ` +
          `The string comparison kept them apart, but the ids would clash — widen the id before continuing.`);
        return id;
      }
    : (key) => shortId(key);

  for (const [n, file] of files.entries()) {
    const key = file.slice(0, -".functions.json".length);
    const at = key.lastIndexOf("@");
    if (at <= 0) { log(`skip (name not pkg@ver): ${file}`); continue; }
    const pkg = key.slice(0, at), ver = key.slice(at + 1);
    if (!pkgVersions.has(pkg)) pkgVersions.set(pkg, []);
    pkgVersions.get(pkg).push(ver);
    const fns = JSON.parse(readFileSync(join(functionsDir, file), "utf8")).functions || [];
    const fids = fns.map((fn, i) => idFor(functionKey(fn, mode, strictType, `${key}#${i}`)));
    versionIndex.set(key, fids);
    fns.forEach((fn, i) => {
      const fid = fids[i];
      total++;
      if (!uniq.has(fid)) {
        const metrics = fn.metrics || {};
        const b = bodyOf(fn, mode);
        uniq.set(fid, {
          id: fid, signature: signature(fn, strictType), type: fn.type, context: fn.context,
          params: fn.params, async: fn.async, generator: fn.generator, loc: fn.loc, metrics,
          strings: fn.strings, properties: fn.properties, globals: fn.globals,
          textNorm: fn.textNorm ?? null, keyedOn: b?.src ?? "none",
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

  return {
    stateVersion: STATE_VERSION, mode, strictType, identity: idMode,
    files: files.length, firstFile: files[0] ?? null, total,
    keys: [...keyById],
    pkgVersions: [...pkgVersions],
    uniq: [...uniq],
    occ: [...occ].map(([fid, m]) => [fid, [...m]]),
    rawVariants: [...rawVariants].map(([fid, m]) => [fid, [...m]]),
    rawText: [...rawText],
    parents: [...parents].map(([fid, s]) => [fid, [...s]]),
    versionIndex: [...versionIndex],
  };
}

// Fold states into one, in the order given. The FIRST state holding a function id wins
// for that record's first-seen fields — which is what batch mode does, because it reads
// files in sorted order and only fills a record the first time it sees the id. Callers
// must therefore pass the partials in ascending `firstFile` order (see 07_merge-partials).
export function mergeStates(states) {
  const list = states.filter(Boolean);
  if (!list.length) throw new Error("mergeStates: no states");
  const mode = list[0].mode, strictType = list[0].strictType;
  const idMode = list[0].identity ?? "hash";
  for (const s of list) {
    if (s.stateVersion !== STATE_VERSION) throw new Error(`partial has stateVersion ${s.stateVersion}, expected ${STATE_VERSION}`);
    if (s.mode !== mode || s.strictType !== strictType || (s.identity ?? "hash") !== idMode)
      throw new Error(`partials disagree on identity settings (mode=${s.mode}/${mode}, strictType=${s.strictType}/${strictType}, identity=${s.identity ?? "hash"}/${idMode}) — re-run the stream step with one setting`);
  }

  const pkgVersions = new Map(), uniq = new Map(), occ = new Map(), rawVariants = new Map();
  const rawText = new Map(), parents = new Map(), versionIndex = new Map();
  const keyById = new Map();
  let files = 0, total = 0;

  for (const s of list) {
    files += s.files; total += s.total;
    for (const [pkg, vers] of s.pkgVersions) {
      if (!pkgVersions.has(pkg)) pkgVersions.set(pkg, []);
      pkgVersions.get(pkg).push(...vers);
    }
    for (const [fid, rec] of s.uniq) if (!uniq.has(fid)) uniq.set(fid, rec); // first state wins
    for (const [fid, entries] of s.occ) {
      if (!occ.has(fid)) occ.set(fid, new Map());
      const m = occ.get(fid);
      for (const [k, idx] of entries) { if (!m.has(k)) m.set(k, []); m.get(k).push(...idx); }
    }
    for (const [fid, entries] of s.rawVariants) {
      if (!rawVariants.has(fid)) rawVariants.set(fid, new Map());
      const m = rawVariants.get(fid);
      for (const [rk, c] of entries) m.set(rk, (m.get(rk) || 0) + c); // sum, first-insertion order kept
    }
    for (const [rk, text] of s.rawText) if (!rawText.has(rk)) rawText.set(rk, text);
    for (const [fid, ps] of s.parents) {
      if (!parents.has(fid)) parents.set(fid, new Set());
      for (const p of ps) parents.get(fid).add(p);
    }
    for (const [key, fids] of s.versionIndex) versionIndex.set(key, fids);
    // "string" identity: the same id must stand for the same key in every partial, or two
    // different functions from two packages would be merged by their label alone
    for (const [id, key] of s.keys ?? []) {
      const seen = keyById.get(id);
      if (seen === undefined) keyById.set(id, key);
      else if (seen !== key) throw new Error(
        `id collision across packages: the 24-char id ${id} stands for two DIFFERENT functions. ` +
        `Widen the id before merging — the string comparison keeps them apart but their labels clash.`);
    }
  }

  return {
    stateVersion: STATE_VERSION, mode, strictType, identity: idMode,
    files, firstFile: list[0].firstFile, total,
    keys: [...keyById],
    pkgVersions: [...pkgVersions], uniq: [...uniq],
    occ: [...occ].map(([fid, m]) => [fid, [...m]]),
    rawVariants: [...rawVariants].map(([fid, m]) => [fid, [...m]]),
    rawText: [...rawText],
    parents: [...parents].map(([fid, s]) => [fid, [...s]]),
    versionIndex: [...versionIndex],
  };
}

// Turn a state into finished records: the most common raw text, occurrence and version
// counts, per-package version ranges and parents. Shared by finalize() (the merged output)
// and packageDocument() (one package's own JSON), so both describe a function identically.
export function deriveRecords(state, { trivialNodes = 6 } = {}) {
  const pkgVersions = new Map(state.pkgVersions.map(([p, v]) => [p, [...v]]));
  const occ = new Map(state.occ.map(([fid, e]) => [fid, new Map(e)]));
  const rawVariants = new Map(state.rawVariants.map(([fid, e]) => [fid, new Map(e)]));
  const rawText = new Map(state.rawText);
  const parents = new Map(state.parents.map(([fid, p]) => [fid, new Set(p)]));
  const versionIndex = Object.fromEntries(state.versionIndex);
  // clone the records: finalize adds derived fields and must stay re-runnable on the same state
  const uniq = new Map(state.uniq.map(([fid, rec]) => [fid, { ...rec, trivial: (rec.metrics?.nodes ?? 99) < trivialNodes }]));
  // identical to batch's count: batch counted the body source once per FIRST-SEEN function
  const bodySources = {};
  for (const u of uniq.values()) bodySources[u.keyedOn] = (bodySources[u.keyedOn] || 0) + 1;

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
  return { pkgVersions, occ, uniq, versionIndex, bodySources };
}

// One package's own function collection, as a single JSON object: every distinct function
// found across all its versions, with the same fields as unique_functions.jsonl, plus where it
// occurs (version -> indices) and which functions each version contains.
// `pkgKey` (e.g. "@scope+name") names the package even when no version yielded functions.
export function packageDocument(state, { trivialNodes = 6, settings = {}, pkgKey = null } = {}) {
  const { pkgVersions, occ, uniq, versionIndex } = deriveRecords(state, { trivialNodes });
  const pkgs = [...pkgVersions.keys()];
  if (pkgs.length > 1) throw new Error(`packageDocument needs a one-package state (got ${pkgs.length})`);
  const pkg = pkgs[0] ?? pkgKey;
  if (!pkg) throw new Error("packageDocument: empty state and no pkgKey");
  if (!pkgVersions.has(pkg)) pkgVersions.set(pkg, []);
  const order = [...uniq.values()].sort((a, b) => b.n_versions - a.n_versions || (a.id < b.id ? -1 : 1));
  const functions = order.map((u) => {
    const { packages, ...rest } = u;
    const mine = packages[pkg];
    const occurrences = {};
    for (const [k, idx] of [...occ.get(u.id)].sort((a, b) => cmpVersion(a[0].split("\0")[1], b[0].split("\0")[1]))) occurrences[k.split("\0")[1]] = idx;
    return { ...rest, first: mine.first, last: mine.last, ranges: mine.ranges, occurrences };
  });
  const byVersion = {};
  for (const v of pkgVersions.get(pkg)) byVersion[v] = versionIndex[`${pkg}@${v}`] ?? [];
  return {
    package: pkg.replace("+", "/"),
    versions: pkgVersions.get(pkg),
    settings: { dedup_mode: state.mode, strict_type: state.strictType, identity: state.identity ?? "hash", trivial_nodes: trivialNodes, ...settings },
    summary: {
      versions: pkgVersions.get(pkg).length,
      function_instances: state.total,
      unique_functions: functions.length,
      unique_non_trivial: functions.filter((f) => !f.trivial).length,
      in_one_version_only: functions.filter((f) => f.n_versions === 1).length,
    },
    functions,
    version_index: byVersion,
  };
}

// Write the step-05 output files from a state.
// opts: { trivialNodes, near, nearMinNodes, log, t0, extra }  (extra: fields merged into summary.json)
export function finalize(state, outDir, opts = {}) {
  const { trivialNodes = 6, near = null, nearMinNodes = 20, extra = null } = opts;
  const t0 = opts.t0 ?? Date.now();
  const mode = state.mode, strictType = state.strictType;
  const total = state.total;
  const { pkgVersions, occ, uniq, versionIndex, bodySources } = deriveRecords(state, { trivialNodes });

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
    mode, strictType, identity: state.identity ?? "hash", files: state.files,
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

  if (extra) Object.assign(summary, extra);
  summary.seconds = Math.round((Date.now() - t0) / 100) / 10;
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  return summary;
}

// ------------------------------------------------------------------ main (batch)
// Unchanged behaviour: read the whole functions dir, then write the outputs.
export function dedup(functionsDir, outDir, opts = {}) {
  const t0 = Date.now();
  return finalize(collect(functionsDir, opts), outDir, { ...opts, t0 });
}

// ------------------------------------------------------------------ CLI
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const args = process.argv.slice(2);
  const valued = new Set(["--mode", "--identity", "--trivial-nodes", "--near", "--near-min-nodes"]);
  const opt = (name, fb) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fb; };
  const positional = args.filter((a, i) => !a.startsWith("--") && !valued.has(args[i - 1]));
  const functionsDir = resolve(positional[0] ?? "extracted-functions");
  const outDir = resolve(positional[1] ?? "deduplicated-functions");
  const mode = opt("--mode", "normalized");
  if (!["normalized", "exact"].includes(mode)) { console.error(`--mode must be normalized or exact (got ${mode})`); process.exit(1); }
  const idMode = opt("--identity", process.env.DEDUP_IDENTITY ?? "string");
  if (!IDENTITY_MODES.includes(idMode)) { console.error(`--identity must be ${IDENTITY_MODES.join(" or ")} (got ${idMode})`); process.exit(1); }
  const nearRaw = opt("--near", "");
  const near = nearRaw === "" || Number(nearRaw) <= 0 ? null : Number(nearRaw);
  if (!existsSync(functionsDir)) { console.error(`Functions folder not found: ${functionsDir}  (run step 04 first)`); process.exit(1); }
  try {
    const s = dedup(functionsDir, outDir, {
      mode, strictType: args.includes("--strict-type"), identity: idMode,
      trivialNodes: Number(opt("--trivial-nodes", 6)), near, nearMinNodes: Number(opt("--near-min-nodes", 20)),
    });
    console.log(JSON.stringify(s, null, 2));
    console.log(`\nDone. ${s.function_instances} function instances -> ${s.unique_functions} unique (${s.dedup_ratio}x)  (see ${outDir})`);
  } catch (e) { console.error(String(e.message)); process.exit(1); }
}
