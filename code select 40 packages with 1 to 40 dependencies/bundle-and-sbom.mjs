// Build Aletheia's "lab bundles" (Swierzy et al., Sec. 5.3): real, functional Webpack
// bundles of "the latest version of each package including all of its dependencies",
// code splitting disabled, nothing tree-shaken away. Unlike pseudo-bundle.mjs's
// dysfunctional reference-index bundler (Sec. 3.3, used only to build Aletheia's
// per-package fingerprint index), these are genuine runnable bundles with a real
// source map - the same kind of artifact the crawled real-world dataset consists of
// (Sec. 4.2.2: packages are identified from a bundle by the node_modules paths in its
// source map). Shipping a source map here means the *same* ground-truth-extraction
// step used on crawled bundles+maps can be reused unmodified on this reference dataset,
// so the two are directly comparable.
//
// Works on the folder produced by download-with-deps.mjs:
//   packages/<name>/node_modules/<name>/...
//
// Output (under outRoot, default ./bundles):
//   bundles/<name>@<version>.min.js       the webpack bundle (whole package, nothing tree-shaken away)
//   bundles/<name>@<version>.min.js.map   its source map (node_modules/<pkg>/... paths preserved)
//   sbom/<name>@<version>.cdx.json        CycloneDX 1.5 SBOM: package + every dependency actually bundled, exact versions
//   modules/<name>@<version>.json         which files of which package@version were pulled into the bundle
//   manifest.jsonl                        one line per package (ok/failed, sizes, byte counts, ...)
//   summary.json / .csv                   overview of all packages (ok / failed + reason)
//
// Setup (once, in the folder where this script lives):
//   npm i webpack
// Usage:
//   node bundle-and-sbom.mjs [packagesDir=packages] [outRoot=bundles] [concurrency=2] [onlyName]
// Examples:
//   node bundle-and-sbom.mjs
//   node bundle-and-sbom.mjs packages out 4
//   node bundle-and-sbom.mjs packages out 1 lodash       # just one package
// Options via environment variables:
//   MINIFY=1     minify the bundles (slower, smaller; real-world bundles are usually minified too)
//
// Safe to stop and re-run: packages that already have an SBOM are skipped.
// Bundling only reads the downloaded files - it never runs their code.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

let webpack;
try {
  webpack = (await import("webpack")).default;
} catch {
  console.error("webpack is not installed. Run:  npm i webpack   (in the folder with this script)");
  process.exit(1);
}

const packagesDir = resolve(process.argv[2] ?? "packages");
const outRoot = resolve(process.argv[3] ?? "bundles");
const CONC = Number(process.argv[4] ?? 2);
const ONLY = process.argv[5];
const MINIFY = process.env.MINIFY === "1";

const bundlesDir = join(outRoot, "bundles");
const sbomDir = join(outRoot, "sbom");
const modulesDir = join(outRoot, "modules");
for (const d of [bundlesDir, sbomDir, modulesDir]) mkdirSync(d, { recursive: true });

// "@scope/name" -> "@scope+name", matching build.mjs's bundleFile() convention so
// split-functions.mjs and friends can walk real and pseudo bundles identically.
const bundleKey = (name, version) => `${name.replace("/", "+")}@${version}`;

// ---------- helpers ----------
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const posix = (p) => p.split(sep).join("/");

// Given an absolute file path inside node_modules, find the owning package (name, version, root dir).
const pkgCache = new Map();
function owningPackage(file) {
  const f = posix(file);
  const idx = f.lastIndexOf("/node_modules/");
  if (idx === -1) return null;
  const rest = f.slice(idx + "/node_modules/".length).split("/");
  const nameParts = rest[0].startsWith("@") ? rest.slice(0, 2) : rest.slice(0, 1);
  const name = nameParts.join("/");
  const root = f.slice(0, idx + "/node_modules/".length) + name;
  if (pkgCache.has(root)) return pkgCache.get(root);
  let info = null;
  try {
    const pj = readJson(join(root, "package.json"));
    info = {
      name: pj.name ?? name,
      version: pj.version ?? "0.0.0",
      root,
      license: pj.license ?? (Array.isArray(pj.licenses) ? pj.licenses.map((l) => l.type).join(" OR ") : undefined),
      description: pj.description,
      homepage: pj.homepage,
      deps: Object.keys({ ...pj.dependencies, ...pj.optionalDependencies, ...pj.peerDependencies }),
    };
  } catch {
    info = null;
  }
  pkgCache.set(root, info);
  return info;
}

