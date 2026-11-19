// Function lineages: the history of every function of a package across its versions, and the
// code markers that tell its variants apart. Not part of Aletheia or Debun — an addition of
// this thesis, meant for version detection later.
//
// Input: one package document (05_deduplicated_functions/packages/<pkg>.json). It holds each
// function's normalized code (textNorm), its features and its positions in every version
// (occurrences), so nothing is downloaded or extracted again.
//
// 1. LINKING, for each pair of consecutive versions A → B
//    * functions in both A and B are anchors (like unchanged lines in `diff`)
//    * "gone" = only in A, "new" = only in B; an edited function is one gone + one new
//    * a gone and a new function are compared only between the same or neighbouring anchors
//    * score = 0.7 · token-bigram similarity of textNorm + 0.3 · overlap of strings, property
//      names and globals; one-to-one, best first, score ≥ minSimilarity
//    * trivial functions take part only with includeTrivial (they look alike)
//    A lineage is tagged with the id of the variant that appeared first.
//
// 2. EVENTS of a lineage, in version order: born · edited · reverted (back to an earlier
//    variant) · removed (absent from a version on) · reappeared (back after a gap).
//    An edit carries its kind and its changes (token diff of textNorm, v0/v1/… numbering
//    ignored): added · removed · replaced · mixed (a combination) · variables_only · too_large.
//
// 3. MARKERS: every change of every edit proposes small pieces of normalized code, with a few
//    tokens of context, e.g. "getDerivedStateFromError : ! 0 ,":
//      added code → the new code          removed code → the old code
//      replaced  → the old and the new    and, for a pure addition or removal, the old/new
//                                          adjacency ("this is what it looked like without it")
//    Each candidate is then TESTED on every variant of the lineage, so a marker always states
//    a checked fact: present in these variants (= these versions), absent in those.
//
// 4. IDENTIFICATION: for each variant, the fewest markers (contains / lacks) that tell it
//    apart from every sibling; when none can (e.g. the same code once numbering is ignored),
//    the variant is marked not unique and the siblings it cannot be told from are listed.
//
// Matching later: matchVariants(lineage, code) tests every marker on any function's
// normalized code and returns the variants (and versions) consistent with all of them.

