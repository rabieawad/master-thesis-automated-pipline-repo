Real examples for the tier-3 tests (gzipped; the tests unpack them into a temporary folder):

- tier2/05_deduplicated_functions: tier 2's output for copy-to-clipboard, toggle-selection,
  throttle-debounce (with their lineage files) and eventemitter3 (every published version).
- tier1/06_extracted_functions, tier1/05_selected_bundles: tier 1's webpack bundles of
  copy-to-clipboard@3.3.3 (bundles toggle-selection@1.0.6), copy-to-clipboard@4.0.2 (has
  toggle-selection's code inlined), throttle-debounce@3.0.1 and @5.0.2, eventemitter3@5.0.4 —
  their extracted functions, the bundle with its source map, and its SBOM.
