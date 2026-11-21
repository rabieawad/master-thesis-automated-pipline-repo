// Tier 3: which packages, and which versions of them, are inside a bundle — decided from the
// bundle's functions and the tier-2 reference index. Not part of Aletheia or Debun.
//
// 1. MATCH every non-trivial bundle function
//      exact   its tier-2 fingerprint (signature + normalized code) is in the reference
//      approx  MinHash/LSH candidates whose estimated similarity is ≥ minSim — the bundle is
//              minified by Terser (webpack), the reference by swc, so the same source can come
//              out slightly different
// 2. WEIGH each match: evidence e(f, p) = similarity × specificity(f) × size(f)
//      specificity  1 − log(k)/log(P): k = packages the function matches, P = packages indexed
//                   (a helper found in 50 packages proves little, one found in 1 proves a lot);
//                   a function found in more than maxShared packages (Babel/TS helpers, the
//                   webpack runtime of prebuilt builds) gives no evidence at all
//      size         min(1, tokens/40): tiny functions match by chance
// 3. PACKAGES, greedily ("explaining away"). Coverage of p = the share of p's non-trivial
//    functions (at its best version) that the bundle matches, counted as distinct reference
//    functions. A package is accepted when it has
//      ≥ minEvidence from ≥ minFunctions not-yet-explained functions and coverage ≥ minCoverage,
//      or (small packages) coverage ≥ smallCoverage with ≥ smallEvidence,
//      or (code shared with a package chosen before it, e.g. a UMD build that holds its
//      dependencies) the same, counting functions the earlier package explains no better than
//      p, with coverage ≥ shareCoverage.
//    Among accepted packages the next is the one with the highest evidence × coverage^orderPower
//    (practically: coverage first — a prebuilt mega-bundle that contains copies of many
//    libraries covers a small share of itself, the libraries cover a large share); it explains
//    the functions it matches within explainDelta of their best match.
// 4. VERSIONS of each package, from the functions that are its own (the ones it matches about as
//    well as any found package does, and no other found package matches as well). Each of them is
//    consistent with a set of versions: those of the record it matches exactly; for an approximate
//    match those of the records within supportDelta of its best, or (lineage mode) of the lineage
//    variant whose markers the bundle's code has (see tier2/lib/lineage.mjs).
//      intersect (default)  the intersection of the sets: one version = exact, several = a range,
//                           the newest as the guess; when the functions contradict, the versions
//                           consistent with the most functions (or, versionFallback "union", all of
//                           them), with the conflicting functions listed
//      vote                 score(v) = Σ evidence of the functions consistent with v; the range is
//                           every version within versionTolerance of the best score
//
// Three modes are computed from the same matches, for comparison:
//    exact           exact matches only
//    approx          exact + approximate
//    approx+lineage  exact + approximate, with lineage markers refining approximate matches

import { identity } from "../../tier2/05_dedup-functions.mjs";
import { markerSpace, hasMarker } from "../../tier2/lib/lineage.mjs";
import { sketch, similarity } from "./sketch.mjs";
import { rangeIndices, inRanges } from "./index.mjs";
import { canonicalRequire } from "./modules.mjs";
import semver from "semver";

