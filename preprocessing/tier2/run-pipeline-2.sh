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
#   output2/05_deduplicated_functions/ unique_functions.jsonl, occurrences.csv, version_index.json, summary.json
#   output2/logs/                   one log per step
#
# Settings (environment variables):
#   INPUT_DIR=...        first pipeline output folder (REQUIRED; its 04_/05_ folders live here)
#   VERSIONS=all         which versions to download per package:
#                          all    = every stable version, all majors/minors/patches (Aletheia-paper style)
#                          minor  = only patches within the recorded version's major.minor
#                          latest = only the newest stable version
#                          exact  = only the exact recorded version
#                        (PATCH_LEVEL is still accepted as an alias)
#   INCLUDE_PACKAGE=1    also include the packages themselves (0 = dependencies only)
#   CONC=6               parallel registry queries / downloads (steps 01-02)
#   BUNDLE_CONC=4        packages pseudo-bundled at once (step 03)
#   MINIFY=0             minify the pseudo-bundles (step 03); 0 keeps LOC correct in step 04
#   MIN_LOC=0            keep only functions with LOC >= this (step 04); 6 = the paper's library filter
#   DEDUP_MODE=normalized  step 05 identity: normalized (locals renamed) or exact (raw body text)
#   DEDUP_IDENTITY=string  step 05 comparison: string = compare signature+body text character by
#                        character (no hash collision possible); hash = the older truncated sha256
#   DEDUP_STRICT_TYPE=0  step 05: 1 = keep FunctionDeclaration / FunctionExpression with equal bodies apart
#   TRIVIAL_NODES=6      step 05: functions with fewer AST nodes are flagged trivial
#   NEAR_THRESHOLD=0     step 05: >0 (e.g. 0.85) also lists near-duplicate pairs (never merged)
#   STREAM=1             streamed mode: work through the tier-1 groups ONE PACKAGE AT A TIME
#                        (download -> bundle -> extract -> collect), keeping only that package's
#                        final function collection, then merge the per-package partials. Same
#                        outputs as batch mode, a fraction of the disk. 0 = classic batch mode.
#   KEEP_ARTIFACTS=      streamed mode only: comma list of intermediate artifacts to KEEP --
#                        02 (.tgz), 03 (bundles), 04 (per-version functions.json), partials, or
#                        all. Empty (the default) deletes every intermediate file.
#
# Safe to stop and re-run: finished downloads/bundles are skipped, and in streamed mode a
# package whose partial already exists is skipped (a half-finished one is redone from scratch).

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

INPUT_DIR="${INPUT_DIR:-}"
VERSIONS="${VERSIONS:-${PATCH_LEVEL:-all}}"
INCLUDE_PACKAGE="${INCLUDE_PACKAGE:-1}"
CONC="${CONC:-6}"
BUNDLE_CONC="${BUNDLE_CONC:-4}"
MINIFY="${MINIFY:-0}"
MIN_LOC="${MIN_LOC:-0}"
DEDUP_MODE="${DEDUP_MODE:-normalized}"
DEDUP_IDENTITY="${DEDUP_IDENTITY:-string}"
DEDUP_STRICT_TYPE="${DEDUP_STRICT_TYPE:-0}"
TRIVIAL_NODES="${TRIVIAL_NODES:-6}"
NEAR_THRESHOLD="${NEAR_THRESHOLD:-0}"
STREAM="${STREAM:-1}"
KEEP_ARTIFACTS="${KEEP_ARTIFACTS:-}"

if [ -z "$INPUT_DIR" ]; then echo "Set INPUT_DIR to the first pipeline's output folder, e.g. INPUT_DIR=../pipeline-ui/output ./run-pipeline-2.sh" >&2; exit 1; fi

OUT="$HERE/output2"
D1="$OUT/01_reference_list"; D2="$OUT/02_downloaded_packages"; D3="$OUT/03_pseudo_bundles"; D4="$OUT/04_extracted_functions"; D5="$OUT/05_deduplicated_functions"; LOGS="$OUT/logs"
mkdir -p "$D1" "$D2" "$D3" "$D4" "$D5" "$LOGS"
banner() { printf '\n==== %s ====\n' "$*"; }

for f in 01_build-list.mjs 02_download.mjs 03_pseudo-bundle.mjs 04_extract-functions.mjs 05_dedup-functions.mjs 06_stream-packages.mjs 07_merge-partials.mjs; do
  [ -f "$HERE/$f" ] || { echo "Missing $f next to run-pipeline-2.sh" >&2; exit 1; }
done
command -v node >/dev/null || { echo "node is not installed (need Node 18+)" >&2; exit 1; }
command -v npm  >/dev/null || { echo "npm is not installed" >&2; exit 1; }

