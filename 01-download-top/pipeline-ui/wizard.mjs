#!/usr/bin/env node
// Interactive terminal wizard for the first pipeline: it asks you for each
// parameter (Enter keeps the shown default), then runs the step you choose.
//
//   node wizard.mjs                 ask for everything, then run
//   node wizard.mjs --defaults      skip the questions, use defaults, run the whole pipeline
//   node wizard.mjs --step=03       preselect a step (still asks params unless --defaults)
//   node wizard.mjs --TOP_N=100 --DOWNLOAD_LIMIT=100 --defaults   override + run non-interactively
//
// This is only a convenience layer. The 01..06 scripts and run-pipeline.sh keep
// working on their own without it.

import { spawn } from "node:child_process";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { PARAMS, DEFAULTS, STEPS, buildCommand } from "./lib-pipeline.mjs";

// ---- parse --key=value overrides and flags ----
const argv = process.argv.slice(2);
const flags = {};
for (const a of argv) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) flags[m[1]] = m[2] ?? true;
}
const useDefaults = !!flags.defaults || !stdin.isTTY;
let step = typeof flags.step === "string" ? flags.step : null;

const params = { ...DEFAULTS };
for (const p of PARAMS) if (flags[p.key] !== undefined) params[p.key] = String(flags[p.key]);

function printHeader() {
  stdout.write("\n  First-pipeline wizard (data preparation)\n");
  stdout.write("  Press Enter to keep the [default]. Ctrl-C to quit.\n\n");
}

async function ask() {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  for (const p of PARAMS) {
    if (flags[p.key] !== undefined) continue; // already set on the command line
    let prompt;
    if (p.type === "bool") {
      prompt = `  ${p.label} (y/n) [${params[p.key] === "1" ? "y" : "n"}]: `;
    } else if (p.type === "select") {
      prompt = `  ${p.label} (${p.options.join("/")}) [${params[p.key]}]: `;
    } else {
      prompt = `  ${p.label} [${params[p.key]}]: `;
    }
    const ans = (await rl.question(prompt)).trim();
    if (ans === "") continue;
    params[p.key] = p.type === "bool" ? (/^y(es)?$/i.test(ans) ? "1" : "0") : ans;
  }

  if (!step) {
    stdout.write("\n  Steps:\n");
    for (const s of STEPS) stdout.write(`    ${s.id.padEnd(6)} ${s.label}\n`);
    const ans = (await rl.question(`\n  Which step? [all]: `)).trim();
    step = ans || "all";
  }
  rl.close();
}

function summarize() {
  stdout.write("\n  Running: " + (STEPS.find((s) => s.id === step)?.label ?? step) + "\n");
  for (const p of PARAMS) stdout.write(`    ${p.key} = ${params[p.key]}\n`);
  stdout.write("\n");
}

async function main() {
  printHeader();
  if (useDefaults) {
    if (!step) step = "all";
  } else {
    await ask();
  }
  summarize();

  let built;
  try { built = buildCommand(step, params); } catch (e) { stdout.write(String(e.message) + "\n"); process.exit(1); }

  const child = spawn(built.cmd, built.args, {
    cwd: built.cwd,
    env: { ...process.env, ...built.env },
    stdio: "inherit", // stream straight to this terminal
  });
  child.on("close", (code) => process.exit(code ?? 0));
}

main();
