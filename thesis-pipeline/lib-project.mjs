// Unified PROJECT model: a project is made of two sub-pipelines (tiers) that are
// chained — tier 2 (reference dataset) reads tier 1's (data-prep) output, wired
// automatically so you never type a directory.
//
// This file is a thin combiner over the two existing tier libs; each tier's 01..0N
// scripts and run-pipeline*.sh keep working on their own.

import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
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
    STEPS: T1.STEPS,
    stepIds: stepIdsOf(T1.STEPS),
    defaults: T1.DEFAULTS,
  },
  tier2: {
    key: "tier2",
    title: "Tier 2 · Reference dataset",
    subtitle: "build list → download → pseudo-bundle → extract (input = tier 1 output)",
    PARAMS: tier2Params,
    STEPS: T2.STEPS,
    stepIds: stepIdsOf(T2.STEPS),
    defaults: Object.fromEntries(tier2Params.map((p) => [p.key, p.default])),
  },
};

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