export const MODES = ["exact", "approx", "approx+lineage"];
export const DEFAULTS = {
  minSim: 0.5,            // approximate match threshold (estimated Jaccard of 3-token shingles)
  minBands: 2,            // LSH: a candidate must share ≥ 2 of the 21 bands (4× faster; lost 0.03 % of the matches on the test bed)
  simPower: 1,            // evidence grows with similarity^simPower
  minEvidence: 1.5,       // a package needs at least this much unexplained evidence…
  minFunctions: 2,        // …from at least this many functions
  explainDelta: 0.05,     // a chosen package explains functions it matches within this of their best match
  versionTolerance: 0.03, // versions within 3 % of the best score form the range
  bestDelta: 0.02,        // records within this of a function's best similarity in a package all count
  minLineageAgree: 0.75,  // lineage markers are used when the best variants agree with ≥ 75 % of them
  shareCoverage: 0.5,     // a package whose functions another explains equally well is still found at this coverage
  maxShared: 30,          // functions matching more packages than this give no evidence (they can still be explained)
  orderPower: 8,          // the next package is the one with the highest evidence × coverage^orderPower
  versionVotes: "near",   // which functions vote for a package's version (near | own | split | mine | all, see below)
  supportDelta: 0.05,     // an approximate match supports the versions of records within this of its best (sketch noise)
  contestedWeight: 0,     // the version vote of a function another chosen package matches as well
  versionMethod: "intersect", // intersect | vote (see the version step below)
  versionFallback: "most",  // intersect, when the functions contradict: most | union
  versionPick: "latest",  // how the reported version is picked inside the range (latest | parsimony)
  minCoverage: 0.05,      // a package must explain ≥ 5 % of its own functions (at its best version)…
  strongEvidence: Infinity, // …unless its evidence is this strong (off: it brought in prebuilt mega-bundles)
  smallCoverage: 0.5,     // a small package is accepted when the bundle covers ≥ 50 % of it…
  smallEvidence: 0.5,     // …with at least this much evidence
  // the package decision (step 3):
  //   greedy       packages are accepted one after another and each explains (takes) the functions it
  //                matches, which later packages can no longer use
  //   independent  every package is judged on its own, on every function it matches about as well as
  //                that function's best match (within explainDelta): a function found in several
  //                packages counts for each of them, none takes it from another
  algorithm: "greedy",
  nearDelta: 0.05,        // independent: a function counts for p when p matches it within this of its best match
                          // (1 = every match ≥ minSim counts: the package's own reference can match its code
                          // worse than a prebuilt copy does, because the copy was minified like the bundle)
  // size-aware requirement: a package needs a share of the evidence it could ever give, instead of a
  // fixed minEvidence. potential(p, v) = Σ over p's non-trivial functions at version v of
  // specificity × size (a function in more than maxShared packages gives 0). Required evidence =
  // max(sizeFloor, min(minEvidence, sizeShare × potential)); required functions = min(minFunctions,
  // half the package's function count, at least 1). Small or helper-like packages need little, large ones minEvidence.
  sizeAware: false,
  sizeShare: 0.5,
  sizeFloor: 0.15,
  // stub versions: a version with fewer non-trivial functions than minVersionShare × the package's
  // median version is not used for coverage (placeholder releases such as @clerk/ui 0.0.1, four
  // functions of webpack runtime, which any webpack bundle "covers"). 0 = off.
  minVersionShare: 0,
  // dependency confirmation (needs the index's dependencies.json, step 01b): after the decision, a
  // package that a found package declares as a dependency is accepted with depMinFunctions distinct
  // functions it matches (exact, or within depNear of the function's best match and ≥ minSim) —
  // repeated, so dependencies of dependencies follow (qs → side-channel → get-intrinsic → gopd)
  depConfirm: false,
  depNear: 0.15,
  depMinFunctions: 1,
  depMinExact: 1,
  depKinds: "dependencies,optionalDependencies", // which declared kinds count (peerDependencies are often not installed)
  depFromConfirmed: false, // follow the dependencies of packages accepted through a dependency too
  depEmbedded: 0.5,       // skip a dependency when more than this share of its matched code is also in the parent's reference (1 = off)
  // declared ranges narrow versions: a found package that other found packages declare as a dependency
  // (at their reported version) keeps only the versions of its range that satisfy one of the declared
  // semver ranges; "override" also replaces a range that satisfies none (the code points elsewhere,
  // e.g. when the reference lacks the newer code). off | restrict | override
  depRanges: "off",
  // ownership: of the packages that match a function about as well as its best match, the ones that
  // only hold a COPY of it get copyWeight of its evidence. q holds a copy when another candidate r is
  // a declared dependency of q (any version), or — without a dependency either way — q's median
  // version is ownSizeRatio × larger than r's (a prebuilt build holding a small library).
  // a package must have ≥ minUnique of its matched functions near-best ONLY for it (found in no other
  // package's reference about as well — a package declaring it as a dependency holds a copy and does
  // not count): a package that merely holds copies has none. 0 = off.
  minUnique: 0,
  minExact: 0,            // a package needs ≥ minExact exactly matched functions (approximate look-alikes alone don't count)…
  exactUnlessCoverage: 0.3, // …unless its approximate matches cover at least this share of it
  ownership: false,
  copyWeight: 0,
  ownSizeRatio: 5,
};

// The bundle's functions, prepared for matching: fingerprint as tier 2 computes it, sketch.
export function prepareBundle(doc, tier2Settings = {}, canon = false) {
  const mode = tier2Settings.dedup_mode ?? "normalized", strict = !!tier2Settings.strict_type, trivialNodes = tier2Settings.trivial_nodes ?? 6;
  const out = [];
  for (const fn of doc.functions ?? []) {
    const code = fn.textNorm ?? fn.text;
    if (code == null) continue;
    if ((fn.metrics?.nodes ?? 99) < trivialNodes) continue; // trivial: no evidence
    // the index made require(...) canonical (step 01 --canonical-require): the same here
    if (canon && code.includes("require(")) {
      const c = canonicalRequire(code);
      const { sig, ntok } = sketch(c);
      out.push({ k: fn.index, id: identity({ ...fn, textNorm: c }, mode, strict), code: c, sig, ntok, propName: fn.propName ?? null });
      continue;
    }
    const { sig, ntok } = sketch(code);
    out.push({ k: fn.index, id: identity(fn, mode, strict), code, sig, ntok, propName: fn.propName ?? null });
  }
  return out;
}

