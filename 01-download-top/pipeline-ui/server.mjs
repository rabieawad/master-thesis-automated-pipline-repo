#!/usr/bin/env node
// Web control panel for the FIRST pipeline (the 6-step data-preparation pipeline).
//
//   node server.mjs [port=5173]
//   then open http://127.0.0.1:5173
//
// What it does:
//   - one form for every pipeline knob
//   - run the whole pipeline, or any single step (01..06), with live streaming logs
//   - a command console to run arbitrary bash commands (also streamed live)
//   - lists the files each step produced under ./output
//
// It is a thin wrapper: it only ever shells out to the same 01..06 scripts and
// run-pipeline.sh, which keep working on their own without this server.
//
// Binds to 127.0.0.1 only: it runs shell commands, so it must not be exposed to
// the network. No dependencies (Node 18+ built-ins only).

import http from "node:http";
import { spawn } from "node:child_process";
import { join, resolve, relative } from "node:path";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { HERE, PARAMS, DEFAULTS, STEPS, dirs, buildCommand } from "./lib-pipeline.mjs";

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 5173);

// ---------------- job registry ----------------
let jobSeq = 0;
const jobs = new Map(); // id -> { id, label, status, code, buffer:[], listeners:Set, proc }

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

  const proc = spawn(cmd, args, {
    cwd: opts.cwd ?? HERE,
    env: { ...process.env, ...(opts.env ?? {}) },
    shell: false,
  });
  job.proc = proc;

  const onData = (stream) => {
    let acc = "";
    return (chunk) => {
      acc += chunk.toString();
      const lines = acc.split("\n");
      acc = lines.pop();
      for (const line of lines) emit(job, { type: "line", stream, text: line });
    };
  };
  proc.stdout.on("data", onData("out"));
  proc.stderr.on("data", onData("err"));
  proc.on("error", (e) => emit(job, { type: "line", stream: "err", text: String(e.message) }));
  proc.on("close", (code) => {
    job.status = code === 0 ? "done" : "error";
    job.code = code;
    emit(job, { type: "status", status: job.status, code });
    for (const res of job.listeners) res.end();
    job.listeners.clear();
  });
  return job;
}

// ---------------- http helpers ----------------
function writeSse(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); }
    });
  });
}

// list files produced under ./output (shallow-ish, capped)
function listOutputs(outRoot) {
  const d = dirs(outRoot);
  if (!existsSync(d.OUT)) return [];
  const rows = [];
  const walk = (dir, depth) => {
    if (depth > 3 || rows.length > 400) return;
    let entries = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full, depth + 1);
      else rows.push({ path: relative(d.OUT, full), bytes: st.size });
    }
  };
  walk(d.OUT, 0);
  rows.sort((a, b) => a.path.localeCompare(b.path));
  return rows;
}

// ---------------- server ----------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const path = url.pathname;

  if (path === "/" || path === "/index.html") {
    const html = readFileSync(join(HERE, "public", "index.html"));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(html);
  }

  if (path === "/api/config") {
    return json(res, 200, { params: PARAMS, defaults: DEFAULTS, steps: STEPS, cwd: HERE, outDir: join(HERE, "output") });
  }

  if (path === "/api/jobs") {
    return json(res, 200, [...jobs.values()].map((j) => ({ id: j.id, label: j.label, status: j.status, code: j.code })));
  }

  if (path === "/api/outputs") {
    return json(res, 200, listOutputs(url.searchParams.get("outDir")));
  }

  if (path === "/api/run" && req.method === "POST") {
    const body = await readBody(req);
    const step = String(body.step ?? "all");
    const params = { ...DEFAULTS, ...(body.params ?? {}) };
    let built;
    try { built = buildCommand(step, params); } catch (e) { return json(res, 400, { error: String(e.message) }); }
    const label = (STEPS.find((s) => s.id === step)?.label ?? step);
    const job = startJob(label, built.cmd, built.args, { cwd: built.cwd, env: built.env });
    return json(res, 200, { jobId: job.id });
  }

  if (path === "/api/exec" && req.method === "POST") {
    const body = await readBody(req);
    const command = String(body.command ?? "").trim();
    if (!command) return json(res, 400, { error: "empty command" });
    const cwd = body.cwd ? resolve(body.cwd) : HERE;
    const job = startJob(`$ ${command}`, "bash", ["-lc", command], { cwd, env: {} });
    return json(res, 200, { jobId: job.id });
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
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    for (const event of job.buffer) writeSse(res, event); // replay history
    if (job.status === "running") {
      job.listeners.add(res);
      req.on("close", () => job.listeners.delete(res));
    } else {
      res.end();
    }
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\nPipeline control panel on  http://127.0.0.1:${PORT}`);
  console.log(`Serving scripts from       ${HERE}`);
  console.log(`(localhost only — it runs shell commands)\n`);
});
