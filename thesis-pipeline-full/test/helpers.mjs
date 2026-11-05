// Shared test helpers: project paths, temp dirs, fixtures, running step scripts.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const TIER1 = join(ROOT, "tier1");
export const TIER2 = join(ROOT, "tier2");

// make a fresh temp dir; caller cleans with cleanup()
export function tmp(prefix = "tp") {
  const dir = mkdtempSync(join(tmpdir(), prefix + "-"));
  return { dir, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} } };
}
export function writeJson(p, obj) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(obj, null, 2)); }
export function writeText(p, s) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); }
export function read(p) { return readFileSync(p, "utf8"); }
export function exists(p) { return existsSync(p); }

// run a project script with node; returns {stdout, code}. Never throws on non-zero.
export function runNode(script, args = [], opts = {}) {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
    return { stdout, code: 0 };
  } catch (e) {
    return { stdout: (e.stdout || "") + (e.stderr || ""), code: e.status ?? 1 };
  }
}

// parse a simple CSV (handles quoted cells with embedded commas/quotes)
export function parseCsv(text) {
  const parseLine = (line) => { const out = []; let cur = "", q = false; for (let i = 0; i < line.length; i++) { const c = line[i]; if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; } else if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c; } out.push(cur); return out; };
  const lines = text.split(/\r?\n/).filter((l) => l.length);
  const header = parseLine(lines[0]);
  return lines.slice(1).map((l) => { const cells = parseLine(l); const row = {}; header.forEach((h, i) => (row[h] = cells[i])); return row; });
}

// is an npm module importable (for gating integration tests that need project deps)?
export async function hasModule(name) { try { await import(name); return true; } catch { return false; } }

// build an npm-pack-style .tgz from an in-memory file map {relpath: content}. Files are put
// under package/ and tarred, matching what 03_pseudo-bundle expects (--strip-components=1).
export function makeTgz(tgzPath, files) {
  const t = tmp("pack");
  try {
    for (const [rel, content] of Object.entries(files)) writeText(join(t.dir, "package", rel), content);
    mkdirSync(dirname(tgzPath), { recursive: true });
    execFileSync("tar", ["-czf", tgzPath, "-C", t.dir, "package"], { stdio: "ignore" });
  } finally { t.cleanup(); }
}