const purl = (name, version) => `pkg:npm/${name.startsWith("@") ? "%40" + name.slice(1) : name}@${version}`;

function flattenModules(mods, out = []) {
  for (const m of mods ?? []) {
    out.push(m);
    if (m.modules) flattenModules(m.modules, out);
  }
  return out;
}

function licenseEntry(l) {
  if (!l) return undefined;
  const s = String(typeof l === "object" ? l.type ?? l.name : l);
  return [/\s(OR|AND|WITH)\s|^\(/.test(s) ? { expression: s } : { license: { id: s } }];
}

// ---------- bundling ----------
function bundleOne(pkgDir, name, outDir, filename) {
  const entry = join(pkgDir, ".bundle-entry.js");
  writeFileSync(entry, `module.exports = require(${JSON.stringify(name)});\n`);
  return new Promise((res) => {
    const compiler = webpack({
      mode: "production",
      context: pkgDir,
      entry,
      target: "web",
      // Real, separate source map (Sec. 4.2.2 ground truth relies on one): webpack's
      // default devtoolModuleFilenameTemplate keeps "./node_modules/<pkg>/..." in each
      // mapped source's path, which is exactly what the node_modules-path package
      // detector (used on crawled bundles too) expects to find.
      devtool: "source-map",
      output: {
        path: outDir,
        filename,
        sourceMapFilename: `${filename}.map`,
        library: { name: "PKG", type: "umd" },
        globalObject: "globalThis",
        clean: false,
      },
      module: {
        rules: [
          { test: /\.css$/i, type: "asset/source" },
          { test: /\.(png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|wasm|mp3|mp4)$/i, type: "asset/resource" },
        ],
      },
      // keep every module so the SBOM reflects the whole package, not only what a tree-shaker would keep
      optimization: { minimize: MINIFY, concatenateModules: false, usedExports: false, sideEffects: false },
      performance: { hints: false },
      infrastructureLogging: { level: "none" },
      stats: "none",
    });
    compiler.run((err, stats) => {
      const finish = (r) => compiler.close(() => res(r));
      if (err) return finish({ ok: false, error: String(err.message ?? err).slice(0, 400) });
      const json = stats.toJson({ all: false, modules: true, nestedModules: true, errors: true, assets: true });
      if (stats.hasErrors()) {
        const first = json.errors?.[0]?.message ?? "unknown webpack error";
        return finish({ ok: false, error: first.split("\n").slice(0, 2).join(" ").slice(0, 400) });
      }
      finish({ ok: true, modules: flattenModules(json.modules), assets: json.assets?.length ?? 0 });
    });
  });
}

// ---------- SBOM ----------
function buildSbom(name, rootVersion, modules) {
  const used = new Map(); // "name@version" -> { info, files:Set }
  for (const m of modules) {
    const file = m.nameForCondition;
    if (!file) continue;
    const info = owningPackage(file);
    if (!info) continue;
    const key = `${info.name}@${info.version}`;
    if (!used.has(key)) used.set(key, { info, files: new Set() });
    used.get(key).files.add(posix(file).slice(posix(info.root).length + 1));
  }

  // dependency graph: a bundled package "depends on" the bundled packages it declares as dependencies
  const byName = new Map();
  for (const { info } of used.values()) {
    if (!byName.has(info.name)) byName.set(info.name, []);
    byName.get(info.name).push(info);
  }
  const components = [];
  const dependencies = [];
  let rootRef = purl(name, rootVersion);
  for (const [key, { info, files }] of [...used].sort(([a], [b]) => a.localeCompare(b))) {
    const ref = purl(info.name, info.version);
    const isRoot = info.name === name;
    if (isRoot) rootRef = ref;
    const dependsOn = [...new Set(info.deps.flatMap((d) => (byName.get(d) ?? []).map((i) => purl(i.name, i.version))))].filter((r) => r !== ref);
    dependencies.push({ ref, dependsOn });
    if (isRoot) continue; // the root goes into metadata.component
    components.push({
      type: "library",
      "bom-ref": ref,
      name: info.name,
      version: info.version,
      purl: ref,
      ...(info.description ? { description: info.description } : {}),
      ...(licenseEntry(info.license) ? { licenses: licenseEntry(info.license) } : {}),
      properties: [{ name: "webpack:bundled-files", value: String(files.size) }],
    });
  }

  const rootInfo = [...used.values()].find((u) => u.info.name === name)?.info;
  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: { components: [{ type: "application", name: "bundle-and-sbom.mjs", version: "1.0.0" }, { type: "application", name: "webpack", version: webpack.version }] },
      component: {
        type: "library",
        "bom-ref": rootRef,
        name,
        version: rootVersion,
        purl: rootRef,
        ...(rootInfo && licenseEntry(rootInfo.license) ? { licenses: licenseEntry(rootInfo.license) } : {}),
      },
    },
    components,
    dependencies,
  };

  const modulesReport = Object.fromEntries([...used].map(([k, v]) => [k, [...v.files].sort()]));
  return { sbom, modulesReport, componentCount: components.length };
}

