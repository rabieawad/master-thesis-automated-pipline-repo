import fs from "node:fs";
const cand = JSON.parse(fs.readFileSync("/tmp/fresh/candidates.json")).candidates;
const catOf = new Map(cand.map((c) => [c.name, c.category]));
const dir = "/tmp/fresh/tier1/output/06_extracted_functions";
const items = fs.readdirSync(dir).filter((f) => f.endsWith(".functions.json")).map((f) => {
  const key = f.slice(0, -".functions.json".length), name = key.slice(0, key.lastIndexOf("@")).replace("+", "/");
  return { key, name, category: catOf.get(name) ?? "?", fns: JSON.parse(fs.readFileSync(`${dir}/${f}`)).functions.length };
});
const sorted = [...items].sort((a, b) => a.fns - b.fns), third = Math.ceil(sorted.length / 3);
sorted.forEach((it, i) => (it.size = i < third ? "small" : i < 2 * third ? "medium" : "large"));
let x = 20261121; const rnd = () => ((x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 2 ** 32);
const keep = [...items];
while (keep.length > 50) {
  const byCat = {}; keep.forEach((i) => (byCat[i.category] = (byCat[i.category] || 0) + 1));
  const maxC = Math.max(...Object.values(byCat)), cats = Object.keys(byCat).filter((c) => byCat[c] === maxC).sort();
  const cat = cats[Math.floor(rnd() * cats.length)];
  const bySize = {}; keep.forEach((i) => (bySize[i.size] = (bySize[i.size] || 0) + 1));
  const inCat = keep.filter((i) => i.category === cat).sort((a, b) => bySize[b.size] - bySize[a.size]);
  const top = inCat.filter((i) => bySize[i.size] === bySize[inCat[0].size]);
  keep.splice(keep.indexOf(top[Math.floor(rnd() * top.length)]), 1);
}
const count = (k) => { const m = {}; keep.forEach((i) => (m[i[k]] = (m[i[k]] || 0) + 1)); return m; };
console.log("bundled", items.length, "→ kept", keep.length, "| by size", JSON.stringify(count("size")), "\n by category", JSON.stringify(count("category")));
console.log(" dropped:", items.filter((i) => !keep.includes(i)).map((i) => `${i.key} (${i.category}, ${i.size})`).join(", "));
fs.writeFileSync("/tmp/fresh/heldout50.json", JSON.stringify(keep, null, 1));
