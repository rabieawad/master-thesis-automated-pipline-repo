#!/usr/bin/env node
// Web control panel for the SECOND (reference) pipeline.
//   node server2.mjs [port=5273]   then open http://127.0.0.1:5273
//
// Thin wrapper over the steps 01..04 scripts and run-pipeline-2.sh, which keep
// working on their own. Form for every knob, run whole/individual steps with live
// logs, a bash console, and an outputs list. Binds to 127.0.0.1 only.

import http from "node:http";
import { spawn } from "node:child_process";
import { join, resolve, relative } from "node:path";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { HERE, PARAMS, DEFAULTS, STEPS, dirs, buildCommand } from "./lib-pipeline-2.mjs";

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 5273);

let jobSeq = 0;
const jobs = new Map();

function emit(job, event) {
  job.buffer.push(event);
  if (job.buffer.length > 5000) job.buffer.splice(0, job.buffer.length - 5000);
  for (const res of job.listeners) writeSse(res, event);
}
function startJob(label, cmd, args, opts = {}) {
  const id = String(++jobSeq);
  const job = { id, label, status: "running", code: null, buffer: [], listeners: new Set(), proc: null };
  jobs.set(id, job);
  emit(job, { type: "status", status: "running", label });
  emit(job, { type: "line", stream: "meta", text: `$ ${cmd} ${args.join(" ")}` });
  const proc = spawn(cmd, args, { cwd: opts.cwd ?? HERE, env: { ...process.env, ...(opts.env ?? {}) }, shell: false });
  job.proc = proc;
  const onData = (stream) => { let acc = ""; return (chunk) => { acc += chunk.toString(); const lines = acc.split("\n"); acc = lines.pop(); for (const line of lines) emit(job, { type: "line", stream, text: line }); }; };
  proc.stdout.on("data", onData("out"));
  proc.stderr.on("data", onData("err"));
  proc.on("error", (e) => emit(job, { type: "line", stream: "err", text: String(e.message) }));
  proc.on("close", (code) => { job.status = code === 0 ? "done" : "error"; job.code = code; emit(job, { type: "status", status: job.status, code }); for (const res of job.listeners) res.end(); job.listeners.clear(); });
  return job;
}

function writeSse(res, event) { res.write(`data: ${JSON.stringify(event)}\n\n`); }
function json(res, code, obj) { const b = JSON.stringify(obj); res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(b) }); res.end(b); }
function readBody(req) { return new Promise((resolve) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } }); }); }

function listOutputs(outRoot) {
  const d = dirs(outRoot);
  if (!existsSync(d.OUT)) return [];
  const rows = [];
  const walk = (dir, depth) => {
    if (depth > 3 || rows.length > 400) return;
    let entries = []; try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) { const full = join(dir, name); let st; try { st = statSync(full); } catch { continue; } if (st.isDirectory()) walk(full, depth + 1); else rows.push({ path: relative(d.OUT, full), bytes: st.size }); }
  };
  walk(d.OUT, 0);
  rows.sort((a, b) => a.path.localeCompare(b.path));
  return rows;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const path = url.pathname;

  if (path === "/" || path === "/index.html") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(readFileSync(join(HERE, "public", "index.html"))); }
  if (path === "/api/config") return json(res, 200, { params: PARAMS, defaults: DEFAULTS, steps: STEPS, cwd: HERE, title: "Reference pipeline control panel" });
  if (path === "/api/jobs") return json(res, 200, [...jobs.values()].map((j) => ({ id: j.id, label: j.label, status: j.status, code: j.code })));
  if (path === "/api/outputs") return json(res, 200, listOutputs(url.searchParams.get("outDir")));

  if (path === "/api/run" && req.method === "POST") {
    const body = await readBody(req);
    const step = String(body.step ?? "all");
    const params = { ...DEFAULTS, ...(body.params ?? {}) };
    let built; try { built = buildCommand(step, params); } catch (e) { return json(res, 400, { error: String(e.message) }); }
    const label = STEPS.find((s) => s.id === step)?.label ?? step;
    return json(res, 200, { jobId: startJob(label, built.cmd, built.args, { cwd: built.cwd, env: built.env }).id });
  }
  if (path === "/api/exec" && req.method === "POST") {
    const body = await readBody(req);
    const command = String(body.command ?? "").trim();
    if (!command) return json(res, 400, { error: "empty command" });
    return json(res, 200, { jobId: startJob(`$ ${command}`, "bash", ["-lc", command], { cwd: body.cwd ? resolve(body.cwd) : HERE }).id });
  }
  if (path === "/api/stop" && req.method === "POST") {
    const body = await readBody(req);
    const job = jobs.get(String(body.jobId));
    if (job?.proc && job.status === "running") { job.proc.kill("SIGTERM"); return json(res, 200, { ok: true }); }
    return json(res, 404, { error: "no such running job" });
  }
  if (path === "/api/stream") {
    const job = jobs.get(url.searchParams.get("job"));
    if (!job) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    for (const event of job.buffer) writeSse(res, event);
    if (job.status === "running") { job.listeners.add(res); req.on("close", () => job.listeners.delete(res)); } else res.end();
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" }); res.end("Not found");
});

function listen(port, attemptsLeft = 20) {
  server.once("error", (err) => {
    if (err.code === "EADDRINUSE" && attemptsLeft > 0) { console.log(`Port ${port} in use — trying ${port + 1}...`); setTimeout(() => listen(port + 1, attemptsLeft - 1), 50); }
    else if (err.code === "EADDRINUSE") { console.error(`\nAll ports ${PORT}..${PORT + 20} in use. Free one or: node server2.mjs <port>\n`); process.exit(1); }
    else throw err;
  });
  server.listen(port, "127.0.0.1", () => { console.log(`\nReference pipeline control panel on  http://127.0.0.1:${port}`); console.log(`Serving scripts from                 ${HERE}`); console.log(`(localhost only — it runs shell commands)\n`); });
}
listen(PORT);
