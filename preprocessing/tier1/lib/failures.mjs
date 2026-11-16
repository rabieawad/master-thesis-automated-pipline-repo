// One fixed list of reasons a package does not end up as a bundle. The automatic check, the
// bundler's own errors and Claude's repair reports all use these same category names, so
// every package's outcome can be counted and compared in one table.

export const CATEGORIES = {
  no_js_entry:          "the package has no JavaScript entry webpack can load (no main/exports '.', or it points at a missing file)",
  stylesheet_only:      "the entry is a stylesheet (CSS/SCSS/LESS); the faithful webpack config does not load CSS from node_modules",
  remote_imports:       "the code imports from remote https:// URLs, which webpack cannot bundle",
  missing_dependency:   "a module the package requires was not installed",
  native_module:        "a native addon or platform-specific binary webpack cannot read",
  unsupported_syntax:   "webpack cannot parse a file (syntax or file type it has no loader for)",
  bundler_crash:        "the bundling process itself crashed",
  out_of_memory:        "the bundling process ran out of memory",
  timeout:              "bundling took longer than the time limit",
  download_failed:      "the package could not be installed",
  other:                "none of the above",
};
export const CATEGORY_NAMES = Object.keys(CATEGORIES);

// Best-effort category for an error message from the bundler (webpack) or the installer.
export function categorizeError(error, name = "") {
  const e = String(error ?? "");
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (/heap out of memory|ERR_WORKER_OUT_OF_MEMORY|JavaScript heap/i.test(e)) return "out_of_memory";
  if (/timed? ?out|ETIMEDOUT/i.test(e)) return "timeout";
  if (/https?:\/\//i.test(e) && /UnhandledSchemeError|Reading from "https?:/i.test(e)) return "remote_imports";
  if (name && (new RegExp(`Can't resolve '${esc}'`).test(e) || /is not exported under the conditions/.test(e))) return "no_js_entry";
  if (/\.node['"]|native addon|\.node$/i.test(e)) return "native_module";
  if (/Can't resolve '/.test(e) || /Module not found/.test(e)) return "missing_dependency";
  if (/Module parse failed/.test(e)) return /Unexpected character '@'/.test(e) ? "stylesheet_only" : "unsupported_syntax";
  if (/^crashed|exited with|SIGKILL|SIGSEGV/i.test(e)) return "bundler_crash";
  return "other";
}

// The one standard log line every package gets, whatever happened to it:
//   RESULT | <name>@<version> | <outcome> | <category> | <one-line cause>
export function resultLine(id, outcome, category = "", cause = "") {
  const one = String(cause ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
  return `RESULT | ${id} | ${outcome} | ${category || "-"} | ${one || "-"}`;
}
