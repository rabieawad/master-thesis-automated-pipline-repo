#!/usr/bin/env node
// Interactive terminal wizard for the SECOND (reference) pipeline. Asks for each
// parameter (Enter keeps the [default]), then runs the chosen step.
//
//   node wizard2.mjs
//   node wizard2.mjs --defaults                         use defaults, run the whole pipeline
//   node wizard2.mjs --INPUT_DIR=../pipeline-ui/output --defaults
//   node wizard2.mjs --step=01
//
// Convenience only — steps 01..04 and run-pipeline-2.sh keep working without it.

import { spawn } from "node:child_process";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { PARAMS, DEFAULTS, STEPS, buildCommand } from "./lib-pipeline-2.mjs";

const argv = process.argv.slice(2);
const flags = {};
for (const a of argv) { const m = a.match(/^--([^=]+)(?:=(.*))?$/); if (m) flags[m[1]] = m[2] ?? true; }
const useDefaults = !!flags.defaults || !stdin.isTTY;
let step = typeof flags.step === "string" ? flags.step : null;

const params = { ...DEFAULTS };
for (const p of PARAMS) if (flags[p.key] !== undefined) params[p.key] = String(flags[p.key]);

async function ask() {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  for (const p of PARAMS) {
    if (flags[p.key] !== undefined) continue;
    let prompt;
    if (p.type === "bool") prompt = `  ${p.label} (y/n) [${params[p.key] === "1" ? "y" : "n"}]: `;
    else if (p.type === "select") prompt = `  ${p.label} (${p.options.join("/")}) [${params[p.key]}]: `;
    else prompt = `  ${p.label} [${params[p.key] || "(none)"}]: `;
    const ans = (await rl.question(prompt)).trim();
    if (ans === "") continue;
    params[p.key] = p.type === "bool" ? (/^y(es)?$/i.test(ans) ? "1" : "0") : ans;
  }
  if (!step) {
    stdout.write("\n  Steps:\n");
    for (const s of STEPS) stdout.write(`    ${s.id.padEnd(6)} ${s.label}\n`);
    step = (await rl.question(`\n  Which step? [all]: `)).trim() || "all";
  }
  rl.close();
}

async function main() {
  stdout.write("\n  Reference-pipeline wizard\n  Press Enter to keep the [default]. Ctrl-C to quit.\n\n");
  if (useDefaults) { if (!step) step = "all"; } else await ask();

  stdout.write("\n  Running: " + (STEPS.find((s) => s.id === step)?.label ?? step) + "\n");
  for (const p of PARAMS) stdout.write(`    ${p.key} = ${params[p.key] || "(none)"}\n`);
  stdout.write("\n");

  let built; try { built = buildCommand(step, params); } catch (e) { stdout.write(String(e.message) + "\n"); process.exit(1); }
  const child = spawn(built.cmd, built.args, { cwd: built.cwd, env: { ...process.env, ...built.env }, stdio: "inherit" });
  child.on("close", (code) => process.exit(code ?? 0));
}
main();
