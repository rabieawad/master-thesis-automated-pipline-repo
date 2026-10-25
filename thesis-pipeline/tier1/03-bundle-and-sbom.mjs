// node bundle-and-sbom.mjs packages out 4
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
//   node bundle-and-sbom.mjs packages out 4 selected.csv # only the packages listed
//                                                         # in selected.csv/.json (any
//                                                         # other folders under packagesDir
//                                                         # are ignored, however they got there)
// Options via environment variables:
//   MINIFY=1     minify the bundles (slower, smaller; real-world bundles are usually minified too)
//
// Safe to stop and re-run: packages that already have an SBOM are skipped.
// Bundling only reads the downloaded files - it never runs their code.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { totalmem } from "node:os";

let webpack;
try {
  webpack = (await import("webpack")).default;
} catch {
  console.error("webpack is not installed. Run:  npm i webpack   (in the folder with this script)");
  process.exit(1);
}

// Minifying runs terser. By default webpack runs it in worker threads, which have a small
// memory limit of their own (ERR_WORKER_OUT_OF_MEMORY on big packages). We run it in the
// bundling process instead (parallel: false), where the heap limit below applies.
// HEAP_MB is the memory limit of each bundling process (see its default below).
// Newer webpack ships its minifier as "minimizer-webpack-plugin", older ones as "terser-webpack-plugin".
let makeMinimizer = null; // () => plugin, or null = leave webpack's own default in place
try {
  const MinimizerPlugin = (await import("minimizer-webpack-plugin")).default;
  makeMinimizer = () =>
    new MinimizerPlugin({
      parallel: false,
      test: /\.[cm]?js(\?.*)?$/i,
      minify: MinimizerPlugin.terserMinify,
      minimizerOptions: { compress: { passes: 2 } },
    });
} catch {
  try {
    const TerserPlugin = (await import("terser-webpack-plugin")).default;
    makeMinimizer = () => new TerserPlugin({ parallel: false, terserOptions: { compress: { passes: 2 } } });
  } catch {}
}
// Default: three quarters of this computer's memory, so a package can use as much as it needs
// while one package at a time is bundled. Override with HEAP_MB=<number>.
const HEAP_MB = Number(process.env.HEAP_MB ?? Math.floor((totalmem() / 1048576) * 0.75));

const packagesDir = resolve(process.argv[2] ?? "packages");
const outRoot = resolve(process.argv[3] ?? "bundles");
const CONC = Number(process.argv[4] ?? 2);
const ONLY = process.argv[5];
const MINIFY = process.env.MINIFY === "1";

// "@scope/name" -> "@scope+name", matching build.mjs's bundleFile() convention so
// split-functions.mjs and friends can walk real and pseudo bundles identically.
const bundleKey = (name, version) => `${name.replace("/", "+")}@${version}`;

// If ONLY points at a .csv/.json file (e.g. select-sample.mjs's selected.csv), only
// the folders it names get bundled - every other folder under packagesDir is skipped,
// whatever it is or how it got there (a leftover from an earlier download, a sibling
// patch version fetched separately, ...).
let onlySet = null;
if (ONLY && (ONLY.endsWith(".csv") || ONLY.endsWith(".json"))) {
  const path = resolve(ONLY);
  let rows;
  if (ONLY.endsWith(".json")) {
    rows = JSON.parse(readFileSync(path, "utf8"));
  } else {
    const parseCsvLine = (line) => {
      const out = [];
      let cur = "";
      let q = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (q) {
          if (c === '"') {
            if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
          } else cur += c;
        } else if (c === '"') q = true;
        else if (c === ",") { out.push(cur); cur = ""; }
        else cur += c;
      }
      out.push(cur);
      return out;
    };
    const lines = readFileSync(path, "utf8").split(/\r?\n/).filter((l) => l.length > 0);
    const header = parseCsvLine(lines[0]);
    const nameIdx = header.indexOf("name");
    const versionIdx = header.indexOf("version");
    if (nameIdx === -1 || versionIdx === -1) {
      console.error(`${path} has no "name"/"version" columns (found: ${header.join(", ")})`);
      process.exit(1);
    }
    rows = lines.slice(1).map((line) => {
      const cells = parseCsvLine(line);
      return { name: cells[nameIdx], version: cells[versionIdx] };
    });
  }
  // Accept both the bundleKey folder name (what download-selected.mjs writes,
  // "@scope+name@version") and the bare folder name without the version, in case
  // packages were downloaded some other way.
  onlySet = new Set();
  for (const r of rows) {
    if (!r.name || !r.version) continue;
    onlySet.add(bundleKey(r.name, r.version));
    onlySet.add(r.name.replace("/", "+"));
  }
  console.log(`--only ${ONLY}: restricting to ${onlySet.size} known folder name(s)`);
}

