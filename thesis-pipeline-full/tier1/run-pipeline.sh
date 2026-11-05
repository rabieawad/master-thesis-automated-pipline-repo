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
#   output/05_selected_bundles/            selected_dependencies.csv + bundles/, sbom/, modules/ of the selected packages
#   output/06_extracted_functions/         one <bundle>.functions.json per selected bundle + summary.csv
#   output/logs/                           one log file per step (+ copies: 05_selected_dependencies.csv, 06_extract_functions_summary.csv)
#
# Safe to stop and re-run: finished work is skipped (step 01 if its list exists,
# steps 02 and 03 skip packages they already did, step 04 is quick and always re-run).
#
# Settings (optional, as environment variables):
#   TOP_N=1500      how many top packages to crawl (step 01)
#   PERIOD=month    jsDelivr stats period: day | week | month | year (step 01)
#   DOWNLOAD_LIMIT=all   only download the first N packages of the list (step 02), e.g. 100 for a test
#   INCLUDE_ZERO_DEP=1   download AND bundle packages that have no dependencies too (default on);
#                        set INCLUDE_ZERO_DEP=0 to download only packages with >=1 dependency
#   CONC=4          parallel jobs for step 02 (downloads)
#   BUNDLE_CONC=1   packages bundled at the same time in step 03 (1 = one at a time, gives each the most memory)
#   HEAP_MB=...     memory limit in MB of each bundling process (step 03); default = 75% of this computer's memory
#   MINIFY=1        minify the bundles (step 03); set MINIFY=0 to turn it off
#   SAMPLE_N=40     how many packages to select (step 04)
#   MIN_DEPS=0      smallest number of bundled dependencies allowed (step 04); 0 = allow zero-dependency packages
#   MAX_DEPS=20     largest number of bundled dependencies allowed (step 04); raise it for larger trees
#   SEED=42         random seed for the selection (step 04)
#   MIN_LOC=0       keep only functions with at least this many lines (step 06); 0 = keep all, 6 = the paper's library filter
#
# Example, small test run:  TOP_N=100 DOWNLOAD_LIMIT=100 ./run-pipeline.sh

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

TOP_N="${TOP_N:-1500}"
PERIOD="${PERIOD:-month}"
DOWNLOAD_LIMIT="${DOWNLOAD_LIMIT:-all}"
INCLUDE_ZERO_DEP="${INCLUDE_ZERO_DEP:-1}"
CONC="${CONC:-4}"
BUNDLE_CONC="${BUNDLE_CONC:-1}"
MINIFY="${MINIFY:-1}"
SAMPLE_N="${SAMPLE_N:-40}"
MIN_DEPS="${MIN_DEPS:-0}"
MAX_DEPS="${MAX_DEPS:-20}"
SEED="${SEED:-42}"
MIN_LOC="${MIN_LOC:-0}"

# INCLUDE_ZERO_DEP is the human-friendly switch; step 02 itself reads ONLY_WITH_DEPS.
# INCLUDE_ZERO_DEP=1 (default) -> ONLY_WITH_DEPS=0 (download everything, zero-dep included)
# INCLUDE_ZERO_DEP=0           -> ONLY_WITH_DEPS=1 (only packages with >=1 dependency)
if [ "$INCLUDE_ZERO_DEP" = "0" ]; then ONLY_WITH_DEPS=1; else ONLY_WITH_DEPS=0; fi

OUT="$HERE/output"
D1="$OUT/01_top1500_package_list"
D2="$OUT/02_downloaded_packages"
D3="$OUT/03_bundles_minified"
D4="$OUT/04_selected_sample"
D5="$OUT/05_selected_bundles"
D6="$OUT/06_extracted_functions"
LOGS="$OUT/logs"
mkdir -p "$D1" "$D2" "$D3" "$D4" "$D5" "$D6" "$LOGS"

banner() { printf '\n==== %s ====\n' "$*"; }

