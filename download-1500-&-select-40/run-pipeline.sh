#!/usr/bin/env bash
# Runs the whole data-preparation pipeline in order and keeps every step's output
# in its own clearly named folder.
#
# Put this file in the same folder as the four .mjs scripts, then run:
#   chmod +x run-pipeline.sh
#   ./run-pipeline.sh
#
# Output (everything goes under ./output):
#   output/01_top1500_package_list/        jsdelivr-top.json / .csv   (which packages)
#   output/02_downloaded_packages/         <package>/node_modules/... (packages + dependencies)
#   output/03_bundles_minified/            bundles/, sbom/, modules/, manifest.jsonl, summary.json/.csv
#   output/04_selected_sample/             selected.json / .csv (the 40 picked) + sample/ (their folders)
#   output/logs/                           one log file per step
#
# Safe to stop and re-run: finished work is skipped (step 01 if its list exists,
# steps 02 and 03 skip packages they already did, step 04 is quick and always re-run).
#
# Settings (optional, as environment variables):
#   TOP_N=1500      how many top packages to crawl (step 01)
#   PERIOD=month    jsDelivr stats period: day | week | month | year (step 01)
#   DOWNLOAD_LIMIT=all   only download the first N packages of the list (step 02), e.g. 100 for a test
#   CONC=4          parallel jobs for steps 02 and 03
#   MINIFY=1        minify the bundles (step 03); set MINIFY=0 to turn it off
#   SAMPLE_N=40     how many packages to select (step 04)
#   MIN_DEPS=1      smallest number of bundled dependencies allowed (step 04)
#   MAX_DEPS=20     largest number of bundled dependencies allowed (step 04)
#   SEED=42         random seed for the selection (step 04)
#
# Example, small test run:  TOP_N=100 DOWNLOAD_LIMIT=100 ./run-pipeline.sh

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

TOP_N="${TOP_N:-1500}"
PERIOD="${PERIOD:-month}"
DOWNLOAD_LIMIT="${DOWNLOAD_LIMIT:-all}"
CONC="${CONC:-4}"
MINIFY="${MINIFY:-1}"
SAMPLE_N="${SAMPLE_N:-40}"
MIN_DEPS="${MIN_DEPS:-1}"
MAX_DEPS="${MAX_DEPS:-20}"
SEED="${SEED:-42}"

OUT="$HERE/output"
D1="$OUT/01_top1500_package_list"
D2="$OUT/02_downloaded_packages"
D3="$OUT/03_bundles_minified"
D4="$OUT/04_selected_sample"
LOGS="$OUT/logs"
mkdir -p "$D1" "$D2" "$D3" "$D4" "$LOGS"

banner() { printf '\n==== %s ====\n' "$*"; }

# ---------- checks ----------
for f in 01-1500-jsdeliver.mjs 02-download-with-deps.mjs 03-bundle-and-sbom.mjs 04-select-sample40.mjs; do
  [ -f "$HERE/$f" ] || { echo "Missing $f next to run-pipeline.sh" >&2; exit 1; }
done
command -v node >/dev/null || { echo "node is not installed (need Node 18+)" >&2; exit 1; }
command -v npm >/dev/null || { echo "npm is not installed" >&2; exit 1; }

# webpack is needed by step 03 and is looked up next to the script, so install it here once
if [ ! -d "$HERE/node_modules/webpack" ]; then
  banner "Setup: installing webpack (once)"
  npm install --no-save --no-audit --no-fund webpack
fi

# ---------- step 01: crawl the top packages ----------
banner "Step 01: crawl top $TOP_N npm packages from jsDelivr -> $D1"
if [ -s "$D1/jsdelivr-top.json" ]; then
  echo "already done, skipping (delete $D1 to redo)"
else
  # the script writes jsdelivr-top.json / .csv into the current folder, so run it inside the step folder
  (cd "$D1" && node "$HERE/01-1500-jsdeliver.mjs" "$TOP_N" "$PERIOD") 2>&1 | tee "$LOGS/01_crawl_top_packages.log"
fi

# ---------- step 02: download packages with their dependencies ----------
banner "Step 02: download packages with dependencies -> $D2"
node "$HERE/02-download-with-deps.mjs" "$D1/jsdelivr-top.json" "$D2" "$CONC" "$DOWNLOAD_LIMIT" 2>&1 \
  | tee "$LOGS/02_download_packages.log"

# ---------- step 03: bundle every package, write source map + SBOM ----------
banner "Step 03: bundle (MINIFY=$MINIFY) and write SBOMs -> $D3"
MINIFY="$MINIFY" node "$HERE/03-bundle-and-sbom.mjs" "$D2" "$D3" "$CONC" 2>&1 \
  | tee "$LOGS/03_bundle_and_sbom.log"

# ---------- step 04: pick the random sample ----------
banner "Step 04: select $SAMPLE_N packages with $MIN_DEPS-$MAX_DEPS bundled dependencies -> $D4"
node "$HERE/04-select-sample40.mjs" "$D3/summary.json" \
  --n "$SAMPLE_N" --min "$MIN_DEPS" --max "$MAX_DEPS" --seed "$SEED" \
  --out "$D4/selected" --packages-dir "$D2" --copy-to "$D4/sample" 2>&1 \
  | tee "$LOGS/04_select_sample.log"

banner "Done"
cat <<EOF
01 package list    : $D1/jsdelivr-top.json
02 downloaded      : $D2
03 bundles + SBOMs : $D3  (summary: $D3/summary.json)
04 selected sample : $D4/selected.csv  and  $D4/sample/
logs               : $LOGS
EOF
