# Thesis pipeline — one project, three chained tiers

A **project** is made of three sub-pipelines that run one after the other:

- **Tier 1 · Data preparation** (6 steps, +1 optional): crawl top packages → download → bundle+SBOM → *(optional: Claude repair of failed bundles)* → select sample → collect → extract functions.
- **Tier 2 · Reference dataset** (5 steps): build version list → download → pseudo-bundle → extract functions → deduplicate functions across versions.
- **Tier 3 · Detection** (3 steps): build a search index from tier 2 → detect which packages and versions are in each tier-1 bundle → report the metrics against the bundles' SBOMs. See [Tier 3](#tier-3--detection-which-packages-and-versions-are-in-a-bundle).

**Tier 2's input is wired automatically to tier 1's output, and tier 3's to both** — you never type a directory. You configure tier 2 *after* tier 1 has produced output (its parameters are edited later).

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
  include), *Report* (tier 3: step 03's `report.md`) and *Console* (a shell in the tier's output folder).
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
  "explanation": "brief, Claude's own words: at most 3 sentences (400 characters)" }
```

The **outcome is what the unchanged bundler proves**, never only Claude's claim: if Claude says
"repaired" but the bundler still fails, it is recorded as `not_repaired` with a note. A missing or
malformed report is recorded as such (`report_valid: false`) and the category falls back to the one
derived from the original error. Each package's normalized record is `claude_repair/<package>/repair.json`
(standard fields + Claude's full explanation), and every package — repaired, failed, skipped or
bundled — gets one standard log line:

```
RESULT | <name>@<version> | <outcome> | <category> | <cause or details>
```

and every package Claude worked on gets the same fixed block under it, fields always in this order:

```
RESULT | some-pkg@1.2.0 | repaired | missing_dependency | the entry imports 'left-out', which is not installed
    bundler     : 1 dependencies bundled, 2143 bytes
    changes     : added pkg/node_modules/left-out (1 file(s) differ)
    explanation : The bundler could not resolve 'left-out'. I installed it at the requested range and try-bundle.sh printed BUNDLE_OK.
    note        : -
    record      : claude_repair/some-pkg/repair.json
