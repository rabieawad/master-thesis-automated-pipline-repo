# Tier 3 · Detection report

57 bundles (57 with an SBOM, 57 with a source map), 97445 non-trivial bundle functions: 71835 matched exactly, 20101 only approximately, 5509 not at all. Index: 466331 reference functions, built 2026-11-21T03:22:15.980Z.

## Packages

TP = detected and in the SBOM, FP = detected but not in it, FN = in the SBOM and in the index but not detected. *Code-present precision* also counts a detection as right when the source map shows the package's code is in the bundle as a vendored copy. *Recall (detectable)* leaves out packages whose bundled code cannot be matched at all (no functions, or tier 2's reference holds other code).

| Mode | TP | FP | FN | Not indexed | Precision | Recall | F1 | Code-present precision | Recall (detectable) |
|---|---|---|---|---|---|---|---|---|---|
| exact | 318 | 6 | 47 | 0 | 0.981 | 0.871 | 0.923 | 0.991 | 0.906 |
| approx+lineage | 319 | 4 | 46 | 0 | 0.988 | 0.874 | 0.927 | 0.994 | 0.909 |

## Versions

For every TP whose true version was indexed: is the reported version the true one (exact), is the true one inside the reported range, and how many versions the range spans.

| Mode | TPs | Exact | In range | Median range | Mean range | Exact (root) | Exact (dependency) |
|---|---|---|---|---|---|---|---|
| exact | 315 | 0.895 | 0.902 | 1 | 3.4 | 0.941 (51) | 0.886 (264) |
| approx+lineage | 316 | 0.896 | 0.899 | 1 | 3 | 0.941 (51) | 0.887 (265) |

Intersection: for how many of those TPs all of the package's functions agree on a version set (then the range is their intersection), and how often the true version is inside.

| Mode | Functions agree | True version inside | Single version (right) | Functions contradict | True version inside |
|---|---|---|---|---|---|
| exact | 214 | 196 | 111 (110) | 101 | 88 |
| approx+lineage | 172 | 157 | 107 (103) | 144 | 127 |

## Functions

From the source maps: of the bundle functions a detected package explains, how many really come from it (accuracy), and how many of the functions that come from some package got explained at all (coverage).

| Mode | Functions from a package | Explained | Explained by the right package | Accuracy | Coverage |
|---|---|---|---|---|---|
| exact | 95860 | 69381 | 62359 | 0.899 | 0.724 |
| approx+lineage | 95860 | 87695 | 79344 | 0.905 | 0.915 |

## Why it went wrong

- **exact** — missed: explained by another package 22; too little evidence 11; reference lacks the code 10; no functions in the bundle 4. Wrongly found: compiled into another package 2; holds a copy of another package 2; shared or generic code 1; embedded in a file of another package 1.
- **approx+lineage** — missed: too little evidence 22; explained by another package 10; reference lacks the code 10; no functions in the bundle 4. Wrongly found: shared or generic code 1; compiled into another package 1; embedded in a file of another package 1; holds a copy of another package 1.

## Per bundle (approx+lineage)

