// Code sketches for approximate matching: MinHash signatures of a function's normalized code,
// and locality-sensitive hashing (LSH) to find similar functions without comparing all pairs.
//
// A function is turned into its set of SHINGLES: every run of K consecutive tokens of textNorm,
// with local names (v0, v1, …) masked to "v". Two functions' Jaccard similarity
// |A ∩ B| / |A ∪ B| is estimated from small fixed-size signatures:
//   * one-permutation MinHash (OPH): each shingle hash goes to one of BINS bins by its top bits,
//     each bin keeps its minimum; empty bins are filled by rotation densification
//     (Shrivastava 2017), so every signature has BINS values;
//   * the share of equal bins between two signatures estimates their Jaccard similarity.
// LSH: the signature is cut into BANDS bands of ROWS values; two functions become candidates
// if any band is identical. With 21 bands of 3 rows a pair with similarity 0.5 is found with
// probability 1 − (1 − 0.5³)²¹ ≈ 0.94, 0.4 with ≈ 0.75, 0.3 with ≈ 0.44.

import { tokens, mask } from "../../tier2/lib/lineage.mjs";

export const BINS = 64, BANDS = 21, ROWS = 3, SHINGLE = 3;
const EMPTY = 0xffffffff;

// 32-bit FNV-1a, finished with murmur3's fmix32 for good bit mixing
function hash32(str, seed = 0x811c9dc5) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0; h ^= h >>> 16;
  return h >>> 0;
}
const mix = (x) => { x = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0; x = Math.imul(x ^ (x >>> 15), 0x846ca68b) >>> 0; return (x ^ (x >>> 16)) >>> 0; };

export const maskedTokens = (code) => tokens(code).map(mask);

export function shingles(masked, k = SHINGLE) {
  if (masked.length <= k) return [masked.join(" ")];
  const out = new Set();
  for (let i = 0; i + k <= masked.length; i++) out.add(masked.slice(i, i + k).join(" "));
  return [...out];
}

// OPH signature (Uint32Array of BINS values) of a list of shingles
export function signature(sh, bins = BINS) {
  const sig = new Uint32Array(bins).fill(EMPTY);
  const shift = 32 - Math.log2(bins);
  for (const s of sh) {
    const h = hash32(s), b = h >>> shift, v = mix(h);
    if (v < sig[b]) sig[b] = v;
  }
  // rotation densification: an empty bin takes the value of the next non-empty bin to the
  // right (circularly), offset by the distance, so empty bins agree only when the sets do
  if (sig.every((v) => v === EMPTY)) return sig.fill(0);
  for (let b = 0; b < bins; b++) {
    if (sig[b] !== EMPTY) continue;
    let j = (b + 1) % bins, d = 1;
    while (sig[j] === EMPTY) { j = (j + 1) % bins; d++; }
    sig[b] = mix(sig[j] + d * 0x9e3779b1);
  }
  return sig;
}

export const sketch = (code) => { const m = maskedTokens(code); return { sig: signature(shingles(m)), ntok: m.length }; };

// estimated Jaccard similarity of two signatures (a and b may be views into larger arrays)
export function similarity(a, b) {
  let eq = 0; for (let i = 0; i < a.length; i++) if (a[i] === b[i]) eq++;
  return eq / a.length;
}

// the LSH band keys of a signature (one 32-bit key per band)
export function bandKeys(sig) {
  const out = new Uint32Array(BANDS);
  for (let b = 0; b < BANDS; b++) {
    let h = 0x9747b28c ^ b;
    for (let r = 0; r < ROWS; r++) h = mix((h ^ sig[b * ROWS + r]) >>> 0);
    out[b] = h;
  }
  return out;
}

// An LSH table over many signatures stored back to back in one Uint32Array.
export class LSH {
  constructor() { this.tables = Array.from({ length: BANDS }, () => new Map()); this.n = 0; }
  add(i, sig) {
    const keys = bandKeys(sig);
    for (let b = 0; b < BANDS; b++) { const t = this.tables[b], k = keys[b]; const l = t.get(k); if (l) l.push(i); else t.set(k, [i]); }
    if (i >= this.n) this.n = i + 1;
  }
  // records that share at least minBands bands with sig (a record with similarity s shares a
  // band with probability s^ROWS; requiring 2 bands cuts the candidates of generic code by
  // two thirds and, on the test bed, loses 0.03 % of the matches ≥ 0.5)
  candidates(sig, minBands = 1) {
    const keys = bandKeys(sig);
    if (minBands <= 1) {
      const out = new Set();
      for (let b = 0; b < BANDS; b++) { const l = this.tables[b].get(keys[b]); if (l) for (const i of l) out.add(i); }
      return out;
    }
    if (!this.count || this.count.length < this.n) { this.count = new Uint8Array(this.n); this.touched = new Int32Array(1024); }
    const count = this.count; let touched = this.touched, nt = 0;
    for (let b = 0; b < BANDS; b++) {
      const l = this.tables[b].get(keys[b]); if (!l) continue;
      for (let j = 0; j < l.length; j++) {
        const i = l[j];
        if (count[i]++ === 0) { if (nt === touched.length) { const t = new Int32Array(nt * 2); t.set(touched); touched = this.touched = t; } touched[nt++] = i; }
      }
    }
    const out = [];
    for (let j = 0; j < nt; j++) { const i = touched[j]; if (count[i] >= minBands) out.push(i); count[i] = 0; }
    return out;
  }
}
