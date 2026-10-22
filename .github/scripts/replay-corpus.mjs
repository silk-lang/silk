#!/usr/bin/env node
// Runs `silk check --replay --differential` on every native and invalid corpus program.
//
// Usage: node replay-corpus.mjs <silk> <corpus> <work> <stdlib>
//
// Each program is checked as a one-module package: a trivia edit adds a comment after the first
// top-level line that occurs once in main.silk, and a second edit removes it. Every step must
// report `differences=0`. A program without such a line, or whose main.silk is a splice marker
// the corpus harness expands, is skipped. One whose profile assembly refuses it before the replay
// starts is counted apart, since it never reaches a store.
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';

const [silk, corpus, work, stdlib] = process.argv.slice(2);
if (!silk || !corpus || !work || !stdlib) {
  console.error('usage: replay-corpus.mjs <silk> <corpus> <work> <stdlib>');
  process.exit(2);
}
mkdirSync(work, { recursive: true });

const programs = [];
for (const kind of ['native', 'invalid']) {
  for (const name of readdirSync(join(corpus, kind)).sort()) {
    if (statSync(join(corpus, kind, name)).isDirectory()) programs.push({ kind, name });
  }
}

function check(directory, script) {
  return new Promise((resolve) => {
    const child = spawn(silk, ['check', '--stdlib', stdlib, '--replay', script, '--differential'], { cwd: directory });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('close', (code) => resolve({ code, output }));
  });
}

async function replay({ kind, name }) {
  const source = join(corpus, kind, name);
  const directory = join(work, `${kind}-${name}`);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory);
  cpSync(join(source, 'main.silk'), join(directory, 'main.silk'));
  if (existsSync(join(source, 'imports'))) cpSync(join(source, 'imports'), directory, { recursive: true });
  writeFileSync(join(directory, 'silk.toml'), '[package]\nname = "replay-corpus"\nversion = "0.1.0"\nroot = "main.silk"\n');
  const text = readFileSync(join(directory, 'main.silk'), 'utf8');
  const line = text.split('\n').find((candidate) => candidate.trim() !== '' && !candidate.startsWith(' ')
    && text.split(`${candidate}\n`).length === 2);
  if (line === undefined) return { status: 'skipped' };
  const first = `${line}\n`;
  const commented = `${first}// replay\n`;
  const edit = (find, replace) => `[[edit]]\nkind = "trivia"\nmodule = "main.silk"\nfind = ${JSON.stringify(find)}\nreplace = ${JSON.stringify(replace)}\n`;
  const script = join(directory, 'edits.toml');
  writeFileSync(script, `${edit(first, commented)}\n${edit(commented, first)}`);
  const { code, output } = await check(directory, script);
  if (!output.includes('silk-replay step=0')) return { status: 'refused-before-replay', output };
  const agreed = output.split('differences=0').length - 1;
  if (code === 0 && agreed === 3) return { status: 'ok' };
  return { status: 'failed', output };
}

const counts = {};
const failed = [];
let next = 0;
async function worker() {
  while (next < programs.length) {
    const program = programs[next];
    next += 1;
    const result = await replay(program);
    counts[result.status] = (counts[result.status] ?? 0) + 1;
    if (result.status === 'failed') failed.push({ ...program, output: result.output });
    if (result.status !== 'ok') console.log(`${program.kind}/${program.name}: ${result.status}`);
  }
}
await Promise.all(Array.from({ length: availableParallelism() }, worker));

console.log(`\n${JSON.stringify(counts)}`);
for (const program of failed) console.error(`\n${program.kind}/${program.name}:\n${program.output}`);
if (failed.length > 0) process.exit(1);
