// Compress finished per-package files of a streamed tier-2 run in place (<pkg>.json -> <pkg>.json.gz)
// to save disk; step 08 and tier 3 read both forms (lib/json-gz.mjs). A package counts as finished
// when its stream state file exists (partials/<pkg>.state.json), so this is safe while step 06 runs.
//   node tier2/tools/compress-packages.mjs <tier 2 out dir>
import { readdirSync, existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const out = process.argv[2];
if (!out) { console.error("usage: node tier2/tools/compress-packages.mjs <tier 2 out dir>"); process.exit(2); }
const D5 = join(out, "05_deduplicated_functions"), PKG = join(D5, "packages");
const PART = [join(D5, "partials"), join(out, "partials")].find((d) => existsSync(d));
let n = 0, before = 0, after = 0;
for (const f of readdirSync(PKG).filter((x) => x.endsWith(".json"))) {
  const key = f.slice(0, -5);
  if (PART && !existsSync(join(PART, `${key}.state.json`))) continue; // still being written
  const src = join(PKG, f), dst = src + ".gz", buf = readFileSync(src);
  writeFileSync(dst + ".tmp", gzipSync(buf)); renameSync(dst + ".tmp", dst); unlinkSync(src);
  n++; before += buf.length; after += statSync(dst).size;
}
console.log(`compressed ${n} package file(s): ${(before / 2 ** 20).toFixed(0)} MB -> ${(after / 2 ** 20).toFixed(0)} MB`);