# ---------- checks ----------
for f in 01-1500-jsdeliver.mjs 02-download-with-deps.mjs 03-bundle-and-sbom.mjs 04-select-sample40.mjs 05-collect-selected-bundles.mjs 06-extract-functions.mjs; do
  [ -f "$HERE/$f" ] || { echo "Missing $f next to run-pipeline.sh" >&2; exit 1; }
done
command -v node >/dev/null || { echo "node is not installed (need Node 18+)" >&2; exit 1; }
command -v npm >/dev/null || { echo "npm is not installed" >&2; exit 1; }

# webpack (step 03) and meriyah + escodegen (step 06, the versions DEBUN uses) are looked up next to the
# script, so install them here once, all in one command (a second "npm install --no-save" would remove
# the first one's packages). The check really loads them, so a half-installed folder is repaired too.
if ! node --input-type=module -e "await import('webpack'); await import('meriyah'); await import('escodegen')" >/dev/null 2>&1; then
  banner "Setup: installing webpack, meriyah and escodegen (once)"
  rm -rf "$HERE/node_modules/webpack" "$HERE/node_modules/meriyah" "$HERE/node_modules/escodegen"
  npm install --no-save --no-audit --no-fund webpack meriyah@6.0.6 escodegen@2.1.0
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
ONLY_WITH_DEPS="$ONLY_WITH_DEPS" node "$HERE/02-download-with-deps.mjs" "$D1/jsdelivr-top.json" "$D2" "$CONC" "$DOWNLOAD_LIMIT" 2>&1 \
  | tee "$LOGS/02_download_packages.log"

# ---------- step 03: bundle every package, write source map + SBOM ----------
banner "Step 03: bundle (MINIFY=$MINIFY) and write SBOMs -> $D3"
# Minified Webpack builds use a lot of memory, so by default one package is bundled at a time and
# may use most of the computer's memory. A package that still crashes is marked FAIL and skipped.
MINIFY="$MINIFY" node "$HERE/03-bundle-and-sbom.mjs" "$D2" "$D3" "$BUNDLE_CONC" 2>&1 \
  | tee "$LOGS/03_bundle_and_sbom.log"

# ---------- step 04: pick the random sample ----------
banner "Step 04: select $SAMPLE_N packages with $MIN_DEPS-$MAX_DEPS bundled dependencies -> $D4"
node "$HERE/04-select-sample40.mjs" "$D3/summary.json" \
  --n "$SAMPLE_N" --min "$MIN_DEPS" --max "$MAX_DEPS" --seed "$SEED" \
  --out "$D4/selected" --packages-dir "$D2" --copy-to "$D4/sample" 2>&1 \
  | tee "$LOGS/04_select_sample.log"

# ---------- step 05: collect the selected bundles + dependency list ----------
banner "Step 05: collect the selected bundles, SBOMs and dependency list -> $D5"
node "$HERE/05-collect-selected-bundles.mjs" "$D4/selected.json" "$D3" "$D5" 2>&1 \
  | tee "$LOGS/05_collect_selected_bundles.log"
cp "$D5/selected_dependencies.csv" "$LOGS/05_selected_dependencies.csv"

# ---------- step 06: extract the functions of the selected bundles ----------
banner "Step 06: extract functions from the selected bundles -> $D6"
node "$HERE/06-extract-functions.mjs" "$D5/bundles" "$D6" --min-loc "$MIN_LOC" 2>&1 \
  | tee "$LOGS/06_extract_functions.log"
cp "$D6/summary.csv" "$LOGS/06_extract_functions_summary.csv"

banner "Done"
cat <<EOF
01 package list    : $D1/jsdelivr-top.json
02 downloaded      : $D2
03 bundles + SBOMs : $D3  (summary: $D3/summary.json)
04 selected sample : $D4/selected.csv  and  $D4/sample/
05 selected bundles: $D5/selected_dependencies.csv  and  bundles/ sbom/ modules/ in $D5
06 functions       : $D6/<bundle>.functions.json  and  $D6/summary.csv
logs               : $LOGS  (also copies 05_selected_dependencies.csv and 06_extract_functions_summary.csv)
EOF
