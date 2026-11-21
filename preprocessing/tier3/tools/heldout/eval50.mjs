import fs from "node:fs";
const keep = JSON.parse(fs.readFileSync("/tmp/fresh/heldout50.json")); const K = new Map(keep.map((k) => [k.key, k]));
// packages seen before: anything in the earlier references or earlier SBOMs (= the exclusion list of select.mjs, minus nothing)
const seen = new Set();
for (const f of ["/tmp/t2x-ix/meta.json"]) JSON.parse(fs.readFileSync(f)).packages.forEach((p) => seen.add(p.name));
for (const dir of ["/tmp/t3/D3/sbom", "/tmp/pilot/tier1/output/05_selected_bundles/sbom"]) for (const f of fs.readdirSync(dir)) { const s = JSON.parse(fs.readFileSync(`${dir}/${f}`)); for (const c of [s.metadata.component, ...(s.components || [])]) seen.add(c.group ? `${c.group}/${c.name}` : c.name); }
const meta = JSON.parse(fs.readFileSync("/tmp/fresh/t3/01_index/meta.json"));
const med = new Map(meta.packages.map((p) => { const a = p.nonTrivial.filter((x) => x > 0).sort((x, y) => x - y); return [p.name, a.length ? a[a.length >> 1] : 0]; }));
const mode = "approx+lineage", rows = [];
for (const f of fs.readdirSync("/tmp/fresh/t3/02_detections/bundles")) {
  const j = JSON.parse(fs.readFileSync(`/tmp/fresh/t3/02_detections/bundles/${f}`)); if (!K.has(j.bundle)) continue;
  for (const r of j.modes[mode].evaluation.rows) rows.push({ ...r, bundle: j.bundle, cat: K.get(j.bundle).category, bsize: K.get(j.bundle).size, seen: seen.has(r.name), med: med.get(r.name) ?? 0 });
}
const score = (R, label) => {
  const tp = R.filter((r) => r.status === "TP").length, fp = R.filter((r) => r.status === "FP").length, fn = R.filter((r) => r.status === "FN").length;
  const fpc = R.filter((r) => r.status === "FP" && /^(vendored|embedded|compiled into)/.test(r.reason || "")).length;
  const V = R.filter((r) => r.status === "TP" && r.versionIndexed), ve = V.filter((r) => r.exact).length, vi = V.filter((r) => r.inRange).length;
  const P = tp / (tp + fp), Rc = tp / (tp + fn), Pc = (tp + fpc) / (tp + fp), F = (p) => (2 * p * Rc) / (p + Rc);
  console.log(`${label.padEnd(34)} n ${String(tp + fn).padStart(3)} | P ${P.toFixed(3)} R ${Rc.toFixed(3)} F1 ${F(P).toFixed(3)} | code-present F1 ${F(Pc).toFixed(3)} | wrong ${fp} | versions exact ${(ve / V.length).toFixed(3)} in range ${(vi / V.length).toFixed(3)}`);
};
score(rows, "ALL 50 bundles");
score(rows.filter((r) => r.root), "  bundle's own package (root)");
score(rows.filter((r) => !r.root), "  dependencies");
score(rows.filter((r) => !r.seen), "  never seen before");
score(rows.filter((r) => r.seen), "  seen before (shared deps)");
for (const N of [50, 200]) score(rows.filter((r) => r.med >= N), `  large packages (median ≥ ${N} fns)`);
for (const s of ["small", "medium", "large"]) score(rows.filter((r) => r.bsize === s), `  ${s} bundles`);
const reasons = (st) => { const m = {}; rows.filter((r) => r.status === st).forEach((r) => { const k = (r.reason || "-").replace(/ (inside|as|by|of|into) .*/, " $1 X"); m[k] = (m[k] || 0) + 1; }); return JSON.stringify(m); };
console.log("missed:", reasons("FN")); console.log("wrong:", reasons("FP"));
console.log("missed list:", rows.filter((r) => r.status === "FN").map((r) => `${r.name}[${r.reason}]`).join(", "));
console.log("wrong list:", rows.filter((r) => r.status === "FP").map((r) => `${r.name}←${r.codeFrom}`).join(", "));
const byCat = {}; rows.forEach((r) => { (byCat[r.cat] ??= []).push(r); });
for (const [c, R] of Object.entries(byCat)) score(R, `  category ${c}`);
