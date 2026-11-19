# Tier 3 on the test bed: results, and how the algorithm got there

## The test bed

- **Bundles (tier 1):** 44 webpack bundles of 24 popular npm packages — the latest version of each
  and, for 20 of them, an older one — built by tier 1's unchanged bundler, each with its SBOM (the ground truth: the
  package plus every package whose modules went into the bundle, at exact versions) and its source
  map. 32,111 functions, 26,420 of them non-trivial.
- **Reference (tier 2):** a real tier-2 dataset of 147 packages, every published version,
  pseudo-bundled, extracted and deduplicated by tier 2 with its lineage step: 191,627 non-trivial
  functions. 99 of its packages occur in these bundles; the other 48 (e.g. `@clerk/clerk-js`,
  `@findify/bundle`, `@finsweet/fs-components` — prebuilt bundles holding copies of many libraries)
  act as distractors.
- Truth: 103 distinct packages, 99 of them indexed (4 `@vue/*` packages are not); 213
  bundle–package pairs, 209 of them indexed.

Matching: 50 % of the non-trivial bundle functions match a reference function exactly, 35 % only
approximately (similarity ≥ 0.5), 15 % not at all (webpack's runtime, code whose reference is
missing, see below).

## Results

Package level (against the SBOMs). *Code-present precision* also counts a detection as right when
the source map shows the package's code is in the bundle as a vendored or embedded copy (which an
SBOM cannot know). *Recall (detectable)* leaves out truth packages none of whose bundled functions
can be matched.

| Mode | TP | FP | FN | Precision | Recall | F1 | Code-present precision | Recall (detectable) |
|---|---|---|---|---|---|---|---|---|
| exact | 101 | 17 | 108 | 0.856 | 0.483 | 0.618 | 0.958 | 0.591 |
| approx | 135 | 25 | 74 | 0.844 | 0.646 | 0.732 | 0.913 | 0.718 |
| approx+lineage | 135 | 25 | 74 | 0.844 | 0.646 | 0.732 | 0.913 | 0.718 |

Version level, for every TP whose true version is indexed:

Versions by intersection (the default, see below):

| Mode | TPs | Version exact | True version in range | Median range | Mean range |
|---|---|---|---|---|---|
| exact | 97 | 0.804 | 0.918 | 2 | 5.5 |
| approx | 131 | 0.832 | 0.916 | 2 | 3.5 |
| approx+lineage | 131 | **0.840** | **0.924** | **1** | 3.2 |

What the reported version and range were, for those 131 (approx+lineage):

| Outcome | Count |
|---|---|
| right version, and the range is that one version | 67 |
| right version, the range also lists other possible versions | 43 |
| wrong version picked, the true one inside the range | 11 |
| true version outside the range | 10 |

By role (approx+lineage): the bundle's own package 0.737 exact (n 38), its dependencies 0.882
(n 93).

Function level, from the source maps (approx): 26,056 non-trivial functions come from a package;
20,211 were explained by a detected package, 17,424 of them by the right one — **attribution
accuracy 0.862**, coverage 0.776 (exact mode: 0.922 and 0.474).

Speed: step 01 builds the index in 31 s; step 02 runs the 44 bundles in about 30 s, three modes
included.

## How the algorithm got there

Every change was measured on the same 44 bundles (approx mode unless noted).

