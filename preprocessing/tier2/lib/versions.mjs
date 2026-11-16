// Pure version helpers for tier-2 step 01 (no I/O, no network), kept separate so they can be
// unit-tested — the step script itself runs on import.
// (This file replaces lib/sampling.mjs: the seeded version-sampling strategies were removed,
//  because tier 2 now streams one package at a time and always considers every version.)

export const parseVer = (v) => { const [a, b, c] = v.split("-")[0].split("."); return { major: +a, minor: +b, patch: +c }; };
export const cmpVer = (a, b) => (a.major - b.major) || (a.minor - b.minor) || (a.patch - b.patch);
export const isStable = (v) => !v.includes("-");

// Turn a raw version list into sorted {v, p} entries, dropping prereleases and unparseable ones.
export const stableOf = (versions) => (versions || []).filter(isStable).map((v) => ({ v, p: parseVer(v) }))
  .filter(({ p }) => Number.isFinite(p.major) && Number.isFinite(p.minor) && Number.isFinite(p.patch));