// Match every bundle function against the index: for each, per package, the best similarity
// and the records within bestDelta of it.
export function matchBundle(ix, fns, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  for (const f of fns) {
    const exact = ix.byId.get(f.id) ?? [];
    const byPkg = new Map(), exactPkgs = new Set();
    const put = (i, sim, isExact) => {
      const p = ix.rec.pkg[i];
      let e = byPkg.get(p); if (!e) { e = { best: 0, cand: [] }; byPkg.set(p, e); }
      e.cand.push([i, sim, isExact]); if (sim > e.best) e.best = sim;
    };
    for (const i of exact) { put(i, 1, true); exactPkgs.add(ix.rec.pkg[i]); }
    const seen = new Set(exact);
    for (const i of ix.lsh.candidates(f.sig, o.minBands)) {
      if (seen.has(i)) continue;
      const sim = similarity(f.sig, ix.sigOf(i));
      if (sim >= o.minSim) put(i, sim, false);
    }
    for (const e of byPkg.values()) e.recs = e.cand.filter(([, s]) => s >= e.best - o.bestDelta);
    f.byPkg = byPkg; f.exactPkgs = exactPkgs;
    f.bestSim = Math.max(0, ...[...byPkg.values()].map((e) => e.best));
  }
  return fns;
}

// potential(p)[v]: the evidence package p could give at version v if all its non-trivial functions
// were in the bundle (exact matches): Σ specificity(packages sharing the function) × size
function potential(ix, p, o) {
  ix._potential ??= new Map();
  let a = ix._potential.get(p);
  if (a) return a;
  const pkg = ix.meta.packages[p]; a = new Float64Array(pkg.versions.length);
  for (let i = pkg.start; i < pkg.end; i++) {
    const k = ix.pkgsOfId.get(ix.rec.id[i]) ?? 1;
    const w = k > o.maxShared ? 0 : specificity(k, ix.P) * sizeWeight(ix.rec.ntok[i]);
    if (w > 0) for (const v of rangeIndices(ix.rec.versions[i])) a[v] += w;
  }
  ix._potential.set(p, a);
  return a;
}

// does package `from` declare package `to` as a dependency, directly or through up to `depth` levels?
export function dependsOn(ix, from, to, depth = 3) {
  if (!ix.deps?.size || from == null || to == null) return false;
  let frontier = new Set([from]); const seen = new Set([from]);
  for (let d = 0; d < depth && frontier.size; d++) {
    const next = new Set();
    for (const x of frontier) for (const y of depsAny(ix, x)) { if (y === to) return true; if (!seen.has(y)) { seen.add(y); next.add(y); } }
    frontier = next;
  }
  return false;
}
// any-version dependency set of a package (from the index's dependencies.json)
function depsAny(ix, p) {
  ix._depsAny ??= new Map();
  let s = ix._depsAny.get(p);
  if (!s) { s = new Set(); for (const e of ix.deps?.get(p)?.values() ?? []) for (const [k, l] of Object.entries(e)) if (k !== "ranges") for (const d of l) s.add(d); ix._depsAny.set(p, s); }
  return s;
}
// which of the near-best packages of a function only hold a copy of it (see DEFAULTS.ownership)
function copyHolders(ix, view, o) {
  const top = Math.max(...[...view.values()].map((e) => e.best));
  const cand = [...view].filter(([, e]) => e.best >= top - o.explainDelta).map(([p]) => p);
  if (cand.length < 2) return null;
  const out = new Set();
  for (const q of cand) for (const r of cand) {
    if (q === r) continue;
    const qr = depsAny(ix, q).has(r), rq = depsAny(ix, r).has(q);
    if (qr && !rq) { out.add(q); break; }
    if (!qr && !rq && medianSize(ix.meta.packages[q]) >= o.ownSizeRatio * Math.max(1, medianSize(ix.meta.packages[r]))) { out.add(q); break; }
  }
  return out.size < cand.length ? out : null; // never everyone
}

// the median non-trivial function count of a package's versions (versions with none left out)
function medianSize(pkg) {
  if (pkg._median == null) { const a = pkg.nonTrivial.filter((x) => x > 0).sort((x, y) => x - y); pkg._median = a.length ? a[a.length >> 1] : 0; }
  return pkg._median;
}

const specificity = (k, P) => (k <= 1 ? 1 : Math.max(0, 1 - Math.log(k) / Math.log(Math.max(P, 2))));
const sizeWeight = (ntok) => Math.min(1, ntok / 40);

