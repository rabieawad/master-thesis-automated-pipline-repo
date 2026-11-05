// Pure, deterministic version-sampling helpers for tier-2 step 01 (VERSIONS=sample).
// Extracted from 01_build-list.mjs so they can be unit-tested in isolation (the script
// itself runs a pipeline on import and can't be imported directly). No I/O, no network.

export const parseVer = (v) => { const [a, b, c] = v.split("-")[0].split("."); return { major: +a, minor: +b, patch: +c }; };
export const cmpVer = (a, b) => (a.major - b.major) || (a.minor - b.minor) || (a.patch - b.patch);
export const isStable = (v) => !v.includes("-");

// Turn a raw version list into sorted {v, p} entries, dropping prereleases and unparseable ones.
export const stableOf = (versions) => (versions || []).filter(isStable).map((v) => ({ v, p: parseVer(v) }))
  .filter(({ p }) => Number.isFinite(p.major) && Number.isFinite(p.minor) && Number.isFinite(p.patch));

// seeded RNG (reproducible per package)
export function mulberry32(a) { return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export function hashStr(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

export const SAMPLE_STRATEGIES = {
  // "minor-window" (default, simple): per major.minor line, pick ONE random anchor patch,
  // then keep a contiguous window of perMinorN patches next to it (anchor + neighbours,
  // clamped). So a line yields up to perMinorN + 1 versions.
  "minor-window"(stable, observedV, rng, opts = {}) {
    const perMinorN = opts.perMinorN ?? 4;
    const chosen = new Set();
    const groups = new Map();
    for (const s of stable) { const k = s.p.major + "." + s.p.minor; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); }
    const sortedGroups = [...groups.values()].sort((a, b) => a[0].p.major - b[0].p.major || a[0].p.minor - b[0].p.minor);
    for (const g of sortedGroups) {
      const total = Math.min(g.length, perMinorN + 1);
      const anchor = Math.floor(rng() * g.length);
      const start = Math.max(0, Math.min(anchor, g.length - total));
      for (let i = 0; i < total; i++) chosen.add(g[start + i].v);
    }
    return chosen;
  },

  // "minor-adjacent" (older): keep observed + adjacentN nearest neighbours, then per
  // major.minor group take up to perMinorN patches, 50/50 random vs contiguous.
  "minor-adjacent"(stable, observedV, rng, opts = {}) {
    const perMinorN = opts.perMinorN ?? 4;
    const adjacentN = opts.adjacentN ?? 4;
    const chosen = new Set();
    const idxOf = new Map(stable.map((s, i) => [s.v, i]));
    if (idxOf.has(observedV)) {
      const oi = idxOf.get(observedV);
      chosen.add(stable[oi].v);
      let left = oi - 1, right = oi + 1, added = 0;
      while (added < adjacentN && (left >= 0 || right < stable.length)) {
        if (left >= 0) { chosen.add(stable[left--].v); if (++added >= adjacentN) break; }
        if (right < stable.length) { chosen.add(stable[right++].v); added++; }
      }
    } else {
      chosen.add(observedV);
    }
    const groups = new Map();
    for (const s of stable) { const k = s.p.major + "." + s.p.minor; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); }
    const sortedGroups = [...groups.values()].sort((a, b) => a[0].p.major - b[0].p.major || a[0].p.minor - b[0].p.minor);
    for (const g of sortedGroups) {
      const K = Math.min(perMinorN, g.length);
      if (rng() < 0.5) {
        const idx = g.map((_, i) => i);
        for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
        for (let i = 0; i < K; i++) chosen.add(g[idx[i]].v);
      } else {
        const centre = Math.floor(rng() * g.length);
        const start = Math.max(0, Math.min(centre - Math.floor(K / 2), g.length - K));
        for (let i = 0; i < K; i++) chosen.add(g[start + i].v);
      }
    }
    return chosen;
  },
};

// The set of versions a sample run keeps for ONE anchor. `stable` is stableOf(...) output.
// <= threshold versions are taken whole; above that the seeded strategy runs. The observed
// version is always kept.
export function sampleKept(name, observedV, stable, { strategy = "minor-window", perMinorN = 4, adjacentN = 4, threshold = 50, seed = 42 } = {}) {
  if (!stable || stable.length === 0) return new Set([observedV]);
  if (stable.length <= threshold) return new Set(stable.map((s) => s.v));
  const strat = SAMPLE_STRATEGIES[strategy] ?? SAMPLE_STRATEGIES["minor-window"];
  const rng = mulberry32((seed >>> 0) ^ hashStr(name));
  const chosen = strat(stable, observedV, rng, { perMinorN, adjacentN });
  chosen.add(observedV); // observed always kept
  return chosen;
}

// How many versions a sample run keeps for one anchor at a given perMinorN (preview sweep).
export function keptCountForSample(name, observedV, stable, perMinorN, opts = {}) {
  if (!stable || stable.length === 0) return 1;
  if (stable.length <= (opts.threshold ?? 50)) return stable.length;
  const chosen = sampleKept(name, observedV, stable, { ...opts, perMinorN });
  // count = stable versions chosen, plus the observed one if it wasn't among the stable list
  const inStable = new Set(stable.map((s) => s.v));
  let n = 0; for (const v of chosen) if (inStable.has(v)) n++;
  return inStable.has(observedV) ? n : n + 1;
}
