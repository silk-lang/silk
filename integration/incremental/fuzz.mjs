#!/usr/bin/env node
// Edits a copy of a package at random and checks that each warm build gives what a cold build of
// the same sources gives: the same exit status, the same diagnostics, and the same executable.
//
// Usage: node integration/incremental/fuzz.mjs --silk <silkc> --workspace <dir> --package <name>
//          [--stdlib <dir>] [--iterations <n>] [--seed <n>] [--work <dir>] [--command build|check]
//          [--edit-stdlib] [--keep-going]
//
// The workspace is copied to `<work>/tree` (its `build` and `.git` folders left out), and the
// standard library to `<work>/tree/.stdlib`, so both builds read the same paths. After each round
// of edits the warm build runs in the tree with the cache the earlier rounds left, then its output
// folder is set aside and a cold build runs in the same tree. A round whose builds disagree is
// written to `<work>/failures/round-<n>` with the edits that led to it and both builds' output.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const options = { iterations: '20', seed: '1', command: 'build' };
const flags = new Set(['edit-stdlib', 'keep-going']);
const argv = process.argv.slice(2);
for (let at = 0; at < argv.length; at += 1) {
  const name = argv[at].replace(/^--/, '');
  if (flags.has(name)) options[name] = true;
  else options[name] = argv[(at += 1)];
}
if (!options.silk || !options.workspace || !options.package) {
  console.error('usage: fuzz.mjs --silk <silkc> --workspace <dir> --package <name> [--stdlib <dir>] [--iterations <n>] [--seed <n>] [--work <dir>] [--command build|check] [--edit-stdlib] [--keep-going]');
  process.exit(2);
}
const work = options.work ?? join(tmpdir(), `silk-incremental-fuzz-${options.seed}`);
const tree = join(work, 'tree');
const stdlib = join(tree, '.stdlib');
const aside = join(work, 'warm-build');
const failures = join(work, 'failures');

