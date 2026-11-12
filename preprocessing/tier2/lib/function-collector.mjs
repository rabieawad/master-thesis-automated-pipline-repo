/**
 * Function collector for the reference pipeline.
 *
 * This is deliberately a thin re-export of the first pipeline's step 06
 * (../../tier1/06-extract-functions.mjs). Both pipelines therefore share ONE
 * collector and ONE feature extractor, so the reference dataset lines up with the
 * first dataset field-for-field (same functions, order, text/hash/loc, and the
 * same minification-robust v2 fields). Keeping a single source of truth avoids the
 * two copies silently drifting apart.
 *
 * Re-exported here: collectFunctions, countLoc, extractFunctions (+ default),
 * extractWithFeatures. For the reference dataset the pseudo-bundle is kept
 * un-minified, so each function's LOC is the real pre-minification line count.
 */
export * from "../../tier1/06-extract-functions.mjs";
export { default } from "../../tier1/06-extract-functions.mjs";

// The shared extractFunctions defaults to the paper's library filter (minLoc = 6).
// The reference pipeline has always kept *every* function by default (minLoc = 0) and
// lets the caller opt into a filter, so preserve that contract here. The collector and
// feature extraction are unchanged — this only sets the default LOC threshold.
import { extractFunctions as _extractFunctions } from "../../tier1/06-extract-functions.mjs";
export function extractFunctions(code, opts = {}) {
    return _extractFunctions(code, { minLoc: 0, ...opts });
}