| Bundle | In SBOM | Detected | TP | FP | FN | Version exact |
|---|---|---|---|---|---|---|
| @agm+core@3.0.0-beta.0 | 5 | 5 | 5 | 0 | 0 | 2/4 |
| @amplitude+analytics-browser@2.49.4 | 15 | 15 | 15 | 0 | 0 | 6/15 |
| @antv+g2plot@2.4.35 | 31 | 27 | 27 | 0 | 4 | 22/27 |
| @coreui+chartjs@4.2.0 | 1 | 0 | 0 | 0 | 1 | – |
| @daybrush+utils@1.13.0 | 1 | 1 | 1 | 0 | 0 | 1/1 |
| @googlemaps+js-api-loader@2.1.3 | 1 | 1 | 1 | 0 | 0 | 1/1 |
| @hookform+devtools@4.4.0 | 1 | 0 | 0 | 0 | 1 | – |
| @microsoft+clarity@1.0.2 | 1 | 1 | 1 | 0 | 0 | 1/1 |
| @monaco-editor+react@4.7.0 | 4 | 3 | 3 | 0 | 1 | 3/3 |
| @mparticle+web-sdk@2.81.0 | 1 | 1 | 1 | 0 | 0 | 1/1 |
| @perspective-dev+client@5.9.4 | 1 | 1 | 1 | 0 | 0 | 1/1 |
| @progress+kendo-react-dateinputs@17.0.0 | 25 | 23 | 23 | 0 | 2 | 22/23 |
| @svgdotjs+svg.js@3.2.8 | 1 | 1 | 1 | 0 | 0 | 1/1 |
| @tsparticles+basic@4.6.0 | 13 | 11 | 11 | 0 | 2 | 11/11 |
| @tsparticles+updater-life@4.6.0 | 2 | 2 | 2 | 0 | 0 | 2/2 |
| @umijs+use-params@1.0.9 | 2 | 2 | 2 | 0 | 0 | 2/2 |
| @unovis+ts@1.8.1 | 40 | 38 | 37 | 1 | 3 | 34/35 |
| @vee-validate+zod@4.15.1 | 8 | 7 | 7 | 0 | 1 | 7/7 |
| @vue+compiler-sfc@3.5.46 | 1 | 2 | 1 | 1 | 0 | 1/1 |
| @wojtekmaj+react-datetimerange-picker@7.1.0 | 18 | 15 | 15 | 0 | 3 | 11/15 |
| @zag-js+dom-query@1.48.0 | 1 | 1 | 1 | 0 | 0 | 1/1 |
| ag-charts-react@14.3.0 | 4 | 4 | 4 | 0 | 0 | 4/4 |
| aspida@1.14.0 | 2 | 1 | 1 | 0 | 1 | 1/1 |
| autocompleter@10.1.0 | 1 | 1 | 1 | 0 | 0 | 1/1 |
| azure-maps-control@3.7.4 | 1 | 2 | 1 | 1 | 0 | 1/1 |
| camelcase-css@2.0.1 | 1 | 1 | 1 | 0 | 0 | 1/1 |
| chartjs-chart-treemap@5.0.2 | 3 | 3 | 3 | 0 | 0 | 3/3 |
| ckeditor4@4.25.2 | 1 | 1 | 1 | 0 | 0 | 1/1 |
| css-tree@3.2.1 | 2 | 1 | 1 | 0 | 1 | 1/1 |
| embla-carousel-class-names@8.6.0 | 1 | 1 | 1 | 0 | 0 | 1/1 |
| gantt-task-react@0.3.9 | 2 | 2 | 2 | 0 | 0 | 2/2 |
| grapesjs@0.23.9 | 1 | 1 | 1 | 0 | 0 | 1/1 |
| hast-util-from-html-isomorphic@2.0.0 | 8 | 3 | 3 | 0 | 5 | 3/3 |
| hast-util-from-html@2.1.0 | 15 | 10 | 10 | 0 | 5 | 9/10 |
| hast-util-is-element@3.0.0 | 1 | 1 | 1 | 0 | 0 | 1/1 |
| hast-util-select@6.0.5 | 17 | 15 | 15 | 0 | 2 | 15/15 |
| jszip-utils@0.1.0 | 1 | 1 | 1 | 0 | 0 | 1/1 |
| konva@10.10.0 | 1 | 1 | 1 | 0 | 0 | 0/1 |
| morphdom@2.7.8 | 1 | 1 | 1 | 0 | 0 | 1/1 |
| nanostores@1.5.5 | 1 | 1 | 1 | 0 | 0 | 1/1 |
| ngx-skeleton-loader@14.0.0 | 4 | 4 | 4 | 0 | 0 | 4/4 |
| pikaday@1.8.2 | 1 | 1 | 1 | 0 | 0 | 1/1 |
| rc-tabs@15.7.0 | 15 | 14 | 14 | 0 | 1 | 12/14 |
| rc-trigger@5.3.4 | 11 | 10 | 10 | 0 | 1 | 8/10 |
| react-activity@2.1.3 | 2 | 2 | 2 | 0 | 0 | 1/2 |
| react-datepicker@9.1.0 | 11 | 10 | 10 | 0 | 1 | 10/10 |
| react-datetime-picker@7.1.0 | 17 | 15 | 14 | 1 | 3 | 10/14 |
| react-places-autocomplete@7.3.0 | 4 | 4 | 4 | 0 | 0 | 4/4 |
| recharts@3.11.0 | 26 | 23 | 23 | 0 | 3 | 23/23 |
| redux-watch@1.2.0 | 2 | 2 | 2 | 0 | 0 | 2/2 |
| squire-rte@2.4.11 | 1 | 1 | 1 | 0 | 0 | 1/1 |
| use-analytics@1.1.0 | 5 | 2 | 2 | 0 | 3 | 2/2 |
| use-local-storage-state@20.0.0 | 2 | 2 | 2 | 0 | 0 | 2/2 |
| vue-hot-reload-api@2.3.4 | 1 | 1 | 1 | 0 | 0 | 1/1 |
| vuedraggable@2.24.3 | 2 | 2 | 2 | 0 | 0 | 2/2 |
| xhr-mock@2.5.1 | 23 | 21 | 21 | 0 | 2 | 21/21 |
| xmldom@0.6.0 | 1 | 1 | 1 | 0 | 0 | 1/1 |

