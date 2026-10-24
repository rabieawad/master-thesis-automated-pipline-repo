// Step 05: collect the selected packages' bundles into one folder, and list their dependencies.
//
// Reads the selection from step 04 (selected.json) and the bundle output of step 03, then writes:
//
//   <outDir>/selected_dependencies.csv   column 1 = package name
//                                        column 2 = its BUNDLED dependencies as a list, e.g.
//                                                   ["@clerk/shared@4.41.0","react@19.3.1",...]
//                                        (every package that actually went into the bundle except the
//                                        package itself, read from the step-03 modules report at exact
//                                        versions). A self-contained package that bundled nothing shows [].
//   <outDir>/bundles/<name>@<version>.min.js, .min.js.map, .min.js.LICENSE.txt   the bundle and its extra files
//   <outDir>/sbom/<name>@<version>.cdx.json                                      its SBOM
//   <outDir>/modules/<name>@<version>.json                                       which files of which package went in
//
// Usage:
//   node 05-collect-selected-bundles.mjs [selected.json=selected.json] [bundlesRoot=bundles] [outDir=selected-bundles]
// Example (the folders the pipeline uses):
//   node 05-collect-selected-bundles.mjs output/04_selected_sample/selected.json output/03_bundles_minified output/05_selected_bundles
//
// "bundlesRoot" is the folder step 03 wrote (it contains bundles/, sbom/, modules/).
// Safe to run again: files are overwritten with the same content.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";

const selectedPath = resolve(process.argv[2] ?? "selected.json");
const bundlesRoot = resolve(process.argv[3] ?? "bundles");
const outDir = resolve(process.argv[4] ?? "selected-bundles");

if (!existsSync(selectedPath)) {
  console.error(`Selection file not found: ${selectedPath}  (run step 04 first)`);
  process.exit(1);
}

const selected = JSON.parse(readFileSync(selectedPath, "utf8"));
const srcBundles = join(bundlesRoot, "bundles");
const srcSbom = join(bundlesRoot, "sbom");
const srcModules = join(bundlesRoot, "modules");
const dstBundles = join(outDir, "bundles");
const dstSbom = join(outDir, "sbom");
const dstModules = join(outDir, "modules");
for (const d of [dstBundles, dstSbom, dstModules]) mkdirSync(d, { recursive: true });

// "@scope/name" -> "@scope+name", the same convention bundle-and-sbom.mjs uses for file names
const bundleKey = (name, version) => `${name.replace("/", "+")}@${version}`;
const csvCell = (s) => (/[",\r\n]/.test(String(s)) ? `"${String(s).replaceAll('"', '""')}"` : String(s));

const bundleFiles = existsSync(srcBundles) ? readdirSync(srcBundles) : [];
const rows = [];
const problems = [];

for (const entry of selected) {
  const { name, version } = entry;
  const key = bundleKey(name, version);

  // Bundled dependencies = every package that actually went into the bundle except
  // the package itself. Taken straight from the step-03 modules report (modules/<key>.json),
  // whose keys are the bundled packages at exact versions; the first key is the package
  // itself. (This is the same set as the SBOM components; we read the modules report so the
  // CSV matches it exactly. SBOM is used as a fallback if the modules file is missing.)
  const rootId = `${name}@${version}`;
  const modulesFile = join(srcModules, `${key}.json`);
  const sbomFile = join(srcSbom, `${key}.cdx.json`);
  let deps = [];
  if (existsSync(modulesFile)) {
    const mods = JSON.parse(readFileSync(modulesFile, "utf8"));
    deps = Object.keys(mods).filter((k) => k !== rootId).sort();
    copyFileSync(modulesFile, join(dstModules, `${key}.json`));
  } else {
    problems.push(`${key}: no modules file found`);
    if (existsSync(sbomFile)) deps = (JSON.parse(readFileSync(sbomFile, "utf8")).components ?? []).map((c) => `${c.name}@${c.version}`).sort();
  }
  if (existsSync(sbomFile)) copyFileSync(sbomFile, join(dstSbom, `${key}.cdx.json`));
  else problems.push(`${key}: no SBOM found`);

  // one row per package; second column = its bundled dependencies as a JSON list
  rows.push([name, JSON.stringify(deps)]);

  // the bundle plus its extra files (.map, .LICENSE.txt): everything named "<key>.min.js…"
  const mine = bundleFiles.filter((f) => f === `${key}.min.js` || f.startsWith(`${key}.min.js.`));
  if (!mine.some((f) => f === `${key}.min.js`)) problems.push(`${key}: no bundle file found`);
  for (const f of mine) copyFileSync(join(srcBundles, f), join(dstBundles, f));
}

writeFileSync(join(outDir, "selected_dependencies.csv"), "package,bundled_dependencies\n" + rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n");

console.log(`Collected ${selected.length} selected package(s) -> ${outDir}`);
console.log(`  selected_dependencies.csv   (${rows.length} rows, bundled dependencies as a list)`);
console.log(`  bundles/, sbom/, modules/`);
if (problems.length) {
  console.log(`\nWARNING: ${problems.length} problem(s):`);
  for (const p of problems) console.log(`  - ${p}`);
}