```

The explanation is asked to be brief; a longer one is cut to 400 characters in the log and in
`report.csv` (which has an `explanation` column) and noted, and kept in full in `repair.json`.

Settings: packages per run (`CLAUDE_MAX_PACKAGES`, 20), turns per package (40), spending cap per
package in USD (blank = none), time limit (20 min), model (blank = Claude Code's default), and the
Claude command. Claude Code must be installed and signed in (`npm i -g @anthropic-ai/claude-code`,
then run `claude` once). Re-running the step skips packages already repaired. For the thesis, report
the repaired packages separately: their *input* was modified, even though the bundler was not.

## Tier 1: dependencies that don't exist on npm (`SKIP_MISSING_DEPS`, off)

Some published packages list dependencies that were never published (e.g. `@finsweet/fs-components`
lists 15 internal `core-…` packages; its own code does not use them). pnpm then cannot install the
package at all — in Aletheia's setup too — so with the setting **off** (faithful) it is recorded as
`download_failed`, with pnpm's own reason (`ERR_PNPM_FETCH_404 … not in the npm registry`).

With it **on**, when pnpm stops because a dependency (or the requested version of it) does not exist,
the download installs again without that dependency, using pnpm's own `overrides` (`"-"` = remove), as
often as needed. The bundler is unchanged. The package's outcome is **`bundled_without_missing_deps`**,
and the names left out are in its record, its `.meta.json` and the bundling summary
(`missingDepsRemoved`) — report these packages separately, like the Claude repairs.

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
4. **delete** the download, the unpacked package and pnpm's cache for it.

A package the bundler fails on is **postponed** when `CLAUDE_REPAIR` is on: its download is parked in
`02_downloaded_packages/_postponed/<package>/` (logged as `bundle_failed … postponed for Claude repair`)
and the stream moves on. **After every package has been streamed**, Claude repairs the postponed ones
one after another (at most `CLAUDE_MAX_PACKAGES` per run), and each parked download is deleted as
soon as its repair is done. Packages over the limit, or left by a stopped run, stay parked and are
repaired on the next run, without streaming anything again.

**Kept:** bundles and source maps, SBOMs and module reports, extracted functions (step 06), Claude's
reports, logs (`03_bundles_minified/stream/logs/<package>/`), one record per package
(`stream/records/`, also the resume marker) and `stream/results.csv` (one standard row per package:
outcome, category, cause, dependencies bundled, bundle size, the entry the check found).
`summary.json/.csv` and `manifest.jsonl` are rebuilt in step 03's exact format, so selection (04),
collect (05) and extraction (06) run unchanged. Under **Also keep**, tick *Downloaded packages* to
keep the `.tgz` files.

**Disk errors while cleaning up never stop the run.** Each package is unpacked and bundled in a
temporary folder with thousands of small files. If deleting it fails (e.g. `EIO` on a failing or
network/USB drive), the delete is retried, then the folder is moved aside to `…_stream-undeleted`
(deleted again at the end of the run), and the next package starts. **Temporary folder for
bundling** (`WORK_DIR`) puts that folder on another disk, e.g. `/tmp` — use it when the output drive
gives I/O errors; only the finished bundles, SBOMs and logs are then written to the output drive.

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
- **Open an existing project** — a project made earlier somewhere else (e.g. the `projects` folder of an
  older copy of the pipeline). Give the project's folder, any folder inside it, or a whole `projects`
  folder. Projects open **where they are** (nothing is copied; the link is kept in
  `projects/opened-projects.json`) and continue from their first unfinished step; steps added by newer
  versions are filled in as *not run*, and a step left running is marked interrupted. **Remove** takes an
  opened project off the list and leaves its files. To use another projects folder as the main one,
  start the server with `PROJECTS_DIR=/path/to/projects node server.mjs`.
- **Damaged projects are listed, not hidden.** Every save keeps the previous good `project.json` as
  `project.json.bak`; if `project.json` cannot be read (e.g. after a disk error) the backup is used, and if
  neither can be read the project is shown with the reason so you can fix or delete it.
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

## Packing step outputs into `.tgz` (`PACK_OUTPUTS`, on, every tier)

When a run ends (finished, failed or stopped), each step's **per-package files** are packed into one
`.tgz` per kind, next to where they were; before the next run they are unpacked automatically, so
every step always works on plain files. Paths inside an archive are unchanged (`tar -xzf bundles.tgz`
in its folder gives the files back). By hand: `node lib-pack.mjs pack|unpack tier1|tier2|tier3 <output folder>`.

| tier | archive | holds |
|---|---|---|
| 1 | `02_downloaded_packages/packages.tgz` | kept downloads (`.tgz` + `.meta.json`) |
| 1 | `03_bundles_minified/bundles.tgz`, `sbom.tgz`, `modules.tgz` | bundles + source maps, SBOMs, module reports |
| 1 | `03_bundles_minified/claude_repair/workspaces.tgz` | Claude's per-package folders |
| 1 | `03_bundles_minified/stream/records.tgz` | one record per package |
| 1 | `05_selected_bundles/bundles.tgz`, `sbom.tgz`, `modules.tgz` | the selected bundles |
| 1 | `06_extracted_functions/functions.tgz` | `<bundle>.functions.json` |
| 2 | `02_downloaded_packages/packages.tgz` | kept downloads |
| 2 | `03_pseudo_bundles/bundles.tgz` | pseudo-bundles |
| 2 | `04_extracted_functions/functions.tgz` | per-version function files |
| 2 | `05_deduplicated_functions/packages.tgz`, `lineages.tgz`, `partials.tgz`, `versions.tgz`, `groups.tgz` | `packages/<package>.json`, `lineages/<package>.json` and the per-package records |
| 3 | `02_detections/bundles.tgz` | `<bundle>.json`, the detections per bundle |

A tier-3 run reads tier 1's `06_extracted_functions/functions.tgz`, `05_selected_bundles/bundles.tgz` and
`sbom.tgz` and tier 2's `packages.tgz` and `lineages.tgz`: it unpacks just those before it starts and packs
them again when it ends (if that tier packs its outputs). Tier 3 never runs at the same time as tier 1 or 2.

**Never packed:** logs, and the small files that are not per package: lists, summaries, manifests,
CSV/JSON reports, `stream/results.csv`, Claude's `report.csv`/`report.json`, and the merged
`unique_functions.jsonl`. Switch `PACK_OUTPUTS` off to keep everything as plain files (the next run
still unpacks what was packed before).

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

## Tier-2 step 06 (streamed): function lineages — history and markers (`LINK_EDITS`, on)

Not part of Aletheia or Debun: an addition of this thesis, for version detection. Within each
package, the edited versions of every function are linked into a **lineage**, its whole history is
recorded, and checked code **markers** say which variant (and so which versions) a function is.

**Files**
- `lineages/<pkg>.json` (new, next to `packages/`): `{ package, versions, settings, source,
  summary, function_index, lineages: [...] }`. `function_index` maps every function id to its
  lineage; `source` is the package file it was made from.
- `packages/<pkg>.json`: only a `lineage` tag is added to each function (the id of the lineage's
  first variant). Nothing else changes.
- `unique_functions.jsonl`: each record's `packages.<pkg>` entry gets `lineage`.

**One lineage**
```json
{ "lineage": "3fac0422…", "born": "1.0.0", "last_seen": "3.3.2", "status": "alive",
  "variants": [ { "id": "3fac0422…", "versions": [["1.0.0","1.0.0"]] }, … ],
  "events": [
    { "version": "1.0.0", "type": "born", "ids": ["3fac0422…"] },
    { "version": "1.0.1", "type": "edited", "from": "…", "to": "…", "similarity": 0.955, "kind": "added",
      "parts": {"added":1,"removed":0,"replaced":0}, "tokens_added": 4, "tokens_removed": 0,
      "changes": [ { "type": "added", "after": "defaultProps : ! 0 ,", "context": "! 0 ," } ] }, … ],
  "markers": [
    { "code": "! 0 , defaultProps : ! 0 , displayName : !", "origin": {"change": "added", "version": "1.0.1"},
      "variants": ["…"], "present": [["1.0.1","3.3.2"]], "absent": [["1.0.0","1.0.0"]], "in_rule": true, "elsewhere": 0 }, … ],
  "identify": { "<variant id>": { "versions": [...], "contains": ["…"], "lacks": ["…"], "unique": true } } }
