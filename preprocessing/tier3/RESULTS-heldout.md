# Tier 3 · held-out evaluation on 50 fresh packages (2026-11-21)

The question: were tier 3's settings tuned to the test bed and the pilot set? To check, everything
was frozen first, then a new set of packages never used before was drawn, run through tiers 1 → 3
once, and scored. Nothing was changed after seeing the result.

## How the set was built

1. **Settings frozen** before selection: `tools/heldout/FROZEN-settings.json`, with checksums of
   `tier3/lib/detect.mjs`, `tier3/lib/modules.mjs` and `tier2/lib/aletheia-bundler.mjs`
   (`FROZEN-code.sha256`, verified unchanged before the tier-3 run). The only code changed afterwards
   lets tier 2's step 08 and tier 3's index read gzip-compressed package files (disk space).
2. **Selection** (`tools/heldout/select.mjs`): npm registry search, 13 categories (UI for React and
   Vue, dates, charts, HTTP, state, editors, animation, maps, analytics, utilities, DOM, validation);
   per category 5 packages drawn with a fixed seed (20261121) from the 100 most downloaded with ≥ 100k
   downloads a month and ≥ 10 dependents; CLIs, native bindings, build plugins and React Native left
   out; categories that also hold server packages need a browser keyword. **Excluded: every package
   used before** — the test bed, the pilot set, both references and every SBOM (151 names). The draw
   was kept exactly as the rules produced it.
3. **Tier 1, unchanged** (your list in place of step 01; jsDelivr is unreachable from here): 57 of 65
   bundled; 8 failed in tier 1 (Node-only packages, missing peer dependencies).
4. **50 kept** by a fixed rule (`pick50.mjs`): drop from the most represented category, from its most
   represented size third — 17 large, 17 medium, 16 small bundles, 3–4 per category.
5. **Tier 2** with exported code kept: 285 packages, 17 538 versions, lineages for all (94.4 % of
   variants identifiable by markers).
6. **Tier 3** once, with the frozen settings, through the pipeline as the panel runs it.

Only the 50 roots had to be new; their dependencies could overlap with earlier sets (as agreed).
283 of the 349 packages in these bundles had never been seen before.

## Results (approximate matching with lineages, against the SBOMs)

| | packages | precision | recall | F1 | versions exact / in range |
|---|---|---|---|---|---|
| **all 50 bundles** | 349 | **0.987** | **0.871** | **0.925** | 0.901 / 0.904 |
| the bundle's own package | 50 | 1.000 | 0.920 | 0.958 | 0.957 / 0.957 |
| dependencies | 299 | 0.985 | 0.863 | 0.920 | 0.891 / 0.895 |
| **never seen before** | 283 | 0.984 | 0.883 | **0.931** | 0.887 / 0.891 |
| seen before (shared dependencies) | 66 | 1.000 | 0.818 | 0.900 | 0.963 / 0.963 |
| large packages (median ≥ 50 functions) | 164 | 0.987 | 0.915 | 0.949 | 0.912 / 0.912 |
| small bundles | 31 | 1.000 | 0.677 | 0.808 | 1.000 / 1.000 |
| medium bundles | 120 | 0.990 | 0.858 | 0.920 | 0.893 / 0.893 |
| large bundles | 198 | 0.984 | 0.909 | 0.945 | 0.893 / 0.899 |

All 57 bundles: precision 0.988, recall 0.874, F1 0.927. Exact matching only: F1 0.923.
For comparison (other data): test bed 0.947, pilot 0.879 (both used during development);
Debun reports F1 0.918 on its own 68 websites.

**Wrong detections (4):** victory-vendor (it re-packages d3-shape — same code), maplibre-gl inside
azure-maps-control (compiled in), source-map-js inside @vue/compiler-sfc, and
@wojtekmaj/react-datetimerange-picker matched to react-datetime-picker's code (same authors, shared code).

**Missed (45):**
- too little evidence 21 — mostly **react-dom** (7 bundles: React 19's `react-dom` holds a few
  functions against a large reference) and small `hast-util-*` / `unist-*` helpers;
- explained by another package 10 — dependencies whose code the parent's reference also holds
  (@antv/* inside @antv/g2, @tsparticles/basic inside its engine, redux-thunk inside @reduxjs/toolkit…);
- reference lacks the code 10 — e.g. `tiny-invariant`, `warning`, `devlop`, `vue` in one bundle;
- no functions in the bundle 4.

## Reading

- Precision held up very well (0.987); this sample happens to contain few prebuilt packages that
  carry copies of other libraries, which were the main source of wrong detections on the pilot set.
- Recall (0.871) is a little lower than on the development sets; the misses are the known failure
  modes (react-dom, tiny helpers, copies held by a parent), not new ones.
- Packages never seen before score as well as the rest (F1 0.931): the settings were not specific to
  the packages used during development.
- Weak spots: small bundles and utility packages (many one-function helpers); version accuracy in the
  analytics category (0.53), worth a look.

## Caveats

- One sample of 50 bundles; categories have 3–4 bundles each, so per-category numbers are noisy.
- Selection by npm search popularity, not jsDelivr's list that tier 1 normally uses.
- All packages in these bundles are in the reference (it is built from their SBOMs, as the pipeline
  does); packages absent from the reference would add wrong detections on real websites.
