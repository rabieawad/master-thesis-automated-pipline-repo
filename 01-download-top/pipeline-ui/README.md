# First pipeline — data preparation (with web UI + CLI wizard)

This is the **first** pipeline from the PDF (crawl → download → bundle → select →
collect → extract functions), made more flexible and wrapped with two optional
front-ends. The second pipeline (reference dataset) is not included here.

## Three ways to run it — all do the same thing

1. **Web control panel** (asks for parameters in the browser, live logs, console):
   ```bash
   node server.mjs           # then open http://127.0.0.1:5173
   ```
2. **Interactive terminal wizard** (asks for each parameter, then runs):
   ```bash
   node wizard.mjs
   node wizard.mjs --defaults            # skip questions, use defaults, run all
   node wizard.mjs --TOP_N=100 --DOWNLOAD_LIMIT=100 --defaults
   ```
3. **Plain scripts / shell** (unchanged way, nothing extra needed):
   ```bash
   ./run-pipeline.sh
   TOP_N=100 DOWNLOAD_LIMIT=100 ./run-pipeline.sh
   node 04-select-sample40.mjs output/03_bundles_minified/summary.json --n 10 --min 0 --max 50
   ```

The wizard and the web UI are only convenience layers — they shell out to the same
`01..06` scripts and `run-pipeline.sh`, which keep working entirely on their own.

## What changed from your previous version (flexibility)

| Want | How |
| --- | --- |
| Pick **how many to download** | `DOWNLOAD_LIMIT` (`all` or a number) |
| Pick **how many to select** (stage 04) | `SAMPLE_N` |
| **Download + bundle zero-dependency packages by default** | now the default. Script `02` default flipped: zero-dep packages are downloaded unless you set `INCLUDE_ZERO_DEP=0` (web UI: untick the box; script directly: `ONLY_WITH_DEPS=1`) |
| **Stage 04 range "0 to N"** | `MIN_DEPS` now defaults to **0** (was 1); `MAX_DEPS` is any number you set (was fixed at 20) |

Everything else (source maps, SBOMs, memory handling, resume-on-rerun) is unchanged.

## All parameters

| Parameter | Default | Meaning / step |
| --- | --- | --- |
| `TOP_N` | 1500 | how many top packages to crawl (01) |
| `PERIOD` | month | jsDelivr stats period: day/week/month/year (01) |
| `DOWNLOAD_LIMIT` | all | how many packages to download (02) |
| `INCLUDE_ZERO_DEP` | 1 | download + bundle packages with no dependencies too (02); `0` = only with deps |
| `CONC` | 4 | parallel downloads (02) |
| `BUNDLE_CONC` | 1 | packages bundled at once (03) |
| `MINIFY` | 1 | minify bundles (03) |
| `SAMPLE_N` | 40 | how many packages to pick (04) |
| `MIN_DEPS` | 0 | min bundled dependencies allowed (04); 0 allows zero-dep |
| `MAX_DEPS` | 20 | max bundled dependencies allowed (04) |
| `SEED` | 42 | random seed for the selection (04) |
| `MIN_LOC` | 0 | keep only functions with ≥ this many lines (06) |

## Web control panel

- A form for every parameter, with the new defaults.
- **Run whole pipeline** or any **single step** (01–06), plus a **Setup** button that
  installs `webpack` / `meriyah` / `escodegen` (needed by steps 03 and 06).
- **Live streaming logs** with pass/fail status.
- **Console tab**: type any `bash` command and watch it run (`ls`, `cat a log`,
  re-run a step by hand, `git …`). Streamed live.
- **Outputs tab**: lists the files produced under `./output`.
- Binds to **127.0.0.1 only** — it runs shell commands, so don't expose it to a network.

## Requirements

- Node 18+ (uses built-in `fetch`; the UI/wizard have **no dependencies**).
- Steps 03 and 06 need `webpack`, `meriyah@6.0.6`, `escodegen@2.1.0`
  (`run-pipeline.sh` and the web UI's **Setup** button install them for you).
- Network access to `data.jsdelivr.com` (01) and the npm registry (02).

## Files

```
server.mjs              web control panel (Node http, no deps)
public/index.html       its single-page UI
wizard.mjs              interactive CLI parameter wizard
lib-pipeline.mjs        shared: parameters, steps, exact command per step
run-pipeline.sh         the original orchestrator (updated defaults)
01-1500-jsdeliver.mjs   01 crawl
02-download-with-deps.mjs  02 download  (zero-dep default flipped)
03-bundle-and-sbom.mjs  03 bundle + source map + SBOM
04-select-sample40.mjs  04 select sample
05-collect-selected-bundles.mjs  05 collect
06-extract-functions.mjs 06 extract functions
```