const bundlesDir = join(outRoot, "bundles");
const sbomDir = join(outRoot, "sbom");
const modulesDir = join(outRoot, "modules");
for (const d of [bundlesDir, sbomDir, modulesDir]) mkdirSync(d, { recursive: true });

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
        // "[file].map" (a per-asset placeholder), NOT a fixed string: a package with
        // a dynamic import() gets an extra chunk asset alongside the main bundle, and
        // a fixed sourceMapFilename made every chunk's map collide on the same name.
        sourceMapFilename: "[file].map",
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
      optimization: {
        minimize: MINIFY,
        concatenateModules: false,
        usedExports: false,
        sideEffects: false,
        splitChunks: false,
        runtimeChunk: false,
        // same terser settings as webpack's default, but without worker threads (see HEAP_MB above)
        ...(MINIFY && makeMinimizer ? { minimizer: [makeMinimizer()] } : {}),
      },
      // Aletheia Sec. 4.1: "We employ Webpack as bundler with code split disabled."
      // splitChunks:false only turns off SIZE-based splitting; a package that uses a
      // dynamic import() internally still gets a second chunk unless we force every
      // chunk back into one. LimitChunkCountPlugin does that unconditionally.
      plugins: [new webpack.optimize.LimitChunkCountPlugin({ maxChunks: 1 })],
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
// Packages are stored as <folder>.tgz (one file each) with a <folder>.meta.json sidecar
// holding {name, version}. Legacy extracted folders with a package.json are still accepted.
const folders = [];
for (const d of readdirSync(packagesDir)) {
  if (d.startsWith(".") || d === "download-results.json" || d.endsWith(".meta.json")) continue;
  if (d.endsWith(".tgz")) folders.push(d.slice(0, -4));
  else { try { if (statSync(join(packagesDir, d)).isDirectory() && existsSync(join(packagesDir, d, "package.json"))) folders.push(d); } catch {} }
}