// A small seeded generator (mulberry32), so a seed names one sequence of edits.
let state = Number(options.seed) >>> 0;
function random() {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (items) => items[Math.floor(random() * items.length)];

function sources(directory) {
  const found = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'build' && !name.startsWith('.')) found.push(...sources(path));
    } else if (name.endsWith('.silk')) found.push(path);
  }
  return found;
}

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
cpSync(options.workspace, tree, {
  recursive: true,
  filter: (path) => !/[\\/](build|\.git|node_modules)$/.test(path),
});
cpSync(options.stdlib ?? join(options.workspace, 'stdlib'), stdlib, { recursive: true });
// The package's own folder: the one whose manifest names it.
function packageFolder(directory) {
  const manifest = join(directory, 'silk.toml');
  if (existsSync(manifest) && new RegExp(`^name\\s*=\\s*"${options.package}"`, 'm').test(readFileSync(manifest, 'utf8'))) return directory;
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (name !== 'build' && !name.startsWith('.') && statSync(path).isDirectory()) {
      const found = packageFolder(path);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}
const own = packageFolder(tree);
if (own === undefined) {
  console.error(`no manifest in ${options.workspace} names the package ${options.package}`);
  process.exit(2);
}
const packaged = sources(own);
const library = options['edit-stdlib'] ? sources(stdlib) : [];
const editable = packaged.concat(library);
const pristine = new Map(editable.map((path) => [path, readFileSync(path, 'utf8')]));
// Most of the standard library is outside what a package reaches, so three edits in four go to
// the package's own files.
const chooseFile = () => (library.length > 0 && random() < 0.25 ? pick(library) : pick(packaged));

// A line that starts a top-level item.
const topLevel = /^(pub |effect |fn |struct |union |enum |impl |interface |service |const |static |import |\/\/\/|#)/;

function blocks(lines) {
  const starts = [];
  for (let at = 0; at < lines.length; at += 1) {
    if (topLevel.test(lines[at]) && !(at > 0 && lines[at - 1].startsWith('///'))) starts.push(at);
  }
  return starts.map((start, index) => ({ start, end: starts[index + 1] ?? lines.length }));
}

// Each edit answers a short description, or undefined when it does not apply to the file.
const edits = {
  comment(lines, round) {
    const starts = lines.flatMap((line, at) => (topLevel.test(line) ? [at] : []));
    if (starts.length === 0) return undefined;
    const at = pick(starts);
    lines.splice(at, 0, `// fuzz ${round}`);
    return `comment before line ${at + 1}`;
  },
  blank(lines) {
    const candidates = lines.flatMap((line, at) => (/[{}]\s*$/.test(line) ? [at] : []));
    if (candidates.length === 0) return undefined;
    const at = pick(candidates);
    lines.splice(at + 1, 0, '');
    return `blank line after line ${at + 1}`;
  },
  literal(lines) {
    const candidates = lines.flatMap((line, at) => (/^\s+/.test(line) && !line.includes('"') && /(?<![\w.])\d+(?![\w.])/.test(line) ? [at] : []));
    if (candidates.length === 0) return undefined;
    const at = pick(candidates);
    const matches = [...lines[at].matchAll(/(?<![\w.])\d+(?![\w.])/g)];
    const chosen = pick(matches);
    const value = BigInt(chosen[0]) + 1n;
    lines[at] = lines[at].slice(0, chosen.index) + value.toString() + lines[at].slice(chosen.index + chosen[0].length);
    return `literal ${chosen[0]} -> ${value} on line ${at + 1}`;
  },
  swap(lines) {
    const found = blocks(lines).filter((block) => !lines[block.start].startsWith('import '));
    if (found.length < 2) return undefined;
    const index = Math.floor(random() * (found.length - 1));
    const [first, second] = [found[index], found[index + 1]];
    const moved = lines.slice(second.start, second.end).concat(lines.slice(first.start, first.end));
    lines.splice(first.start, second.end - first.start, ...moved);
    return `swap the items at lines ${first.start + 1} and ${second.start + 1}`;
  },
  rename(lines, round) {
    const text = lines.join('\n');
    const names = lines.flatMap((line) => {
      const found = /^(?:effect )?fn (\w+)/.exec(line);
      return found && found[1] !== 'main' ? [found[1]] : [];
    });
    if (names.length === 0) return undefined;
    const name = pick(names);
    const renamed = `${name}Fz${round}`;
    const pattern = new RegExp(`(?<![\\w.])${name}(?!\\w)`, 'g');
    const replaced = text.replace(pattern, renamed).split('\n');
    lines.splice(0, lines.length, ...replaced);
    return `rename private fn ${name} to ${renamed}`;
  },
  duplicate(lines, round) {
    const found = blocks(lines).filter((block) => /^(?:effect )?fn \w+/.test(lines[block.start]));
    if (found.length === 0) return undefined;
    const block = pick(found);
    const copy = lines.slice(block.start, block.end);
    const name = /fn (\w+)/.exec(copy[0])[1];
    copy[0] = copy[0].replace(`fn ${name}`, `fn ${name}Copy${round}`);
    lines.push('', ...copy);
    return `copy fn ${name} to the end`;
  },
};

function mutate(round) {
  const done = [];
  const count = 1 + Math.floor(random() * 3);
  while (done.length < count) {
    const path = chooseFile();
    if (random() < 0.15) {
      writeFileSync(path, pristine.get(path));
      done.push({ file: relative(tree, path), edit: 'restore the original text' });
      continue;
    }
    const name = pick(Object.keys(edits));
    const lines = readFileSync(path, 'utf8').split('\n');
    const description = edits[name](lines, round);
    if (description === undefined) continue;
    writeFileSync(path, lines.join('\n'));
    done.push({ file: relative(tree, path), edit: description });
  }
  return done;
}

function run() {
  const started = Date.now();
  const ran = spawnSync(options.silk, [options.command, '--package', options.package, '--stdlib', stdlib, '--progress', 'never'], {
    cwd: tree,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  const output = `${ran.stdout}${ran.stderr}`.replace(/ in \d+(\.\d+)?m?s\b/g, ' in <time>');
  let executable = '';
  if (options.command === 'build' && ran.status === 0) {
    const llvm = join(tree, 'build', 'llvm');
    for (const triple of existsSync(llvm) ? readdirSync(llvm) : []) {
      const path = join(llvm, triple, 'debug', options.package);
      if (existsSync(path)) executable = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  }
  return { status: ran.status, output, executable, seconds: (Date.now() - started) / 1000 };
}

const primed = run();
console.log(`cold start: status ${primed.status} in ${primed.seconds.toFixed(1)} s`);
let failed = 0;
const history = [];
for (let round = 1; round <= Number(options.iterations); round += 1) {
  const applied = mutate(round);
  history.push({ round, applied });
  const warm = run();
  renameSync(join(tree, 'build'), aside);
  const cold = run();
  const agreed = warm.status === cold.status && warm.output === cold.output && warm.executable === cold.executable;
  console.log(`round ${round}: ${agreed ? 'same' : 'DIFFERENT'} status ${warm.status}/${cold.status}, warm ${warm.seconds.toFixed(1)} s, cold ${cold.seconds.toFixed(1)} s; ${applied.map((edit) => `${edit.file}: ${edit.edit}`).join('; ')}`);
  if (!agreed) {
    failed += 1;
    const saved = join(failures, `round-${round}`);
    mkdirSync(saved, { recursive: true });
    writeFileSync(join(saved, 'edits.json'), `${JSON.stringify(history, null, 2)}\n`);
    writeFileSync(join(saved, 'warm.txt'), `status ${warm.status}\nexecutable ${warm.executable}\n\n${warm.output}`);
    writeFileSync(join(saved, 'cold.txt'), `status ${cold.status}\nexecutable ${cold.executable}\n\n${cold.output}`);
    for (const [path, text] of pristine) {
      const now = readFileSync(path, 'utf8');
      if (now !== text) {
        const copy = join(saved, 'sources', relative(tree, path));
        mkdirSync(join(copy, '..'), { recursive: true });
        writeFileSync(copy, now);
      }
    }
  }
  // The next round continues from the warm build's cache.
  rmSync(join(tree, 'build'), { recursive: true, force: true });
  renameSync(aside, join(tree, 'build'));
  if (!agreed && !options['keep-going']) break;
}
console.log(failed === 0 ? 'every round agreed' : `${failed} round(s) disagreed; see ${failures}`);
process.exit(failed === 0 ? 0 : 1);
