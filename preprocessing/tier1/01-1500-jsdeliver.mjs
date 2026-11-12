// Crawl the top N npm packages from jsDelivr's public stats API.
// Usage: node crawl-jsdelivr.mjs [N=1500] [period=month]
// Needs Node 18+ (built-in fetch).
import { writeFileSync } from "node:fs";

const TARGET = Number(process.argv[2] ?? 60);
const PERIOD = process.argv[3] ?? "month"; // day | week | month | year | s_month | s_year
const PAGE_SIZE = 100;
const UA = "jsdelivr-top-crawler (personal research script)";

const out = [];
for (let page = 1; out.length < TARGET; page++) {
  const url = `https://data.jsdelivr.com/v1/stats/packages?type=npm&period=${PERIOD}&limit=${PAGE_SIZE}&page=${page}`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${res.status} on page ${page}`);
  const rows = await res.json();
  if (!rows.length) break; // ran out of data
  out.push(...rows);
  console.log(`page ${page}: ${out.length} total`);
  await new Promise((r) => setTimeout(r, 500)); // be polite
}

const top = out.slice(0, TARGET).map((r, i) => ({
  rank: i + 1,
  name: r.name,
  hits: r.hits,
  bandwidth: r.bandwidth,
}));

writeFileSync("jsdelivr-top.json", JSON.stringify(top, null, 2));
writeFileSync(
  "jsdelivr-top.csv",
  "rank,name,hits,bandwidth\n" + top.map((r) => `${r.rank},${r.name},${r.hits},${r.bandwidth}`).join("\n")
);
console.log(`Saved ${top.length} packages`);
