# Thesis pipeline — one project, two chained tiers

A **project** is made of two sub-pipelines that run one after the other:

- **Tier 1 · Data preparation** (6 steps, +1 optional): crawl top packages → download → bundle+SBOM → *(optional: Claude repair of failed bundles)* → select sample → collect → extract functions.
- **Tier 2 · Reference dataset** (5 steps): build version list → download → pseudo-bundle → extract functions → deduplicate functions across versions.

**Tier 2's input is wired automatically to tier 1's output** — you never type a directory. You configure tier 2 *after* tier 1 has produced output (its parameters are edited later).

## The control panel

`node server.mjs` and open http://127.0.0.1:5273. On the left are your projects (each with a small
progress bar per tier); on the right the open project:

- **The step track** — the tier's steps in order, each with its status (✓ done, ring = running,
  ✕ failed), when it ran and how long it took. Click a step to see its saved log and its actions:
  *Run this step*, *Run up to here*, *Redo from here…* (optionally clearing the output first).
- **One main button** under the track: *Run the whole tier*, *Continue from step N*, or *Stop* while
  something runs.
- **Activity panel** — *Log* (live output, or a step's saved log), *Files* (the tier's output grouped
  by folder with sizes; tier 1's bundle folders are marked *always kept*), *Packages* (tier 2: what to
  include) and *Console* (a shell in the tier's output folder).
- **Settings** — grouped (e.g. tier 1: Mode, Package source, Sample selection, Bundling, Claude
  repair, Function extraction, Performance), with a search box across all settings, a short
  explanation under each, a dot on anything changed from its default and a one-click reset. Settings
  that don't apply to the current mode are hidden. *New project* uses the same panel.
- **More** — rename, install the tier's dependencies, count the downloads (tier 2, no download),
  delete the project.
- **Appearance** — Auto (follows the system), Light or Dark, at the bottom of the left column.

### Tier-2 download count and inclusion selection

- **Count the downloads** (tier 2, under *More*): a dry-run of step 01 that reports how many
  `name@version` *will be downloaded* for the current settings (by origin, and the biggest anchors)
  and writes `preview.json`/`preview.csv` — **without** downloading or writing the real list.
- **Packages** (tier-2 tab): the survived items from tier 1 (each selected package + its bundled
  dependencies). Per-package toggles choose whether to include the package and whether to include
  its dependencies. Default is everything. Excluding a package only drops it as a top-level anchor —
  it still enters the set if another included package bundles it as a dependency. The saved
  selection feeds both the count and the real step-01 build (via `selection.json` → `--selection`).

## Tier-1 bundles are always kept

The bundles tier 1 builds (`03_bundles_minified/` and `05_selected_bundles/`) are the **test bed**:
later they are scanned to find which library versions they contain. Nothing deletes them. A *Redo
from here* with "clear the output first" **moves** these folders to
`<output>/_archived_bundles/<time>/` instead of deleting them, so the redo starts clean and the old
bundles survive. Logs live outside the step folders and are never cleared either.

## Tier-1 bundling is faithful to Aletheia's `generate_bundles.py`

The test-bed bundles are built the way Aletheia built its lab bundles:

- **Install** (step 02, or 03 in cheap mode): `pnpm add <pkg> --ignore-scripts --no-optional`, as the
  original's `pnpm install --no-optional --ignore-scripts` (npm fallback: `--omit=optional`).
- **Entry**: an `index.js` containing `import * as pkg0 from '<pkg>';`, the original's entry. An ESM
  import makes webpack resolve the package with its `import` conditions, so a package that ships
  separate ESM and CommonJS builds is bundled from the same build Aletheia used.
- **webpack configuration**: the original template verbatim (mode, source map, optimization
  block, the ts/css/file loader rules, one chunk). Minification uses webpack 5's default
  minimizer options, `{ compress: { passes: 2 } }`; it only runs outside worker threads to avoid
  out-of-memory crashes, which does not change the output.

Checked byte for byte: for `acorn` (a dual ESM/CommonJS package), this bundler's output is identical
to running the original template and `index.js` through plain webpack, apart from the source-map
file name. Deliberate differences, to state in the thesis: one package (with its dependencies) per
bundle instead of several random packages; the latest version instead of a random one; longer
time limits; webpack pinned (5.112.2). Bundles built before this change used a CommonJS entry, one
compress pass and installed optional dependencies, so redo them from the download step.

## Tier 1, optional step: Claude repair of failed bundles (`CLAUDE_REPAIR`)

Some packages fail to bundle (a dependency the install left out, a native addon webpack can't read,
…). With **Repair failed packages with Claude** on, a step runs right after bundling (*03b* in
expensive mode, *04b* in cheap mode; `07-claude-repair-bundles.mjs`). For each failed package:

1. The package is unpacked into a private workspace, `03_bundles_minified/claude_repair/<package>/`,
   with a `TASK.md` and a `try-bundle.sh` that runs the **unchanged** bundler on it.
2. Claude Code (`claude -p`, headless) is told to repair **the package, never the bundler**: add a
   dependency the install left out, or stub a native/optional module, with the smallest change; no
   install scripts (`--ignore-scripts`), no running the package's code. It must write a
   **standardized `REPAIR.json`** (see below).
3. This script then **re-writes the check script, confirms the bundler file is byte-identical, and
   runs the unchanged bundler itself**. Only a bundle produced by that run is accepted, so every
   bundle, source map and SBOM still comes from the same faithful webpack configuration.
4. Accepted results go into the normal bundle folders; the package's entry in `summary.json` is
   replaced and marked `"bundledBy": "claude-repair"` (with `originalError`), so it is visible
   downstream. `claude_repair/report.csv` lists every attempt (outcome, category, cause, files
   changed, turns, cost), and each package keeps `repair.json`, Claude's own `REPAIR.json`,
   `changes.json` (every file added/changed/removed) and `changed-files/`. The original download is never modified, so original + `changed-files/`
   reproduces the repair; the full working copy is deleted.

### Standardized reports and the shared failure categories

Every package's outcome uses one fixed list of categories (`tier1/lib/failures.mjs`), whether it
came from the automatic check, the bundler's error, or Claude:

`no_js_entry` · `stylesheet_only` · `remote_imports` · `missing_dependency` · `native_module` ·
`unsupported_syntax` · `bundler_crash` · `out_of_memory` · `timeout` · `download_failed` · `other`

Claude must write `REPAIR.json` in exactly this shape; the step validates it:

```json
{ "outcome": "repaired | not_repaired", "category": "<one of the list>",
  "cause": "one sentence", "evidence": "the decisive error line, verbatim",
  "changes": [{ "file": "pkg/...", "action": "added | changed | stubbed | removed", "reason": "..." }],
  "still_represents_package": "... (when repaired)",
  "explanation": "free text, in Claude's own words" }
```

The **outcome is what the unchanged bundler proves**, never only Claude's claim: if Claude says
"repaired" but the bundler still fails, it is recorded as `not_repaired` with a note. A missing or
malformed report is recorded as such (`report_valid: false`) and the category falls back to the one
derived from the original error. Each package's normalized record is `claude_repair/<package>/repair.json`
(standard fields + Claude's full explanation), and every package — repaired, failed, skipped or
bundled — gets one standard log line:

```
RESULT | <name>@<version> | <outcome> | <category> | <cause or details>
    explanation: <Claude's explanation, when Claude was involved>
```

Settings: packages per run (`CLAUDE_MAX_PACKAGES`, 20), turns per package (40), spending cap per
package in USD (blank = none), time limit (20 min), model (blank = Claude Code's default), and the
Claude command. Claude Code must be installed and signed in (`npm i -g @anthropic-ai/claude-code`,
then run `claude` once). Re-running the step skips packages already repaired. For the thesis, report
the repaired packages separately: their *input* was modified, even though the bundler was not.

## Tier-1 streamed mode (`STREAM`, on for new projects)

Tier 1 runs one package at a time (`tier1/08-stream-packages.mjs`), calling the unchanged scripts:

1. **download** the package with its dependencies (step 02's script, Aletheia's install flags);
2. **check it can be bundled** (`CHECK_BUNDLEABLE`, on): webpack's *own* resolver, built from the
   bundler's exact settings and loader rules, is asked which file the bundler's entry
   (`import * as pkg0 from '<name>'`) would load. Only two cases are skipped, both certain to fail:
   no entry at all (`no_js_entry`) or a stylesheet entry (`stylesheet_only`). Nothing is bundled
   or sent to Claude for them. Checked against real bundling on 26 packages of a real sample: it
   agreed on all 26 (10 skipped = exactly the 10 that fail; none that bundle was skipped);
3. **bundle + SBOM** (step 03's script);
4. **Claude repair**, only if bundling failed and `CLAUDE_REPAIR` is on (inside the stream, while the
   download still exists — no separate 03b/04b step);
5. **delete** the download, the unpacked package and pnpm's cache for it.

**Kept:** bundles and source maps, SBOMs and module reports, extracted functions (step 06), Claude's
reports, logs (`03_bundles_minified/stream/logs/<package>/`), one record per package
(`stream/records/`, also the resume marker) and `stream/results.csv` (one standard row per package:
outcome, category, cause, dependencies bundled, bundle size, the entry the check found).
`summary.json/.csv` and `manifest.jsonl` are rebuilt in step 03's exact format, so selection (04),
collect (05) and extraction (06) run unchanged. Under **Also keep**, tick *Downloaded packages* to
keep the `.tgz` files.

Steps: expensive `01 → 02–03 stream → 04 → 05 → 06`; cheap `01 → 02 → 03–04 stream → 05 → 06`. A
download already in `02_downloaded_packages/` (e.g. from a batch run) is used instead of downloading
again, and then deleted like the rest. Streamed and batch bundles are byte-identical (checked on 16
real packages; SBOMs differ only in the serial number and timestamp every run writes). Projects
created before this keep running in batch mode.

### Tier-1 mode: expensive vs cheap

Tier 1 has a `MODE` parameter:
- **expensive** (default) — crawl → download **all** → bundle **all** → select the sample from the
  *actual bundled* dependencies → collect → extract. Most accurate, most work.
- **cheap** — crawl **and collect dependency/version metadata** from npm (no downloads) → **select the
  sample from that metadata** → download **only the sample** → bundle it → collect → extract. You only
  ever download/bundle the sample. The step labels in the state table change to match the mode.

Cheap step 01 also writes two tables you can inspect:
- `packages-dependencies.csv` — **Table A**: each package → declared deps, split into **runtime** vs
  excluded **tooling/@types**, with `runtime_count`, `estimated_landed`, and a `pre_bundled` flag.
- `version-metadata.csv` — **Table B**: each package *and* dependency → counts of major / minor / patch
  releases, its latest version, and the full sorted list of versions.

The sample is still bundled in cheap mode, so step 05 produces **accurate** (SBOM-based, exact-version)
dependencies for the sample — the cheapness is in not downloading/bundling everything.

Step 01's npm-metadata phase is **resumable**: results are cached to `info-cache.json`, so an
interrupted crawl continues instead of restarting.

### Cheap-mode selection: by what actually lands, and by distribution

Cheap step 02 selects on a configurable **basis** (`DEP_BASIS`): `landed` (default — declared deps
minus build-tooling/`@types`, and 0 for packages that pre-bundle their deps into one file), `runtime`
(declared minus tooling/types), or `declared` (raw). "Landed" estimates how many packages actually end
up *in the bundle* — so a package like `@analytics-debugger/ga4mp`, whose 9 "dependencies" are all
build tools, counts as 0 rather than 9. (This is a metadata estimate: reliable for tooling/types,
heuristic for pre-bundling via file-count, and blind to node-only / dynamic imports — exact landing is
only known after bundling.)

You can also control the **distribution** of dependency counts in the sample with `DEP_DIST`, e.g.
`0:3,2-5:3,8-15:5` selects 3 packages with 0 landed deps, 3 with 2–5, and 5 with 8–15 (ranges are on
the chosen basis, seeded, no reuse). When `DEP_DIST` is blank it falls back to `min`/`max`/`N`.

```bash
node server.mjs            # open http://127.0.0.1:5273
```

## Projects

- **New project** — name it, set tier-1 parameters, run tier 1; then edit tier-2 parameters and run tier 2.
- **Import tier-1 output** — point at an existing first-pipeline output folder to run **only tier 2** on it (tier 1 is marked *imported*).
- Each project is saved under a readable layout and is **resumable**:

```
projects/<name-slug>/
  project.json            name, both tiers' parameters, per-step state table
  tier1/output/           first pipeline output (01_… … 06_…)
  tier1/logs/01.log …06.log
  tier2/output/           reference pipeline output (01_… … 05_…)
  tier2/logs/01.log …05.log
```

Per tier you can **Run whole tier**, **Continue** (from the first unfinished step), run **a single step**, **Run up to step N** (from the first unfinished step up to and including N, then stop), or **Redo from step N** (re-run step N and everything after with the current parameters, even if already done — with an optional *rebuild* that first deletes the output those steps own, so new parameters actually take effect instead of being skipped over existing output). State (status / started / duration / exit code) and per-step logs are saved, written atomically, and survive a server restart (a step left mid-run is marked interrupted; Continue resumes).

## Storage: downloads are always tarred

Every downloaded package is stored as **one `.tgz` file**, never an unpacked folder, so the
filesystem tracks one file per package instead of a whole tree of tiny files (which is what
was overwhelming the volume — inodes, slack space, slow listings).
- Tier 2: `npm pack` already produces a `.tgz`; it is kept as-is.
- Tier 1: the installed tree (package + dependencies) is tarred into `<pkg>.tgz` with a small
  `<pkg>.meta.json` sidecar, and the tree is removed.
- Bundling (both tiers) **extracts a package to a temp dir only while bundling it, then deletes
  the temp dir** — so disk only ever holds the `.tgz` files.

## Tier-2 version selection (`VERSIONS`)

- `all` (default) — every stable version (all majors/minors/patches), the paper's full index. A
  dependency with a long history is indexed in full.
- `minor` / `latest` / `exact` — same-minor patches / newest only / exact recorded version.

The old `sample` mode (which capped long version histories with seeded per-minor sampling, to save
disk) has been **removed**, with its settings `SAMPLE_THRESHOLD`, `SAMPLE_STRATEGY`, `PER_MINOR_N`,
`ADJACENT_N` and `SEED`: streamed mode now keeps disk use low, so every version is considered.

## Tier-2 step 05: deduplicate functions across versions

Most functions are unchanged between consecutive versions, so step 04's output repeats the same
function hundreds of times. Step 05 collapses it into **one record per distinct function** and keeps
the **version intervals** each one appears in — so you embed each function once and can assign it back
to its versions (e.g. 310,837 instances → 7,637 unique functions on 906 Sentry versions, ~10 s).

**Identity** is an exact string match, no fuzziness. The comparison key of a function is written
out in full as `"<signature>\0<bodySource>\0<body text>"`, and `DEDUP_IDENTITY` decides how two
keys are compared:
- `string` (**default**) — the keys themselves, **character by character**. "Same function" means
  literally the same string, so no hash collision is possible by construction. Each record is still
  *labelled* `id = sha256(key)[:24]`; if two different keys ever shared a label the run stops with an
  id-collision error instead of merging them.
- `hash` — compare the truncated `sha256(key)[:24]` ids, the older, more compact form. Marginally
  less memory; two different functions sharing a 24-char id would be silently merged.

Measured on 1,533 `@sentry/*` versions (689,402 function instances): the two give **byte-identical**
output, zero colliding ids, and `string` costs +4.5 % peak memory and no extra time — see
[`tier2/STRING-COMPARISON-RESULTS.md`](tier2/STRING-COMPARISON-RESULTS.md).

What counts as the *body* is a separate choice (`DEDUP_MODE`):
- `DEDUP_MODE=normalized` (default): body = `textNorm` (bundle-declared names renamed `v0, v1, …`),
  so a local renamed between versions still matches. `exact`: body = raw `text`.
- The **signature** (kind, async, generator, param count/rest/defaults/destructured) is part of the
  key, because `text` is only the body. `FunctionDeclaration` and `FunctionExpression` with the same
  body count as one kind unless `DEDUP_STRICT_TYPE=1`; arrow functions stay distinct.
- If step 04 ran with `--no-text`/`--no-norm`, or a function was unprintable, it falls back to
  `hashNorm` / `hash` / `rawText` (recorded per function as `keyedOn`).

Output in `05_deduplicated_functions/`:

| file | what it is |
|---|---|
| `unique_functions.jsonl` | one line per distinct function: `text` (most common raw-name variant — best for embedding), `textNorm`, `packages{pkg:{first,last,n_versions,ranges}}`, `n_occurrences`, `raw_variants`, `trivial`, `parent_ids`, metrics |
| `occurrences.csv` | `function_id, package, version, count, indices` — the map back to versions |
| `version_index.json` | `"pkg@ver" → [function_id per original index]` — rebuild any version exactly |
| `near_duplicates.csv` | only when `NEAR_THRESHOLD > 0`: pairs of *different* functions with token-shingle Jaccard ≥ threshold (MinHash LSH). Listed for lineage, never merged |
| `summary.json` | counts |

`ranges` are contiguous runs over the versions **present in this dataset**, semver-sorted; more than
one range means the function disappeared and came back. `trivial` (fewer than `TRIVIAL_NODES` AST
nodes) marks bodies like `{}` you will usually skip when embedding. Nested functions are already
stubbed by step 04, so each child is its own record (`parent_ids` links them).

## Tier-2 streamed mode (`STREAM`) and `KEEP_ARTIFACTS`

Batch mode runs each step over **all** packages, so every `.tgz`, every pseudo-bundle and every
per-version `functions.json` sits on disk at the same time — hundreds of GB for a real reference
set, when the only thing actually needed is the final per-package function collection.

**Streamed mode (`STREAM=1`, the default for new projects)** keeps the same five stages but
reorders them around one package at a time:

1. **Step 01 runs once, globally, unchanged.** Its `reference-packages.json` fixes every package's
   version list *before* anything is downloaded. That matters for `VERSIONS=minor`/`exact`, where
   the same dependency can be observed at different versions in different groups — the version list
   must not depend on the order groups are processed in.
2. **Work order comes from tier 1's `selected_dependencies.csv`**, in CSV order: each **group** is a
   selected package plus its bundled dependencies (reusing step 01's own column detection). The
   package itself is included when `INCLUDE_PACKAGE=1`, and only names present in
   `reference-packages.json` are kept — so `selection.json` toggles are honoured automatically.
   Anything in the reference list that no group reaches is swept up in a final `_ungrouped` group,
   so the merged output can never be missing a package.
3. **The unit of storage and dedup is the tier-2 package, not the group.** A package already finished
   (`tslib` met again in a later group) is skipped and its collection reused.
4. **Per package**, in `_work/<pkgKey>/`: write that package's rows to a subset list → `02_download.mjs`
   → record each `.tgz`'s size and `sha512-<base64>` integrity (npm's own `dist.integrity`) *before*
   it can be deleted → `03_pseudo-bundle.mjs` → `04_extract-functions.mjs --min-loc $MIN_LOC` → the
   **collect** half of step 05, written atomically (temp file + rename) to
   `05_deduplicated_functions/partials/<pkgKey>.state.json`. **A partial existing means that package
   is done** — that is the whole resume protocol. Then the kept artifacts are moved into the normal
   batch locations and the work dir is deleted.
5. **After each group**, `05_deduplicated_functions/groups/<groupKey>.json` records the anchor, the
   members and each member's status (`done` / `failed` / `reused`).
6. **At the end**, `07_merge-partials.mjs` merges every partial into the usual step-05 outputs and
   adds `"streamed": true` to `summary.json`, then deletes the partials unless they were kept.

The steps 01–04 scripts, the collector and the pseudo-bundler are **not** reimplemented or modified:
the driver calls them as child processes exactly the way `lib-pipeline-2.mjs` does. Only
`05_dedup-functions.mjs` was restructured internally, into `collect(functionsDir) -> state`,
`mergeStates(states) -> state` and `finalize(state, outDir)`, with `dedup() = finalize(collect(…))`
and its CLI unchanged.

### Why the merged output is byte-identical to batch step 05

- Batch reads `<pkg>@<ver>.functions.json` files **sorted by filename**, and all of one package's
  files are contiguous in that order, so merging the partials in ascending order of each one's
  smallest filename key replays exactly the batch traversal.
- On merge, the **first** state holding a function id wins its first-seen fields — what batch does
  when it fills a record the first time it meets the id.
- Raw-variant counts are **summed while keeping first-insertion order**, so ties in the "most common
  raw variant" (`text`) break the same way.
- `bodySources` / `keyed_on` is recomputed in `finalize` from the records' `keyedOn`, which is
  identical to batch's count (batch counted it once per first-seen function).
- `DEDUP_MODE`, `DEDUP_IDENTITY` and `DEDUP_STRICT_TYPE` are **baked into the partials** (identity is
  computed while collecting), so a mismatch between partials is rejected loudly. With the `string`
  comparison each partial also carries its `id -> exact key` table, so an id standing for two
  different functions is caught across packages too, not just within one. `TRIVIAL_NODES` and
  `NEAR_THRESHOLD` are applied in `finalize`, so **kept partials can be re-finalized** with
  different values without re-downloading anything.
- The merge keeps step 05's 6 GB heap setting.

`test/tier2-stream.test.mjs` asserts this equivalence on local fixture packages, running both modes
for real (offline) and comparing `unique_functions.jsonl`, `occurrences.csv`, `version_index.json`
and `summary.json` byte for byte.

### One JSON file per package

When a package finishes, its own function collection is written to
`05_deduplicated_functions/packages/<package>.json` and **always kept**:

```json
{ "package": "axios", "versions": ["…"], "settings": { … }, "summary": { … },
  "functions": [ { "id": "…", "text": "…", "textNorm": "…", "loc": 14, "metrics": { … }, "trivial": false,
                   "n_versions": 40, "n_occurrences": 41, "first": "0.18.0", "last": "1.7.2",
                   "ranges": [["0.18.0", "0.27.2"], ["1.0.0", "1.7.2"]],
                   "occurrences": { "1.7.2": [12] }, "raw_variants": 2, "parent_ids": [ … ], … } ],
  "version_index": { "1.7.2": ["…ids…"] } }
```

Each function has the same fields as in the merged `unique_functions.jsonl` and the same `id`, so
the two always line up. It is built by the same step-05 code (`deriveRecords`), so it cannot drift.
The merge step writes any that are missing (for packages streamed before this existed).

### `KEEP_ARTIFACTS`

In the settings this is a set of checkboxes, one per step: tick a step and **all** its files are
kept; untick it and they are deleted as soon as each package is done. **Logs are always kept** (shown
ticked and locked), as are the per-version records and group manifests. Stored as a comma list of the
intermediate artifacts to **keep**; the default is `03` (the pseudo-bundles are kept, everything
else intermediate is deleted). Kept artifacts are *moved* into the normal batch locations, so the layout is the same
as after a batch run.

| value | keeps | where |
|---|---|---|
| *(empty)* | nothing — only the per-package JSON files and the merged collection survive | — |
| `02` | the downloaded tarballs | `02_downloaded_packages/*.tgz` |
| `03` | the pseudo-bundles | `03_pseudo_bundles/bundles/*.js` |
| `04` | the per-version function files | `04_extracted_functions/*.functions.json` |
| `partials` | the per-package collect states, so the merge can be re-run with other `TRIVIAL_NODES` / `NEAR_THRESHOLD` values | `05_deduplicated_functions/partials/` |
| `all` | all of the above | |

Kept regardless, because they are small and are the only trace left once the intermediates are gone:

| file | what it is |
|---|---|
| `05_deduplicated_functions/versions/<pkgKey>.csv` | per version: `package, version, download, tgz_bytes, tgz_integrity, bundle, bundle_bytes, functions_total, functions_kept, status` |
| `05_deduplicated_functions/groups/<groupKey>.json` | the group's anchor, members and per-member status |
| `logs/stream/<pkgKey>/0{2,3,4}*.log` | that package's step logs (step 03's holds the file-selector `Fallback` warnings) |

### Resume

On start the stream step **deletes any leftover `_work/` dirs** (a killed run's half-finished package
is redone from scratch), skips every package that already has a partial, and retries the ones that
failed (a failed package deliberately leaves no partial). If the final outputs are already there and
no partials remain, both streamed steps report **"already complete"** and stop.

### `MINIFY` (both tiers, both modes)

The bundlers (tier-1 `03-bundle-and-sbom.mjs`, tier-2 `03_pseudo-bundle.mjs`) only read
`UNMINIFIED=1`; the settings used to pass `MINIFY`, which they never read, so `MINIFY=0` silently
produced minified bundles everywhere except tier 2's streamed mode. The bundlers are unchanged; the
**wiring** now passes `UNMINIFIED=1` whenever `MINIFY=0` (tier 1 steps 03/04 and the Claude repair
step, tier 2 batch step 03 and the streamed driver, and both `run-pipeline*.sh`). Defaults are
unaffected: tier 1 is minified by default (faithful to Aletheia), tier 2 un-minified by default.
Note: a tier-2 **batch** run with `MINIFY=0` now really is un-minified, so its output differs from a
batch run made before this fix.

### Steps in the UI

The step track is mode-aware: batch shows `01 … 05`, streamed shows

```
01     Build reference list (+ version expansion)
02–05  Stream packages (download → bundle → extract → collect)
05     Merge
```

A project saved before streamed mode existed has no `STREAM` key and keeps running in batch mode, so
it resumes exactly as before. (The control panel itself is described near the top of this file.)

## Tests

A granular regression suite (Node's built-in runner, no extra dependencies) covers each step of both tiers:

```bash
npm test        # = node --test test/*.test.mjs
```

What it checks, per step:
- **Shared** — `dep-classify` (tooling/types/runtime, pre-bundled heuristic, estimated-landed); the project layer (tier wiring, mode-aware clean-dir mapping).
- **Tier 1** — `lib-pipeline` buildCommand for every step in both modes + `dirs`/`stepDirs`; the Claude repair step (placement after bundling in both modes, command and bundler env, a real repair with a stand-in `claude` command that the unchanged bundler then bundles, an attempt to fake success by editing the check script being rejected, a missing `claude` command failing clearly); protected bundle folders (a clean redo archives them, never deletes them); `MINIFY=0` reaching the bundler; step 02c selection (flat, bucket distribution, basis landed-vs-declared, seed reproducibility); step 04 sample selection; step 05 bundled-deps CSV; step 03 webpack bundle + SBOM (runs when `webpack` is installed); step 06 function extraction + `--min-loc` (runs when `meriyah`/`escodegen` are installed).
- **Tier 2** — `lib-pipeline-2` buildCommand (incl. `preview`, `--selection` passthrough and step-05 flags) + `stepDirs`; the removal of version sampling (no `sample` option or sampling flags left) and the version helpers; step 01 base-set + inclusion selection (offline via `--versions exact`, incl. the "excluded-but-kept-as-dependency" rule); the file-selector root-manifest fix (nested-stub regression) and resilience; the §3.3 pseudo-bundler transform (Fix B keeps exports, `wrapJson`, `module([…])` wrapper); step 03 end-to-end (runs when the bundler deps are installed); step 04 function extraction; step 05 dedup (identity rules, version intervals/gaps, round-trip, near-duplicates, fallback keys — no extra deps), the `string` vs `hash` comparison (`functionKey` shape, identical output in both modes and both `DEDUP_MODE`s, id-collision refusal within a package and across partials) and its `collect`/`mergeStates`/`finalize` split (`dedup() == finalize(collect())` == merged per-package partials, byte for byte).
- **Tier 2 streamed mode** (`tier2-stream.test.mjs`) — batch vs streamed **byte-identical** output (default settings, and with `--mode exact --strict-type --near`); a dependency in two groups processed once and marked `reused`; `KEEP_ARTIFACTS=""` leaving no `.tgz`/bundle/`functions.json` and `"03"` leaving only bundles; re-finalizing kept partials with a different `TRIVIAL_NODES`; resume after a real `SIGKILL` mid-run (finished packages skipped, leftover work dir discarded, output equal to an uninterrupted run, then "already complete"); `MINIFY=0` really producing un-minified bundles; group order and `INCLUDE_PACKAGE=0`; a failed download leaving no partial. These run the real step scripts as child processes but **never touch the network**: step 02 is fed a local tarball cache (`--tgz-cache`), whose `.tgz` files it then skips exactly as it skips an already-downloaded package.

Tests that need a heavy dependency (`webpack`, `@swc/core`, `meriyah`, …) **skip cleanly** if it isn't installed, so `npm test` works before `npm install` and runs in full after it. The network-only steps (jsDelivr crawl, npm download) are intentionally not in the automated suite; everything they feed is exercised with local fixtures.

## Requirements

- Node 18+. Deps (installed by each tier's **Setup deps** button, or `npm install` at the root):
  tier 1 uses `webpack`, `meriyah`, `escodegen`, `source-map-js`; tier 2 uses `@swc/core`, `acorn*`, `astring`, `meriyah`, `escodegen`.
- Network: jsDelivr + npm registry (tier 1 steps 01–02); npm registry (tier 2 steps 01–02).
- Binds to `127.0.0.1` only (it runs shell commands).

## Layout

```
server.mjs            unified web server (projects, two tiers, atomic state)
public/index.html     the UI
lib-project.mjs       combines the two tier libs, project paths, auto-wiring
tier1/                first pipeline: 01-…06 scripts, 07-claude-repair-bundles.mjs (optional),
                      run-pipeline.sh, lib-pipeline.mjs
tier2/                reference pipeline: 01_…05_ scripts (batch), 06_stream-packages.mjs +
                      07_merge-partials.mjs (streamed), run-pipeline-2.sh, lib-pipeline-2.mjs, lib/
```

Each tier's scripts and `run-pipeline*.sh` still work on their own from inside `tier1/` and `tier2/`.