// The matches a mode may use: exact mode keeps only exact matches; the approximate modes keep
// matches with similarity ≥ minSim (matching may have used a lower threshold).
function viewFor(f, mode, o) {
  const m = new Map();
  for (const [p, e] of f.byPkg) {
    if (mode === "exact") { const recs = e.recs.filter((r) => r[2]); if (recs.length) m.set(p, { best: 1, recs, exact: true }); continue; }
    if (e.best < o.minSim) continue;
    m.set(p, { best: e.best, recs: e.recs, exact: e.recs.some((r) => r[2]) });
  }
  return m;
}

// Lineage refinement: which variants of the record's lineage the bundle code is, by markers.
function lineageVersions(ix, p, recIndex, code, o, cache) {
  const lin = ix.rec.lineage[recIndex]; if (!lin) return null;
  const L = ix.lineagesOf(p)[lin]; if (!L || !L.m.length) return null;
  let space = cache.get(code); if (!space) { space = markerSpace(code); cache.set(code, space); }
  const seen = L.m.map(([c]) => hasMarker(space, c));
  let best = -1, bestVars = [];
  for (const [vid, vers] of L.v) {
    let agree = 0; L.m.forEach(([, vs], k) => { if (vs.includes(vid) === seen[k]) agree++; });
    const a = agree / L.m.length;
    if (a > best + 1e-9) { best = a; bestVars = [vers]; } else if (Math.abs(a - best) < 1e-9) bestVars.push(vers);
  }
  if (best < o.minLineageAgree) return null;
  const s = new Set(); for (const vers of bestVars) for (const i of rangeIndices(vers)) s.add(i);
  return s;
}

