// Per-package JSON files may be stored gzip-compressed (<pkg>.json.gz) to save disk: tier 2 writes
// plain .json; a finished package's file can be compressed in place (tools/compress-packages.mjs).
// These helpers read either form and write back in the form the file already has.
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";

export const isPackageFile = (f) => f.endsWith(".json") || f.endsWith(".json.gz");
export const keyOfPackageFile = (f) => f.replace(/\.json(\.gz)?$/, "");
export function readJsonFile(path) {
  const buf = readFileSync(path);
  return JSON.parse((path.endsWith(".gz") ? gunzipSync(buf) : buf).toString("utf8"));
}
export function writeJsonFile(path, obj, indent = undefined) {
  const text = JSON.stringify(obj, null, indent);
  writeFileSync(path + ".tmp", path.endsWith(".gz") ? gzipSync(text) : text);
  renameSync(path + ".tmp", path);
}