| # | Change | Why (what the errors showed) | P | R | F1 | Version exact |
|---|---|---|---|---|---|---|
| 0 | First version: greedy by evidence, explaining away, parsimony for versions | — | 0.494 | 0.383 | 0.431 | 0.487 (lineage 0.526) |
| 1 | Next package = the best-covered one, not the one with most evidence | prebuilt mega-bundles (`@clerk/clerk-js` ×29, `@findify/bundle` ×21 false detections) hold copies of many libraries and took their functions | 0.566 | 0.555 | 0.560 | |
| 2 | Coverage counts distinct reference functions, weighted by similarity | many bundle copies of one helper inflated coverage to 1.0 | 0.777 | 0.550 | 0.644 | |
| 3 | Small packages accepted at coverage ≥ 0.5 | packages with 2–5 functions (`hoist-non-react-statics`, `@emotion/*`) can't reach the evidence threshold | 0.764 | 0.603 | 0.674 | |
| — | *tried and dropped:* accept on strong evidence alone | brought the mega-bundles back | 0.655 | 0.617 | 0.635 | |
| 4 | Reported version: newest among equal scores instead of parsimony | the right version was in the range but parsimony picked the oldest: a bundle holds only part of a package, so "functions this version has and the bundle lacks" penalises newer versions | | | | 0.393 → 0.779 (lineage 0.475 → 0.787) |
| 5 | Function-level evaluation from the source maps | to see *why* each error happens (next rows) | | | | |
| 6 | Functions found in > 30 packages give no evidence | Babel/TypeScript helpers and webpack's runtime, inlined in hundreds of packages, made `qrcode.react` and others "appear" | 0.911 | 0.536 | 0.675 | |
| 7 | Shared code: a package whose code an earlier one holds is still found at coverage ≥ 0.5 | algoliasearch's UMD build holds its `@algolia/*` clients; element-ui's holds its dependencies | 0.848 | 0.612 | 0.711 | |
| 8 | Minimum evidence 2.0 → 1.5 | small dependencies just below it | **0.844** | **0.646** | **0.732** | **0.802 (lineage 0.809)** |
| 9 | LSH candidates must share 2 of 21 bands | ~10,600 candidates per function, most of generic code | same | same | same | same, 4× faster (100 s → 26 s) |
| 10 | Version votes: only the package's own code (below) | tracing every wrong version showed other packages' functions voting | same | same | same | 0.809 → 0.832, in range 0.847 → 0.916 (approx 0.802 → 0.840, exact mode 0.753 → 0.804) |
| 11 | Versions by intersection instead of votes (below) | a deterministic answer: the versions all the package's functions are consistent with | same | same | same | 0.832 → 0.840, in range 0.916 → 0.924, median range 2 → 1; single-version answers 57 (55 right) → 70 (67 right) |

Exact mode went from P 0.663 / R 0.301 / F1 0.414 to 0.856 / 0.483 / 0.618.

## Ablation: each rule switched off (approx+lineage, everything else as tuned)

| Variant | P | R | F1 | Version exact | In range | Attribution accuracy |
|---|---|---|---|---|---|---|
| **as tuned** | 0.844 | 0.646 | 0.732 | 0.840 | 0.924 | 0.862 |
| order by evidence, not coverage | 0.814 | 0.608 | 0.696 | 0.821 | 0.919 | 0.748 |
| no `maxShared` limit | 0.732 | 0.665 | 0.697 | 0.837 | 0.919 | 0.852 |
| no shared-code rule | 0.904 | 0.584 | 0.709 | 0.864 | 0.915 | 0.864 |
| no small-package rule | 0.842 | 0.612 | 0.709 | 0.831 | 0.919 | 0.862 |
| minimum evidence 2.0 | 0.848 | 0.612 | 0.711 | 0.831 | 0.919 | 0.862 |
| every function that matches the package counts for its version | 0.844 | 0.646 | 0.732 | 0.809 | 0.847 | 0.862 |
| an approximate match counts for its nearest record only | 0.844 | 0.646 | 0.732 | 0.824 | 0.908 | 0.862 |
| contradiction → union of all functions' versions | 0.844 | 0.646 | 0.732 | 0.840 | 0.962 (median range 10) | 0.862 |
| voting instead of intersection | 0.844 | 0.646 | 0.732 | 0.832 | 0.916 | 0.862 |
| voting with parsimony | 0.844 | 0.646 | 0.732 | 0.519 | 0.916 | 0.862 |
| `minSim` 0.6 | 0.850 | 0.651 | 0.737 | 0.841 | 0.909 | 0.883 |
| `minSim` 0.7 | 0.855 | 0.622 | 0.720 | 0.810 | 0.897 | 0.898 |
| LSH: 1 band is enough | 0.844 | 0.646 | 0.732 | 0.840 | 0.924 | 0.862 |
| everything off (= version 0) | 0.494 | 0.383 | 0.431 | 0.539 | 0.829 | 0.703 |

`minSim` 0.6 is marginally better on F1 and worse on versions; 0.5 was kept. Reproduce with
`node tier3/tools/sweep.mjs … --variants '[{}, {"orderPower":0}, …]'`.

## Why versions came out wrong, and the fix

Every wrong version of the first tuned run was traced function by function: which bundle
functions voted for the reported version and not for the true one, and where the source map says
they come from. Three causes:

