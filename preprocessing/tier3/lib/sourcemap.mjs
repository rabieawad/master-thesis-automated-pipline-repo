// Tier 3: which package each bundle function came from, read from the bundle's source map.
// Used only for evaluation — a function-level ground truth next to the package-level SBOM.
//
// webpack (tier 1, devtool "source-map") keeps "./node_modules/<pkg>/…" in every source path;
// with pnpm the real path also names the version: ".pnpm/<name with + for />@<version>[_peers]/
// node_modules/<name>/…". A function's origin is the source of the mapping segment at (or just
// before) the function's first character.

const B64 = new Int8Array(128).fill(-1);
"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".split("").forEach((c, i) => { B64[c.charCodeAt(0)] = i; });

// mappings → per generated line, sorted [column, sourceIndex] pairs (segments without a source dropped)
export function decodeMappings(mappings) {
  const lines = [[]];
  let src = 0, col = 0, i = 0, field = 0, seg = [];
  const n = mappings.length;
  while (i < n) {
    const c = mappings.charCodeAt(i);
    if (c === 59 /* ; */ || c === 44 /* , */) {
      if (seg.length) { col += seg[0]; if (seg.length >= 4) { src += seg[1]; lines[lines.length - 1].push(col, src); } }
      seg = []; field = 0; i++;
      if (c === 59) { lines.push([]); col = 0; }
      continue;
    }
    let value = 0, shift = 0, cont;
    do {
      const d = B64[mappings.charCodeAt(i++)];
      if (d < 0) throw new Error("invalid source map mappings");
      cont = d & 32; value += (d & 31) << shift; shift += 5;
    } while (cont);
    seg.push(value & 1 ? -(value >>> 1) : value >>> 1);
    // fields 2–3 (original line/column) and 4 (name) are read but not needed
    field++;
  }
  if (seg.length) { col += seg[0]; if (seg.length >= 4) { src += seg[1]; lines[lines.length - 1].push(col, src); } }
  return lines;
}

// "webpack://holder/./node_modules/.pnpm/@a+b@1.2.3_x@1/node_modules/@a/b/dist/x.js"
//   → { name: "@a/b", version: "1.2.3", file: "dist/x.js" }; null outside node_modules
export function packageOfSource(path) {
  const parts = String(path).split("/");
  const last = parts.lastIndexOf("node_modules");
  if (last < 0 || last === parts.length - 1) return null;
  let name = parts[last + 1], rest = last + 2;
  if (name.startsWith("@") && parts[last + 2]) { name += "/" + parts[last + 2]; rest++; }
  let version = null;
  const pn = parts.indexOf(".pnpm");
  if (pn >= 0 && pn < last) {
    const dir = parts[pn + 1] ?? "", key = name.replace("/", "+") + "@";
    if (dir.startsWith(key)) version = dir.slice(key.length).split("_")[0].split("(")[0];
  }
  return { name, version, file: parts.slice(rest).join("/") };
}

// For every function of a tier-1 functions document: { name, version, file } or null (webpack
// runtime, the holder entry, or no mapping). `code` is the bundle text, `map` its parsed map.
export function attributeFunctions(code, map, functions) {
  const lines = decodeMappings(map.mappings ?? "");
  const lineStart = [0];
  for (let i = 0; i < code.length; i++) if (code.charCodeAt(i) === 10) lineStart.push(i + 1);
  const srcInfo = (map.sources ?? []).map((s) => packageOfSource((map.sourceRoot ?? "") + s));
  const out = new Map();
  for (const fn of functions) {
    const off = fn.start;
    if (typeof off !== "number") { out.set(fn.index, null); continue; }
    let lo = 0, hi = lineStart.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStart[mid] <= off) lo = mid; else hi = mid - 1; }
    const segs = lines[lo] ?? [], col = off - lineStart[lo];
    // last segment with column ≤ col (segments are pairs [column, source])
    let a = 0, b = segs.length / 2 - 1, hit = -1;
    while (a <= b) { const m = (a + b) >> 1; if (segs[2 * m] <= col) { hit = m; a = m + 1; } else b = m - 1; }
    out.set(fn.index, hit < 0 ? null : srcInfo[segs[2 * hit + 1]] ?? null);
  }
  return out;
}
