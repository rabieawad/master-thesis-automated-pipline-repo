# Does a string-to-string comparison change step 05's result?

**No.** On this corpus the exact character-by-character comparison of the function texts and the
truncated-`sha256` comparison produce **byte-identical** output, and there is not a single colliding
id. The string comparison is now the default (`DEDUP_IDENTITY=string`) because it makes "same
function" mean literally the same string, at +4.5 % peak memory and no extra time.

## Corpus

1533 package versions from the two uploaded tarball collections (1,534 `.tgz`, one duplicate
across the two archives dropped), bundled un-minified (`MINIFY=0`) and extracted with `MIN_LOC=0`:

| package | versions |
|---|---|
| `@sentry/browser` | 589 |
| `@sentry/browser-utils` | 37 |
| `@sentry/conventions` | 34 |
| `@sentry/core` | 580 |
| `@sentry/feedback` | 37 |
| `@sentry/replay` | 219 |
| `@sentry/replay-canvas` | 37 |

**689,402 function instances** in total. Every version downloaded, bundled and
extracted without a failure.

## What was compared

The comparison key of a function is `"<signature>\0<bodySource>\0<body text>"`. The two ways of
comparing two keys:

- **`string`** — compare the keys themselves, character by character.
- **`hash`** — compare `sha256(key)[:24]`, i.e. 96 bits, which is what step 05 did before.

They can only disagree if two *different* keys share a 24-char id, which would silently merge two
functions that are not the same.

## Result

### 1. Step 05 run twice over the same extracted functions

Same input directory, only the comparison changed:

| `DEDUP_MODE` | extra flags | unique functions | `unique_functions.jsonl`, `occurrences.csv`, `version_index.json`, `summary.json` |
|---|---|---|---|
| `normalized` | — | 16,148 | **byte-identical** |
| `exact` | — | 17,396 | **byte-identical** |
| `exact` | `--strict-type` | 17,435 | **byte-identical** |
| `normalized` | `--strict-type` | 16,204 | **byte-identical** |

### 2. Independent re-grouping with no hashing at all

Every function instance was re-grouped by its **full key string** (a `Map` keyed by the strings
themselves, so lookup is string equality) and the grouping compared against step 05's own
`version_index.json`:

| | `normalized` | `exact` |
|---|---|---|
| function instances | 689,402 | 689,402 |
| groups by exact string comparison | 16,148 | 17,396 |
| groups by truncated `sha256` id | 16,148 | 17,396 |
| ids covering more than one string group | **0** | **0** |
| string groups split across ids | 0 | 0 |
| instances missing from step 05 | 0 | 0 |
| **mapping is a bijection** | **yes** | **yes** |

The id ↔ string-group mapping is one-to-one in both modes: no truncated id stands for two different
function texts, and no function text is split across two ids.

### 3. Cost

| comparison | wall time | peak RSS |
|---|---|---|
| `hash` | 11 s | 1,064 MB |
| `string` | 11 s | 1,112 MB (+4.5 %) |

The `string` comparison keeps one copy of each *distinct* key (16,148
of them, against 689,402 instances), so the overhead does not grow with the
number of versions.

## What *does* change the answer

Not the hash, but the choice of **which text** is compared (`DEDUP_MODE`):

- `normalized` (16,148 unique) vs `exact`
  (17,396 unique) — **1,248 more**
  records in `exact` mode, because a function whose locals were renamed between versions counts as
  new there.
- 896 of the 16,148
  `normalized` records (5.5 %)
  hold **more than one raw spelling** of the same normalized body — those are exactly the groups the
  normalization merges and `exact` mode would keep apart.
- Dedup ratio on this corpus: **42.7×** (689,402 instances →
  16,148 unique), 400 functions shared across more
  than one package, 556 with a gap in their version range.

## Reproducing it

```bash
# one extraction pass, keeping the per-version functions.json files
MINIFY=0 node tier2/06_stream-packages.mjs <out> --input <tier1-out> \
  --min-loc 0 --identity string --keep 04 --tgz-cache <dir-of-tgz>

# then the same step 05 twice over that one directory
node tier2/05_dedup-functions.mjs <out>/04_extracted_functions /tmp/d5-string --identity string
node tier2/05_dedup-functions.mjs <out>/04_extracted_functions /tmp/d5-hash   --identity hash
cmp /tmp/d5-string/unique_functions.jsonl /tmp/d5-hash/unique_functions.jsonl
```

`test/tier2-05-dedup.test.mjs` and `test/tier2-stream.test.mjs` assert the same equivalence on small
fixtures, plus the id-collision refusal that would fire if a collision ever did occur.

## Side result

The streamed pipeline was validated at full scale on the way: the 7 per-package partials merged into
output **byte-identical** to a batch step 05 over all 1,533 versions
(689,402 instances), with `MINIFY=0` honoured and intermediate files deleted as
they went.