// name/version WITHOUT extracting: from the meta sidecar, else from a legacy folder.
function metaFor(folder) {
  try { const m = readJson(join(packagesDir, `${folder}.meta.json`)); if (m && m.name) return m; } catch {}
  try {
    const pkgDir = join(packagesDir, folder);
    const name = Object.keys(readJson(join(pkgDir, "package.json")).dependencies ?? {})[0];
    let version = "unknown";
    try { version = readJson(join(pkgDir, "node_modules", ...name.split("/"), "package.json")).version; } catch {}
    return { name, version };
  } catch { return {}; }
}
// Give a usable package directory: extract the .tgz to a temp dir (cleaned up after), or
// use the legacy folder as-is.
function materialize(folder) {
  const tgz = join(packagesDir, `${folder}.tgz`);
  if (existsSync(tgz)) {
    const tmp = join(packagesDir, `.x-${process.pid}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
    execFileSync("tar", ["-xzf", tgz, "-C", tmp], { stdio: "ignore" }); // tgz made with `-C dir .`
    return { dir: tmp, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
  }
  return { dir: join(packagesDir, folder), cleanup: () => {} };
}

async function process_(folder) {
  const meta = metaFor(folder);
  const name = meta.name;
  if (!name) return { folder, ok: false, error: "no package metadata found (not downloaded?)" };
  if (onlySet) {
    if (!onlySet.has(folder) && !onlySet.has(name.replace("/", "+"))) return null;
  } else if (ONLY && ONLY !== name && ONLY !== folder) return null;

  const rootVersion = meta.version ?? "unknown";

  const key = bundleKey(name, rootVersion);
  const id = `${name}@${rootVersion}`;
  const filename = `${key}.min.js`;
  const sbomFile = join(sbomDir, `${key}.cdx.json`);
  const modulesFile = join(modulesDir, `${key}.json`);
  if (existsSync(sbomFile)) {
    // Already bundled in an earlier run: rebuild this entry from the files on disk, so
    // summary.json still has the dependency count and sizes (select-sample.mjs needs them).
    let dependenciesInBundle;
    try {
      dependenciesInBundle = readJson(sbomFile).components.length;
    } catch {}
    const size = (p) => {
      try {
        return statSync(p).size;
      } catch {
        return 0;
      }
    };
    const mapBytes = size(join(bundlesDir, `${filename}.map`));
    return {
      id,
      folder,
      name,
      version: rootVersion,
      ok: true,
      skipped: true,
      dependenciesInBundle,
      bundleBytes: size(join(bundlesDir, filename)),
      sourceMapBytes: mapBytes,
      outFile: join(bundlesDir, filename),
      sourceMapFile: mapBytes ? join(bundlesDir, `${filename}.map`) : undefined,
    };
  }

  const mat = materialize(folder); // extract the .tgz to a temp dir just for bundling
  try {
    const r = await bundleOne(mat.dir, name, bundlesDir, filename);
    if (!r.ok) return { id, folder, name, version: rootVersion, ok: false, error: r.error };

    const { sbom, modulesReport, componentCount } = buildSbom(name, rootVersion, r.modules);
    writeFileSync(sbomFile, JSON.stringify(sbom, null, 2));
    writeFileSync(modulesFile, JSON.stringify(modulesReport, null, 2));
    let bytes = 0;
    let mapBytes = 0;
    try { bytes = statSync(join(bundlesDir, filename)).size; } catch {}
    try { mapBytes = statSync(join(bundlesDir, `${filename}.map`)).size; } catch {}
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
  } finally {
    mat.cleanup();
  }
}

// ---------- one separate process per package ----------
// Every package is bundled in its own child process. If a big package runs out of memory or
// crashes, only that child dies: the package is marked FAIL and the run goes on.
// (The child is this same file, started with BUNDLE_CHILD=<folder>.)
if (process.env.BUNDLE_CHILD) {
  const r = await process_(process.env.BUNDLE_CHILD);
  console.log("@@RESULT@@" + JSON.stringify(r));
  process.exit(0);
}

// true when this folder still has to be bundled (not filtered out, not done in an earlier run)
function needsBundling(folder) {
  const meta = metaFor(folder); // no extraction — reads the meta sidecar
  const name = meta.name;
  if (!name) return false;
  if (onlySet) {
    if (!onlySet.has(folder) && !onlySet.has(name.replace("/", "+"))) return false;
  } else if (ONLY && ONLY !== name && ONLY !== folder) return false;
  const version = meta.version ?? "unknown";
  return !existsSync(join(sbomDir, `${bundleKey(name, version)}.cdx.json`));
}

function bundleInChild(folder) {
  return new Promise((res) => {
    execFile(
      process.execPath,
      [`--max-old-space-size=${HEAP_MB}`, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
      { env: { ...process.env, BUNDLE_CHILD: folder }, maxBuffer: 64 * 1024 * 1024, timeout: 3 * 60 * 60_000 },
      (err, stdout, stderr) => {
        const line = String(stdout).split("\n").reverse().find((l) => l.startsWith("@@RESULT@@"));
        if (line) return res(JSON.parse(line.slice("@@RESULT@@".length)));
        const why = err?.killed
          ? "timed out after 3 hours"
          : err?.signal
            ? `killed by the system (${err.signal}), probably out of memory`
            : (String(stderr).split("\n").find((l) => /out of memory|Error/i.test(l)) ?? `process exited with code ${err?.code}`).trim();
        res({ folder, ok: false, error: `crashed: ${why}`.slice(0, 300) });
      },
    );
  });
}

const processIsolated = (folder) => (needsBundling(folder) ? bundleInChild(folder) : process_(folder));

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
        r = await processIsolated(folder);
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