const TOKEN = /[A-Za-z_$][\w$]*|\d[\w.]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\S/g;
export const tokens = (s) => (s ?? "").match(TOKEN) ?? [];
export const mask = (t) => (/^v\d+$/.test(t) ? "v" : t); // local names: the numbering is not code
// a function's code as markers are tested on it: masked tokens, space separated, padded
export const markerSpace = (code) => " " + tokens(code).map(mask).join(" ") + " ";
export const hasMarker = (space, markerCode) => space.includes(" " + markerCode + " ");
const isWordy = (t) => /^[A-Za-z_$]/.test(t) && t !== "v" || /^["'`\d]/.test(t);

export const DEFAULTS = { minSimilarity: 0.5, includeTrivial: false, maxDiffTokens: 4000, context: 3, maxContext: 8, maxRule: 3 };

function bigrams(t) {
  const m = new Map();
  for (let i = 0; i + 1 < t.length; i++) { const k = t[i] + "\u0001" + t[i + 1]; m.set(k, (m.get(k) ?? 0) + 1); }
  return m;
}
function dice(a, b) {
  let inter = 0, na = 0, nb = 0;
  for (const v of a.values()) na += v;
  for (const v of b.values()) nb += v;
  for (const [k, v] of a) inter += Math.min(v, b.get(k) ?? 0);
  return na + nb ? (2 * inter) / (na + nb) : 1;
}
function jaccard(a = [], b = []) {
  const A = new Set(a), B = new Set(b);
  if (!A.size && !B.size) return 1;
  let i = 0; for (const x of A) if (B.has(x)) i++;
  return i / (A.size + B.size - i);
}

// Token diff of two masked token arrays. Hunks hold index ranges: A[a0,a1) removed, B[b0,b1) added.
export function diffTokens(A, B, maxDiffTokens = DEFAULTS.maxDiffTokens) {
  const n = A.length, m = B.length;
  if (n > maxDiffTokens || m > maxDiffTokens) return null;
  // trim the common start and end first: most edits are small, the table stays small
  let s = 0; while (s < n && s < m && A[s] === B[s]) s++;
  let e = 0; while (e < n - s && e < m - s && A[n - 1 - e] === B[m - 1 - e]) e++;
  const N = n - s - e, M = m - s - e;
  const dp = Array.from({ length: N + 1 }, () => new Uint16Array(M + 1));
  for (let i = N - 1; i >= 0; i--) for (let j = M - 1; j >= 0; j--) dp[i][j] = A[s + i] === B[s + j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const hunks = []; let i = 0, j = 0, cur = null;
  while (i < N || j < M) {
    if (i < N && j < M && A[s + i] === B[s + j]) { if (cur) { hunks.push(cur); cur = null; } i++; j++; continue; }
    if (!cur) cur = { a0: s + i, a1: s + i, b0: s + j, b1: s + j };
    if (j >= M || (i < N && dp[i + 1][j] >= dp[i][j + 1])) { i++; cur.a1 = s + i; } else { j++; cur.b1 = s + j; }
  }
  if (cur) hunks.push(cur);
  return hunks;
}

// what kind of edit a list of hunks is: one kind, or a combination
export function editKind(hunks) {
  if (hunks == null) return { kind: "too_large", parts: null };
  const parts = { added: 0, removed: 0, replaced: 0 };
  for (const h of hunks) {
    if (h.a1 > h.a0 && h.b1 > h.b0) parts.replaced++;
    else if (h.b1 > h.b0) parts.added++;
    else parts.removed++;
  }
  const present = Object.entries(parts).filter(([, k]) => k > 0).map(([k]) => k);
  return { kind: present.length === 0 ? "variables_only" : present.length === 1 ? present[0] : "mixed", parts };
}

// versions (indices into doc.versions) -> [[first, last], …] runs
function toRanges(idx, versions) {
  const s = [...idx].sort((a, b) => a - b), out = [];
  for (const i of s) { const last = out.at(-1); if (last && last[2] === i - 1) { last[1] = versions[i]; last[2] = i; } else out.push([versions[i], versions[i], i]); }
  return out.map(([a, b]) => [a, b]);
}

export function analyzePackage(doc, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const V = doc.versions, vIndex = new Map(V.map((v, i) => [v, i]));
  const byId = new Map(doc.functions.map((f) => [f.id, f]));
  // per function: masked tokens, original tokens, marker space, versions it is in
  const T = new Map();
  const info = (id) => {
    let x = T.get(id);
    if (!x) { const f = byId.get(id), raw = tokens(f.textNorm ?? f.text); const masked = raw.map(mask); x = { raw, masked, space: " " + masked.join(" ") + " ", big: bigrams(masked) }; T.set(id, x); }
    return x;
  };
  const verOf = new Map(doc.functions.map((f) => [f.id, new Set(Object.keys(f.occurrences ?? {}).map((v) => vIndex.get(v)).filter((i) => i != null))]));
  const born = (id) => Math.min(...verOf.get(id));
  const eligible = (id) => o.includeTrivial || !byId.get(id).trivial;

  // ordered sequence of function ids in each version
  const seq = V.map(() => []);
  for (const f of doc.functions) for (const [v, pos] of Object.entries(f.occurrences ?? {})) { const i = vIndex.get(v); if (i != null) for (const p of pos) seq[i].push([p, f.id]); }
  for (let i = 0; i < V.length; i++) seq[i] = [...new Set(seq[i].sort((a, b) => a[0] - b[0]).map((x) => x[1]))];

  // ---- 1. links ----
  const parent = new Map();
  const root = (x) => { while (parent.has(x)) x = parent.get(x); return x; };
  const links = [];
  for (let k = 0; k + 1 < V.length; k++) {
    const A = seq[k], B = seq[k + 1], inA = new Set(A), inB = new Set(B);
    const anchorBefore = (S, other) => { const r = new Map(); let last = "^"; for (const id of S) { if (other.has(id)) last = id; else r.set(id, last); } return r; };
    const gone = anchorBefore(A, inB), fresh = anchorBefore(B, inA);
    const order = new Map(["^", ...A.filter((id) => inB.has(id))].map((a, i) => [a, i]));
    const cand = [];
    for (const [g, ag] of gone) {
      if (!eligible(g)) continue;
      const fg = byId.get(g);
      for (const [n, an] of fresh) {
        if (!eligible(n) || Math.abs(order.get(ag) - order.get(an)) > 1) continue;
        const fn = byId.get(n);
        const s = 0.7 * dice(info(g).big, info(n).big) + 0.3 * ((jaccard(fg.strings, fn.strings) + jaccard(fg.properties, fn.properties) + jaccard(fg.globals, fn.globals)) / 3);
        if (s >= o.minSimilarity) cand.push([s, g, n]);
      }
    }
    cand.sort((x, y) => y[0] - x[0] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : x[2] < y[2] ? -1 : 1));
    const usedG = new Set(), usedN = new Set();
    for (const [s, g, n] of cand) {
      if (usedG.has(g) || usedN.has(n)) continue;
      usedG.add(g); usedN.add(n);
      const rg = root(g), rn = root(n);
      if (rg !== rn) { if (born(rn) < born(rg) || (born(rn) === born(rg) && rn < rg)) parent.set(rg, rn); else parent.set(rn, rg); }
      links.push({ from: g, to: n, k, similarity: Math.round(s * 1000) / 1000 });
    }
  }

  // ---- group into lineages ----
  const members = new Map();
  for (const f of doc.functions) { const r = root(f.id); if (!members.has(r)) members.set(r, []); members.get(r).push(f.id); }
  const linksOf = new Map();
  for (const l of links) { const r = root(l.from); if (!linksOf.has(r)) linksOf.set(r, []); linksOf.get(r).push(l); }

  // inverted index token -> function ids, to count where a marker also occurs outside its lineage
  // Where a marker also occurs outside its lineage — counted only for markers used in a rule.
  // Indexes: token -> functions (for a cheap rarity score), token pair -> functions (to test
  // only functions holding the marker's two rarest pairs; same answer, much faster).
  let tokPost = null, pairPost = null;
  const tokPostings = () => { if (!tokPost) { tokPost = new Map(); for (const f of doc.functions) for (const t of new Set(info(f.id).masked)) { if (!tokPost.has(t)) tokPost.set(t, new Set()); tokPost.get(t).add(f.id); } } return tokPost; };
  const rarity = (code) => { const P = tokPostings(); let r = Infinity; for (const t of code.split(" ")) if (isWordy(t)) r = Math.min(r, P.get(t)?.size ?? 0); return r; };
  const pairs = (toks) => { const out = new Set(); for (let i = 0; i + 1 < toks.length; i++) out.add(toks[i] + " " + toks[i + 1]); return out; };
  const elsewhere = (code, lin) => {
    if (!pairPost) { pairPost = new Map(); for (const f of doc.functions) for (const pr of pairs(info(f.id).masked)) { if (!pairPost.has(pr)) pairPost.set(pr, []); pairPost.get(pr).push(f.id); } }
    const lists = [...pairs(code.split(" "))].map((pr) => pairPost.get(pr) ?? []).sort((a, b) => a.length - b.length);
    const second = lists[1] ? new Set(lists[1]) : null, mine = new Set(members.get(lin));
    let c = 0;
    for (const id of lists[0] ?? []) if (!mine.has(id) && (!second || second.has(id)) && hasMarker(info(id).space, code)) c++;
    return c;
  };

  const lineages = [], index = {};
  const counts = { lineages: 0, edited_lineages: 0, events: { born: 0, edited: 0, reverted: 0, removed: 0, reappeared: 0 },
    edit_kinds: { added: 0, removed: 0, replaced: 0, mixed: 0, variables_only: 0, too_large: 0 },
    variants_in_edited_lineages: 0, variants_unique: 0, markers: 0 };
  for (const [lin, ids] of members) {
    counts.lineages++;
    for (const id of ids) index[id] = lin;
    const present = new Set(); for (const id of ids) for (const i of verOf.get(id)) present.add(i);
    const variants = ids.map((id) => ({ id, versions: toRanges(verOf.get(id), V) }))
      .sort((a, b) => born(a.id) - born(b.id) || (a.id < b.id ? -1 : 1));
    const first = Math.min(...present), last = Math.max(...present);
    const entry = { lineage: lin, born: V[first], last_seen: V[last], status: last === V.length - 1 ? "alive" : "removed", variants };

    // ---- 2. events ----
    const events = [{ version: V[first], type: "born", ids: ids.filter((id) => verOf.get(id).has(first)) }];
    for (let i = first + 1; i <= last; i++) {
      if (present.has(i) && !present.has(i - 1)) events.push({ version: V[i], type: "reappeared", ids: ids.filter((id) => verOf.get(id).has(i)) });
      if (!present.has(i) && present.has(i - 1)) events.push({ version: V[i], type: "removed" });
    }
    if (last < V.length - 1) events.push({ version: V[last + 1], type: "removed" });
    const ls = (linksOf.get(lin) ?? []).sort((a, b) => a.k - b.k || (a.to < b.to ? -1 : 1));
    const candidates = new Map(); // marker code -> origin
    for (const l of ls) {
      const A = info(l.from), B = info(l.to), hunks = diffTokens(A.masked, B.masked, o.maxDiffTokens);
      const { kind, parts } = editKind(hunks);
      const reverted = born(l.to) < l.k + 1; // the "new" variant existed before: back to an earlier one
      const changes = [];
      for (const h of hunks ?? []) {
        const type = h.a1 > h.a0 && h.b1 > h.b0 ? "replaced" : h.b1 > h.b0 ? "added" : "removed";
        changes.push({ type, ...(h.a1 > h.a0 ? { before: A.raw.slice(h.a0, h.a1).join(" ") } : {}), ...(h.b1 > h.b0 ? { after: B.raw.slice(h.b0, h.b1).join(" ") } : {}),
          context: A.raw.slice(Math.max(0, h.a0 - o.context), h.a0).join(" ") });
        // ---- 3. marker candidates, with enough context to be specific and checked on A and B ----
        const propose = (src, x0, x1, other, origin) => {
          for (let c = o.context; c <= o.maxContext; c++) {
            const code = src.slice(Math.max(0, x0 - c), Math.min(src.length, x1 + c)).join(" ");
            const toks = code.split(" ");
            if (toks.length < 3 || !toks.some(isWordy)) continue;
            const inSrc = true, inOther = hasMarker(other.space, code);
            if (inSrc && !inOther) { if (!candidates.has(code)) candidates.set(code, origin); return; }
          }
        };
        const at = V[l.k + 1];
        if (h.a1 > h.a0) propose(A.masked, h.a0, h.a1, B, { change: type === "replaced" ? "replaced (old code)" : "removed", version: at });
        if (h.b1 > h.b0) propose(B.masked, h.b0, h.b1, A, { change: type === "replaced" ? "replaced (new code)" : "added", version: at });
        if (h.a1 === h.a0) propose(A.masked, h.a0, h.a0, B, { change: "absent before the addition", version: at });
        if (h.b1 === h.b0) propose(B.masked, h.b0, h.b0, A, { change: "absent after the removal", version: at });
      }
      counts.edit_kinds[kind]++; counts.events[reverted ? "reverted" : "edited"]++;
      events.push({ version: V[l.k + 1], type: reverted ? "reverted" : "edited", from: l.from, to: l.to, similarity: l.similarity, kind, parts,
        tokens_added: hunks ? hunks.reduce((t, h) => t + h.b1 - h.b0, 0) : null, tokens_removed: hunks ? hunks.reduce((t, h) => t + h.a1 - h.a0, 0) : null,
        changes: hunks ? changes : null });
    }
    events.sort((a, b) => vIndex.get(a.version) - vIndex.get(b.version) || ["born", "reappeared", "edited", "reverted", "removed"].indexOf(a.type) - ["born", "reappeared", "edited", "reverted", "removed"].indexOf(b.type));
    for (const e of events) if (e.type === "born" || e.type === "removed" || e.type === "reappeared") counts.events[e.type]++;
    entry.events = events;

    if (ids.length > 1) {
      counts.edited_lineages++; counts.variants_in_edited_lineages += ids.length;
      // test every candidate on every variant: keep facts that split the variants
      const markers = [];
      for (const [code, origin] of candidates) {
        const inV = ids.filter((id) => hasMarker(info(id).space, code));
        if (inV.length === 0 || inV.length === ids.length) continue;
        const pres = new Set(); for (const id of inV) for (const i of verOf.get(id)) pres.add(i);
        const abs = [...present].filter((i) => !pres.has(i));
        markers.push({ code, origin, variants: inV, present: toRanges(pres, V), absent: toRanges(abs, V) });
      }
      for (const m of markers) m.rarity = rarity(m.code);
      // ---- 4. the fewest markers that tell each variant apart ----
      const bit = (m, id) => m.variants.includes(id);
      const identify = {};
      for (const v of ids) {
        let rest = ids.filter((w) => w !== v); const contains = [], lacks = [];
        while (rest.length && contains.length + lacks.length < o.maxRule) {
          let best = null, bestN = 0;
          for (const m of markers) {
            const n = rest.filter((w) => bit(m, w) !== bit(m, v)).length;
            // most siblings told apart; on a tie the marker with the rarest word, then the shortest
            if (n > bestN || (n === bestN && n > 0 && (m.rarity < best.rarity || (m.rarity === best.rarity && m.code.length < best.code.length)))) { best = m; bestN = n; }
          }
          if (!best) break;
          (bit(best, v) ? contains : lacks).push(best.code);
          rest = rest.filter((w) => bit(best, w) === bit(best, v));
        }
        const same = rest.filter((w) => info(w).space === info(v).space);
        const r = { versions: variants.find((x) => x.id === v).versions, contains, lacks, unique: rest.length === 0 };
        if (rest.length) {
          const all = new Set(verOf.get(v)); for (const w of rest) for (const i of verOf.get(w)) all.add(i);
          Object.assign(r, { also_matches: rest, versions_if_matched: toRanges(all, V),
            why: same.length === rest.length ? "same code as its siblings once the v0/v1/… numbering is ignored" : `needs more than ${o.maxRule} markers, or the edit was too large to diff` });
        } else counts.variants_unique++;
        identify[v] = r;
      }
      // in how many other functions of the package a rule's marker also occurs
      const used = new Set(Object.values(identify).flatMap((r) => [...r.contains, ...r.lacks]));
      for (const m of markers) { if (used.has(m.code)) { m.in_rule = true; m.elsewhere = elsewhere(m.code, lin); } delete m.rarity; }
      counts.markers += markers.length;
      entry.markers = markers; entry.identify = identify;
    }
    lineages.push(entry);
  }
  lineages.sort((a, b) => vIndex.get(a.born) - vIndex.get(b.born) || (a.lineage < b.lineage ? -1 : 1));
  return { lineages, index, summary: counts };
}

// For matching later: which variants of a lineage (and so which versions) are consistent with
// a function's normalized code (textNorm), judged by every marker of the lineage.
//   exact   variants that agree with every marker
//   ranked  every variant with the share of markers it agrees with, best first — for code
//           that is close but not identical (another minifier, a patch release not indexed)
export function matchVariants(lineage, code) {
  const all = lineage.variants;
  if (!lineage.markers?.length) return { exact: all.map((v) => v.id), versions: all.flatMap((v) => v.versions), ranked: all.map((v) => ({ id: v.id, agree: 1 })) };
  const space = markerSpace(code), seen = lineage.markers.map((m) => hasMarker(space, m.code));
  const ranked = all.map((v) => ({ id: v.id, versions: v.versions, agree: lineage.markers.filter((m, i) => m.variants.includes(v.id) === seen[i]).length / lineage.markers.length }))
    .sort((a, b) => b.agree - a.agree);
  const exact = ranked.filter((r) => r.agree === 1);
  return { exact: exact.map((r) => r.id), versions: exact.flatMap((r) => r.versions), ranked: ranked.map(({ id, agree }) => ({ id, agree: Math.round(agree * 1000) / 1000 })) };
}
