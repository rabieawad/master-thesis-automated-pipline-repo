// Packs each step's bulk output (the per-package files) into .tgz archives when a run ends,
// and unpacks them again before the next run, so every step always sees plain files.
//
// Packed (one archive per kind of output, next to where the files were):
//   tier 1  02_downloaded_packages/packages.tgz          the downloaded <folder>.tgz + .meta.json
//           03_bundles_minified/bundles.tgz, sbom.tgz, modules.tgz
//           03_bundles_minified/claude_repair/workspaces.tgz   Claude's per-package folders
//           03_bundles_minified/stream/records.tgz       one record per package (streamed mode)
//           05_selected_bundles/bundles.tgz, sbom.tgz, modules.tgz
//           06_extracted_functions/functions.tgz         <bundle>.functions.json
//   tier 2  02_downloaded_packages/packages.tgz          <name>@<version>.tgz
//           03_pseudo_bundles/bundles.tgz
//           04_extracted_functions/functions.tgz
//           05_deduplicated_functions/packages.tgz, lineages.tgz, partials.tgz, versions.tgz, groups.tgz
//   tier 3  02_detections/bundles.tgz                    <bundle>.json, the detections per bundle
// Never packed: logs, and the small files that are not per package (lists, summaries,
// manifests, CSV/JSON reports, the merged unique_functions.jsonl …).
//
// Inside each archive the paths are the same as before packing, so
//   tar -xzf bundles.tgz          (run in the folder that holds it)
// gives back the original files.

import { existsSync, readdirSync, statSync, writeFileSync, renameSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

// what to pack, per tier. `dir` = a subfolder packed whole; `files` = top-level files
// matching the pattern; `subdirs` = every subfolder of `base` together.
const TARGETS = {
  tier1: [
    { base: "02_downloaded_packages", archive: "packages.tgz", files: /\.tgz$|\.meta\.json$/ },
    ...["bundles", "sbom", "modules"].map((d) => ({ base: "03_bundles_minified", archive: `${d}.tgz`, dir: d })),
    { base: "03_bundles_minified/claude_repair", archive: "workspaces.tgz", subdirs: true },
    { base: "03_bundles_minified/stream", archive: "records.tgz", dir: "records" },
    ...["bundles", "sbom", "modules"].map((d) => ({ base: "05_selected_bundles", archive: `${d}.tgz`, dir: d })),
    { base: "06_extracted_functions", archive: "functions.tgz", files: /\.functions\.json$/ },
  ],
  tier2: [
    { base: "02_downloaded_packages", archive: "packages.tgz", files: /\.tgz$/ },
    { base: "03_pseudo_bundles", archive: "bundles.tgz", dir: "bundles" },
    { base: "04_extracted_functions", archive: "functions.tgz", files: /\.functions\.json$/ },
    ...["packages", "lineages", "partials", "versions", "groups"].map((d) => ({ base: "05_deduplicated_functions", archive: `${d}.tgz`, dir: d })),
  ],
  tier3: [
    { base: "02_detections", archive: "bundles.tgz", dir: "bundles" },
  ],
};
// only: optional list of "base/archive" (e.g. "06_extracted_functions/functions.tgz") to limit a
// call to some targets — tier 3 unpacks and repacks just the tier-1/tier-2 archives it reads
const pick = (tier, only) => (TARGETS[tier] ?? []).filter((t) => !only || only.includes(`${t.base}/${t.archive}`));

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

// the entries (relative to base) a target would put in its archive right now
function members(t, base) {
  if (!isDir(base)) return [];
  if (t.dir) return isDir(join(base, t.dir)) && readdirSync(join(base, t.dir)).length ? [t.dir] : [];
  const names = readdirSync(base).filter((n) => n !== t.archive && !n.startsWith(t.archive));
  if (t.files) return names.filter((n) => t.files.test(n) && !isDir(join(base, n)));
  if (t.subdirs) return names.filter((n) => isDir(join(base, n)));
  return [];
}

// existing plain files win over the archived copy: GNU tar needs --skip-old-files (its -k
// fails on existing files), bsdtar (macOS, Windows) uses -k
let keepFlag = null;
function untar(archive, base) {
  if (keepFlag == null) { try { keepFlag = /GNU tar/.test(execFileSync("tar", ["--version"], { encoding: "utf8" })) ? "--skip-old-files" : "-k"; } catch { keepFlag = "-k"; } }
  execFileSync("tar", ["-xzf", archive, keepFlag, "-C", base], { stdio: ["ignore", "ignore", "pipe"] });
}

// Pack the bulk output of one tier's output folder. Returns [{ archive, entries, bytes }].
export function packOutputs(tier, outRoot, log = () => {}, only = null) {
  const done = [];
  for (const t of pick(tier, only)) {
    const base = join(outRoot, t.base), archive = join(base, t.archive);
    const add = members(t, base);
    if (!add.length) continue;
    // an archive from an earlier run (if any) is merged in, so nothing is lost
    if (existsSync(archive)) { untar(archive, base); }
    const all = members(t, base);
    const list = join(base, `.${t.archive}.list`), tmp = `${archive}.tmp`;
    writeFileSync(list, all.join("\0") + "\0");
    try {
      execFileSync("tar", ["-czf", tmp, "-C", base, "--null", "-T", list], { stdio: ["ignore", "ignore", "pipe"], maxBuffer: 64 * 1024 * 1024 });
      renameSync(tmp, archive);
    } catch (e) {
      rmSync(tmp, { force: true });
      log(`could not pack ${archive}: ${String(e.stderr ?? e.message).trim().slice(0, 200)} — files left as they are`);
      continue;
    } finally { rmSync(list, { force: true }); }
    for (const m of all) rmSync(join(base, m), { recursive: true, force: true });
    const bytes = statSync(archive).size;
    done.push({ archive, entries: all.length, bytes });
    log(`packed ${all.length} ${t.dir ? "folder" : "item"}(s) into ${join(t.base, t.archive)} (${(bytes / 1048576).toFixed(1)} MB)`);
  }
  return done;
}

// Unpack every archive packOutputs made in this output folder, and delete the archives.
export function unpackOutputs(tier, outRoot, log = () => {}, only = null) {
  const done = [];
  for (const t of pick(tier, only)) {
    const base = join(outRoot, t.base), archive = join(base, t.archive);
    if (!existsSync(archive)) continue;
    try { mkdirSync(base, { recursive: true }); untar(archive, base); rmSync(archive, { force: true }); done.push(archive); log(`unpacked ${join(t.base, t.archive)}`); }
    catch (e) { log(`could not unpack ${archive}: ${String(e.stderr ?? e.message).trim().slice(0, 200)}`); }
  }
  return done;
}

export const PACK_TARGETS = TARGETS;

// CLI:  node lib-pack.mjs pack|unpack tier1|tier2|tier3 <outputFolder>
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [cmd, tier, out] = process.argv.slice(2);
  if (!["pack", "unpack"].includes(cmd) || !TARGETS[tier] || !out) { console.error("usage: node lib-pack.mjs pack|unpack tier1|tier2|tier3 <outputFolder>"); process.exit(2); }
  (cmd === "pack" ? packOutputs : unpackOutputs)(tier, out, (s) => console.log(s));
}
