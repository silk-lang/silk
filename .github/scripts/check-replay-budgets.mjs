#!/usr/bin/env node
// Checks a `silk check --replay` log against one entry of compiler/fixtures/replay/budgets.json.
//
// Usage: node check-replay-budgets.mjs <replay.log> <budgets.json> <workspace>
//
// Every step must appear in order with its budgeted kind and module. An edit's units run and units
// marked outdated must stay within budget, and so must its demands, as a fraction of the initial
// check's: rechecking walks every root again, so that walk is the fixed cost of an update and
// grows with the workspace. Its `update-us` must stay within the entry's per-update limit, except
// in a `--differential` log: there each update follows a one-shot store that the replay dropped and
// returned to the system, so it times page faults the check server never takes. A
// budgeted rejection count must match exactly, and a budgeted `unchanged` count is a floor: that
// many reruns must complete answers that hash equal to the ones they replace. A budgeted `verified`
// count is a floor too: that many outdated units must be confirmed current without rerunning. A
// `--differential` log must also report `differences=0` for every step. The initial check is only
// reported. An entry's `retention` bounds how much its `answers` and `mir-functions` may grow from
// step `from` to the last step, so a long session releases what its edits replace.
//
// An entry's `fanout` step is a trivia edit: it changes no answer, so the units it marks outdated
// are every unit that reads the edited module, directly or through another unit. New code that
// uses the module raises that count, so it is the one number that tracks the workspace. Its limit
// is the top-level `fanout` base it names plus every line for that name in the files of the
// `fanout` directory beside budgets.json. A step budgeted with `outdatedOverFanout` may mark at
// most that many more units than the fanout step's limit (fewer when negative), which is what
// the edit's kind costs on top of the module's readers, so it only moves when the compiler does.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [logPath, budgetsPath, workspace] = process.argv.slice(2);
if (!logPath || !budgetsPath || !workspace) {
  console.error('usage: check-replay-budgets.mjs <replay.log> <budgets.json> <workspace>');
  process.exit(2);
}
const budgetsFile = JSON.parse(readFileSync(budgetsPath, 'utf8'));
const entry = budgetsFile[workspace];
if (!entry || workspace === 'fanout') {
  console.error(`no budgets for ${workspace} in ${budgetsPath}`);
  process.exit(2);
}

function invalid(message) {
  console.error(message);
  process.exit(2);
}

