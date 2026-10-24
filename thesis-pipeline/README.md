# Thesis pipeline — one project, two chained tiers

A **project** is made of two sub-pipelines that run one after the other:

- **Tier 1 · Data preparation** (6 steps): crawl top packages → download → bundle+SBOM → select sample → collect → extract functions.
- **Tier 2 · Reference dataset** (4 steps): build version list → download → pseudo-bundle → extract functions.

**Tier 2's input is wired automatically to tier 1's output** — you never type a directory. You configure tier 2 *after* tier 1 has produced output (its parameters are edited later).

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

Per tier you can **Run whole tier**, **Continue** (from the first unfinished step), or run **a single step**. State (status / started / duration / exit code) and per-step logs are saved, written atomically, and survive a server restart (a step left mid-run is marked interrupted; Continue resumes).

## UI

- Left: projects list with a progress row per tier (T1 / T2).
- Select a project → switch between **Tier 1** and **Tier 2**, each with its own state table, run controls, live + saved logs, a bash **Console** (runs in that tier's output folder), and an **Outputs** file list.
- Edit a tier's parameters anytime it isn't running.
- Larger, higher-contrast text throughout.

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
