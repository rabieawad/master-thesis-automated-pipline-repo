#!/usr/bin/env node
// Unified control panel: PROJECTS, each made of two chained sub-pipelines (tiers).
//
//   node server.mjs [port=5273]   then open http://127.0.0.1:5273
//
// A project = tier 1 (data preparation, 6 steps) + tier 2 (reference dataset, 4 steps).
// Tier 2's input is auto-wired to tier 1's output, so you never type a directory.
// Each project is saved under projects/<slug>/ with a per-tier state table and logs,
// and is resumable (run whole tier / continue / single step). Create a new project,
// or import an existing tier-1 output to run only tier 2 on it.
//
// Thin wrapper over the tier scripts, which keep working on their own. Localhost only.

import http from "node:http";
import { spawn } from "node:child_process";
import { join, resolve, relative } from "node:path";
import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync, statSync, mkdirSync, rmSync, createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { HERE, PROJECTS_DIR, TIERS, projectDir, projectFile, tierOutput, tierLogs, buildTierCommand } from "./lib-project.mjs";

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 5273);
mkdirSync(PROJECTS_DIR, { recursive: true });
const TIER_KEYS = ["tier1", "tier2"];

// ---------------- project store (atomic, file-backed) ----------------
function loadProject(slug) { try { return JSON.parse(readFileSync(projectFile(slug), "utf8")); } catch { return null; } }
function saveProject(proj) {
  proj.updatedAt = new Date().toISOString();
  const tmp = projectFile(proj.slug) + ".tmp";
  writeFileSync(tmp, JSON.stringify(proj, null, 2));
  renameSync(tmp, projectFile(proj.slug)); // atomic replace
}
function listProjects() {
  const out = [];
  for (const slug of readdirSync(PROJECTS_DIR)) { const p = loadProject(slug); if (p) out.push(p); }
  out.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return out;
}
const slugify = (name) => (String(name || "project").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "project") + "-" + randomUUID().slice(0, 4);
const freshSteps = (tier) => Object.fromEntries(TIERS[tier].stepIds.map((s) => [s, { status: "pending", startedAt: null, finishedAt: null, exitCode: null, durationMs: null }]));

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
  };
  saveProject(proj);
  return proj;
}

// boot: any step left "running" is dead -> error
for (const p of listProjects()) { let ch = false; for (const t of TIER_KEYS) for (const s of TIERS[t].stepIds) if (p[t].steps[s]?.status === "running") { p[t].steps[s].status = "error"; p[t].steps[s].note = "interrupted (server restarted)"; ch = true; } if (ch) saveProject(p); }