## Wrongly found packages (approx+lineage, first 25)

| Bundle | Package | Reason | Code from |
|---|---|---|---|
| @unovis+ts@1.8.1 | victory-vendor | shared or generic code | d3-shape/src/arc.js |
| @vue+compiler-sfc@3.5.46 | source-map-js | compiled into @vue/compiler-sfc (declared dependency) | @vue/compiler-sfc/dist/compiler-sfc.esm-browser.js |
| azure-maps-control@3.7.4 | maplibre-gl | embedded in a file of azure-maps-control | azure-maps-control/dist/atlas-esm.min.js |
| react-datetime-picker@7.1.0 | @wojtekmaj/react-datetimerange-picker | holds a copy of react-datetime-picker | react-datetime-picker/dist/DateTimePicker.js |

## Missed packages (approx+lineage, first 25)

| Bundle | Package | Reason | Bundled functions | Matchable |
|---|---|---|---|---|
| @antv+g2plot@2.4.35 | @antv/color-util@2.0.6 | explained by @antv/g2 | 11 | 9 |
| @antv+g2plot@2.4.35 | @antv/component@0.8.35 | explained by @antv/g2 | 607 | 534 |
| @antv+g2plot@2.4.35 | @antv/dom-util@2.0.4 | explained by @antv/g2 | 21 | 11 |
| @antv+g2plot@2.4.35 | lodash-es@4.18.1 | too little evidence | 1278 | 478 |
| @coreui+chartjs@4.2.0 | @coreui/chartjs@4.2.0 | too little evidence | 1 | 1 |
| @hookform+devtools@4.4.0 | @hookform/devtools@4.4.0 | no functions in the bundle | 0 | 0 |
| @monaco-editor+react@4.7.0 | state-local@1.0.7 | explained by @monaco-editor/loader | 26 | 25 |
| @progress+kendo-react-dateinputs@17.0.0 | @progress/kendo-svg-icons@5.5.0 | reference lacks the code | 2 | 0 |
| @progress+kendo-react-dateinputs@17.0.0 | react-dom@19.3.1 | too little evidence | 19 | 17 |
| @tsparticles+basic@4.6.0 | @tsparticles/basic@4.6.0 | explained by @tsparticles/engine | 8 | 6 |
| @tsparticles+basic@4.6.0 | @tsparticles/plugin-hsl-color@4.6.0 | too little evidence | 14 | 10 |
| @unovis+ts@1.8.1 | internmap@1.0.1 | explained by d3-array | 16 | 15 |
| @unovis+ts@1.8.1 | kdbush@3.0.0 | explained by maplibre-gl | 16 | 11 |
| @unovis+ts@1.8.1 | lodash-es@4.18.1 | explained by @unovis/dagre-layout | 549 | 224 |
| @vee-validate+zod@4.15.1 | vue@3.5.46 | reference lacks the code | 1 | 0 |
| @wojtekmaj+react-datetimerange-picker@7.1.0 | make-event-props@2.0.0 | too little evidence | 4 | 3 |
| @wojtekmaj+react-datetimerange-picker@7.1.0 | react-dom@19.3.1 | too little evidence | 19 | 17 |
| @wojtekmaj+react-datetimerange-picker@7.1.0 | warning@4.0.3 | reference lacks the code | 1 | 0 |
| aspida@1.14.0 | form-data@4.0.6 | no functions in the bundle | 0 | 0 |
| css-tree@3.2.1 | source-map-js@1.2.4 | explained by css-tree | 56 | 55 |
| hast-util-from-html-isomorphic@2.0.0 | hast-util-from-html-isomorphic@2.0.0 | too little evidence | 3 | 1 |
| hast-util-from-html-isomorphic@2.0.0 | comma-separated-tokens@2.0.3 | too little evidence | 4 | 2 |
| hast-util-from-html-isomorphic@2.0.0 | hast-util-parse-selector@4.0.0 | too little evidence | 3 | 1 |
| hast-util-from-html-isomorphic@2.0.0 | hastscript@9.0.3 | too little evidence | 11 | 9 |
| hast-util-from-html-isomorphic@2.0.0 | web-namespaces@2.0.1 | no functions in the bundle | 0 | 0 |
