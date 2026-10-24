# Second pipeline — reference dataset

Builds a per-package **reference dataset** from the first pipeline's output: for each
selected package **and** each of its bundled dependencies, download it at patch-level
versions, **pseudo-bundle its own code** with the Aletheia bundler, and list every
function. Same plain-script style as the first pipeline, with an optional web UI and
CLI wizard.

## Three ways to run — all the same

1. **Web control panel** (form, live logs, bash console):
   ```bash
   node server2.mjs            # open http://127.0.0.1:5273
   ```
2. **Interactive wizard**:
   ```bash
   node wizard2.mjs
   node wizard2.mjs --INPUT_DIR=../pipeline-ui/output --defaults
   ```
3. **Plain shell**:
   ```bash
   INPUT_DIR=/path/to/first-pipeline/output ./run-pipeline-2.sh
   ```
The UI and wizard just shell out to `ref-01..04`, which keep working on their own.

## Input

Point it at the **first pipeline's output folder** (`INPUT_DIR`). It reads:
- `05_selected_bundles/selected_dependencies.csv` — the bundled dependencies (name@version),
- `04_selected_sample/selected.json` — each selected package's own version.

## The four steps

| Step | Script | What it does |
| --- | --- | --- |
| 01 | `ref-01-build-list.mjs` | De-duplicated list of every package + dependency as `name@version`, then **patch-level expansion** (see below). → `01_reference_list/reference-packages.json/.csv` |
| 02 | `ref-02-download.mjs` | `npm pack name@version` (just that package's tarball, no deps) → `02_downloaded_packages/<name>@<version>/` |
| 03 | `ref-03-pseudobundle.mjs` | Aletheia pseudo-bundler on each package's **own code only** → `03_pseudo_bundles/bundles/<name>@<version>.js` |
| 04 | `ref-04-extract-functions.mjs` | Function list per bundle (same collector/format as step 06) → `04_extracted_functions/<name>@<version>.functions.json` + `summary.csv` |

## Patch-level expansion (`PATCH_LEVEL`)

For each `name@x.y.z`, download its same-minor patch siblings from npm, and **only** those:
- `all` (default) — every `name@x.y.*` published (e.g. `@popperjs/core@2.11.8` → all `2.11.x`)
- `latest` — only the newest `x.y.*`
- `exact` — only the recorded `x.y.z`, no expansion

## Parameters

| Parameter | Default | Meaning |
| --- | --- | --- |
| `INPUT_DIR` | — | first pipeline output folder (required) |
| `PATCH_LEVEL` | all | which same-minor patches to pull (all/latest/exact) |
| `INCLUDE_PACKAGE` | 1 | include the packages themselves, not just their dependencies |
| `CONC` | 6 | parallel registry queries / downloads (01–02) |
| `BUNDLE_CONC` | 4 | packages pseudo-bundled at once (03) |
| `MINIFY` | 0 | minify the pseudo-bundles (03). Off keeps LOC correct in 04 (there is no source map here) |
| `MIN_LOC` | 0 | keep only functions with LOC ≥ this (04); 6 = the paper's library filter |

## The pseudo-bundler and fix (B)

The pseudo-bundler (vendored in `lib/`) wraps each package's **own** source files into
`module([...])` and rewrites `import "dep"` → `require("dep")` **without inlining the
dependency's code** — so each reference entry is one package's own functions.

The study's released `rewriteImports` had an unfinished to-do (`// todo just remove them
for now`) that **deleted whole `export` declarations, function bodies and all**, so
ESM-dist packages lost their exported functions. This copy applies **fix (B)**: it keeps
the declaration and drops only the keyword —
`export function foo(){…}` → `function foo(){…}`,
`export const x = …` → `const x = …`,
`export default X` → `var _$__default = X;` — matching the paper's stated "exports are
rewritten to CJS style". Imports are unchanged (already rewritten to `require`).

## Requirements

- Node 18+.
- Deps: `@swc/core`, `acorn`, `acorn-loose`, `acorn-walk`, `astring` (pseudo-bundler),
  `meriyah@6.0.6`, `escodegen@2.1.0` (function collector). `run-pipeline-2.sh` and the
  UI's **Setup** button install them.
- Network: npm registry (steps 01–02).

## Files

```
server2.mjs            web control panel          public/index.html   its UI
wizard2.mjs            interactive CLI wizard      lib-pipeline-2.mjs  shared params/steps/commands
run-pipeline-2.sh      orchestrator
ref-01-build-list.mjs  ref-02-download.mjs  ref-03-pseudobundle.mjs  ref-04-extract-functions.mjs
lib/aletheia-bundler.mjs  lib/file-selector.mjs  lib/parse-utils.mjs  lib/utils.mjs   (pseudo-bundler, fix B)
lib/function-collector.mjs   (DEBUN collector)
```
