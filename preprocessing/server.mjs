#!/usr/bin/env node
// Unified control panel: PROJECTS, each made of two chained sub-pipelines (tiers).
//
//   node server.mjs [port=5273]   then open http://127.0.0.1:5273
//
// A project = tier 1 (data preparation, 6 steps) + tier 2 (reference dataset, 5 steps).
// Tier 2's input is auto-wired to tier 1's output, so you never type a directory.
// Each project is saved under projects/<slug>/ with a per-tier state table and logs,
// and is resumable (run whole tier / continue / single step). Create a new project,
// or import an existing tier-1 output to run only tier 2 on it.
//
// Thin wrapper over the tier scripts, which keep working on their own. Localhost only.

import http from "node:http";
import { spawn } from "node:child_process";
import { join, resolve, relative, dirname } from "node:path";
import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync, statSync, mkdirSync, rmSync, createWriteStream, openSync, readSync, closeSync, copyFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { packOutputs, unpackOutputs } from "./lib-pack.mjs";
import { HERE, PROJECTS_DIR, OPENED_FILE, openedProjects, saveOpenedProjects, TIERS, TIER_KEYS, TIER3_INPUT_ARCHIVES, projectDir, projectFile, tierOutput, tierLogs, buildTierCommand, cleanStepOutputs, activeStepIds, allStepIds, tierView } from "./lib-project.mjs";

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 5273);
mkdirSync(PROJECTS_DIR, { recursive: true });

// ---------------- project store (atomic, file-backed) ----------------
// project.json, or its backup (project.json.bak, the last good version) if it cannot be read
function readProjectFile(file) {
  let why = null;
  for (const f of [file, file + ".bak"]) {
    try { const p = JSON.parse(readFileSync(f, "utf8")); if (p && p.tier1 && p.tier2) return { proj: p, fromBackup: f !== file }; why = why ?? `${f.endsWith(".bak") ? "backup" : "project.json"} is not a project`; }
    catch (e) { why = why ?? (existsSync(f) ? `project.json cannot be read (${e.code || e.name}: ${String(e.message).slice(0, 100)})` : "no project.json"); }
  }
  return { proj: null, problem: why };
}
function loadProject(slug) {
  const r = readProjectFile(projectFile(slug));
  if (r.proj) { r.proj.slug = slug; fillSteps(r.proj); } // the folder's name (or its entry in opened-projects.json) is the slug
  return r.proj;
}
function saveProject(proj) {
  proj.updatedAt = new Date().toISOString();
  const file = projectFile(proj.slug), tmp = file + ".tmp";
  // keep the last good version as project.json.bak, in case the disk damages project.json
  try { JSON.parse(readFileSync(file, "utf8")); copyFileSync(file, file + ".bak"); } catch {}
  writeFileSync(tmp, JSON.stringify(proj, null, 2));
  renameSync(tmp, file); // atomic replace
}
// a project saved by an older version may lack steps added since: add them as "not run"
// (and a tier added since — tier 3 — with its default settings)
function fillSteps(proj) {
  for (const t of TIER_KEYS) {
    if (!proj[t]) proj[t] = { params: { ...TIERS[t].defaults }, steps: {} };
    proj[t].steps = { ...freshSteps(t), ...(proj[t].steps ?? {}) };
  }
  return proj;
}
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
// Every project: the folders in PROJECTS_DIR plus the ones opened from elsewhere. A project
// that cannot be read is still listed, with the reason, so it can be fixed or removed.
function listAll() {
  const out = [], opened = openedProjects();
  let names = []; try { names = readdirSync(PROJECTS_DIR).filter((n) => isDir(join(PROJECTS_DIR, n))); } catch {}
  for (const slug of [...names.filter((n) => !opened[n]), ...Object.keys(opened)]) {
    const dir = projectDir(slug), where = opened[slug] ? "opened" : "local";
    if (!isDir(dir)) { out.push({ slug, name: slug, damaged: `folder not found: ${dir} (drive not mounted?)`, where, dir }); continue; }
    const r = readProjectFile(join(dir, "project.json"));
    if (!r.proj) { if (where === "opened" || existsSync(join(dir, "tier1")) || existsSync(join(dir, "project.json.bak")) || existsSync(join(dir, "project.json"))) out.push({ slug, name: slug, damaged: r.problem, where, dir }); continue; }
    r.proj.slug = slug; fillSteps(r.proj);
    out.push(Object.assign(r.proj, { where, dir, ...(r.fromBackup ? { note: "project.json could not be read; loaded from its backup" } : {}) }));
  }
  out.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return out;
}
const listProjects = () => listAll().filter((p) => !p.damaged);
const slugify = (name) => (String(name || "project").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "project") + "-" + randomUUID().slice(0, 4);
// state for every step id the tier can have in ANY mode, so switching mode never loses a row
const freshSteps = (tier) => Object.fromEntries(allStepIds(tier).map((s) => [s, { status: "pending", startedAt: null, finishedAt: null, exitCode: null, durationMs: null }]));