// ---------- main ----------
const folders = readdirSync(packagesDir).filter((d) => {
  const p = join(packagesDir, d);
  return !d.startsWith(".") && statSync(p).isDirectory() && existsSync(join(p, "package.json"));
});

async function process_(folder) {
  const pkgDir = join(packagesDir, folder);
  let name;
  try {
    name = Object.keys(readJson(join(pkgDir, "package.json")).dependencies ?? {})[0];
  } catch {}
  if (!name) return { folder, ok: false, error: "no dependency found in package.json (not downloaded?)" };
  if (ONLY && ONLY !== name && ONLY !== folder) return null;

  let rootVersion = "unknown";
  try {
    rootVersion = readJson(join(pkgDir, "node_modules", ...name.split("/"), "package.json")).version;
  } catch {}

  const key = bundleKey(name, rootVersion);
  const id = `${name}@${rootVersion}`;
  const filename = `${key}.min.js`;
  const sbomFile = join(sbomDir, `${key}.cdx.json`);
  const modulesFile = join(modulesDir, `${key}.json`);
  if (existsSync(sbomFile)) return { id, folder, name, version: rootVersion, ok: true, skipped: true };

  const r = await bundleOne(pkgDir, name, bundlesDir, filename);
  if (!r.ok) return { id, folder, name, version: rootVersion, ok: false, error: r.error };

  const { sbom, modulesReport, componentCount } = buildSbom(name, rootVersion, r.modules);
  writeFileSync(sbomFile, JSON.stringify(sbom, null, 2));
  writeFileSync(modulesFile, JSON.stringify(modulesReport, null, 2));
  let bytes = 0;
  let mapBytes = 0;
  try {
    bytes = statSync(join(bundlesDir, filename)).size;
  } catch {}
  try {
    mapBytes = statSync(join(bundlesDir, `${filename}.map`)).size;
  } catch {}
  return {
    id,
    folder,
    name,
    version: rootVersion,
    ok: true,
    dependenciesInBundle: componentCount,
    bundleBytes: bytes,
    sourceMapBytes: mapBytes,
    outFile: join(bundlesDir, filename),
    sourceMapFile: mapBytes ? join(bundlesDir, `${filename}.map`) : undefined,
  };
}

const results = [];
let next = 0;
const started = Date.now();
const manifestPath = join(outRoot, "manifest.jsonl");
const { open } = await import("node:fs/promises");
const manifest = await open(manifestPath, "w");

await Promise.all(
  Array.from({ length: CONC }, async () => {
    while (next < folders.length) {
      const folder = folders[next++];
      let r;
      try {
        r = await process_(folder);
      } catch (e) {
        r = { folder, ok: false, error: String(e.message).slice(0, 300) };
      }
      if (!r) continue;
      results.push(r);
      await manifest.write(JSON.stringify(r) + "\n");
      const mins = ((Date.now() - started) / 60000).toFixed(1);
      console.log(`[${results.length}/${folders.length}] ${r.ok ? (r.skipped ? "skip" : "ok  ") : "FAIL"} ${r.name ?? r.folder}${r.ok ? (r.dependenciesInBundle != null ? `  (${r.dependenciesInBundle} deps bundled)` : "") : "  -> " + r.error}  (${mins} min)`);
    }
  })
);
await manifest.close();

results.sort((a, b) => (a.id ?? a.folder).localeCompare(b.id ?? b.folder));
writeFileSync(join(outRoot, "summary.json"), JSON.stringify(results, null, 2));
writeFileSync(
  join(outRoot, "summary.csv"),
  "package,version,ok,dependencies_bundled,bundle_bytes,source_map_bytes,error\n" +
    results
      .map((r) => [r.name ?? r.folder, r.version ?? "", r.ok, r.dependenciesInBundle ?? "", r.bundleBytes ?? "", r.sourceMapBytes ?? "", JSON.stringify(r.error ?? "")].join(","))
      .join("\n")
);
const failed = results.filter((r) => !r.ok);
console.log(`\nDone. bundled=${results.length - failed.length}  failed=${failed.length}  (see ${join(outRoot, "summary.csv")}, ${manifestPath})`);
