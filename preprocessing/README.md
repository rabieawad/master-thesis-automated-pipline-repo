# Thesis pipeline — one project, two chained tiers

A **project** is made of two sub-pipelines that run one after the other:

- **Tier 1 · Data preparation** (6 steps): crawl top packages → download → bundle+SBOM → select sample → collect → extract functions.
- **Tier 2 · Reference dataset** (5 steps): build version list → download → pseudo-bundle → extract functions → deduplicate functions across versions.

**Tier 2's input is wired automatically to tier 1's output** — you never type a directory. You configure tier 2 *after* tier 1 has produced output (its parameters are edited later).

### Tier-2 preview and inclusion selection

- **Preview downloads** (tier-2 button): a dry-run of step 01 that reports how many `name@version`
  *will be downloaded* for the current settings (plus a by-origin split, a `PER_MINOR_N` sweep, and
  the biggest anchors) and writes `preview.json`/`preview.csv` — **without** downloading or writing
  the real list.
- **Reference set — what to include** (tier-2 panel): the survived items from tier 1 (each selected
  package + its bundled dependencies). Per-package toggles choose whether to include the package and
  whether to include its dependencies, with *all packages* / *all deps* master toggles. Default is
  everything. Excluding a package only drops it as a top-level anchor — it still enters the set if
  another included package bundles it as a dependency. The saved selection feeds both the Preview
  count and the real step-01 build (via `selection.json` → `--selection`).

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

- `all` — every stable version (all majors/minors/patches), the paper's full index.
- `sample` — **cap big histories.** Packages with ≤ `SAMPLE_THRESHOLD` (default 50) versions are
  taken whole; above that, a **seeded** strategy samples. Reproducible via `SEED`; the observed
  version is always kept. Two pluggable strategies (`--sample-strategy` / `SAMPLE_STRATEGY`):
  - **`minor-window`** (default, simple): for each major.minor line, pick one random anchor patch,
    then keep a contiguous window of `PER_MINOR_N` (4) patches next to it — so a line yields up to
    `PER_MINOR_N + 1` versions. Lower `PER_MINOR_N` caps harder.
  - **`minor-adjacent`** (older): keep the observed version + `ADJACENT_N` nearest neighbours, then
    `PER_MINOR_N` patches per major.minor group chosen 50/50 random-vs-contiguous.
- `minor` / `latest` / `exact` — same-minor patches / newest only / exact recorded version.

## Tier-2 step 05: deduplicate functions across versions

Most functions are unchanged between consecutive versions, so step 04's output repeats the same
function hundreds of times. Step 05 collapses it into **one record per distinct function** and keeps
the **version intervals** each one appears in — so you embed each function once and can assign it back
to its versions (e.g. 310,837 instances → 7,637 unique functions on 906 Sentry versions, ~10 s).

**Identity** is an exact string match, no fuzziness: `sha256(signature + body)[:24]`.
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

## UI

- Left: projects list with a progress row per tier (T1 / T2).
- Select a project → switch between **Tier 1** and **Tier 2**, each with its own state table, run controls, live + saved logs, a bash **Console** (runs in that tier's output folder), and an **Outputs** file list.
- Edit a tier's parameters anytime it isn't running.
- Larger, higher-contrast text throughout.

## Tests

A granular regression suite (Node's built-in runner, no extra dependencies) covers each step of both tiers:

```bash
npm test        # = node --test test/*.test.mjs
```

What it checks, per step:
- **Shared** — `dep-classify` (tooling/types/runtime, pre-bundled heuristic, estimated-landed); the project layer (tier wiring, mode-aware clean-dir mapping).
- **Tier 1** — `lib-pipeline` buildCommand for every step in both modes + `dirs`/`stepDirs`; step 02c selection (flat, bucket distribution, basis landed-vs-declared, seed reproducibility); step 04 sample selection; step 05 bundled-deps CSV; step 03 webpack bundle + SBOM (runs when `webpack` is installed); step 06 function extraction + `--min-loc` (runs when `meriyah`/`escodegen` are installed).
- **Tier 2** — `lib-pipeline-2` buildCommand (incl. `preview`, `--selection` passthrough and step-05 flags) + `stepDirs`; version sampling (`minor-window`/`minor-adjacent`, threshold, reproducibility, sweep monotonicity); step 01 base-set + inclusion selection (offline via `--versions exact`, incl. the "excluded-but-kept-as-dependency" rule); the file-selector root-manifest fix (nested-stub regression) and resilience; the §3.3 pseudo-bundler transform (Fix B keeps exports, `wrapJson`, `module([…])` wrapper); step 03 end-to-end (runs when the bundler deps are installed); step 04 function extraction; step 05 dedup (identity rules, version intervals/gaps, round-trip, near-duplicates, fallback keys — no extra deps).

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
tier1/                first pipeline: 01-…06 scripts, run-pipeline.sh, lib-pipeline.mjs
tier2/                reference pipeline: 01_…05_ scripts, run-pipeline-2.sh, lib-pipeline-2.mjs, lib/
```

Each tier's scripts and `run-pipeline*.sh` still work on their own from inside `tier1/` and `tier2/`.
