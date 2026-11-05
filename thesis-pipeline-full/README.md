# Thesis pipeline — one project, two chained tiers

A **project** is made of two sub-pipelines that run one after the other:

- **Tier 1 · Data preparation** (6 steps): crawl top packages → download → bundle+SBOM → select sample → collect → extract functions.
- **Tier 2 · Reference dataset** (4 steps): build version list → download → pseudo-bundle → extract functions.

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
  tier2/output/           reference pipeline output (01_… … 04_…)
  tier2/logs/01.log …04.log
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
- **Tier 2** — `lib-pipeline-2` buildCommand (incl. `preview` and `--selection` passthrough) + `stepDirs`; version sampling (`minor-window`/`minor-adjacent`, threshold, reproducibility, sweep monotonicity); step 01 base-set + inclusion selection (offline via `--versions exact`, incl. the "excluded-but-kept-as-dependency" rule); the file-selector root-manifest fix (nested-stub regression) and resilience; the §3.3 pseudo-bundler transform (Fix B keeps exports, `wrapJson`, `module([…])` wrapper); step 03 end-to-end (runs when the bundler deps are installed); step 04 function extraction.

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
tier2/                reference pipeline: 01_…04_ scripts, run-pipeline-2.sh, lib-pipeline-2.mjs, lib/
```

Each tier's scripts and `run-pipeline*.sh` still work on their own from inside `tier1/` and `tier2/`.
