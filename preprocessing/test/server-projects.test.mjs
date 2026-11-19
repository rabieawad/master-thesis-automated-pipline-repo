// Opening existing projects, damaged project.json, backups — against a real server process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

async function withServer(projectsDir, fn) {
  const port = 5600 + Math.floor(Math.random() * 300);
  const p = spawn(process.execPath, [join(ROOT, "server.mjs"), String(port)], { env: { ...process.env, PROJECTS_DIR: projectsDir }, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; p.stdout.on("data", (c) => (out += c));
  for (let i = 0; i < 50 && !/control panel on\s+http:\/\/127\.0\.0\.1:(\d+)/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
  const real = Number(out.match(/127\.0\.0\.1:(\d+)/)?.[1] ?? port);
  const api = async (path, opts = {}) => (await fetch(`http://127.0.0.1:${real}${path}`, { method: opts.method ?? (opts.body ? "POST" : "GET"), headers: { "content-type": "application/json" }, body: opts.body ? JSON.stringify(opts.body) : undefined })).json();
  try { return await fn(api); } finally { p.kill(); }
}

// a project as an older version saved it: no STREAM param, no step 07/08
const OLD = (slug) => ({
  id: "proj_old", slug, name: "1500 year 42", createdAt: "2026-11-01T10:00:00Z",
  tier1: { params: { MODE: "cheap", TOP_N: "1500", SEED: "42" }, steps: {
    "01": { status: "done" }, "02": { status: "done" }, "03": { status: "running" }, "04": { status: "pending" }, "05": { status: "pending" }, "06": { status: "pending" } } },
  tier2: { params: {}, steps: { "01": { status: "pending" } } },
});

test("an old project in another folder can be opened in place, continued, and removed from the list without deleting it", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "srv-")); try {
    const mine = join(dir, "projects"), oldCopy = join(dir, "old-copy", "projects");
    mkdirSync(mine, { recursive: true });
    const oldProj = join(oldCopy, "1500-year-42-83fa");
    mkdirSync(join(oldProj, "tier1", "output", "01_top1500_package_list"), { recursive: true });
    writeFileSync(join(oldProj, "project.json"), JSON.stringify(OLD("1500-year-42-83fa")));
    await withServer(mine, async (api) => {
      // a folder that is not a project
      assert.match((await api("/api/projects/open", { body: { path: join(dir, "old-copy") } })).error, /no project found/);
      // a folder inside the project works too (e.g. its tier1/output)
      let r = await api("/api/projects/open", { body: { path: join(oldProj, "tier1", "output") } });
      assert.deepEqual(r.opened.map((o) => [o.slug, o.dir]), [["1500-year-42-83fa", oldProj]]);
      // opening it again does nothing
      r = await api("/api/projects/open", { body: { path: oldCopy } });
      assert.equal(r.opened.length, 0); assert.equal(r.already.length, 1);

      const list = await api("/api/projects");
      assert.equal(list.length, 1); assert.equal(list[0].where, "opened"); assert.equal(list[0].dir, oldProj);
      const p = await api("/api/project?slug=1500-year-42-83fa");
      assert.equal(p.tier1.steps["03"].status, "error", "a step left running is marked interrupted");
      assert.equal(p.tier1.steps["08"].status, "pending", "steps added by newer versions are filled in");
      assert.deepEqual(p.view.tier1.steps.map((s) => s.id ?? s.step).filter(Boolean).length > 0, true);
      // its files are used where they are
      assert.equal(JSON.parse(readFileSync(join(oldProj, "project.json"), "utf8")).tier1.steps["03"].status, "error");

      // "Remove" takes it off the list only
      assert.equal((await api("/api/project?slug=1500-year-42-83fa", { method: "DELETE" })).removedFromList, true);
      assert.equal((await api("/api/projects")).length, 0);
      assert.ok(existsSync(join(oldProj, "project.json")), "the project's files stay");
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a damaged project.json is listed with the reason, and the backup is used when there is one", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "srv-")); try {
    const mine = join(dir, "projects");
    const a = join(mine, "broken-1111"), b = join(mine, "saved-2222");
    mkdirSync(join(a, "tier1"), { recursive: true }); writeFileSync(join(a, "project.json"), "{ not json");
    mkdirSync(join(b, "tier1"), { recursive: true }); writeFileSync(join(b, "project.json"), "");
    writeFileSync(join(b, "project.json.bak"), JSON.stringify(OLD("saved-2222")));
    mkdirSync(join(mine, "not-a-project")); // a stray empty folder is not listed
    await withServer(mine, async (api) => {
      const list = await api("/api/projects");
      const broken = list.find((x) => x.slug === "broken-1111"), saved = list.find((x) => x.slug === "saved-2222");
      assert.match(broken.damaged, /project\.json cannot be read/);
      assert.ok(!saved.damaged); assert.match(saved.note, /backup/);
      assert.equal(list.length, 2);
      // a save writes a good project.json again (and keeps a backup)
      await api("/api/project/rename", { body: { slug: "saved-2222", name: "rescued" } });
      assert.equal(JSON.parse(readFileSync(join(b, "project.json"), "utf8")).name, "rescued");
      await api("/api/project/rename", { body: { slug: "saved-2222", name: "rescued again" } });
      assert.equal(JSON.parse(readFileSync(join(b, "project.json.bak"), "utf8")).name, "rescued");
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("tier 3: an old project gets it with its defaults; new projects have it; its settings and report are served; a run without input fails clearly", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "srv-")); try {
    const mine = join(dir, "projects"), old = join(mine, "old-3333");
    mkdirSync(join(old, "tier1"), { recursive: true });
    writeFileSync(join(old, "project.json"), JSON.stringify(OLD("old-3333")));
    await withServer(mine, async (api) => {
      const cfg = await api("/api/config");
      assert.deepEqual(cfg.tierKeys, ["tier1", "tier2", "tier3"]);
      assert.ok(cfg.tiers.tier3.params.some((p) => p.key === "MIN_SIM"));
      const p = await api("/api/project?slug=old-3333");
      assert.equal(p.tier3.params.MIN_SIM, "0.5");
      assert.deepEqual(p.view.tier3.steps.map((s) => s.id), ["01", "02", "03"]);
      assert.equal(p.view.tier3.steps[0].status, "pending");
      const created = await api("/api/projects", { body: { name: "fresh" } });
      assert.ok(created.tier3 && created.tier3.steps["03"]);
      assert.ok(existsSync(join(mine, created.slug, "tier3", "output")));
      // the report: none yet, then the file step 03 wrote
      assert.equal((await api(`/api/project/report?slug=${created.slug}`)).text, "");
      mkdirSync(join(mine, created.slug, "tier3", "output", "03_report"), { recursive: true });
      writeFileSync(join(mine, created.slug, "tier3", "output", "03_report", "report.md"), "# Tier 3 · Detection report\n");
      const rep = await api(`/api/project/report?slug=${created.slug}`);
      assert.match(rep.text, /Detection report/); assert.equal(rep.path, join("tier3", "output", "03_report", "report.md"));
      // settings of tier 3 are saved like the others; a bad tier is refused
      assert.equal((await api("/api/project/params", { body: { slug: created.slug, tier: "tier3", params: { MIN_SIM: "0.7" } } })).tier3.params.MIN_SIM, "0.7");
      assert.match((await api("/api/project/params", { body: { slug: created.slug, tier: "tier9", params: {} } })).error, /bad tier/);
      // running tier 3 without tier 1's and tier 2's output fails in step 01 with a clear message
      const run = await api("/api/project/run", { body: { slug: created.slug, tier: "tier3", step: "01" } });
      assert.equal(run.started, true);
      let st; for (let i = 0; i < 100; i++) { st = await api(`/api/project?slug=${created.slug}`); if (st.tier3.steps["01"].status !== "running") break; await new Promise((r) => setTimeout(r, 100)); }
      assert.equal(st.tier3.steps["01"].status, "error");
      assert.match((await api(`/api/project/log?slug=${created.slug}&tier=tier3&step=01`)).text, /run tier 2 \(streamed mode\) first/);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