# bundler + collector deps (install once)
if ! node --input-type=module -e "await import('@swc/core'); await import('acorn'); await import('acorn-loose'); await import('acorn-walk'); await import('astring'); await import('meriyah'); await import('escodegen')" >/dev/null 2>&1; then
  banner "Setup: installing @swc/core, acorn, acorn-loose, acorn-walk, astring, meriyah, escodegen (once)"
  npm install --no-save --no-audit --no-fund @swc/core acorn acorn-loose acorn-walk astring meriyah@7.0.0 escodegen@2.1.0
fi

NO_PACKAGE=""; [ "$INCLUDE_PACKAGE" = "0" ] && NO_PACKAGE="--no-package"

banner "Step 01: build reference list (versions=$VERSIONS) -> $D1"
node "$HERE/01_build-list.mjs" "$INPUT_DIR" "$D1" --versions "$VERSIONS" --conc "$CONC" $NO_PACKAGE 2>&1 | tee "$LOGS/01_build_list.log"

if [ "$STREAM" = "0" ]; then

banner "Step 02: download packages (npm pack) -> $D2"
node "$HERE/02_download.mjs" "$D1/reference-packages.json" "$D2" "$CONC" 2>&1 | tee "$LOGS/02_download.log"

banner "Step 03: pseudo-bundle (MINIFY=$MINIFY) -> $D3"
UNMINIFIED="$([ "$MINIFY" = "0" ] && echo 1)" MINIFY="$MINIFY" node "$HERE/03_pseudo-bundle.mjs" "$D2" "$D3" "$BUNDLE_CONC" 2>&1 | tee "$LOGS/03_pseudobundle.log"

banner "Step 04: extract functions (min-loc=$MIN_LOC) -> $D4"
node "$HERE/04_extract-functions.mjs" "$D3/bundles" "$D4" --min-loc "$MIN_LOC" 2>&1 | tee "$LOGS/04_extract_functions.log"

DEDUP_ARGS=(--mode "$DEDUP_MODE" --identity "$DEDUP_IDENTITY" --trivial-nodes "$TRIVIAL_NODES")
[ "$DEDUP_STRICT_TYPE" = "1" ] && DEDUP_ARGS+=(--strict-type)
if awk "BEGIN{exit !($NEAR_THRESHOLD > 0)}"; then DEDUP_ARGS+=(--near "$NEAR_THRESHOLD"); fi

banner "Step 05: deduplicate functions (mode=$DEDUP_MODE) -> $D5"
NODE_OPTIONS="--max-old-space-size=6144" node "$HERE/05_dedup-functions.mjs" "$D4" "$D5" "${DEDUP_ARGS[@]}" 2>&1 | tee "$LOGS/05_dedup_functions.log"

else

# ---- streamed mode: one tier-2 package at a time, then merge the partials ----
STREAM_ARGS=(--input "$INPUT_DIR" --conc "$CONC" --bundle-conc "$BUNDLE_CONC" --min-loc "$MIN_LOC" --mode "$DEDUP_MODE" --identity "$DEDUP_IDENTITY" --keep "$KEEP_ARTIFACTS")
[ "$DEDUP_STRICT_TYPE" = "1" ] && STREAM_ARGS+=(--strict-type)
[ "$INCLUDE_PACKAGE" = "0" ] && STREAM_ARGS+=(--no-package)

banner "Steps 02-05: stream packages (download -> bundle -> extract -> collect), keep=${KEEP_ARTIFACTS:-nothing}"
MINIFY="$MINIFY" node "$HERE/06_stream-packages.mjs" "$OUT" "${STREAM_ARGS[@]}" 2>&1 | tee "$LOGS/06_stream_packages.log"

MERGE_ARGS=(--trivial-nodes "$TRIVIAL_NODES")
if awk "BEGIN{exit !($NEAR_THRESHOLD > 0)}"; then MERGE_ARGS+=(--near "$NEAR_THRESHOLD"); fi
case ",$KEEP_ARTIFACTS," in *,partials,*|*,all,*) MERGE_ARGS+=(--keep-partials);; esac

banner "Step 05: merge the per-package partials (mode=$DEDUP_MODE) -> $D5"
NODE_OPTIONS="--max-old-space-size=6144" node "$HERE/07_merge-partials.mjs" "$D5" "${MERGE_ARGS[@]}" 2>&1 | tee "$LOGS/07_merge_partials.log"

fi

banner "Done"
cat <<EOF
mode               : $([ "$STREAM" = "0" ] && echo batch || echo "streamed (keep=${KEEP_ARTIFACTS:-nothing})")
01 reference list  : $D1/reference-packages.csv
02 downloaded      : $D2
03 pseudo-bundles  : $D3/bundles
04 functions       : $D4/summary.csv
05 deduplicated    : $D5/unique_functions.jsonl  (+ occurrences.csv, version_index.json, summary.json)
logs               : $LOGS
EOF