```
- **Events:** `born`, `edited`, `reverted` (back to an earlier variant), `removed` (absent from that
  version on), `reappeared` (back after a gap). An edit's `kind` is `added`, `removed`, `replaced`,
  `mixed` (a combination; `parts` counts each), `variables_only` or `too_large` (> 4000 tokens).
- **Markers:** each change proposes small pieces of normalized code with a few tokens of context —
  the new code, the old code, and for a pure addition/removal the old/new adjacency. Every candidate
  is then tested on **every** variant, so `present`/`absent` are checked facts within the lineage's
  versions. `elsewhere` (for markers used in a rule) counts other functions of the package that
  also contain it.
- **Identify:** for each variant, the fewest markers (`contains` / `lacks`, at most
  **Markers per variant rule**, 3) that tell it from every sibling. When none can, `unique: false`,
  with `also_matches`, `versions_if_matched` and the reason (e.g. the same code once the numbering
  is ignored).
- **Marker test** (also in `settings.marker_test`): tokens of `textNorm`, `v0, v1, …` masked to `v`,
  space separated; a marker is present when `" " + marker + " "` occurs in `" " + tokens + " "`.

**For matching:** `matchVariants(lineage, textNorm)` in `tier2/lib/lineage.mjs` tests every marker
of a lineage on any function's normalized code and returns `exact` (variants agreeing with every
marker), their `versions`, and `ranked` (every variant by the share of markers it agrees with — for
code that is close but not identical).

**Linking**, for each pair of consecutive versions: functions in both are anchors; a function only
in the older and one only in the newer version are compared if they sit between the same or
neighbouring anchors; score = 0.7 × token-bigram similarity of `textNorm` + 0.3 × overlap of
strings, property names and globals; best pairs first, one-to-one, score ≥ **Minimum similarity**
(0.5). Trivial functions take part only with **Link trivial functions too**.

**On the 147-package reference set** (11,875 versions, 196,155 unique functions, about 5 minutes;
the largest package, `@clerk/clerk-js`, 60 s): 99,299 lineages, 31,036 with edits; 95,924 edits and
9,526 reverts (mixed 33.1%, replaced 32.5%, added 19.7%, removed 8.2%, variables only 4.0%, too
large 2.4%); 701,014 markers; **92.2% of the 127,892 variants in edited lineages are identifiable by
markers**. Checked on all of them: the matcher finds every variant from its own code, and picks only
that variant whenever its rule says unique. Lineage files: 554 MB (package files: 1.7 GB). Links
are similarity-based and not yet checked against an answer key.

Resumable: a package already done with the same settings from the same package file is skipped.
By hand: `node tier2/08_link-edits.mjs <05_deduplicated_functions> [--min-similarity 0.5] [--include-trivial] [--max-rule 3]`.

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

## Tier 3 · Detection: which packages and versions are in a bundle

Tier 3 takes tier 1's bundles (the test bed) and tier 2's reference dataset, and decides for every
bundle **which packages are inside it and which version of each** — a single version where the
code tells them apart, otherwise a range of versions that are all possible. Tier 1's SBOMs are the
ground truth it is measured against. Nothing in tier 3 is part of Aletheia or Debun; it only reads
their outputs.

| step | script | reads | writes |
|---|---|---|---|
| 01 · Build the search index | `01_build-index.mjs` | tier 2 `05_deduplicated_functions/packages/`, `lineages/` | `01_index/` (`meta.json`, `records.json`, `sigs.bin`, `lineages/`) |
| 02 · Detect packages and versions | `02_detect.mjs` | the index; tier 1 `06_extracted_functions/`, and for the evaluation `05_selected_bundles/sbom/` and `bundles/` (source maps) | `02_detections/bundles/<bundle>.json` |
| 03 · Report | `03_report.mjs` | step 02's files | `03_report/report.md`, `summary.json`, `detections.csv`, `evaluation.csv` |

Step 01 keeps its index while tier 2's files are unchanged (names, sizes, times); step 02 skips a
bundle already done with the same settings and index, so changing a setting and choosing *Redo from
step 02* redoes only what changed. The *Report* tab shows `report.md`.

### How a bundle is read

1. **Match** every non-trivial bundle function (the same `trivial_nodes` rule as tier 2) against the
   reference: **exactly**, by tier 2's own fingerprint (signature + normalized code), and
   **approximately**, because webpack minifies with Terser and the reference was minified by swc, so
   the same source often comes out slightly different. Approximate matching uses a MinHash sketch
   (64 values, one-permutation hashing with densification) of the code's 3-token shingles with local
   names masked, and LSH (21 bands × 3 rows; a candidate must share 2 bands) to avoid comparing all
   pairs; a match needs an estimated similarity ≥ `MIN_SIM` (0.5).
2. **Weigh** each match: similarity × specificity × size. Specificity is 1 − log k / log P (a function
   found in k of P indexed packages proves less the more packages have it); a function found in more
   than `MAX_SHARED` (30) packages — Babel/TypeScript helpers, the webpack runtime inside prebuilt
   builds — proves nothing. Size: tiny functions (< 40 tokens) count less.
3. **Choose packages, explaining away.** Coverage of a package = the share of its own non-trivial
   functions (at its best version) that the bundle matches. A package is accepted with enough
   evidence (`MIN_EVIDENCE` 1.5 from ≥ 2 functions, coverage ≥ `MIN_COVERAGE` 0.05), or — small
   packages that can't reach that evidence — with coverage ≥ `SMALL_COVERAGE` (0.5). The next package
   is always the best-covered one: a real library covers a large share of itself, a prebuilt
   mega-bundle that holds copies of many libraries covers a tiny share of itself, so the libraries
   are chosen first and take their functions. A chosen package *explains* the functions it matches
   about as well as anyone; they no longer count for later packages — except that a package whose
   code an earlier one holds a copy of (a UMD build with its dependencies inside) is still found
   when the bundle covers ≥ `SHARE_COVERAGE` (0.5) of it.
4. **Versions, by intersection.** The functions that are the package's own (it matches them about
   as well as any package found in the bundle, and no other found package matches them as well —
   quill 1.x's prebuilt build held eventemitter3, so eventemitter3's functions in a quill 2 bundle
   must not count for quill) are each consistent with a set of versions: the versions of the
   record a function matches exactly; for an approximate match, the records within 0.05 of its best
   similarity (64-value sketches estimate similarity only to a few hundredths); in
   **approx+lineage** mode, the lineage variant whose markers the bundle's code has. The package's
   versions are the **intersection** of those sets: one version is the exact version, several are
   the range (the newest is given as the guess). When the functions contradict each other (empty
   intersection), the range is the versions consistent with the most functions and the functions
   that disagree are listed (`conflictFunctions`); `VERSION_FALLBACK=union` gives every function's
   versions instead, and that union is always written as `unionRange`. `VERSION_METHOD=vote` is the
   older alternative: each version scores the evidence of the functions consistent with it.

Three **modes** are computed from the same matches so they can be compared: `exact` (fingerprints
only), `approx`, `approx+lineage`.

### How it is measured

Package level against the SBOM (root + components): TP, FP, FN, precision, recall, F1; packages that
are not in the index are counted apart. Version level for every TP: exact version, true version in
the range, range size — split into the bundle's own package and its dependencies.

**Function level, from the source maps.** webpack keeps `node_modules/.pnpm/<name>@<version>/…` in
every source path, so each bundle function's true package is known. That gives the attribution
accuracy (of the functions a detected package explains, the share that really come from it), and a
reason for every error:

| missed package (FN) | |
|---|---|
| no functions in the bundle | its modules hold no non-trivial function |
| reference lacks the code | none of its bundled functions matches its reference |
| explained by *X* | most of its matchable functions went to package *X* |
| too little evidence | matchable, but below the thresholds |

| wrongly found (FP) | |
|---|---|
| vendored copy inside *Q* | its functions come from a file of *Q* named after it (element-ui ships `lib/utils/lodash.js`): the code is there, the SBOM can't know |
| embedded in a file of *Q* | ≥ 80 % of them come from one file of *Q*, a prebuilt build holding a copy (`algoliasearch.umd.js` holds the `@algolia/*` clients, `quill/dist/quill.js` holds parchment) |
| holds a copy of *Q* | the other way round: the detected package covers < 25 % of itself; its reference is a prebuilt build that holds *Q* (mealz-components holds lit) |
| same code as *Q* | otherwise from *Q* (lodash found for lodash-es) |
| shared or generic code | no package dominates |

### Results on 44 real bundles

44 bundles of 24 popular packages (the latest version of each, and an older one of 20), built by
tier 1. Reference: a real tier-2 dataset of 147 packages, every version (191,627 non-trivial
functions) — 99 of the bundles' 103 packages, plus 48 others that act as distractors (prebuilt
bundles such as `@clerk/clerk-js` that hold copies of many libraries). Of the 26,420 non-trivial
bundle functions, 50 % match exactly, 35 % only approximately, 15 % not at all.

| mode | precision | recall | F1 | version exact | version in range | median range |
|---|---|---|---|---|---|---|
| exact | 0.856 | 0.483 | 0.618 | 0.804 | 0.918 | 2 |
| approx | 0.844 | 0.646 | 0.732 | 0.832 | 0.916 | 2 |
| approx+lineage | 0.844 | 0.646 | 0.732 | **0.840** | **0.924** | **1** |

When all of a package's functions agree (72 of the 131 correctly found packages, approx+lineage),
the true version is inside their intersection 70 times, and the 36 times the intersection is a
single version it is the right one every time. When they contradict (59), it is typically because
of 3 functions (median): approximate matches across two minifiers (webpack's Terser, tier 2's swc),
lineage markers that describe swc's formatting, another package's code, or tier 2's reference
lacking the newer code.

Counting vendored and embedded copies as right (their code is in the bundle; the SBOM can't know),
precision is 0.913; leaving out packages whose bundled code cannot be matched at all, recall is
0.718. Function attribution accuracy is 0.86 (approx). Step 02 takes 30 s for the 44 bundles (the
index loads in 1.5 s); step 01 builds the index in 31 s. The tuning history (F1 0.431 → 0.732), an
ablation of every rule and the per-bundle results are in
[`tier3/RESULTS-testbed.md`](tier3/RESULTS-testbed.md). The thresholds were tuned on these same
bundles; the ablation shows each rule's effect.

**What limits it, from the error reasons:** tier 2's reference lacks code for packages whose
`exports` lead to an ES-module build, because Aletheia drops `export` declarations: the reference of
`@tanstack/query-core` has 398 non-trivial functions at 4.36.1 and 95 at 5.0.0, `@opentelemetry/core`
164 at 2.12.1 and 44 at 3.1.1, stylis 4 has 6 for about 50 in its bundles — so stylis is missed
and the newest versions of the others are recognised as an older one. Then packages whose reference is a different build than
the one webpack picks (react-dom's development + production files), and prebuilt bundles of other
packages (`mealz-components` holds lit) that compete for the same code.

### Settings (*Settings* on the Tier 3 tab)

`MODES`, `EVALUATE` (off = detections only, for bundles without an SBOM), `PACK_OUTPUTS`; matching:
`MIN_SIM`, `MIN_BANDS`, `MAX_SHARED`; packages: `MIN_EVIDENCE`, `MIN_FUNCTIONS`, `MIN_COVERAGE`,
`SMALL_COVERAGE`, `SHARE_COVERAGE`; versions: `VERSION_METHOD` (`intersect` or `vote`),
`VERSION_FALLBACK` (`most` or `union`), and for voting `VERSION_TOLERANCE`, `VERSION_PICK`
(`latest` or `parsimony`).

### By hand

```bash
node tier3/01_build-index.mjs <tier2 out>/05_deduplicated_functions out3/01_index
node tier3/02_detect.mjs --index out3/01_index --functions <tier1 out>/06_extracted_functions \
     --bundles <tier1 out>/05_selected_bundles/bundles --sbom <tier1 out>/05_selected_bundles/sbom \
     --out out3/02_detections [--modes approx+lineage] [--opts '{"minSim":0.6}'] [--no-evaluate]
node tier3/03_report.mjs out3/02_detections out3/03_report
# compare option sets on the same matches (tuning, ablation):
node tier3/tools/sweep.mjs --index out3/01_index --functions … --bundles … --sbom … \
     --variants '[{}, {"minSim":0.6}, {"shareCoverage":1e9}]'
```

Each `02_detections/bundles/<bundle>.json` holds, per mode, every detected package with its version,
range, evidence, coverage, the bundle functions it explains (`explains`, indices into the tier-1
functions file) and, with an SBOM, the evaluation rows with their reasons.

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
- **Tier 3** (`tier3-lib.test.mjs`, `tier3-real.test.mjs`) — sketches (renumbered locals give similarity 1, a one-token edit stays above 0.6, unrelated code below 0.2) and LSH with 1 and 2 bands; every decision rule on a hand-made index: coverage-first explaining away (a mega-bundle holding a library's copy does not take its functions; evidence-first ordering would), shared code of a UMD build, the small-package path, `maxShared`, `minSim`, newest-among-equals vs parsimony, versions by intersection (a range, a single pinned version, contradicting functions with the most-agreed versions or the union, the conflicting functions listed), only the package's own code deciding its version, and the lineage markers deciding the variant of an approximate match; source-map decoding (VLQ, negative deltas, pnpm paths with versions and peers) and attribution; the SBOM truth, every evaluation status, the metrics and every error reason. **On real examples** (`test/fixtures/tier3`, 224 KB gzipped: tier 2's reference for copy-to-clipboard, toggle-selection, throttle-debounce and eventemitter3, and tier 1's real webpack bundles of them with source maps and SBOMs, plus a made-up carrier package holding a copy of all four): the three steps as child processes — index kept while up to date and rebuilt when tier 2's files change; copy-to-clipboard@3.3.3 found with toggle-selection@1.0.6, both versions in range; throttle-debounce's exact versions; the carrier never detected; the source map attributing the real bundle's functions (4 + 4 + 10 webpack runtime); resume and redo on new settings; `--no-evaluate`; the report and CSVs; the project wiring and the whole tier through its `all` command; packing tier 3's files and only the borrowed tier-1 archives; the sweep tool. The server test checks that an old project gets tier 3 with its defaults, the report endpoint, and a clear error when tier 3 runs without tier 2's output.

Tests that need a heavy dependency (`webpack`, `@swc/core`, `meriyah`, …) **skip cleanly** if it isn't installed, so `npm test` works before `npm install` and runs in full after it. The network-only steps (jsDelivr crawl, npm download) are intentionally not in the automated suite; everything they feed is exercised with local fixtures.

## Requirements

- Node 18+. **Run `npm ci` once in this folder** (or *More → Install the pipeline's tools*): it installs every
  tool at the exact versions in `package-lock.json` (webpack 5.112.2, meriyah 7.0.0, escodegen 2.1.0, @swc/core …),
  which is what faithfulness was checked with. The zip has no `node_modules`, so do this after unzipping into a
  new folder. The streamed step stops with a clear message if a tool is missing, prints the webpack version it
  uses, and warns if it is not the pinned one (e.g. a leftover `tier1/node_modules` — delete it).
- Packages that fail for a reason of the machine (download failed, disk error, missing tool) are **tried again on
  Continue**; only real package outcomes count as done.
- **Bundler self-test:** before any package, the streamed step bundles a tiny test package with the real,
  unchanged bundler. If that fails (e.g. a damaged `node_modules`: `TypeError: … is not a function` inside
  webpack's minifier), the run stops with the fix (`npm ci`) instead of failing — or sending to Claude — every
  package. Each record notes that the self-test passed (`toolsOk`); a `bundler_crash` recorded without it is
  tried again.
- Network: jsDelivr + npm registry (tier 1 steps 01–02); npm registry (tier 2 steps 01–02).
- Binds to `127.0.0.1` only (it runs shell commands).

## Layout

```
server.mjs            unified web server (projects, three tiers, atomic state)
public/index.html     the UI
lib-project.mjs       combines the three tier libs, project paths, auto-wiring
lib-pack.mjs          packs each step's per-package files into .tgz at the end of a run, unpacks before the next
tier1/                first pipeline: 01-…06 scripts, 07-claude-repair-bundles.mjs (optional),
                      run-pipeline.sh, lib-pipeline.mjs
tier2/                reference pipeline: 01_…05_ scripts (batch), 06_stream-packages.mjs +
                      07_merge-partials.mjs + 08_link-edits.mjs (streamed; lineages: lib/lineage.mjs),
                      run-pipeline-2.sh, lib-pipeline-2.mjs, lib/
tier3/                detection: 01_build-index.mjs, 02_detect.mjs, 03_report.mjs, lib-pipeline-3.mjs,
                      lib/ (sketch, index, detect, sourcemap, evaluate), tools/sweep.mjs,
                      RESULTS-testbed.md (the evaluation on 44 real bundles and how the algorithm got there)
```

Each tier's scripts and `run-pipeline*.sh` still work on their own from inside `tier1/` and `tier2/`, and tier 3's from anywhere.