// One file per change that moved a fanout, so two branches never edit the same line and their
// increases add up when both merge. Each line is `<name> <+n|-n>`; `#` starts a comment.
const ledgerDirectory = join(dirname(budgetsPath), 'fanout');
const ledgerPath = ledgerDirectory;
function fanoutLimit(name) {
  const base = budgetsFile.fanout?.[name];
  if (!Number.isInteger(base)) invalid(`${budgetsPath} has no fanout base named ${name}`);
  let ledger = 0;
  let files;
  try {
    files = readdirSync(ledgerDirectory).filter((file) => file.endsWith('.txt')).sort();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    files = [];
  }
  for (const file of files) {
    const lines = readFileSync(join(ledgerDirectory, file), 'utf8').split('\n');
    lines.forEach((text, at) => {
      const line = text.replace(/#.*/, '').trim();
      if (line === '') return;
      const match = /^(\S+)\s+([+-]\d+)$/.exec(line);
      if (!match) invalid(`${join(ledgerPath, file)}:${at + 1}: expected \`<name> <+n|-n>\`, found \`${line}\``);
      if (!Object.hasOwn(budgetsFile.fanout, match[1])) invalid(`${join(ledgerPath, file)}:${at + 1}: no fanout base named ${match[1]}`);
      if (match[1] === name) ledger += Number(match[2]);
    });
  }
  return { base, ledger, limit: base + ledger };
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

const differential = differences.size > 0;
const failures = [];
const rows = [];
const budgets = entry.steps;
const fanout = entry.fanout;
if (fanout) {
  if (!Number.isInteger(fanout.step) || fanout.step < 1 || fanout.step >= budgets.length || budgets[fanout.step].kind !== 'trivia') {
    invalid(`${workspace}: the fanout step must name a trivia step`);
  }
}
const fanoutBudget = fanout ? fanoutLimit(fanout.of) : undefined;
budgets.forEach((budget, at) => {
  if (at === 0 || at === fanout?.step) {
    if ('outdated' in budget || 'outdatedOverFanout' in budget) invalid(`${workspace}: step ${at} must not budget outdated units`);
  } else if (('outdated' in budget) === ('outdatedOverFanout' in budget)) {
    invalid(`${workspace}: step ${at} must budget exactly one of outdated and outdatedOverFanout`);
  } else if ('outdatedOverFanout' in budget && !fanout) {
    invalid(`${workspace}: step ${at} budgets outdatedOverFanout without a fanout step`);
  }
});
if (steps.length !== budgets.length) {
  failures.push(`expected ${budgets.length} steps, the log has ${steps.length}`);
}
for (let at = 0; at < Math.min(steps.length, budgets.length); at += 1) {
  const step = steps[at];
  const budget = budgets[at];
  const label = `step ${at} (${budget.kind} ${budget.module})`;
  const missing = ['demands', 'units-run', 'marked-outdated'].filter((key) => !/^\d+$/.test(step[key] ?? ''));
  if (missing.length > 0) {
    failures.push(`${label}: the log has no count for ${missing.join(', ')}`);
    continue;
  }
  if (step.kind !== budget.kind || step.module !== budget.module) {
    failures.push(`${label}: the log has ${step.kind} ${step.module}`);
    continue;
  }
  const fraction = Number(step.demands) / Number(steps[0].demands);
  let outdatedLimit = budget.outdated;
  if (at === fanout?.step) outdatedLimit = fanoutBudget.limit;
  else if ('outdatedOverFanout' in budget) outdatedLimit = fanoutBudget.limit + budget.outdatedOverFanout;
  if (at > 0) {
    if (Number(step['units-run']) > budget.units) failures.push(`${label}: units-run=${step['units-run']} exceeds its budget of ${budget.units}`);
    if (Number(step['marked-outdated']) > outdatedLimit) {
      if (at === fanout?.step) {
        const over = Number(step['marked-outdated']) - fanoutBudget.base - fanoutBudget.ledger;
        failures.push(
          `${label}: marked-outdated=${step['marked-outdated']} exceeds the ${fanout.of} fanout of ${outdatedLimit} ` +
            `(base ${fanoutBudget.base}, ledger ${fanoutBudget.ledger >= 0 ? '+' : ''}${fanoutBudget.ledger}). ` +
            `When new code that reads ${budget.module} accounts for the ${over} more, add a file under ${ledgerPath}/ ` +
            `with the line \`${fanout.of} +${over}\` and say which code added them; every step budgeted over the fanout follows it.`,
        );
      } else {
        const over = 'outdatedOverFanout' in budget ? ` (the ${fanout.of} fanout's ${fanoutBudget.limit} ${budget.outdatedOverFanout >= 0 ? '+' : ''}${budget.outdatedOverFanout})` : '';
        failures.push(`${label}: marked-outdated=${step['marked-outdated']} exceeds its budget of ${outdatedLimit}${over}`);
      }
    }
    if (fraction > budget.demandsFraction) {
      failures.push(`${label}: demands are ${fraction.toFixed(3)} of the initial check's, over the budget of ${budget.demandsFraction}`);
    }
    if (!differential && Number(step['update-us']) > entry.updateMicroseconds) {
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
  rows.push(`| ${at} | ${budget.kind} | ${limit(step['units-run'], budget.units)} | ${limit(step['marked-outdated'], outdatedLimit)} | ${step.demands} (${limit(fraction.toFixed(3), budget.demandsFraction)}) | ${step.unchanged ?? '-'} | ${step.verified ?? '-'} | ${step.rejections} | ${step['update-us']} | ${step['check-us']} |`);
}

const retention = entry.retention;
if (retention && steps.length > retention.from) {
  const first = steps[retention.from];
  const last = steps[steps.length - 1];
  for (const [key, name] of [['answers', 'answers'], ['mir-functions', 'mirFunctions']]) {
    const growth = Number(last[key]) - Number(first[key]);
    if (!(growth <= retention[name])) {
      failures.push(`${key} grew by ${growth} from step ${retention.from} to step ${steps.length - 1}, over the retention budget of ${retention[name]}`);
    }
  }
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
