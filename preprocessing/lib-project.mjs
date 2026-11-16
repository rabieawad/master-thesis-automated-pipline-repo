// Unified PROJECT model: a project is made of two sub-pipelines (tiers) that are
// chained — tier 2 (reference dataset) reads tier 1's (data-prep) output, wired
// automatically so you never type a directory.
//
// This file is a thin combiner over the two existing tier libs; each tier's 01..0N
// scripts and run-pipeline*.sh keep working on their own.

import { fileURLToPath } from "node:url";
import { dirname, join, resolve, basename } from "node:path";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import * as T1 from "./tier1/lib-pipeline.mjs";
import * as T2 from "./tier2/lib-pipeline-2.mjs";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const PROJECTS_DIR = join(HERE, "projects");

const stepIdsOf = (STEPS) => STEPS.map((s) => s.id).filter((id) => /^\d+$/.test(id));

// Tier 2 gets INPUT_DIR automatically (tier 1's output), so it is hidden from the user.
const tier2Params = T2.PARAMS.filter((p) => p.key !== "INPUT_DIR");

export const TIERS = {
  tier1: {
    key: "tier1",
    title: "Tier 1 · Data preparation",
    subtitle: "crawl → download → bundle → select → collect → extract",
    PARAMS: T1.PARAMS,
    GROUPS: T1.GROUPS,
    STEPS: T1.STEPS,
    stepLabels: T1.STEP_LABELS, // { expensive: {01:..}, cheap: {01:..} }
    stepIds: T1.stepIdsFor({}),  // the default step list (no Claude repair)
    stepIdsFor: T1.stepIdsFor,   // which steps a project runs, from its parameters
    allStepIds: T1.ALL_STEP_IDS, // every id a project keeps state for
    modeFrom: { param: "MODE", default: "expensive" },
    defaults: T1.DEFAULTS,
  },
  tier2: {
    key: "tier2",
    title: "Tier 2 · Reference dataset",
    subtitle: "build list → download → pseudo-bundle → extract → dedup (input = tier 1 output)",
    PARAMS: tier2Params,
    GROUPS: T2.GROUPS,
    STEPS: T2.STEPS,
    stepLabels: T2.STEP_LABELS,        // { batch: {01..05}, streamed: {01,06,07} }
    stepIds: T2.STEP_IDS.batch,        // the default/batch step list
    stepIdsFor: (params) => T2.stepIdsFor(T2.modeOf(params)),
    allStepIds: T2.ALL_STEP_IDS,       // every id a project keeps state for
    // how the UI/server work out the current mode from the saved parameters
    // A project with no STREAM key predates streamed mode: it stays batch (see T2.modeOf).
    modeFrom: { param: "STREAM", map: { "1": "streamed", "0": "batch" }, default: "batch" },
    defaults: Object.fromEntries(tier2Params.map((p) => [p.key, p.default])),
  },
};

// The mode a tier is currently in, from the project's saved parameters.
export function tierMode(project, tier) {
  const T = TIERS[tier];
  const mf = T.modeFrom;
  if (!mf) return "expensive";
  const raw = String(project?.[tier]?.params?.[mf.param] ?? "");
  return (mf.map ? mf.map[raw] : raw) || mf.default;
}
// The numbered steps this project actually runs for a tier, in order (mode-aware, and for
// tier 1 also depending on whether the Claude repair step is switched on).
export function activeStepIds(project, tier) {
  return TIERS[tier].stepIdsFor(project?.[tier]?.params ?? {});
}

// What the interface shows for a tier: its mode and its steps in order, each with the number
// the user knows it by ("03b", "02–05") and a plain label.
export function tierView(project, tier) {
  const T = TIERS[tier];
  const mode = tierMode(project, tier);
  const steps = activeStepIds(project, tier).map((id) => {
    const raw = T.stepLabels?.[mode]?.[id] ?? T.STEPS.find((s) => s.id === id)?.label ?? id;
    const m = /^([^·]+?)\s*·\s*(.*)$/.exec(raw);
    return { id, num: m ? m[1] : id, label: m ? m[2] : raw, ...(project?.[tier]?.steps?.[id] ?? { status: "pending" }) };
  });
  return { mode, steps };
}
// Every step id a project keeps state for (the union over modes).
export const allStepIds = (tier) => TIERS[tier].allStepIds ?? TIERS[tier].stepIds;

// ---- readable project paths ----
export function projectDir(slug) { return join(PROJECTS_DIR, slug); }
export function projectFile(slug) { return join(projectDir(slug), "project.json"); }
export function tierOutput(project, tier) {
  // tier 1 output can be external (imported); tier 2 always lives in the project
  if (tier === "tier1" && project.tier1.externalOutput) return resolve(project.tier1.externalOutput);
  return join(projectDir(project.slug), tier, "output");
}
export function tierLogs(slug, tier) { return join(projectDir(slug), tier, "logs"); }
export function tier1OutputForTier2(project) { return tierOutput(project, "tier1"); }

// Output dirs each step owns, for a clean re-run (tier 1 is mode-aware).
export function stepDirsForTier(project, tier) {
  const outDir = tierOutput(project, tier);
  if (tier === "tier1") return T1.stepDirs(outDir, (project.tier1.params?.MODE) ?? "expensive");
  return T2.stepDirs(outDir, tierMode(project, "tier2"));
}

// Folders that must survive a clean re-run: tier 1's bundles are the test bed.
export function protectedDirsForTier(project, tier) {
  return tier === "tier1" ? T1.protectedDirs(tierOutput(project, tier)) : [];
}

// Clear the output of `steps` before a clean re-run. Ordinary folders are deleted; a protected
// folder (the bundles) is MOVED to <output>/_archived_bundles/<time>/ instead, so a bundle is
// never lost. Logs live outside the step folders and are never touched.
export function cleanStepOutputs(project, tier, steps, now = new Date()) {
  const map = stepDirsForTier(project, tier);
  const out = tierOutput(project, tier);
  const prot = new Set(protectedDirsForTier(project, tier).map((d) => resolve(d)));
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const done = { deleted: [], archived: [] };
  for (const s of steps) for (const dir of map[s] ?? []) {
    const abs = resolve(dir);
    if (!existsSync(abs)) continue;
    if (prot.has(abs)) {
      let entries = []; try { entries = readdirSync(abs); } catch {}
      if (!entries.length) continue;
      const to = join(out, "_archived_bundles", stamp, basename(abs));
      mkdirSync(dirname(to), { recursive: true });
      renameSync(abs, to);
      done.archived.push({ from: abs, to });
    } else {
      // a folder INSIDE a protected one (e.g. claude_repair inside the bundles) is removed alone
      try { rmSync(abs, { recursive: true, force: true }); done.deleted.push(abs); } catch {}
    }
  }
  return done;
}

// ---- the command for a given (project, tier, step) ----
export function buildTierCommand(project, tier, step) {
  const outDir = tierOutput(project, tier);
  if (tier === "tier1") {
    return T1.buildCommand(step, { ...project.tier1.params, outDir });
  } else {
    // tier 2: auto-wire INPUT_DIR to tier 1's output
    return T2.buildCommand(step, { ...project.tier2.params, outDir, INPUT_DIR: tier1OutputForTier2(project) });
  }
}