// ---------------- per-(project,tier) live runtime ----------------
const runtime = new Map(); // `${slug}:${tier}` -> { listeners, buffer, busy, proc }
function rt(slug, tier) { const k = `${slug}:${tier}`; if (!runtime.has(k)) runtime.set(k, { listeners: new Set(), buffer: [], busy: false, proc: null }); return runtime.get(k); }
function emit(slug, tier, e) { const r = rt(slug, tier); r.buffer.push(e); if (r.buffer.length > 4000) r.buffer.splice(0, r.buffer.length - 4000); for (const res of r.listeners) writeSse(res, e); }
const labelOf = (tier, step) => TIERS[tier].STEPS.find((s) => s.id === step)?.label ?? step;

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
      try { mkdirSync(tierLogs(proj.slug, tier), { recursive: true }); writeFileSync(join(tierLogs(proj.slug, tier), `${step}.log`), `# ${labelOf(tier, step)}  ${new Date().toISOString()}\n\n${msg}\n`); } catch {}
      emit(proj.slug, tier, { type: "line", stream: "err", text: msg });
      emit(proj.slug, tier, { type: "step", step, status: "error", code: 1, label: labelOf(tier, step) });
      return resolve_(1);
    }

    proj[tier].steps[step] = { status: "running", startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, durationMs: null };
    saveProject(proj);
    emit(proj.slug, tier, { type: "step", step, status: "running", label: labelOf(tier, step) });
    emit(proj.slug, tier, { type: "line", stream: "meta", text: `$ ${built.cmd} ${built.args.join(" ")}` });

    mkdirSync(tierLogs(proj.slug, tier), { recursive: true });
    const log = createWriteStream(join(tierLogs(proj.slug, tier), `${step}.log`), { flags: "w" });
    log.write(`# ${labelOf(tier, step)}  ${new Date().toISOString()}\n$ ${built.cmd} ${built.args.join(" ")}\n\n`);
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
      emit(proj.slug, tier, { type: "step", step, status: proj[tier].steps[step].status, code, label: labelOf(tier, step) });
      resolve_(code ?? 1);
    });
  });
}
async function runSequence(proj, tier, steps) {
  const r = rt(proj.slug, tier);
  if (r.busy) return;
  r.busy = true; emit(proj.slug, tier, { type: "run", status: "running", steps });
  let ok = true;
  for (const step of steps) { const code = await runStep(proj, tier, step); if (code !== 0) { ok = false; break; } }
  r.busy = false; emit(proj.slug, tier, { type: "run", status: ok ? "done" : "error" });
}
const firstUnfinished = (proj, tier) => TIERS[tier].stepIds.find((s) => !["done", "imported"].includes(proj[tier].steps[s]?.status)) ?? null;

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
    const tiers = {}; for (const k of TIER_KEYS) { const T = TIERS[k]; tiers[k] = { key: k, title: T.title, subtitle: T.subtitle, params: T.PARAMS, defaults: T.defaults, steps: T.STEPS, stepIds: T.stepIds, stepLabels: T.stepLabels }; }
    return json(res, 200, { tiers, tierKeys: TIER_KEYS, cwd: HERE, title: "Thesis pipeline" });
  }

  // projects
  if (p === "/api/projects" && req.method === "GET") return json(res, 200, listProjects());
  if (p === "/api/projects" && req.method === "POST") { const b = await readBody(req); return json(res, 200, makeProject(b.name, b.tier1Params ?? {}, b.tier2Params ?? {})); }
  if (p === "/api/projects/import" && req.method === "POST") {
    const b = await readBody(req);
    const ext = resolve(String(b.externalOutput || ""));
    const hasCsv = existsSync(join(ext, "05_selected_bundles", "selected_dependencies.csv")) || existsSync(join(ext, "selected_dependencies.csv"));
    if (!existsSync(ext)) return json(res, 400, { error: `path not found: ${ext}` });
    const proj = makeProject(b.name || "imported", {}, b.tier2Params ?? {}, ext);
    return json(res, 200, { ...proj, warning: hasCsv ? undefined : "no selected_dependencies.csv found under that path — tier 2 step 01 may fail" });
  }
  if (p === "/api/project" && req.method === "GET") { const proj = loadProject(q.get("slug")); return proj ? json(res, 200, proj) : json(res, 404, { error: "no such project" }); }
  if (p === "/api/project" && req.method === "DELETE") { const slug = q.get("slug"); if (TIER_KEYS.some((t) => rt(slug, t).busy)) return json(res, 409, { error: "project is running" }); try { rmSync(projectDir(slug), { recursive: true, force: true }); return json(res, 200, { ok: true }); } catch (e) { return json(res, 500, { error: String(e.message) }); } }
  if (p === "/api/project/rename" && req.method === "POST") { const b = await readBody(req); const proj = loadProject(b.slug); if (!proj) return json(res, 404, { error: "no such project" }); proj.name = String(b.name || proj.name); saveProject(proj); return json(res, 200, proj); }
  if (p === "/api/project/params" && req.method === "POST") { const b = await readBody(req); const proj = loadProject(b.slug); if (!proj) return json(res, 404, { error: "no such project" }); if (rt(proj.slug, b.tier).busy) return json(res, 409, { error: "tier is running" }); proj[b.tier].params = { ...proj[b.tier].params, ...(b.params ?? {}) }; saveProject(proj); return json(res, 200, proj); }

  if (p === "/api/project/run" && req.method === "POST") {
    const b = await readBody(req); const proj = loadProject(b.slug); const tier = b.tier;
    if (!proj) return json(res, 404, { error: "no such project" });
    if (!TIER_KEYS.includes(tier)) return json(res, 400, { error: "bad tier" });
    if (rt(proj.slug, tier).busy) return json(res, 409, { error: "already running" });
    let steps;
    if (b.step === "all") steps = [...TIERS[tier].stepIds];
    else if (b.step === "continue") { const f = firstUnfinished(proj, tier); steps = f ? TIERS[tier].stepIds.slice(TIERS[tier].stepIds.indexOf(f)) : []; }
    else if (b.step === "setup") steps = ["setup"];
    else if (typeof b.step === "string" && b.step.startsWith("upto:")) {
      // run from the first unfinished step up to AND INCLUDING the target, then stop
      const ids = TIERS[tier].stepIds;
      const endIdx = ids.indexOf(b.step.slice(5));
      if (endIdx < 0) return json(res, 400, { error: "bad target step" });
      const f = firstUnfinished(proj, tier);
      const startIdx = f ? ids.indexOf(f) : 0;
      steps = startIdx <= endIdx ? ids.slice(startIdx, endIdx + 1) : [];
    }
    else steps = [b.step];
    if (steps.length === 0) return json(res, 200, { nothing: true });
    runSequence(proj, tier, steps);
    return json(res, 200, { started: true, steps });
  }
  if (p === "/api/project/stream") { const slug = q.get("slug"), tier = q.get("tier"); if (!existsSync(projectFile(slug))) { res.writeHead(404); return res.end(); } const r = rt(slug, tier); res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" }); for (const e of r.buffer) writeSse(res, e); r.listeners.add(res); req.on("close", () => r.listeners.delete(res)); return; }
  if (p === "/api/project/stop" && req.method === "POST") { const b = await readBody(req); const r = rt(b.slug, b.tier); if (r?.proc) { r.proc.kill("SIGTERM"); return json(res, 200, { ok: true }); } return json(res, 404, { error: "nothing running" }); }
  if (p === "/api/project/log") { const f = join(tierLogs(q.get("slug"), q.get("tier")), `${q.get("step")}.log`); return json(res, 200, { text: existsSync(f) ? readFileSync(f, "utf8") : "" }); }
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
