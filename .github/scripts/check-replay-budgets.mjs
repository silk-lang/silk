#!/usr/bin/env node
// Checks a `silk check --replay` log against one entry of compiler/fixtures/replay/budgets.json.
//
// Usage: node check-replay-budgets.mjs <replay.log> <budgets.json> <workspace>
//
// Every step must appear in order with its budgeted kind and module. An edit's units run and units
// marked outdated must stay within budget, and so must its demands, as a fraction of the initial
// check's: rechecking walks every root again, so that walk is the fixed cost of an update and
// grows with the workspace. Its `update-us` must stay within the entry's per-update limit. A
// budgeted rejection count must match exactly, and a budgeted `unchanged` count is a floor: that
// many reruns must complete answers that hash equal to the ones they replace. A budgeted `verified`
// count is a floor too: that many outdated units must be confirmed current without rerunning. A
// `--differential` log must also report `differences=0` for every step. The initial check is only
// reported.
import { readFileSync } from 'node:fs';

const [logPath, budgetsPath, workspace] = process.argv.slice(2);
if (!logPath || !budgetsPath || !workspace) {
  console.error('usage: check-replay-budgets.mjs <replay.log> <budgets.json> <workspace>');
  process.exit(2);
}
const entry = JSON.parse(readFileSync(budgetsPath, 'utf8'))[workspace];
if (!entry) {
  console.error(`no budgets for ${workspace} in ${budgetsPath}`);
  process.exit(2);
}

function fields(line) {
  const values = {};
  for (const part of line.split(' ').slice(1)) {
    const at = part.indexOf('=');
    if (at > 0) values[part.slice(0, at)] = part.slice(at + 1);
  }
  return values;
}

const steps = [];
const differences = new Map();
for (const line of readFileSync(logPath, 'utf8').split('\n')) {
  if (line.startsWith('silk-replay step=')) steps.push(fields(line));
  else if (line.startsWith('silk-replay-differential step=')) {
    const values = fields(line);
    if ('differences' in values) differences.set(Number(values.step), Number(values.differences));
  }
}

const failures = [];
const rows = [];
const budgets = entry.steps;
if (steps.length !== budgets.length) {
  failures.push(`expected ${budgets.length} steps, the log has ${steps.length}`);
}
for (let at = 0; at < Math.min(steps.length, budgets.length); at += 1) {
  const step = steps[at];
  const budget = budgets[at];
  const label = `step ${at} (${budget.kind} ${budget.module})`;
  if (step.kind !== budget.kind || step.module !== budget.module) {
    failures.push(`${label}: the log has ${step.kind} ${step.module}`);
    continue;
  }
  const fraction = Number(step.demands) / Number(steps[0].demands);
  if (at > 0) {
    for (const [key, name] of [['units-run', 'units'], ['marked-outdated', 'outdated']]) {
      if (Number(step[key]) > budget[name]) failures.push(`${label}: ${key}=${step[key]} exceeds its budget of ${budget[name]}`);
    }
    if (fraction > budget.demandsFraction) {
      failures.push(`${label}: demands are ${fraction.toFixed(3)} of the initial check's, over the budget of ${budget.demandsFraction}`);
    }
    if (Number(step['update-us']) > entry.updateMicroseconds) {
      failures.push(`${label}: update-us=${step['update-us']} exceeds the per-update limit of ${entry.updateMicroseconds}`);
    }
  }
  if ('unchanged' in budget && !(Number(step.unchanged) >= budget.unchanged)) {
    failures.push(`${label}: unchanged=${step.unchanged} is under its floor of ${budget.unchanged}`);
  }
  if ('verified' in budget && !(Number(step.verified) >= budget.verified)) {
    failures.push(`${label}: verified=${step.verified} is under its floor of ${budget.verified}`);
  }
  if ('rejections' in budget && Number(step.rejections) !== budget.rejections) {
    failures.push(`${label}: rejections=${step.rejections}, expected ${budget.rejections}`);
  }
  if (differences.size > 0 && differences.get(at) !== 0) {
    failures.push(`${label}: the differential check reported differences=${differences.get(at)}`);
  }
  const limit = (value, max) => (at > 0 ? `${value} / ${max}` : value);
  rows.push(`| ${at} | ${budget.kind} | ${limit(step['units-run'], budget.units)} | ${limit(step['marked-outdated'], budget.outdated)} | ${step.demands} (${limit(fraction.toFixed(3), budget.demandsFraction)}) | ${step.unchanged ?? '-'} | ${step.verified ?? '-'} | ${step.rejections} | ${step['update-us']} | ${step['check-us']} |`);
}

console.log(`Replay budgets for ${workspace} (measured / budget):\n`);
console.log('| Step | Kind | Units run | Marked outdated | Demands (fraction of initial) | Unchanged | Verified | Rejections | Update us | Check us |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const row of rows) console.log(row);
if (failures.length > 0) {
  console.error(`\n${failures.length} budget failure(s):`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log('\nEvery step is within budget.');