function makeProject(name, tier1Params, tier2Params, externalOutput) {
  const slug = slugify(name);
  for (const t of TIER_KEYS) { mkdirSync(join(projectDir(slug), t, "output"), { recursive: true }); mkdirSync(tierLogs(slug, t), { recursive: true }); }
  const tier1Steps = freshSteps("tier1");
  if (externalOutput) for (const s of Object.keys(tier1Steps)) tier1Steps[s] = { status: "imported", note: "external tier-1 output", startedAt: null, finishedAt: null, exitCode: 0, durationMs: null };
  const proj = {
    id: "proj_" + randomUUID().slice(0, 8), slug, name: name || slug,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    tier1: { params: { ...TIERS.tier1.defaults, ...tier1Params }, steps: tier1Steps, ...(externalOutput ? { externalOutput: resolve(externalOutput) } : {}) },
    tier2: { params: { ...TIERS.tier2.defaults, ...tier2Params }, steps: freshSteps("tier2") },
    tier3: { params: { ...TIERS.tier3.defaults }, steps: freshSteps("tier3") },
  };
  saveProject(proj);
  return proj;
}

// Open existing project(s) where they are: `path` is a project folder (with project.json), any
// folder inside one (e.g. its tier1/output), or a projects folder holding several projects.
function openProjects(path) {
  const start = resolve(path.trim().replace(/^["']|["']$/g, "").replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
  if (!path.trim()) return { error: "give the folder's full path" };
  if (!isDir(start)) return { error: `folder not found: ${start}` };
  const isProject = (d) => existsSync(join(d, "project.json")) || existsSync(join(d, "project.json.bak"));
  let found = [];
  if (isProject(start)) found = [start];
  else {
    // a folder inside a project?
    for (let d = dirname(start), i = 0; i < 4 && d !== dirname(d); d = dirname(d), i++) if (isProject(d)) { found = [d]; break; }
    // or a projects folder
    if (!found.length) try { found = readdirSync(start).map((n) => join(start, n)).filter((d) => isDir(d) && isProject(d)); } catch {}
  }
  if (!found.length) return { error: `no project found in ${start} — choose the project's folder (the one that holds project.json, tier1/ and tier2/), or a folder of projects` };
  const opened = openedProjects(), result = { opened: [], already: [], failed: [] };
  const known = () => new Set([...readdirSync(PROJECTS_DIR).filter((n) => isDir(join(PROJECTS_DIR, n))), ...Object.keys(opened)]);
  for (const dir of found) {
    const r = readProjectFile(join(dir, "project.json"));
    if (!r.proj) { result.failed.push({ dir, problem: r.problem }); continue; }
    const same = [...known()].find((s) => resolve(projectDir(s)) === resolve(dir) || (opened[s] && resolve(opened[s]) === resolve(dir)));
    if (same) { result.already.push({ slug: same, name: r.proj.name, dir }); continue; }
    let slug = dirname(dir) === PROJECTS_DIR ? dir.split(/[\\/]/).pop() : (r.proj.slug || slugify(r.proj.name));
    if (known().has(slug)) slug = slugify(r.proj.name || slug);
    opened[slug] = dir; saveOpenedProjects(opened);
    const proj = r.proj; proj.slug = slug;
    fillSteps(proj);
    // a step that was running when the project was last used is not running now
    for (const t of TIER_KEYS) for (const s of Object.keys(proj[t].steps ?? {})) if (proj[t].steps[s]?.status === "running") { proj[t].steps[s].status = "error"; proj[t].steps[s].note = "interrupted"; }
    saveProject(proj);
    result.opened.push({ slug, name: proj.name, dir, ...(r.fromBackup ? { note: "loaded from project.json.bak" } : {}) });
  }
  return result;
}

// boot: any step left "running" is dead -> error
for (const p of listProjects()) { let ch = false; for (const t of TIER_KEYS) for (const s of allStepIds(t)) if (p[t].steps[s]?.status === "running") { p[t].steps[s].status = "error"; p[t].steps[s].note = "interrupted (server restarted)"; ch = true; } if (ch) saveProject(p); }

// ---------------- per-(project,tier) live runtime ----------------
const runtime = new Map(); // `${slug}:${tier}` -> { listeners, buffer, busy, proc }
function rt(slug, tier) { const k = `${slug}:${tier}`; if (!runtime.has(k)) runtime.set(k, { listeners: new Set(), buffer: [], busy: false, proc: null }); return runtime.get(k); }
// keep the last ~4000 events for late joiners; trim in chunks so a fast step doesn't shift the array on every line
function emit(slug, tier, e) { const r = rt(slug, tier); r.buffer.push(e); if (r.buffer.length > 5000) r.buffer.splice(0, r.buffer.length - 4000); for (const res of r.listeners) writeSse(res, e); }
// a saved step log, at most its last 512 KB (a big bundling log can be tens of MB)
function readLogTail(f, max = 512 * 1024) {
  if (!existsSync(f)) return { text: "" };
  const size = statSync(f).size;
  if (size <= max) return { text: readFileSync(f, "utf8"), size };
  const fd = openSync(f, "r"); const buf = Buffer.alloc(max);
  try { readSync(fd, buf, 0, max, size - max); } finally { closeSync(fd); }
  const text = buf.toString("utf8"); const nl = text.indexOf("\n");
  return { text: nl >= 0 ? text.slice(nl + 1) : text, size, truncated: true, path: f };
}
const labelOf = (tier, step, proj) => { const v = proj && tierView(proj, tier).steps.find((s) => s.id === step); return v ? `${v.num} · ${v.label}` : (TIERS[tier].STEPS.find((s) => s.id === step)?.label ?? step); };
// what the interface needs about a project: the saved project plus each tier's current step list
const withView = (proj) => ({ ...proj, view: Object.fromEntries(TIER_KEYS.map((t) => [t, tierView(proj, t)])) });

// ---------------- tier-2 per-package inclusion selection ----------------
// The "survived" items from tier 1 = each selected package + its bundled dependencies.
function readTier2Items(proj) {
  const t1 = tierOutput(proj, "tier1");
  const find = (...c) => c.find((x) => existsSync(x));
  const depsCsv = find(join(t1, "05_selected_bundles", "selected_dependencies.csv"), join(t1, "selected_dependencies.csv"));
  const selJson = find(join(t1, "04_selected_sample", "selected.json"), join(t1, "selected.json"));
  if (!depsCsv) return { ready: false, items: [] };
  const verOf = {};
  try { for (const e of JSON.parse(readFileSync(selJson, "utf8"))) verOf[e.name] = e.version; } catch {}
  const parseLine = (line) => { const out = []; let cur = "", q = false; for (let i = 0; i < line.length; i++) { const c = line[i]; if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; } else if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c; } out.push(cur); return out; };
  const lines = readFileSync(depsCsv, "utf8").split(/\r?\n/).filter((l) => l.length);
  const header = parseLine(lines[0]);
  const depCol = header.findIndex((h) => /depend/i.test(h));
  const pkgCol = header.findIndex((h) => /^package$|name/i.test(h));
  const items = [];
  for (const line of lines.slice(1)) {
    const cells = parseLine(line);
    const name = cells[pkgCol >= 0 ? pkgCol : 0];
    let deps = []; try { deps = JSON.parse(cells[depCol >= 0 ? depCol : 1] || "[]"); } catch {}
    items.push({ name, version: verOf[name] ?? null, deps, depCount: deps.length });
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  return { ready: true, items };
}
// Write the saved selection to the tier-2 output root (where buildCommand looks for it).
function writeTier2Selection(proj) {
  const out = tierOutput(proj, "tier2");
  const file = join(out, "selection.json");
  const sel = proj.tier2.selection;
  try {
    mkdirSync(out, { recursive: true });
    if (sel && Object.keys(sel).length) writeFileSync(file, JSON.stringify(sel));
    else if (existsSync(file)) rmSync(file, { force: true }); // empty selection = include all
  } catch {}
}

function runStep(proj, tier, step) {
  return new Promise((resolve_) => {
    const r = rt(proj.slug, tier);
    let built;
    try { built = buildTierCommand(proj, tier, step); } catch (e) { emit(proj.slug, tier, { type: "line", stream: "err", text: String(e.message) }); return resolve_(1); }

    // Preflight: make sure the step's script is actually on disk, so a missing/mis-extracted
    // file gives a clear message instead of a raw "Cannot find module" stack trace.
    const script = built.args?.[0];
    if (built.cmd === process.execPath && script && script.endsWith(".mjs") && !existsSync(script)) {
      const msg = `Script not found:\n  ${script}\nMake sure the "${tier}" folder sits next to server.mjs and still contains its 0*.mjs scripts (re-extract the zip if needed).`;
      proj[tier].steps[step] = { status: "error", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), exitCode: 1, durationMs: 0, note: "script not found" };
      saveProject(proj);
      try { mkdirSync(tierLogs(proj.slug, tier), { recursive: true }); writeFileSync(join(tierLogs(proj.slug, tier), `${step}.log`), `# ${labelOf(tier, step, proj)}  ${new Date().toISOString()}\n\n${msg}\n`); } catch {}
      emit(proj.slug, tier, { type: "line", stream: "err", text: msg });
      emit(proj.slug, tier, { type: "step", step, status: "error", code: 1, label: labelOf(tier, step, proj) });
      return resolve_(1);
    }

    proj[tier].steps[step] = { status: "running", startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, durationMs: null };
    saveProject(proj);
    emit(proj.slug, tier, { type: "step", step, status: "running", label: labelOf(tier, step, proj) });
    emit(proj.slug, tier, { type: "line", stream: "meta", text: `$ ${built.cmd} ${built.args.join(" ")}` });

    mkdirSync(tierLogs(proj.slug, tier), { recursive: true });
    const log = createWriteStream(join(tierLogs(proj.slug, tier), `${step}.log`), { flags: "w" });
    log.write(`# ${labelOf(tier, step, proj)}  ${new Date().toISOString()}\n$ ${built.cmd} ${built.args.join(" ")}\n\n`);
    const t0 = Date.now();
    const proc = spawn(built.cmd, built.args, { cwd: built.cwd ?? HERE, env: { ...process.env, ...(built.env ?? {}) }, shell: false });
    r.proc = proc;
    const onData = (stream) => { let acc = ""; return (c) => { acc += c.toString(); const l = acc.split("\n"); acc = l.pop(); for (const line of l) { emit(proj.slug, tier, { type: "line", stream, text: line }); log.write(line + "\n"); } }; };
    proc.stdout.on("data", onData("out")); proc.stderr.on("data", onData("err"));
    proc.on("error", (e) => { emit(proj.slug, tier, { type: "line", stream: "err", text: String(e.message) }); });
    proc.on("close", (code) => {
      log.end(); r.proc = null;
      const fresh = loadProject(proj.slug) || proj;
      fresh[tier].steps[step] = { status: code === 0 ? "done" : "error", startedAt: proj[tier].steps[step].startedAt, finishedAt: new Date().toISOString(), exitCode: code, durationMs: Date.now() - t0 };
      Object.assign(proj, fresh);
      saveProject(proj);
      emit(proj.slug, tier, { type: "step", step, status: proj[tier].steps[step].status, code, label: labelOf(tier, step, proj) });
      resolve_(code ?? 1);
    });
  });
}
async function runSequence(proj, tier, steps) {
  const r = rt(proj.slug, tier);
  if (r.busy) return;
  r.busy = true; emit(proj.slug, tier, { type: "run", status: "running", steps });
  const out = tierOutput(proj, tier), say = (text) => emit(proj.slug, tier, { type: "line", stream: "meta", text });
  // steps always work on plain files: unpack what the last run packed
  try { unpackOutputs(tier, out, say); } catch (e) { say(`unpacking failed: ${e.message}`); }
  // tier 3 reads tier 1's and tier 2's packed outputs: unpack the archives it needs, and pack
  // them again afterwards
  const borrowed = {};
  if (tier === "tier3") for (const [t, only] of Object.entries(TIER3_INPUT_ARCHIVES)) {
    try { const tout = tierOutput(proj, t); borrowed[t] = unpackOutputs(t, tout, (x) => say(`${t}: ${x}`), only).map((a) => relative(tout, a)); } catch (e) { say(`${t}: unpacking failed: ${e.message}`); }
  }
  let ok = true;
  for (const step of steps) { const code = await runStep(proj, tier, step); if (code !== 0) { ok = false; break; } }
  // then pack each step's per-package files into .tgz (logs and small files stay as they are)
  const fresh = loadProject(proj.slug) || proj;
  if (String(fresh[tier].params?.PACK_OUTPUTS ?? "1") === "1") {
    say("packing outputs into .tgz …");
    try { const n = packOutputs(tier, out, say).length; say(n ? `packed ${n} archive(s)` : "nothing to pack"); } catch (e) { say(`packing failed: ${e.message}`); }
  }
  for (const [t, only] of Object.entries(borrowed)) {
    if (!only.length || String(fresh[t]?.params?.PACK_OUTPUTS ?? "1") !== "1") continue;
    try { packOutputs(t, tierOutput(proj, t), (x) => say(`${t}: ${x}`), only); } catch (e) { say(`${t}: packing failed: ${e.message}`); }
  }
  r.busy = false; emit(proj.slug, tier, { type: "run", status: ok ? "done" : "error" });
}
const firstUnfinished = (proj, tier) => activeStepIds(proj, tier).find((s) => !["done", "imported"].includes(proj[tier].steps[s]?.status)) ?? null;

// ---------------- console jobs ----------------
let jobSeq = 0; const jobs = new Map();
function startJob(label, cwd) {
  const id = "job" + ++jobSeq; const job = { id, status: "running", buffer: [], listeners: new Set() };
  jobs.set(id, job);
  const push = (e) => { job.buffer.push(e); for (const res of job.listeners) writeSse(res, e); };
  push({ type: "line", stream: "meta", text: `$ ${label}` });
  const proc = spawn("bash", ["-lc", label], { cwd, env: process.env });
  const onData = (stream) => { let acc = ""; return (c) => { acc += c.toString(); const l = acc.split("\n"); acc = l.pop(); for (const line of l) push({ type: "line", stream, text: line }); }; };
  proc.stdout.on("data", onData("out")); proc.stderr.on("data", onData("err"));
  proc.on("error", (e) => push({ type: "line", stream: "err", text: String(e.message) }));
  proc.on("close", (code) => { job.status = code === 0 ? "done" : "error"; push({ type: "status", status: job.status, code }); for (const res of job.listeners) res.end(); job.listeners.clear(); });
  return job;
}

// ---------------- http helpers ----------------
function writeSse(res, e) { res.write(`data: ${JSON.stringify(e)}\n\n`); }
function json(res, code, obj) { const b = JSON.stringify(obj); res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(b) }); res.end(b); }
function readBody(req) { return new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { r(b ? JSON.parse(b) : {}); } catch { r({}); } }); }); }
function listOutputs(root) { if (!existsSync(root)) return []; const rows = []; const walk = (d, dep) => { if (dep > 4 || rows.length > 500) return; let e = []; try { e = readdirSync(d); } catch { return; } for (const n of e) { const f = join(d, n); let st; try { st = statSync(f); } catch { continue; } if (st.isDirectory()) walk(f, dep + 1); else rows.push({ path: relative(root, f), bytes: st.size }); } }; walk(root, 0); rows.sort((a, b) => a.path.localeCompare(b.path)); return rows; }

