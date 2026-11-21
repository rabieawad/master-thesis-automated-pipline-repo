// Held-out candidates: seeded random picks from npm's most-downloaded packages per category,
// excluding every package already used anywhere (test bed, pilot, both references, all SBOMs).
import fs from "node:fs";
const SEED = 20261121, PER = 5, TOP = 100, MIN_MONTHLY = 100000;
// [query, needs a browser signal in its keywords/description]
const CATS = {
  "ui (react)": ["keywords:react-component", false], "ui (vue)": ["keywords:vue", true], dates: ["keywords:date", true], charts: ["keywords:chart", false],
  http: ["keywords:ajax", true], state: ["keywords:state", true], editors: ["keywords:editor", true], animation: ["keywords:animation", false],
  maps: ["keywords:maps", true], analytics: ["keywords:analytics", true], utilities: ["keywords:utility", true], dom: ["keywords:dom", false], validation: ["keywords:validation", true],
};
const BROWSER = /\b(browser|dom|react|vue|svelte|angular|frontend|front-end|web|ui|component|jquery|client-side|html|css)\b/i;
const BAD = /(^|[\/\-@])(cli|binding|bindings|linux|darwin|win32|storybook|eslint|babel-plugin|webpack|vite-plugin|rollup|postcss|react-native|expo|node|server|nestjs|electron|types|typescript|jest|vitest|test)([\/\-]|$)/i;
const fetchJson = async (u) => { for (let i = 0; i < 5; i++) { const r = await fetch(u); const t = await r.text(); try { return JSON.parse(t); } catch { await new Promise((res) => setTimeout(res, 3000 * (i + 1))); } } throw new Error("registry search failed: " + u); };
const seen = new Set();
const addNames = (arr) => arr.forEach((n) => seen.add(n));
addNames(JSON.parse(fs.readFileSync("/tmp/t2x-ix/meta.json")).packages.map((p) => p.name));
addNames(JSON.parse(fs.readFileSync("/tmp/pilot/t3new/01/meta.json")).packages.map((p) => p.name));
addNames(JSON.parse(fs.readFileSync("/tmp/t3/index/meta.json")).packages.map((p) => p.name));
addNames(JSON.parse(fs.readFileSync("/tmp/pilot/list.json")).map((s) => s.slice(0, s.lastIndexOf("@"))));
for (const dir of ["/tmp/t3/D3/sbom", "/tmp/pilot/tier1/output/05_selected_bundles/sbom"]) for (const f of fs.readdirSync(dir)) {
  const s = JSON.parse(fs.readFileSync(`${dir}/${f}`)); for (const c of [s.metadata.component, ...(s.components || [])]) seen.add(c.group ? `${c.group}/${c.name}` : c.name);
}
let x = SEED; const rnd = () => ((x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 2 ** 32);
const picked = [], taken = new Set();
for (const [cat, [q, needBrowser]] of Object.entries(CATS)) {
  const j = await fetchJson(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(q)}&size=250`);
  await new Promise((res) => setTimeout(res, 1500));
  const sig = (o) => [...(o.package.keywords || []), o.package.description || ""].join(" ");
  const pool = j.objects.filter((o) => (o.downloads?.monthly ?? 0) >= MIN_MONTHLY && Number(o.dependents || 0) >= 10 && !BAD.test(o.package.name) && !/\b(cli|command[- ]line|node\.js only|server-side)\b/i.test(o.package.description || "")
      && (!needBrowser || BROWSER.test(sig(o))) && !seen.has(o.package.name) && !taken.has(o.package.name))
    .sort((a, b) => b.downloads.monthly - a.downloads.monthly).slice(0, TOP);
  const chosen = [];
  while (chosen.length < PER && pool.length) { const o = pool.splice(Math.floor(rnd() * pool.length), 1)[0]; chosen.push(o); taken.add(o.package.name); }
  for (const o of chosen) picked.push({ category: cat, name: o.package.name, version: o.package.version, monthly: o.downloads.monthly });
  console.log(`${cat.padEnd(12)} pool ${String(pool.length + chosen.length).padStart(3)} → ${chosen.map((o) => o.package.name).join(", ")}`);
}
fs.writeFileSync("/tmp/fresh/candidates.json", JSON.stringify({ seed: SEED, per: PER, top: TOP, minMonthly: MIN_MONTHLY, categories: CATS, excluded: seen.size, candidates: picked }, null, 1));
console.log(`${picked.length} candidates, ${seen.size} names excluded`);