// Decide packages and versions for one mode.
export function infer(ix, fns, mode, opts = {}) {
  const o = { ...DEFAULTS, ...opts }, P = ix.P;
  const views = fns.map((f) => viewFor(f, mode, o));
  const ev = fns.map((f, k) => {
    const v = views[k], m = new Map();
    const spec = specificity(v.size, P), size = sizeWeight(f.ntok);
    const common = v.size > o.maxShared; // a helper found in many packages (Babel/TS helpers, webpack runtime)
    const copies = o.ownership && !common && v.size > 1 ? copyHolders(ix, v, o) : null;
    for (const [p, e] of v) m.set(p, common ? 0 : e.best ** o.simPower * spec * size * (copies?.has(p) ? o.copyWeight : 1));
    return m;
  });
  const bestOf = views.map((v) => Math.max(0, ...[...v.values()].map((e) => e.best)));
  // ---- packages, greedily, coverage first ----
  // A package that is really in the bundle explains a large share of its own code (coverage =
  // matched functions / its non-trivial functions at its best version); a package whose
  // reference merely contains copies of other libraries (a prebuilt mega-bundle) explains a
  // tiny share. So the next package is the one with the highest coverage among those with
  // enough evidence; it then explains the functions it matches (within explainDelta of their
  // best match), which the remaining packages can no longer use.
  const chosen = [];
  const pkgFns = new Map(); views.forEach((v, k) => { for (const p of v.keys()) { if (!pkgFns.has(p)) pkgFns.set(p, []); pkgFns.get(p).push(k); } });
  // coverage(p, ks): the best, over p's versions v, of the share of p's non-trivial functions
  // at v that the bundle functions ks match — counted as distinct reference functions, each
  // weighted by how well it is matched, so many bundle copies of one helper count once.
  const coverage = (p, ks) => {
    const pkg = ix.meta.packages[p], recBest = new Map();
    for (const k of ks) for (const [i, sim] of views[k].get(p).recs) if (!(recBest.get(i) >= sim)) recBest.set(i, mode === "exact" ? 1 : sim);
    const cnt = new Float64Array(pkg.versions.length);
    for (const [i, sim] of recBest) for (const v of rangeIndices(ix.rec.versions[i])) cnt[v] += sim;
    const floor = o.minVersionShare > 0 ? o.minVersionShare * medianSize(pkg) : 0;
    let best = 0, nt = 0, bv = 0; for (let v = 0; v < cnt.length; v++) if (pkg.nonTrivial[v] > 0 && pkg.nonTrivial[v] >= floor) { const c = Math.min(1, cnt[v] / pkg.nonTrivial[v]); if (c > best) { best = c; nt = pkg.nonTrivial[v]; bv = v; } }
    return { c: best, nt, v: bv };
  };
  // Is p, with these not-yet-explained functions, in the bundle?
  //   big enough:  evidence ≥ minEvidence from ≥ minFunctions functions, and coverage ≥ minCoverage
  //                — or evidence ≥ strongEvidence (packages whose reference holds several builds,
  //                such as react-dom, cover a small share however much of them is bundled)
  //   small:       coverage ≥ smallCoverage with evidence ≥ smallEvidence — a package with three
  //                functions cannot reach minEvidence, but the bundle can contain most of them
  const accepts = (p, open, g) => {
    if (!open.length) return null;
    let fewExact = false;
    if (o.minExact > 0 && mode !== "exact") { let x = 0; for (const k of open) if (views[k].get(p).exact && ++x >= o.minExact) break; fewExact = x < o.minExact; }
    if (o.minUnique > 0) {
      let u = 0;
      for (const k of open) { let only = true; for (const [q, e] of views[k]) if (q !== p && e.best >= bestOf[k] - o.explainDelta && !depsAny(ix, q).has(p)) { only = false; break; } if (only && ++u >= o.minUnique) break; }
      if (u < o.minUnique) return null;
    }
    const { c, nt, v } = coverage(p, open);
    if (fewExact && c < o.exactUnlessCoverage) return null; // approximate look-alikes covering little of the package
    // size-aware: the evidence needed is a share of what the package could ever give
    const needEv = o.sizeAware ? Math.max(o.sizeFloor, Math.min(o.minEvidence, o.sizeShare * potential(ix, p, o)[v])) : o.minEvidence;
    const needFns = o.sizeAware ? Math.min(o.minFunctions, Math.max(1, Math.ceil(nt / 2))) : o.minFunctions;
    const big = g >= needEv && open.length >= needFns && (c >= o.minCoverage || g >= o.strongEvidence);
    const small = c >= o.smallCoverage && g >= o.smallEvidence && open.length >= Math.min(o.minFunctions, Math.ceil(nt / 2));
    return big || small ? c : null;
  };
  const explainedSim = new Map(); // explained function -> how well its explaining package matches it
  const candidate = (p, ks) => {
    const open = ks.filter((k) => !explainedSim.has(k) && ev[k].get(p) > 0);
    let g = 0; for (const k of open) g += ev[k].get(p);
    const c = accepts(p, open, g);
    if (c != null) return { p, g, n: open.length, c, shared: 0 };
    // shared code: a package whose functions an earlier package explains just as well (that
    // package's reference holds a copy of them, as algoliasearch's UMD build holds its clients)
    // is still found when the bundle covers it well
    if (!(o.shareCoverage <= 1)) return null;
    const shared = ks.filter((k) => explainedSim.has(k) && ev[k].get(p) > 0 && views[k].get(p).best >= explainedSim.get(k) - 1e-9);
    if (!shared.length) return null;
    const all = open.concat(shared); let g2 = g; for (const k of shared) g2 += ev[k].get(p);
    const c2 = accepts(p, all, g2);
    return c2 != null && c2 >= o.shareCoverage ? { p, g: g2, n: all.length, c: c2, shared: shared.length, shares: shared } : null;
  };
  if (o.algorithm === "independent") {
    // every package on its own: all functions it matches about as well as their best match count
    for (const [p, ks] of pkgFns) {
      const mine = ks.filter((k) => ev[k].get(p) > 0 && views[k].get(p).best >= bestOf[k] - o.nearDelta);
      let g = 0; for (const k of mine) g += ev[k].get(p);
      const c = accepts(p, mine, g);
      if (c == null) continue;
      const sharedK = mine.filter((k) => [...views[k]].some(([q, e]) => q !== p && e.best >= bestOf[k] - o.nearDelta));
      chosen.push({ p, gain: g, own: mine.length, coverage: c, shared: sharedK.length, explains: mine, shares: [], rank: g * c ** o.orderPower });
    }
    chosen.sort((a, b) => b.rank - a.rank);
  } else for (;;) {
    let pick = null;
    for (const [p, ks] of pkgFns) {
      if (chosen.some((c) => c.p === p)) continue;
      const cand = candidate(p, ks);
      if (!cand) continue;
      cand.rank = cand.g * cand.c ** o.orderPower;
      if (!pick || cand.rank > pick.rank + 1e-9 || (Math.abs(cand.rank - pick.rank) <= 1e-9 && cand.g > pick.g)) pick = cand;
    }
    if (!pick) {
      if (o.trace) {
        o.trace.length = 0;
        for (const [p, ks] of pkgFns) {
          if (chosen.some((c) => c.p === p)) continue;
          const open = ks.filter((k) => !explainedSim.has(k) && ev[k].get(p) > 0);
          let g = 0; for (const k of open) g += ev[k].get(p);
          o.trace.push({ name: ix.meta.packages[p].name, matched: ks.length, open: open.length, evidence: Math.round(g * 100) / 100, coverage: open.length ? Math.round(coverage(p, open).c * 1000) / 1000 : 0, coverageAll: Math.round(coverage(p, ks).c * 1000) / 1000 });
        }
      }
      break;
    }
    const explains = [];
    for (const k of pkgFns.get(pick.p)) {
      const b = views[k].get(pick.p).best;
      if (!explainedSim.has(k) && b >= bestOf[k] - o.explainDelta) { explainedSim.set(k, b); explains.push(k); }
    }
    chosen.push({ p: pick.p, gain: pick.g, own: pick.n, coverage: pick.c, shared: pick.shared, explains, shares: pick.shares ?? [] });
  }
  // ---- versions of each chosen package ----
  const lineCache = new Map();
  const describe = ({ p, gain, own, coverage: cov, shared, explains, shares, viaDependency }) => {
    const pkg = ix.meta.packages[p], nv = pkg.versions.length;
    const score = new Float64Array(nv); let total = 0, nf = 0, nExact = 0, nLineage = 0;
    // which bundle functions vote for p's version:
    //   own   the functions p explains or shares, minus those another chosen package matches at
    //         least as well (code that moved between packages: side-channel ≤ 1.1.0 held what is
    //         now side-channel-list) — unless that would leave none
    //   all   every function that matches p, also those other packages explain (a dependency
    //         bundled inside an old prebuilt build of p then pulls p to that old version)
    let voters = pkgFns.get(p);
    const share = new Map(); // function -> share of its vote (split: 1 / the chosen packages matching it as well)
    if (o.versionVotes !== "all") {
      const mine = [...explains, ...shares];
      const others = chosen.filter((c) => c.p !== p).map((c) => c.p);
      const rivals = (k) => { const b = views[k].get(p).best; return others.filter((q) => (views[k].get(q)?.best ?? -1) >= b - 1e-9).length; };
      if (o.versionVotes === "own") { const clear = mine.filter((k) => rivals(k) === 0); voters = clear.length ? clear : mine.length ? mine : voters; }
      else if (o.versionVotes === "split") { voters = mine.length ? mine : voters; for (const k of voters) share.set(k, 1 / (1 + rivals(k))); }
      else if (o.versionVotes === "near") {
        // every function p matches about as well as the best package does, whoever explains it;
        // its vote split among the chosen packages that match it as well
        // (best among the CHOSEN packages: a package not in the bundle — @clerk/clerk-js holds a
        // copy of qs that resembles webpack's output more than tier 2's qs does — takes no vote)
        const top = (k) => Math.max(...chosen.map((c) => views[k].get(c.p)?.best ?? -1));
        const near = (k, q) => (views[k].get(q)?.best ?? -1) >= top(k) - o.explainDelta;
        voters = voters.filter((k) => near(k, p) && ev[k].get(p) > 0);
        // a function another chosen package matches as well is contested: it may be that
        // package's code (quill 1.x's prebuilt build held eventemitter3) and votes with
        // contestedWeight (0 by default) — unless every voter is contested, then it is split
        const rivalsOf = new Map(voters.map((k) => { const b = views[k].get(p).best; return [k, others.filter((q) => (views[k].get(q)?.best ?? -1) >= b - 1e-9).length]; }));
        const allContested = voters.every((k) => rivalsOf.get(k) > 0);
        for (const k of voters) { const r = rivalsOf.get(k); share.set(k, r === 0 ? 1 : allContested ? 1 / (1 + r) : o.contestedWeight / r); }
      }
      else voters = mine.length ? mine : voters; // "mine"
    }
    // never no vote at all: then every function that matches p votes
    if (!voters.some((k) => ev[k].get(p) * (share.get(k) ?? 1) > 0)) { voters = pkgFns.get(p); share.clear(); }
    const sets = []; // per function: the versions it is consistent with
    for (const k of voters) {
      const e = views[k].get(p), w = ev[k].get(p) * (share.get(k) ?? 1); if (!(w > 0)) continue;
      let sup = null, viaLineage = false;
      if (mode === "approx+lineage" && !e.exact) { sup = lineageVersions(ix, p, e.recs[0][0], fns[k].code, o, lineCache); if (sup) { nLineage++; viaLineage = true; } }
      if (!sup) {
        // an approximate match supports the versions of every record within supportDelta of its
        // best one: the nearest variant by sketch is not reliably the right version
        sup = new Set();
        const recs = e.exact || !(o.supportDelta > o.bestDelta) ? e.recs : (fns[k].byPkg.get(p).cand ?? e.recs).filter(([, sim]) => sim >= e.best - o.supportDelta);
        for (const [i] of recs) for (const v of rangeIndices(ix.rec.versions[i])) sup.add(v);
      }
      for (const v of sup) score[v] += w;
      sets.push({ k, sup, exact: e.exact, sim: e.best });
      total += w; nf++; if (e.exact) nExact++;
      if (o.votes) { if (!o.votes.has(pkg.name)) o.votes.set(pkg.name, []); o.votes.get(pkg.name).push({ k: fns[k].k, w, exact: e.exact, sim: e.best, lineage: viaLineage, sup: [...sup].sort((a, b) => a - b), recs: e.recs.map(([i]) => i), mine: explains.includes(k) || shares.includes(k) }); }
    }
    let max = 0; for (const s of score) if (s > max) max = s;
    let inRange = []; for (let v = 0; v < nv; v++) if (max > 0 && score[v] >= max * (1 - o.versionTolerance)) inRange.push(v);
    // the pick inside the range:
    //   latest     the highest score; among equal scores the newest version — a bundle usually
    //              holds only part of a package, so functions a version has and the bundle lacks
    //              prove nothing, and package managers install the newest version that fits
    //   parsimony  the version with the fewest of its own range-distinguishing functions missing
    //              from the bundle (biased to old versions when the bundle holds part of a package)
    let best = inRange[0];
    if (inRange.length > 1 && o.versionPick === "parsimony") {
      const miss = new Map(inRange.map((v) => [v, 0]));
      for (let i = pkg.start; i < pkg.end; i++) {
        const vr = ix.rec.versions[i]; let c = 0; for (const v of inRange) if (inRanges(vr, v)) c++;
        if (c > 0 && c < inRange.length) for (const v of inRange) if (inRanges(vr, v)) miss.set(v, miss.get(v) + 1);
      }
      best = inRange.reduce((a, b) => (miss.get(b) < miss.get(a) || (miss.get(b) === miss.get(a) && score[b] > score[a]) ? b : a));
    } else if (inRange.length > 1) {
      const eps = max * 1e-9;
      best = inRange.reduce((a, b) => (score[b] > score[a] + eps || Math.abs(score[b] - score[a]) <= eps ? b : a));
    }
    // versionMethod "intersect" (the default): no scores. Every function of the package is
    // consistent with a set of versions — those of the record it matches exactly, or of the lineage
    // variant its markers point to, or of the records an approximate match is close to — and the
    // package's versions are the INTERSECTION of those sets: one version = the exact version,
    // several = the range (the newest is the guess). When the functions contradict each other (the
    // intersection is empty), versionFallback decides:
    //   most   the versions consistent with the most functions; the others are listed as conflicts
    //   union  every function's versions together
    // Either way the union is reported too (unionRange).
    let consistent = null, conflicts = [], unionRange = null;
    if (o.versionMethod === "intersect" && sets.length) {
      const count = new Map(); for (const st of sets) for (const v of st.sup) count.set(v, (count.get(v) ?? 0) + 1);
      const cmax = Math.max(...count.values());
      consistent = cmax === sets.length;
      const union = [...count.keys()].sort((a, b) => a - b);
      inRange = consistent || o.versionFallback !== "union" ? union.filter((v) => count.get(v) === cmax) : union;
      best = consistent || o.versionFallback !== "union" ? inRange[inRange.length - 1] : inRange.reduce((a, b) => (count.get(b) >= count.get(a) ? b : a));
      conflicts = sets.filter((st) => !st.sup.has(best)).map((st) => st.k);
      if (!consistent) unionRange = union;
    }
    const toRanges = (vs) => { const out = []; for (const v of vs) { const r = out[out.length - 1]; if (r && r[2] === v - 1) { r[1] = pkg.versions[v]; r[2] = v; } else out.push([pkg.versions[v], pkg.versions[v], v]); } return out.map(([a, b]) => [a, b]); };
    const ranges = toRanges(inRange);
    return {
      name: pkg.name, best: best == null ? null : pkg.versions[best], range: ranges, rangeSize: inRange.length,
      versionsIndexed: nv, evidence: Math.round(gain * 100) / 100, coverage: Math.round(cov * 1000) / 1000, ownFunctions: own, sharedFunctions: shared, functions: nf, exactFunctions: nExact,
      lineageFunctions: nLineage, confidence: total ? Math.round((score[best] / total) * 1000) / 1000 : 0,
      ...(consistent == null ? {} : { consistent, conflictFunctions: conflicts.map((k) => fns[k].k), ...(unionRange ? { unionRange: toRanges(unionRange), unionSize: unionRange.length } : {}) }),
      explains: explains.map((k) => fns[k].k), // the bundle functions (their index in the functions file) this package explains
      shares: shares.map((k) => fns[k].k),     // …and those it shares with a package chosen before it (same code in both references)
      ...(viaDependency ? { viaDependency } : {}), // accepted as a declared dependency of this package
    };
  };
  const results = chosen.map(describe);
  // ---- dependency confirmation ----
  // a package that a found package declares as a dependency (at the found versions) is accepted
  // with depMinFunctions distinct functions it matches (within depNear of their best match, ≥
  // minSim), depMinExact of them exact — repeated, so dependencies of dependencies follow
  if (o.depConfirm && ix.deps?.size) {
    const kinds = String(o.depKinds).split(",").map((x) => x.trim()).filter(Boolean);
    for (let i = 0; i < results.length; i++) {
      if (chosen[i].viaDependency && !o.depFromConfirmed) continue;
      const pi = chosen[i].p, perVersion = ix.deps.get(pi); if (!perVersion) continue;
      const vs = ix.meta.packages[pi].versions, r = results[i], want = new Set();
      for (const [a, b] of r.range) { const x = vs.indexOf(a), y = vs.indexOf(b); for (let v = x; v <= y && x >= 0; v++) { const e = perVersion.get(vs[v]) ?? {}; for (const kd of kinds) for (const d of e[kd] ?? []) want.add(d); } }
      for (const d of want) {
        if (chosen.some((c) => c.p === d)) continue;
        const ks = (pkgFns.get(d) ?? []).filter((k) => ev[k].get(d) > 0 && views[k].get(d).best >= Math.max(o.minSim, bestOf[k] - o.depNear));
        if (new Set(ks.map((k) => fns[k].id)).size < o.depMinFunctions) continue;
        if (new Set(ks.filter((k) => views[k].get(d).exact).map((k) => fns[k].id)).size < o.depMinExact) continue;
        // embedded: the parent's own reference holds most of this code (a prebuilt build with its
        // dependencies compiled in) — then the dependency is not a separate package in the bundle
        if (o.depEmbedded < 1 && ks.filter((k) => (views[k].get(pi)?.best ?? -1) >= bestOf[k] - o.depNear).length > o.depEmbedded * ks.length) continue;
        let g = 0; for (const k of ks) g += ev[k].get(d);
        const entry = { p: d, gain: g, own: ks.length, coverage: coverage(d, ks).c, shared: ks.length, explains: [], shares: ks, viaDependency: ix.meta.packages[pi].name };
        chosen.push(entry); results.push(describe(entry));
      }
    }
  }
  if (o.depRanges !== "off" && ix.deps?.size) narrowByDeclaredRanges(ix, chosen, results, o);
  return results;
}