1. **Other packages' code voted.** Every function that matched a package voted for its version,
   also functions another found package explained. quill@2.0.3 was reported as 1.3.7 because the
   bundle's eventemitter3 functions match quill 1.x exactly (quill 1.x's prebuilt `dist/quill.js`
   held eventemitter3); instantsearch.js@4.50.0 was pulled by algoliasearch-helper's functions,
   which some instantsearch builds hold; side-channel 1.1.1 was reported as 1.1.0 three times
   because three functions of side-channel-list/-map/-weakmap also match side-channel's reference
   up to 1.1.0 exactly (the same code is in both); react 18.3.1 and @floating-ui/dom 1.5.3 were
   each pulled by one function of react-dom and of @floating-ui/utils. **Fix:** a function votes only if the
   package matches it about as well as the best *found* package does, and not when another found
   package matches it just as well. "Found" matters: qs@6.11.0's two version-telling functions
   match `@clerk/clerk-js`'s copy of qs (0.94) better than tier 2's qs (0.88) — clerk-js is not in
   the bundle, so it must not take qs's vote.
2. **Sketch noise.** An approximate match voted only for its nearest record, but 64-value sketches
   estimate similarity to a few hundredths, and neighbouring variants of a function are often within
   that: a function of @emotion/serialize 1.3.3 scores 0.64 against the 1.0.0–1.0.3 variant and 0.61
   against the 1.0.4–1.3.3 variant it really is. **Fix:** an approximate match votes for every record
   within 0.05 of its best.
3. **The reference lacks the code** (8 cases, unchanged): see below.

## Versions by intersection

The version is now decided without scores. Each of the package's own functions is consistent with
a set of versions (exact match: its record's versions; approximate: the records within 0.05 of its
best similarity; lineage mode: the variant its markers point to), and the package's versions are
the intersection of the sets. When the intersection is empty — the functions contradict each other
— the range is the versions consistent with the most functions, with the disagreeing functions
listed; the union of all the functions' versions is written as well, and `VERSION_FALLBACK=union`
reports it as the range.

| approx+lineage | Version exact | In range | Median range | Mean range | Single-version answers (right) |
|---|---|---|---|---|---|
| voting | 0.832 | 0.916 | 2 | 3.8 | 57 (55) |
| intersection, contradiction → union | 0.840 | 0.962 | 10 | 50.3 | 36 (36) |
| **intersection, contradiction → most functions** | **0.840** | 0.924 | **1** | **3.2** | **70 (67)** |

How often the functions agree, and what the intersection gives then:

| | Packages | True version inside | Single version (right) | Median range |
|---|---|---|---|---|
| all functions agree | 72 | 70 | 36 (36) | 2 |
| they contradict: most-functions fallback | 59 | 51 | 34 (31) | 1 |
| they contradict: union fallback | 59 | 56 | 0 | 67 |

When a package's functions agree, the intersection is right 70 times out of 72, and a
single-version intersection was never wrong. They contradict in 45 % of the packages, typically
because of 3 functions (median). Over all contradicting packages, the functions that exclude the
true version are approximate matches (684) and lineage-decided ones (514) — the same source
minified by Terser and by swc, and markers that describe swc's formatting —, exact matches (553,
most of them in the 8 packages whose reference lacks the newer code; also lodash: its 4.17.16
tarball holds a second build, 1,067 functions against 555, and 14 bundle functions match only that
build's form exactly), and other packages' code (≈ 270). The union of all their versions is then a
median of 67 versions — true, but no information; the versions most functions agree with keep the
answer useful.

## What is left, by reason (approx+lineage)

**Missed (74):**

- *Too little evidence (28)* — mostly the tiny helper packages of `qs` and `instantsearch.js`
  (`call-bind-apply-helpers`, `dunder-proto`, `es-errors`, `get-proto`, `gopd`, `has-symbols`: 1–7
  functions each, also copied into many prebuilt bundles, so their functions are not specific), and
  `@babel/runtime` / `@swc/helpers` (their helpers are inlined everywhere — the `maxShared` rule
  removes exactly that evidence). `react-dom` 19: 17 of its 19 bundled functions match, but its
  reference holds 2,114 (every build: development, server, …), so its coverage stays below 1 %.
