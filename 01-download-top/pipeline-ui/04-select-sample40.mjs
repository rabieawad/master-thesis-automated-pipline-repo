#!/usr/bin/env node
// Pick a sample of successfully-bundled packages from a bundle-and-sbom.mjs
// summary.json, restricted to packages that actually pulled in dependencies
// (not standalone, zero-dependency bundles) but not huge dependency trees.
//
// Filter:
//   ok === true
//   1 <= dependenciesInBundle <= 20
//
// Usage:
//   node select-sample.mjs <summary.json> [--n 40] [--min 1] [--max 20] [--seed 42]
//                                          [--out selected] [--packages-dir DIR]
//                                          [--copy-to DIR] [--link]
//
// <summary.json> is the summary.json written by bundle-and-sbom.mjs.
//
// --packages-dir points at the folder that *contains* the actual packages
//   (the one you passed as the first argument to bundle-and-sbom.mjs, layout
//   packages/<folder>/node_modules/<name>/...). Each selected entry's "folder"
//   field is a subfolder of it. Give this together with --copy-to to pull the
//   40 selected package folders out into their own directory:
//     node select-sample.mjs summary.json --packages-dir packages --copy-to sample
//   --link symlinks the folders into --copy-to instead of copying them (faster,
//   no extra disk space; copying is the default since it leaves you a
//   self-contained folder you can move or zip).
//
// Output:
//   <out>.json         full entries (folder, name, version, dependenciesInBundle, bundleBytes)
//   <out>.csv          same, flattened
//   <copy-to>/<folder> one directory per selected package, only with --copy-to
//
// Sampling is a seeded shuffle, so the same seed always reproduces the same
// selection (change --seed to draw a different sample).

import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, symlinkSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    n: { type: "string", default: "60" },
    min: { type: "string", default: "0" },
    max: { type: "string", default: "1000" },
    seed: { type: "string", default: "42" },
    out: { type: "string", default: "selected" },
    "packages-dir": { type: "string" },
    "copy-to": { type: "string" },
    link: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (o.help || positionals.length !== 1) {
  console.error(
    "usage: node select-sample.mjs <summary.json> [--n 40] [--min 1] [--max 20] [--seed 42] [--out selected] [--packages-dir DIR] [--copy-to DIR] [--link]",
  );
  process.exit(o.help ? 0 : 1);
}
if (o["copy-to"] && !o["packages-dir"]) {
  console.error("--copy-to requires --packages-dir (where should the package folders come from?)");
  process.exit(1);
}

const n = Number.parseInt(o.n, 10);
const min = Number.parseInt(o.min, 10);
const max = Number.parseInt(o.max, 10);
const seed = Number.parseInt(o.seed, 10);

const data = JSON.parse(readFileSync(positionals[0], "utf8"));
const candidates = data.filter((d) => d.ok && d.dependenciesInBundle >= min && d.dependenciesInBundle <= max);

console.log(`${data.length} total entries, ${data.filter((d) => d.ok).length} successfully bundled`);
console.log(`${candidates.length} candidates with ${min}-${max} dependencies bundled`);
if (candidates.length < n) {
  console.log(`WARNING: only ${candidates.length} candidates available, fewer than the requested ${n} - taking all of them`);
}

// seeded shuffle (mulberry32) so the sample is reproducible given the same seed
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(seed);
const shuffled = [...candidates];
for (let i = shuffled.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
}
const selected = shuffled.slice(0, n).sort((a, b) => a.name.localeCompare(b.name));

writeFileSync(`${o.out}.json`, JSON.stringify(selected, null, 2) + "\n");
const csvCell = (s) => (/[",\r\n]/.test(String(s)) ? `"${String(s).replaceAll('"', '""')}"` : String(s));
writeFileSync(
  `${o.out}.csv`,
  "folder,name,version,dependencies_in_bundle,bundle_bytes\n" +
    selected.map((d) => [csvCell(d.folder), csvCell(d.name), csvCell(d.version), d.dependenciesInBundle, d.bundleBytes ?? ""].join(",")).join("\n") +
    "\n"
);

const hist = {};
for (const d of selected) hist[d.dependenciesInBundle] = (hist[d.dependenciesInBundle] ?? 0) + 1;
console.log(`\nSelected ${selected.length} package(s) -> ${o.out}.json, ${o.out}.csv`);
console.log(
  "dependency-count spread: " +
    Object.keys(hist)
      .map(Number)
      .sort((a, b) => a - b)
      .map((k) => `${k}:${hist[k]}`)
      .join(" ")
);

// ---------- pull the actual package folders out of --packages-dir ----------
if (o["copy-to"]) {
  const packagesDir = resolve(o["packages-dir"]);
  const copyTo = resolve(o["copy-to"]);
  mkdirSync(copyTo, { recursive: true });

  let copied = 0;
  const missing = [];
  for (const d of selected) {
    const src = join(packagesDir, d.folder);
    const dst = join(copyTo, d.folder);
    if (!existsSync(src)) {
      missing.push(d.folder);
      continue;
    }
    rmSync(dst, { recursive: true, force: true });
    if (o.link) symlinkSync(src, dst, "dir");
    else cpSync(src, dst, { recursive: true });
    copied++;
  }

  console.log(`\n${o.link ? "Linked" : "Copied"} ${copied}/${selected.length} package folder(s) from ${packagesDir} -> ${copyTo}`);
  if (missing.length) {
    console.log(`WARNING: ${missing.length} folder(s) not found under ${packagesDir}: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ", ..." : ""}`);
  }
}