function narrowByDeclaredRanges(ix, chosen, results, o) {
  const at = new Map(chosen.map((c, i) => [c.p, results[i]]));
  for (let i = 0; i < results.length; i++) {
    const p = chosen[i].p, r = results[i], pkg = ix.meta.packages[p];
    const wanted = [];
    for (const [q, rq] of at) {
      if (q === p || !rq.best) continue;
      // every version still possible for the parent: the ranges any of them declares
      const qv = ix.meta.packages[q].versions;
      for (const [a, b] of rq.range) { const x = qv.indexOf(a), y = qv.indexOf(b); for (let v = x; v <= y && x >= 0; v++) {
        const range = ix.deps.get(q)?.get(qv[v])?.ranges?.get(p);
        if (range && !wanted.includes(range) && semver.validRange(range)) wanted.push(range);
      } }
    }
    if (!wanted.length) continue;
    const ok = pkg.versions.map((v) => wanted.some((w) => semver.valid(v) && semver.satisfies(v, w, { includePrerelease: false })));
    if (!ok.some(Boolean)) continue;
    const vs = pkg.versions, cur = new Set(); for (const [a, b] of r.range) { const x = vs.indexOf(a), y = vs.indexOf(b); for (let v = x; v <= y && x >= 0; v++) cur.add(v); }
    let keep = [...cur].filter((v) => ok[v]).sort((a, b) => a - b);
    if (!keep.length) { if (o.depRanges !== "override") continue; keep = ok.map((x, v) => (x ? v : -1)).filter((v) => v >= 0); }
    const ranges = []; for (const v of keep) { const last = ranges[ranges.length - 1]; if (last && last[2] === v - 1) { last[1] = vs[v]; last[2] = v; } else ranges.push([vs[v], vs[v], v]); }
    r.declaredRanges = wanted; r.rangeBeforeDeclared = r.range;
    r.range = ranges.map(([a, b]) => [a, b]); r.rangeSize = keep.length; r.best = vs[keep[keep.length - 1]];
  }
}

// Everything for one bundle: prepare, match, infer in every mode.
export function detectBundle(ix, doc, opts = {}) {
  const fns = matchBundle(ix, prepareBundle(doc, ix.meta.tier2_settings, !!ix.meta.canonical_require), opts);
  const stats = {
    functions: doc.functions?.length ?? 0, nonTrivial: fns.length,
    exactMatched: fns.filter((f) => f.exactPkgs.size).length,
    approxMatched: fns.filter((f) => !f.exactPkgs.size && f.byPkg.size).length,
    unmatched: fns.filter((f) => !f.byPkg.size).length,
  };
  return { stats, modes: Object.fromEntries(MODES.map((m) => [m, infer(ix, fns, m, opts)])) };
}