- *Explained by another package (25)* — the 12 `@algolia/*` clients in `algoliasearch@5.64.0`
  (algoliasearch's reference holds all of them, and the bundle covers less than half of each);
  element-ui's `core-js`, `babel-runtime`, `babel-helper-vue-jsx-merge-props` (element-ui's
  reference holds them); lit's packages taken by `mealz-components`, a prebuilt bundle that holds
  lit; `lodash-es` taken by `lodash` (the same code under another name).
- *Reference lacks the code (18)* — tier 2's reference does not hold the bundled code: `stylis` 4 has
  6 reference functions for about 50 in its bundles, `lit-element` 4, `@shoelace-style/animations`,
  and three helper packages with one function each. The cause is in tier 2, faithfully: Aletheia
  drops `export` declarations, so a package whose `exports` lead to an ES-module build loses that
  code.
- *No functions in the bundle (3)* — `lit`, whose entry only re-exports.

**Wrong versions (10 of 131 outside the range):**

- *the reference lacks the newer code (8)*: `@tanstack/query-core` 5 (95–123 reference functions
  against 398 at 4.x, reported as 4.x), `@opentelemetry/instrumentation-fetch` 0.301.2 and the
  api, core, instrumentation and web-common versions it bundles (`@opentelemetry/api` 1.10.0 has
  73 against 191 at 1.9.1, `instrumentation` 0.301.2 11 against 141 at 0.223.2 — reported as the
  older release), `@shoelace-style/shoelace` 2.20.1 (24 against 1,389 at 2.4.0);
- *one react-dom function (1)*: react 18.3.1 → 18.3.0: a react-dom function resembles react's code
  (0.78) a little more than react-dom's own reference does, so it counts for react, and its
  lineage markers point to ≤ 18.3.0. Plain approx gets it right;
- *contradicting functions (1)*: `@emotion/react` 11.8.1 → 11.14.0 (range 11.13.0–11.14.0, 4 of its
  functions disagree).

With voting, `@emotion/serialize` 1.3.3 was reported as 1.0.3 in both emotion bundles: the lineage
markers telling 1.0.3 from 1.0.4 are `var a, b = !0` against `var b = !0` — how swc laid out the
declarations; Terser lays out 1.3.3's code the other way. In the intersection that one function is
outnumbered and listed as a conflict.

In the 11 wrong picks inside the range, the bundled functions do not tell the range's versions
apart and the newest is given as the guess (e.g. throttle-debounce 1.1.0 in element-ui is reported
as 2.0.1, range 1.0.0–2.0.1).

**Wrongly found (25)** — 24 of them are about which name to give code that is in the bundle: 11
detections are real copies of the detected package inside another package's files, 13 name a
package that contains (or equals) the bundled package's code:

- *embedded in a file of Q (10)*: `@algolia/*` inside `algoliasearch.umd.js`, parchment, quill-delta,
  eventemitter3, fast-diff inside `quill/dist/quill.js` (and its Babel helpers matched as
  `@swc/helpers`), toggle-selection inlined by copy-to-clipboard 4, `lodash.isequal` inside
  element-ui's lodash copy;
- *vendored copy inside Q (1)*: lodash in `element-ui/lib/utils/lodash.js`;
- *holds a copy of Q (9)*: prebuilt bundles whose reference contains the real package —
  `mealz-components` (lit), `@emotion/cache` (stylis), `lodash.isequal` (lodash), aos (lodash-es),
  `@opentelemetry/api-logs` (`@opentelemetry/api`);
- *same code as Q (4)*: lodash for lodash-es, `@swc/helpers` for element-ui's inlined helpers
  (both versions), `@clerk/ui` for instantsearch's `@swc/helpers`;
- *shared or generic code (1)*.

## Caveats

- The thresholds were tuned on these 44 bundles; the ablation shows how much each rule matters, and
  the results are stable across the variants (F1 0.70–0.74), but a held-out set would confirm them.
- 24 of the 44 bundles are of the packages' latest versions, which suits "newest among equals". On
  the older versions the reported version is still exact for 72 % (and in range for 83 %).
- The SBOM lists packages by module paths; it cannot see copies of a package inside another one's
  files. The source maps can, which is why both precisions are reported.

## Per bundle

