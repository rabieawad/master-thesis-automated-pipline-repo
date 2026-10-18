# aletheia-refdb

Preprocessing half of Aletheia (Swierzy et al.), without the Dolos fingerprinting.
For every package version in a pnpm-installed dataset it

1. **selects the relevant source files** (port of Aletheia's `file-selector.mjs`),
2. **builds a pseudo-bundle**: every file wrapped as `(function(_$__e){...})`, all wrappers
   in one `module([ ... ])` array, `import` rewritten to `require()`, exports rewritten to
   assignments on `_$__e`,
3. **minifies it with swc** (`minify: true`, `compress.unsafe: true`, same as Aletheia),

and writes a **CycloneDX 1.5 SBOM** per project from `pnpm-lock.yaml` + installed `package.json`s.

## Run

    npm install
    node --max-old-space-size=8000 src/build.mjs /path/to/dataset --out out

`/path/to/dataset` is the folder `fetch-each.sh` creates (contains `pkgs/<name>/`), the `pkgs/`
folder itself, or one pnpm-installed project folder. Needs Node >= 20.12.

| option | default | meaning |
|---|---|---|
| `--out DIR` | `out` | output folder |
| `--jobs N` | cpus-1 | parallel workers (one fresh worker per package) |
| `--exports keep\|strip` | `keep` | `strip` = what Aletheia's code does: delete export statements *with* their declarations |
| `--target es2022` | unset | swc `jsc.target`. Unset = swc default (ES5, injects helper functions for modern syntax), as in Aletheia |
| `--timeout SEC` | 180 | per-package limit |
| `--only a,b` | all | only these project folders |

## Output

    out/bundles/<name>@<version>.min.js   one per package version (scoped: @scope+name@version)
    out/sbom/<project>.cdx.json           CycloneDX SBOM per project
    out/manifest.jsonl                    per package version: strategy, selected files, skipped files, sizes, sha256, errors
    out/summary.json                      totals

A package version that appears in several projects is processed once. Packages with no code
(e.g. types-only `micromark-util-types`) get a manifest entry with `"empty": true` and no bundle file.
Files swc cannot parse (TypeScript syntax, top-level await, ...) are replaced by an empty wrapper
and listed under `skipped` in the manifest; the rest of the bundle is still written.
Each SBOM component carries `aletheia:pseudoBundle` / `aletheia:pseudoBundleSha256` properties
linking it to its bundle file.

## Differences from the original Aletheia code

Bug fixes: the "main package.json" was picked by `countChar`, which counts spaces, so the choice was
arbitrary (now: shallowest); `wrapJson` was called but never defined (now defined); the worker imported a
renamed file; a missing package.json crashed the selector; unpkg/jsdelivr/browser targets are checked for
existence; self-references (`pkg`, `pkg/sub`) resolve against the package root; `node_modules` filtering
looks at the path below the package root (pnpm puts the root itself inside `node_modules`).

Deliberate changes: exports are kept as `_$__e.x = x` assignments by default (otherwise pure-ESM packages
such as arrify end up empty, and exported code is dead-code-eliminated); `package.json` files that get
selected through `exports` are not bundled; BOM and `#!` lines are stripped; unparseable files are
isolated instead of leaving the whole bundle unminified.

Kept as in the original: side-effect-only imports (`import "x"`) are removed; the output is not runnable.

---

# Step 2: `split-functions.mjs` — dissect pseudo-bundles into functions

Takes the output of `build.mjs` and represents every pseudo-bundle as a **set of functions**, collected the
way DEBUN's *Function Collector* does it (Sec. V of the paper): the AST is traversed, and *inner functions are
stripped from their parent and become separate functions*. The paper's example comes out exactly as printed there:

    function f(x) { var y = x.p; return () => y; }
      ->  function f(x) {          and      () => y
            var y = x.p;
            return;
          }

No POG, no fingerprinting: only the function texts plus metadata.

## Run

    npm install
    node src/split-functions.mjs out --out functions            # out/ = output folder of build.mjs
    node src/split-functions.mjs out/bundles/express@5.2.1.min.js --out one   # a single bundle works too
    npm test

| Option | Default | Meaning |
|---|---|---|
| `--min-loc N` | 6 | keep functions whose pretty-printed text has at least N lines. DEBUN uses "lines of code greater than five". `0` keeps everything |
| `--drop-helpers` | off | drop all code outside the `module([...])` wrappers, i.e. the ES5 helpers swc injects (see below) |
| `--text pretty\|compact` | pretty | one statement per line, or single-line text. Line counting for `--min-loc` always uses the pretty form |
| `--no-text` | off | metadata only (still includes the content `hash`) |
| `--verify` | off | re-parse every kept function and report the ones that do not parse (`invalid` field) |
| `--jobs N`, `--timeout SEC` | cpus-1, 120 | worker threads, per-bundle timeout |

## Output

    functions/<name>@<version>.jsonl   one function per line (scoped: @scope+name@version, same as the bundle)
    functions/manifest.jsonl           per bundle: counts, byKind, sizes, errors
    functions/summary.json             totals

An empty `.jsonl` means the bundle has no function above the threshold. A bundle that does not parse gets an
`error` in the manifest and no `.jsonl`; the exit code is then 2.

One JSON object per function:

| Field | Meaning |
|---|---|
| `id` | `f0, f1, ...` in source order; `top` for the prelude |
| `parent`, `depth`, `inner` | nesting: the enclosing function, its depth (0 = not nested), the ids of the functions stripped out of this one |
| `kind` | `module` (one source file), `declaration`, `expression`, `arrow`, `method`, `getter`, `setter`, `constructor`, `prelude` |
| `file` | index of the source file (position in `module([...])`), `-1` outside the wrappers; `outside` is `file == -1` |
| `name`, `label` | the function's own identifier, and what it is assigned to (`exports.sign`, `Client.prototype.send`, property key, `get x`). Minifiers mangle most names, but property names survive |
| `start`, `end` | offsets in the bundle |
| `nodes`, `loc`, `bytes` | AST nodes, pretty-printed lines and UTF-8 bytes of the stripped text |
| `hash` | first 16 hex chars of sha256 of `text`. A content id for finding duplicates, **not** a fingerprint |
| `text` | the function with its inner functions stripped |

## What counts as a unit

- **module**: each `function(_$__e){...}` wrapper is one source file; its text is that file's top-level code with
  every function stripped out.
- **prelude**: top-level code outside all wrappers that is not a function (usually absent).
- **functions**: every declaration, function expression, arrow function, method, getter, setter and constructor, at
  any depth. Every function of the bundle is in exactly one unit (checked by position on all 66 express bundles).

## How an inner function is stripped

So that every text stays valid JavaScript:

- removed: function declarations, `return <fn>`, call / `new` arguments, array elements, `var`/`let x = <fn>`
- methods, getters, setters, constructors keep their signature with an empty body (`m(a) {}`)
- everything else (`a.b = <fn>`, `{k: <fn>}`, an IIFE callee, ...) is replaced by the literal `0`, so the written
  property name stays in the parent

A unit's own text is always a function expression/declaration; for methods the key and kind are in `label`/`kind`
(a constructor that calls `super()` therefore does not parse on its own outside a class; `--verify` accounts for that).

## ES5 helpers

With swc's default (ES5) target, helpers such as `_array_like_to_array` and `_class_call_check` are hoisted
**above** `module([...])`, outside every wrapper, and they occur in almost every bundle. All code of a real
package is inside a wrapper, so `--drop-helpers` (drop everything with `file == -1`) removes them, including the
functions nested inside helpers (`Wrapper`, `ownKeys`) that a name list would miss. On the express dataset it drops
102 of 1,053 functions, which is exactly the difference to a `--target es2022` build. Building the bundles with
`--target es2022` avoids the helpers altogether. Helpers from packages that were already Babel/TypeScript-compiled
live inside the wrappers and stay; remove those with a frequency filter over the whole corpus (DEBUN drops
fingerprints that occur on more than 60% of websites).

## Known limits

- The line rule is applied to astring's pretty-printed text, not to original source lines (the bundles are one line).
- A function inside a computed key (`{[function(){}]: 1}`) is collected, but may also appear inside its method's text.
- `--min-loc` removes a small function from the set but keeps its inner functions that are large enough.

---

# Step 3: `deps-csv.mjs` — dependency table with npm version counts

    node src/deps-csv.mjs /path/to/folder-with-all-packages          # or --dataset DIR, or run it without a folder and it asks
    node src/deps-csv.mjs <dataset> --direct                          # only the dependencies named in each package's own package.json
    node src/deps-csv.mjs <dataset> --stable                          # ignore prereleases (1.0.0-beta.1, canary builds, ...)

`<dataset>` is the folder that holds one pnpm-installed project folder per package
(`<dataset>/<package>/node_modules/.pnpm/...`), or a single project folder. It needs network access to the npm registry.

For every package and dependency the script asks the registry which versions were published.

**`dependencies.csv`**: one line per package folder. The first column is the folder name, the second column is a map from
each of its dependencies to the total number of versions published on npm (the package itself is included, names sorted):

    package,dependencies
    express,"{""accepts"": 37, ""body-parser"": 85, ..., ""express"": 289, ..., ""wrappy"": 4}"

The map is one line of JSON (CSV quoting doubles the quotes). A dependency npm gives no count for (not on npm, git
dependency, failed lookup) gets `null`. All installed dependencies at every level are listed; `--direct` lists only the
direct ones. A dependency that is installed in two versions in one folder appears once.

**`dependencies-counts.json`** (`--counts FILE`): one map for the whole dataset, package name -> total versions on npm,
`{"express": 289, "ms": 32, ...}`. Packages without a count are left out.

**`dependencies-versions.csv`** (the `--out` name plus `-versions`, or `--table FILE`): one line per distinct dependency
version, relating the **installed** version to the versions on npm:

    dependency,installed_version,npm_versions_total,npm_versions_before,npm_versions_after,status,used_by_packages

- `before` / `after`: published versions older / newer than the installed one (semver order).
- `status`: `ok`; `installed_version_not_on_npm`; `not_on_npm`; `non_registry_version` (git or tarball dependency); `lookup_failed`.

With `--stable`, prereleases are left out of every count. The package itself is never counted as its own dependency in the
table (it is found through the folder's `package.json` and `pnpm-lock.yaml`, else from the folder name; `@scope+name` and
`@scope__name` mean `@scope/name`). At the end the console shows the sum of all published versions of the distinct
dependencies and the ones with the most versions, which tells you how big "download all versions" would be.

Registry answers are cached in `.npm-versions-cache/` (`--cache DIR`), so a second run is fast and failed lookups can be
retried. `--refresh` ignores the cache, `--offline` uses only the cache, `--concurrency N` sets the parallel requests (8).
Folders without `node_modules/.pnpm` (failed installs) are reported on the console and left out of the CSV.
