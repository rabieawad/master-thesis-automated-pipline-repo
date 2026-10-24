#!/usr/bin/env bash
# Second (reference) pipeline: build a per-package reference dataset from the first
# pipeline's output. Each package AND each of its bundled dependencies is downloaded
# at patch-level versions, pseudo-bundled (its OWN code only), and its functions listed.
#
#   chmod +x run-pipeline-2.sh
#   INPUT_DIR=/path/to/first-pipeline/output ./run-pipeline-2.sh
#
# Output (under ./output2):
#   output2/01_reference_list/      reference-packages.json / .csv
#   output2/02_downloaded_packages/ <name>@<version>/ (each package's own files)
#   output2/03_pseudo_bundles/      bundles/<name>@<version>.js
#   output2/04_extracted_functions/ <name>@<version>.functions.json + summary.csv
#   output2/logs/                   one log per step
#
# Settings (environment variables):
#   INPUT_DIR=...        first pipeline output folder (REQUIRED; its 04_/05_ folders live here)
#   PATCH_LEVEL=all      all | latest | exact  -- which same-minor patch versions to pull
#   INCLUDE_PACKAGE=1    also include the packages themselves (0 = dependencies only)
#   CONC=6               parallel registry queries / downloads (steps 01-02)
#   BUNDLE_CONC=4        packages pseudo-bundled at once (step 03)
#   MINIFY=0             minify the pseudo-bundles (step 03); 0 keeps LOC correct in step 04
#   MIN_LOC=0            keep only functions with LOC >= this (step 04); 6 = the paper's library filter
#
# Safe to stop and re-run: finished downloads/bundles are skipped.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

INPUT_DIR="${INPUT_DIR:-}"
PATCH_LEVEL="${PATCH_LEVEL:-all}"
INCLUDE_PACKAGE="${INCLUDE_PACKAGE:-1}"
CONC="${CONC:-6}"
BUNDLE_CONC="${BUNDLE_CONC:-4}"
MINIFY="${MINIFY:-0}"
MIN_LOC="${MIN_LOC:-0}"

if [ -z "$INPUT_DIR" ]; then echo "Set INPUT_DIR to the first pipeline's output folder, e.g. INPUT_DIR=../pipeline-ui/output ./run-pipeline-2.sh" >&2; exit 1; fi

OUT="$HERE/output2"
D1="$OUT/01_reference_list"; D2="$OUT/02_downloaded_packages"; D3="$OUT/03_pseudo_bundles"; D4="$OUT/04_extracted_functions"; LOGS="$OUT/logs"
mkdir -p "$D1" "$D2" "$D3" "$D4" "$LOGS"
banner() { printf '\n==== %s ====\n' "$*"; }

for f in ref-01-build-list.mjs ref-02-download.mjs ref-03-pseudobundle.mjs ref-04-extract-functions.mjs; do
  [ -f "$HERE/$f" ] || { echo "Missing $f next to run-pipeline-2.sh" >&2; exit 1; }
done
command -v node >/dev/null || { echo "node is not installed (need Node 18+)" >&2; exit 1; }
command -v npm  >/dev/null || { echo "npm is not installed" >&2; exit 1; }

# bundler + collector deps (install once)
if ! node --input-type=module -e "await import('@swc/core'); await import('acorn'); await import('acorn-loose'); await import('acorn-walk'); await import('astring'); await import('meriyah'); await import('escodegen')" >/dev/null 2>&1; then
  banner "Setup: installing @swc/core, acorn, acorn-loose, acorn-walk, astring, meriyah, escodegen (once)"
  npm install --no-save --no-audit --no-fund @swc/core acorn acorn-loose acorn-walk astring meriyah@6.0.6 escodegen@2.1.0
fi

NO_PACKAGE=""; [ "$INCLUDE_PACKAGE" = "0" ] && NO_PACKAGE="--no-package"

banner "Step 01: build reference list (patch-level=$PATCH_LEVEL) -> $D1"
node "$HERE/ref-01-build-list.mjs" "$INPUT_DIR" "$D1" --patch-level "$PATCH_LEVEL" --conc "$CONC" $NO_PACKAGE 2>&1 | tee "$LOGS/01_build_list.log"

banner "Step 02: download packages (npm pack) -> $D2"
node "$HERE/ref-02-download.mjs" "$D1/reference-packages.json" "$D2" "$CONC" 2>&1 | tee "$LOGS/02_download.log"

banner "Step 03: pseudo-bundle (MINIFY=$MINIFY) -> $D3"
MINIFY="$MINIFY" node "$HERE/ref-03-pseudobundle.mjs" "$D2" "$D3" "$BUNDLE_CONC" 2>&1 | tee "$LOGS/03_pseudobundle.log"

banner "Step 04: extract functions (min-loc=$MIN_LOC) -> $D4"
node "$HERE/ref-04-extract-functions.mjs" "$D3/bundles" "$D4" --min-loc "$MIN_LOC" 2>&1 | tee "$LOGS/04_extract_functions.log"

banner "Done"
cat <<EOF
01 reference list  : $D1/reference-packages.csv
02 downloaded      : $D2
03 pseudo-bundles  : $D3/bundles
04 functions       : $D4/summary.csv
logs               : $LOGS
EOF
