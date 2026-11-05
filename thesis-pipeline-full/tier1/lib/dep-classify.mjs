// Classify a declared dependency by whether it can land in a web bundle, using only
// metadata (the dependency NAME, plus — for the pre-bundled heuristic — the package's
// published file count / unpacked size). No download needed, so this is cheap-mode safe.
//
// Three name-based classes:
//   "tooling" -> build/test tools that are never part of the shipped artifact
//                (bundlers, compilers, linters, test runners). Reliably never land.
//   "types"   -> @types/* : TypeScript type packages, erased at compile. Never land.
//   "runtime" -> everything else: a real runtime library that MAY land.
//
// Note on polyfills/helpers (tslib, @swc/helpers, core-js, regenerator-runtime): these
// frequently DO land (they get bundled in as code), so by the "did it land?" rule they
// are kept as "runtime", NOT excluded.

export const BUILD_TOOL_PATTERNS = [
  /^@babel\//, /^babel-/,
  /^@rollup\//, /^rollup$/, /^rollup-plugin-/,
  /^webpack$/, /^webpack-/, /^@webpack\//,
  /^esbuild$/, /^esbuild-/,
  /^terser$/, /^terser-/,
  /^@swc\/(core|cli|wasm|jest)$/,            // @swc/helpers is NOT tooling (it lands)
  /^vite$/, /^@vitejs\//,
  /^gulp$/, /^gulp-/, /^grunt$/, /^grunt-/,
  /^parcel$/, /^@parcel\//,
  /^eslint$/, /^eslint-/, /^@eslint\//, /^@typescript-eslint\//,
  /^prettier$/, /^stylelint/,
  /^jest$/, /^jest-/, /^@jest\//, /^ts-jest$/, /^babel-jest$/,
  /^mocha$/, /^chai$/, /^sinon$/, /^karma$/, /^karma-/, /^jasmine/, /^vitest$/, /^@vitest\//,
  /^typescript$/, /^ts-node$/, /^tsup$/, /^tsc-/,
  /^browserslist$/, /^postcss$/, /^postcss-/, /^autoprefixer$/, /^sass$/, /^node-sass$/,
  /^uglify-js$/, /^@microsoft\/api-extractor/,
  /^rimraf$/, /^cross-env$/, /^npm-run-all$/, /^concurrently$/, /^nodemon$/,
  /^husky$/, /^lint-staged$/, /^ranlux$/, /^typedoc$/, /^@storybook\//, /^storybook$/,
];

export function classifyDep(name) {
  if (/^@types\//.test(name)) return "types";
  if (BUILD_TOOL_PATTERNS.some((re) => re.test(name))) return "tooling";
  return "runtime";
}

// Split a list of declared dependency names into the three classes.
export function splitDeps(names) {
  const tooling = [], types = [], runtime = [];
  for (const n of names) {
    const c = classifyDep(n);
    (c === "tooling" ? tooling : c === "types" ? types : runtime).push(n);
  }
  return { tooling, types, runtime };
}

// Heuristic "this package pre-bundled its dependencies into its own shipped code",
// from published-tarball stats only (npm `dist.fileCount` / `dist.unpackedSize`).
// Signal: it declares real runtime deps, ships FEW files, but those files are LARGE on
// average -> the dependency code was inlined into one big bundle (so nothing lands as a
// separate package). A tiny wrapper that merely requires its deps (e.g. side-channel)
// has few files too but SMALL average size, so it is NOT flagged.
export function likelyPreBundled(runtimeDepCount, fileCount, unpackedSize, opts = {}) {
  const maxFiles = opts.maxFiles ?? 20;
  const minAvgBytes = opts.minAvgBytes ?? 20000;   // 20 KB average per file
  const minTotalBytes = opts.minTotalBytes ?? 150000; // 150 KB total
  if (runtimeDepCount <= 0) return false;
  if (fileCount == null || unpackedSize == null) return false; // unknown -> don't guess
  const avg = unpackedSize / Math.max(fileCount, 1);
  return fileCount <= maxFiles && unpackedSize >= minTotalBytes && avg >= minAvgBytes;
}

// The estimated number of dependencies that will LAND as attributable packages in the
// bundle, from metadata alone. Reliable for tooling/types; approximate for pre-bundled
// (and blind to node-only / dynamic imports, which metadata cannot see).
export function estimateLanded({ declaredDeps, fileCount, unpackedSize, preBundleOpts } = {}) {
  const { tooling, types, runtime } = splitDeps(declaredDeps || []);
  const pre = likelyPreBundled(runtime.length, fileCount, unpackedSize, preBundleOpts || {});
  return {
    tooling, types, runtime,
    runtimeDepCount: runtime.length,
    likelyPreBundled: pre,
    estimatedLandedCount: pre ? 0 : runtime.length,
  };
}