| Bundle | In SBOM | Detected | TP | FP | FN | Version exact |
|---|---|---|---|---|---|---|
| @ctrl+tinycolor@3.4.1 | 1 | 1 | 1 | 0 | 0 | 1/1 |
| @ctrl+tinycolor@4.3.1 | 1 | 1 | 1 | 0 | 0 | 1/1 |
| @emotion+react@11.14.0 | 15 | 11 | 11 | 0 | 4 | 9/11 |
| @emotion+react@11.8.1 | 14 | 11 | 11 | 0 | 3 | 9/11 |
| @floating-ui+dom@1.5.3 | 3 | 3 | 3 | 0 | 0 | 1/3 |
| @floating-ui+dom@1.8.0 | 3 | 3 | 3 | 0 | 0 | 3/3 |
| @floating-ui+react@0.27.20 | 8 | 7 | 7 | 0 | 1 | 7/7 |
| @opentelemetry+instrumentation-fetch@0.301.2 | 6 | 6 | 5 | 1 | 1 | 0/5 |
| @shoelace-style+shoelace@2.20.1 | 13 | 7 | 6 | 1 | 7 | 5/6 |
| @tanstack+query-core@5.107.1 | 1 | 1 | 1 | 0 | 0 | 0/1 |
| @tanstack+query-core@5.29.0 | 1 | 1 | 1 | 0 | 0 | 0/1 |
| algoliasearch@4.17.0 | 1 | 4 | 1 | 3 | 0 | 1/1 |
| algoliasearch@5.64.0 | 13 | 1 | 1 | 0 | 12 | 1/1 |
| axios@0.27.2 | 1 | 1 | 1 | 0 | 0 | 1/1 |
| axios@1.21.1 | 1 | 1 | 1 | 0 | 0 | 1/1 |
| copy-to-clipboard@3.3.3 | 2 | 2 | 2 | 0 | 0 | 1/2 |
| copy-to-clipboard@4.0.2 | 1 | 1 | 0 | 1 | 1 | – |
| element-ui@2.13.2 | 10 | 8 | 7 | 1 | 3 | 6/7 |
| element-ui@2.15.14 | 10 | 10 | 7 | 3 | 3 | 6/7 |
| eventemitter3@4.0.7 | 1 | 1 | 1 | 0 | 0 | 0/1 |
| eventemitter3@5.0.4 | 1 | 1 | 1 | 0 | 0 | 1/1 |
| hoist-non-react-statics@3.3.0 | 2 | 2 | 2 | 0 | 0 | 1/2 |
| hoist-non-react-statics@3.3.2 | 2 | 2 | 2 | 0 | 0 | 2/2 |
| instantsearch.js@4.123.0 | 23 | 14 | 13 | 1 | 10 | 11/12 |
| instantsearch.js@4.50.0 | 4 | 4 | 4 | 0 | 0 | 2/3 |
| lit@2.4.0 | 4 | 2 | 1 | 1 | 3 | 1/1 |
| lit@3.3.3 | 4 | 1 | 0 | 1 | 4 | – |
| lodash@4.17.21 | 1 | 2 | 1 | 1 | 0 | 1/1 |
| lodash@4.18.1 | 1 | 2 | 1 | 1 | 0 | 1/1 |
| qs@6.11.0 | 19 | 10 | 10 | 0 | 9 | 8/9 |
| qs@6.17.1 | 19 | 10 | 10 | 0 | 9 | 8/9 |
| quill@1.3.7 | 1 | 7 | 1 | 6 | 0 | 1/1 |
| quill@2.0.3 | 8 | 9 | 7 | 2 | 1 | 6/7 |
| react-dom@18.2.0 | 3 | 3 | 3 | 0 | 0 | 2/3 |
| react-dom@19.3.1 | 2 | 1 | 1 | 0 | 1 | 1/1 |
| stylis@4.0.13 | 1 | 1 | 0 | 1 | 1 | – |
| stylis@4.4.0 | 1 | 1 | 0 | 1 | 1 | – |
| tabbable@5.3.3 | 1 | 1 | 1 | 0 | 0 | 1/1 |
| tabbable@6.5.2 | 1 | 1 | 1 | 0 | 0 | 1/1 |
| throttle-debounce@3.0.1 | 1 | 1 | 1 | 0 | 0 | 1/1 |
| throttle-debounce@5.0.2 | 1 | 1 | 1 | 0 | 0 | 1/1 |
| vue@3.5.45 | 5 | 1 | 1 | 0 | 0 | 1/1 |
| web-vitals@3.1.1 | 1 | 1 | 1 | 0 | 0 | 1/1 |
| web-vitals@6.2.3 | 1 | 1 | 1 | 0 | 0 | 1/1 |