// ---------------- server ----------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1"); const p = url.pathname; const q = url.searchParams;

  if (p === "/" || p === "/index.html") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(readFileSync(join(HERE, "public", "index.html"))); }
  if (p === "/api/config") {
    const tiers = {}; for (const k of TIER_KEYS) { const T = TIERS[k]; tiers[k] = { key: k, title: T.title, subtitle: T.subtitle, params: T.PARAMS, groups: T.GROUPS, defaults: T.defaults, modeFrom: T.modeFrom }; }
    return json(res, 200, { tiers, tierKeys: TIER_KEYS, cwd: HERE, title: "Thesis pipeline" });
  }

  // projects
  if (p === "/api/projects" && req.method === "GET") return json(res, 200, listAll().map((x) => (x.damaged ? x : withView(x))));
  if (p === "/api/projects/open" && req.method === "POST") { const b = await readBody(req); return json(res, 200, openProjects(String(b.path ?? ""))); }
  if (p === "/api/projects" && req.method === "POST") { const b = await readBody(req); return json(res, 200, makeProject(b.name, b.tier1Params ?? {}, b.tier2Params ?? {})); }
  if (p === "/api/projects/import" && req.method === "POST") {
    const b = await readBody(req);
    const ext = resolve(String(b.externalOutput || ""));
    const hasCsv = existsSync(join(ext, "05_selected_bundles", "selected_dependencies.csv")) || existsSync(join(ext, "selected_dependencies.csv"));
    if (!existsSync(ext)) return json(res, 400, { error: `path not found: ${ext}` });
    const proj = makeProject(b.name || "imported", {}, b.tier2Params ?? {}, ext);
    return json(res, 200, { ...proj, warning: hasCsv ? undefined : "no selected_dependencies.csv found under that path — tier 2 step 01 may fail" });
  }
  if (p === "/api/project" && req.method === "GET") { const proj = loadProject(q.get("slug")); return proj ? json(res, 200, withView(proj)) : json(res, 404, { error: "no such project" }); }
  if (p === "/api/project" && req.method === "DELETE") {
    const slug = q.get("slug"); if (TIER_KEYS.some((t) => rt(slug, t).busy)) return json(res, 409, { error: "project is running" });
    const opened = openedProjects();
    // a project opened from another folder is only removed from the list; its files stay
    if (opened[slug] && q.get("files") !== "1") { delete opened[slug]; saveOpenedProjects(opened); return json(res, 200, { ok: true, removedFromList: true }); }
    try { rmSync(projectDir(slug), { recursive: true, force: true }); if (opened[slug]) { delete opened[slug]; saveOpenedProjects(opened); } return json(res, 200, { ok: true }); }
    catch (e) { return json(res, 500, { error: String(e.message) }); }
  }
  if (p === "/api/project/rename" && req.method === "POST") { const b = await readBody(req); const proj = loadProject(b.slug); if (!proj) return json(res, 404, { error: "no such project" }); proj.name = String(b.name || proj.name); saveProject(proj); return json(res, 200, proj); }
  if (p === "/api/project/params" && req.method === "POST") { const b = await readBody(req); const proj = loadProject(b.slug); if (!proj) return json(res, 404, { error: "no such project" }); if (!TIER_KEYS.includes(b.tier)) return json(res, 400, { error: "bad tier" }); if (rt(proj.slug, b.tier).busy) return json(res, 409, { error: "tier is running" }); proj[b.tier].params = { ...proj[b.tier].params, ...(b.params ?? {}) }; saveProject(proj); return json(res, 200, proj); }

  // tier-2 inclusion selection: list survived items (+ current selection), and save it
  if (p === "/api/project/tier2-items" && req.method === "GET") {
    const proj = loadProject(q.get("slug")); if (!proj) return json(res, 404, { error: "no such project" });
    const { ready, items } = readTier2Items(proj);
    return json(res, 200, { ready, items, selection: proj.tier2.selection ?? {} });
  }
  if (p === "/api/project/tier2-selection" && req.method === "POST") {
    const b = await readBody(req); const proj = loadProject(b.slug); if (!proj) return json(res, 404, { error: "no such project" });
    if (rt(proj.slug, "tier2").busy) return json(res, 409, { error: "tier is running" });
    proj.tier2.selection = b.selection ?? {}; saveProject(proj); writeTier2Selection(proj);
    return json(res, 200, { ok: true });
  }

  if (p === "/api/project/run" && req.method === "POST") {
    const b = await readBody(req); const proj = loadProject(b.slug); const tier = b.tier;
    if (!proj) return json(res, 404, { error: "no such project" });
    if (!TIER_KEYS.includes(tier)) return json(res, 400, { error: "bad tier" });
    if (rt(proj.slug, tier).busy) return json(res, 409, { error: "already running" });
    // tier 3 reads (and unpacks) tier 1's and tier 2's files: never at the same time as them
    const clash = tier === "tier3" ? ["tier1", "tier2"].find((t) => rt(proj.slug, t).busy) : rt(proj.slug, "tier3").busy ? "tier3" : null;
    if (clash) return json(res, 409, { error: `${TIERS[clash].title.split(" · ")[0]} is running; wait until it finishes` });
    if (tier === "tier2") writeTier2Selection(proj); // sync inclusion selection before running
    let steps;
    if (b.step === "all") steps = [...activeStepIds(proj, tier)];
    else if (b.step === "continue") { const ids = activeStepIds(proj, tier); const f = firstUnfinished(proj, tier); steps = f ? ids.slice(ids.indexOf(f)) : []; }
    else if (b.step === "setup") steps = ["setup"];
    else if (typeof b.step === "string" && b.step.startsWith("upto:")) {
      // run from the first unfinished step up to AND INCLUDING the target, then stop
      const ids = activeStepIds(proj, tier);
      const endIdx = ids.indexOf(b.step.slice(5));
      if (endIdx < 0) return json(res, 400, { error: "bad target step" });
      const f = firstUnfinished(proj, tier);
      const startIdx = f ? ids.indexOf(f) : 0;
      steps = startIdx <= endIdx ? ids.slice(startIdx, endIdx + 1) : [];
    }
    else if (typeof b.step === "string" && b.step.startsWith("from:")) {
      // REDO from the target step to the end — re-run even completed steps (for new
      // parameters). Optional clean: wipe the output dirs those steps own first, so the
      // new parameters actually take effect (otherwise skip-if-exists reuses old output).
      const ids = activeStepIds(proj, tier);
      const startIdx = ids.indexOf(b.step.slice(5));
      if (startIdx < 0) return json(res, 400, { error: "bad target step" });
      steps = ids.slice(startIdx);
      if (b.clean) {
        // bundles are never deleted: a clean re-run moves them to _archived_bundles/
        const c = cleanStepOutputs(proj, tier, steps);
        for (const a of c.archived) emit(proj.slug, tier, { type: "line", stream: "meta", text: `kept the existing bundles: moved ${a.from} -> ${a.to}` });
      }
      // reset downstream state so the table shows a clean re-run
      for (const s of steps) proj[tier].steps[s] = { status: "pending", startedAt: null, finishedAt: null, exitCode: null, durationMs: null };
      saveProject(proj);
    }
    else steps = [b.step];
    if (steps.length === 0) return json(res, 200, { nothing: true });
    runSequence(proj, tier, steps);
    return json(res, 200, { started: true, steps });
  }
  if (p === "/api/project/stream") { const slug = q.get("slug"), tier = q.get("tier"); if (!existsSync(projectFile(slug))) { res.writeHead(404); return res.end(); } const r = rt(slug, tier); res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" }); for (const e of r.buffer) writeSse(res, e); r.listeners.add(res); req.on("close", () => r.listeners.delete(res)); return; }
  if (p === "/api/project/stop" && req.method === "POST") { const b = await readBody(req); const r = rt(b.slug, b.tier); if (r?.proc) { r.proc.kill("SIGTERM"); return json(res, 200, { ok: true }); } return json(res, 404, { error: "nothing running" }); }
  if (p === "/api/project/log") { const f = join(tierLogs(q.get("slug"), q.get("tier")), `${q.get("step")}.log`); return json(res, 200, readLogTail(f)); }
  if (p === "/api/project/report") {
    // tier 3's readable report (step 03)
    const proj = loadProject(q.get("slug")); if (!proj) return json(res, 404, { error: "no such project" });
    const f = join(tierOutput(proj, "tier3"), "03_report", "report.md");
    if (!existsSync(f)) return json(res, 200, { text: "" });
    return json(res, 200, { text: readFileSync(f, "utf8"), path: relative(projectDir(proj.slug), f), mtime: statSync(f).mtime.toISOString() });
  }
  if (p === "/api/project/outputs") { const proj = loadProject(q.get("slug")); if (!proj) return json(res, 404, { error: "no such project" }); return json(res, 200, listOutputs(tierOutput(proj, q.get("tier")))); }

  // console (runs in the tier's output folder)
  if (p === "/api/exec" && req.method === "POST") { const b = await readBody(req); const cmd = String(b.command ?? "").trim(); if (!cmd) return json(res, 400, { error: "empty command" }); const proj = loadProject(b.slug); const cwd = proj ? tierOutput(proj, b.tier || "tier1") : HERE; mkdirSync(cwd, { recursive: true }); return json(res, 200, { jobId: startJob(cmd, cwd).id }); }
  if (p === "/api/job/stream") { const job = jobs.get(q.get("job")); if (!job) { res.writeHead(404); return res.end(); } res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" }); for (const e of job.buffer) writeSse(res, e); if (job.status === "running") { job.listeners.add(res); req.on("close", () => job.listeners.delete(res)); } else res.end(); return; }

  res.writeHead(404, { "content-type": "text/plain" }); res.end("Not found");
});

function listen(port, left = 20) {
  server.once("error", (err) => {
    if (err.code === "EADDRINUSE" && left > 0) { console.log(`Port ${port} in use — trying ${port + 1}...`); setTimeout(() => listen(port + 1, left - 1), 50); }
    else if (err.code === "EADDRINUSE") { console.error(`\nAll ports ${PORT}..${PORT + 20} in use. Free one or: node server.mjs <port>\n`); process.exit(1); }
    else throw err;
  });
  server.listen(port, "127.0.0.1", () => { console.log(`\nThesis pipeline control panel on  http://127.0.0.1:${port}`); console.log(`Projects saved under              ${PROJECTS_DIR}`); console.log(`(localhost only — it runs shell commands)\n`); });
}
listen(PORT);
