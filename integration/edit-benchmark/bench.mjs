#!/usr/bin/env node
// Times `silk build`, `silk check` (asking the check server, and without it) and `silk test` after
// one edit to a copy of a package, for several kinds of edit, and reports the cold run, the first
// edit after it and the edits after that side by side.
//
// Usage: node integration/edit-benchmark/bench.mjs --silk <silkc> [--workspace <dir>]
//          [--packages <name,...>] [--commands <name,...>] [--edits <name,...>] [--rounds <n>]
//          [--stdlib <dir>] [--work <dir>]
//
// The workspace is copied to `<work>/tree`, and a standard library outside it to
// `<work>/tree/.stdlib`, so the checkout is never edited. For each package and command the script removes `build`, runs the
// command (cold), keeps a copy of the `build` folder it left, and runs the command again with
// nothing changed. Then, for each kind of edit, it puts that copy back, so the first edit meets
// the state a cold run leaves, and makes one edit before each timed run. No edit text is used
// twice, so no run finds a state the cache has seen. Every sample is written to
// `<work>/samples.jsonl` and each run's output to `<work>/logs`.
import { spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

// Where each package is edited. A site names a file below the workspace, or below the standard
// library with `stdlib: true`, and `at`, the whole text of one line of it:
//   body       a statement on the line after `at`, the line that opens a function's body
//   comment    a comment on the line before `at`
//   lines      one more comment line before `at` each round, so everything below moves down
//   field      a public field on the line after `at`, the line that opens a struct; its type is
//              `Option<bool>`, which literals may leave out, so the file must import `Option`
//   parameter  the parameter `name` of the function declared on `at` renamed through the function
// `test` holds the options `silk test` takes for the package; a package without it has no tests,
// and `test` is not timed for it.
const packages = {
  'silk-compiler': {
    test: ['--root', 'src/ToolRootCases.silk'],
    edits: {
      leaf: { kind: 'body', file: 'compiler/src/Progress.silk', at: 'fn sameName(left: &[u8], right: &[u8]) -> bool {' },
      large: { kind: 'body', file: 'compiler/src/semantic/PatternAndLambda.silk', at: 'fn exclusiveLoan(value: &Type) -> bool {' },
      std: { kind: 'body', stdlib: true, file: 'silk/collections/list.silk', at: '  pub fn pop(self: &mut Self) -> Option<T> {' },
      signature: { kind: 'parameter', file: 'compiler/src/semantic/RuntimeEncoding.silk', at: 'pub fn equals(left: &[u8], right: &[u8]) -> bool {', name: 'left' },
      field: { kind: 'field', file: 'compiler/src/driver/Project.silk', at: 'pub struct Project {' },
      comment: { kind: 'comment', file: 'compiler/src/semantic/SemanticModel.silk', at: 'fn namesInterface(key: &[u8]) -> bool {' },
      lines: { kind: 'lines', file: 'compiler/src/semantic/SemanticModel.silk', at: 'pub fn familyName(family: Family) -> string<\'static> {' },
      test: { kind: 'body', file: 'compiler/src/driver/ManifestSchemaCases.silk', at: 'test effect fn manifestSchemaRangesFollowTomlStructure() -> () ! AssertionError<\'static> | OutOfMemoryError {' },
    },
  },
  'silk-tool': {
    test: ['--root', 'src/tests.silk'],
    edits: {
      leaf: { kind: 'body', file: 'tool/src/Toolchains.silk', at: 'pub fn compare(left: &[u8], right: &[u8]) -> i32 {' },
      large: { kind: 'body', file: 'tool/src/Command.silk', at: 'fn same(left: &[u8], right: &[u8]) -> bool {' },
      std: { kind: 'body', stdlib: true, file: 'silk/collections/list.silk', at: '  pub fn pop(self: &mut Self) -> Option<T> {' },
      signature: { kind: 'parameter', file: 'tool/src/Toolchains.silk', at: 'pub fn compare(left: &[u8], right: &[u8]) -> i32 {', name: 'left' },
      field: { kind: 'field', file: 'tool/src/Command.silk', at: 'pub struct Context {' },
      comment: { kind: 'comment', file: 'tool/src/Command.silk', at: 'fn same(left: &[u8], right: &[u8]) -> bool {' },
      lines: { kind: 'lines', file: 'tool/src/Command.silk', at: 'pub struct Context {' },
      test: { kind: 'body', file: 'tool/src/tests/ReleaseArchiveCases.silk', at: 'test effect fn releaseReadsTarMembers() -> () ! AssertionError<\'static> | OutOfMemoryError {' },
    },
  },
  // A program with fibers, in a workspace of its own: `--workspace examples/the-conductor --stdlib stdlib`.
  'the-conductor': {
    edits: {
      leaf: { kind: 'body', file: 'main.silk', at: 'fn frequency(pitch: i32) -> f64 {' },
      std: { kind: 'body', stdlib: true, file: 'silk/collections/list.silk', at: '  pub fn pop(self: &mut Self) -> Option<T> {' },
      signature: { kind: 'parameter', file: 'main.silk', at: 'fn frequency(pitch: i32) -> f64 {', name: 'pitch' },
      field: { kind: 'field', file: 'main.silk', at: 'struct Note {' },
      comment: { kind: 'comment', file: 'main.silk', at: 'fn nameOf(fiber: i32) -> string<\'static> {' },
      lines: { kind: 'lines', file: 'main.silk', at: 'struct Note {' },
    },
  },
};

// The commands, with the options each adds to the package, `--stdlib` and `--progress plain`.
const commands = {
  build: { verb: 'build', options: [] },
  check: { verb: 'check', options: [], served: true },
  'check-no-server': { verb: 'check', options: ['--no-server'] },
  test: { verb: 'test', options: [], test: true },
};

const options = { workspace: '.', packages: 'silk-compiler,silk-tool', commands: Object.keys(commands).join(','), rounds: '3' };
const argv = process.argv.slice(2);
const known = ['silk', 'workspace', 'packages', 'commands', 'edits', 'rounds', 'stdlib', 'work'];
for (let at = 0; at < argv.length; at += 2) options[argv[at].replace(/^--/, '')] = argv[at + 1];
const usage = 'usage: bench.mjs --silk <silkc> [--workspace <dir>] [--packages <name,...>] [--commands <name,...>] [--edits <name,...>] [--rounds <n>] [--stdlib <dir>] [--work <dir>]';
function stop(message) {
  console.error(message);
  process.exit(2);
}
if (!options.silk || argv.length % 2 !== 0 || Object.keys(options).some((name) => !known.includes(name))) stop(usage);
const chosenPackages = options.packages.split(',');
for (const name of chosenPackages) if (!Object.hasOwn(packages, name)) stop(`no edits are listed for the package ${name}; the packages are ${Object.keys(packages).join(', ')}`);
const chosenCommands = options.commands.split(',');
for (const name of chosenCommands) if (!Object.hasOwn(commands, name)) stop(`unknown command ${name}; the commands are ${Object.keys(commands).join(', ')}`);
const rounds = Number(options.rounds);
if (!Number.isInteger(rounds) || rounds < 1) stop('--rounds takes a whole number, 1 or more');

const silk = resolve(options.silk);
const workspace = resolve(options.workspace);
const library = resolve(options.stdlib ?? join(workspace, 'stdlib'));
const work = resolve(options.work ?? join(tmpdir(), 'silk-edit-benchmark'));
const tree = join(work, 'tree');
// The standard library the runs read: the tree's own copy when the workspace holds it, where
// tests that read it expect it, otherwise a copy beside the tree's packages.
const inside = !relative(workspace, library).startsWith('..');
const stdlib = inside ? join(tree, relative(workspace, library)) : join(tree, '.stdlib');
const snapshot = join(work, 'cold-build');
const logs = join(work, 'logs');
const samples = join(work, 'samples.jsonl');

// The work folder is removed first, so it must not hold anything the run reads.
for (const read of [workspace, library, silk]) if (!relative(work, read).startsWith('..')) stop(`--work ${work} holds ${read}, and is removed first; name another folder`);
rmSync(work, { recursive: true, force: true });
mkdirSync(logs, { recursive: true });
cpSync(workspace, tree, {
  recursive: true,
  // Build output is left out; the standard library's `silk/build` folder is source.
  filter: (path) => !/[\\/](\.git|node_modules)$/.test(path) && (!/[\\/]build$/.test(path) || path.startsWith(library)),
});
if (!inside) cpSync(library, stdlib, { recursive: true });
// A check server's socket goes in a folder of this run's own, with a short name: a socket's path
// has a length limit. No check outside this run asks a server here.
const sockets = mkdtempSync(join(tmpdir(), 'silk-eb-'));
const environment = { ...process.env, XDG_RUNTIME_DIR: sockets };
process.on('exit', () => rmSync(sockets, { recursive: true, force: true }));

// Edit texts carry a number no earlier round of this run used, and a run starts from a number
// taken from the clock.
let stamp = (Date.now() % 1000000) * 1000;
const fresh = () => (stamp += 1);

const pathOf = (site) => join(site.stdlib ? stdlib : tree, site.file);
const pristine = new Map();
function lineOf(lines, site) {
  const at = lines.indexOf(site.at);
  if (at < 0 || lines.indexOf(site.at, at + 1) >= 0) stop(`${site.file} must hold the line \`${site.at}\` exactly once`);
  return at;
}
const indent = (line) => /^\s*/.exec(line)[0];

// A site's edit of its file's lines, for the numbers `marks` of the rounds so far: the last one
// alone, but for `lines`, which adds a line for each.
const kinds = {
  body(lines, site, marks) {
    const at = lineOf(lines, site);
    lines.splice(at + 1, 0, `${indent(lines[at])}  let _edit = ${marks.at(-1)}`);
  },
  comment(lines, site, marks) {
    const at = lineOf(lines, site);
    lines.splice(at, 0, `${indent(lines[at])}// edit ${marks.at(-1)}`);
  },
  lines(lines, site, marks) {
    const at = lineOf(lines, site);
    lines.splice(at, 0, ...marks.slice(1).map((mark) => `${indent(lines[at])}// edit ${mark}`));
  },
  field(lines, site, marks) {
    const at = lineOf(lines, site);
    lines.splice(at + 1, 0, `${indent(lines[at])}  pub edit${marks.at(-1)}: Option<bool>,`);
  },
  parameter(lines, site, marks) {
    const at = lineOf(lines, site);
    const close = lines.indexOf(`${indent(lines[at])}}`, at);
    if (close < 0) stop(`${site.file}: the function at \`${site.at}\` has no closing line`);
    const name = new RegExp(`(?<![\\w.'])${site.name}(?![\\w(])`, 'g');
    for (let line = at; line <= close; line += 1) lines[line] = lines[line].replace(name, `${site.name}${marks.at(-1)}`);
  },
};

// Writes the files of `sites` as their edits so far leave them. Sites of one file apply in turn,
// each to the lines the ones before it left.
function write(sites) {
  const files = new Map();
  for (const site of sites) {
    const path = pathOf(site);
    if (!pristine.has(path)) pristine.set(path, readFileSync(path, 'utf8'));
    if (!files.has(path)) files.set(path, pristine.get(path).split('\n'));
    kinds[site.kind](files.get(path), site, site.marks);
  }
  for (const [path, lines] of files) writeFileSync(path, lines.join('\n'));
}

// A build hands its cache write to a copy of the compiler that outlives it, holding a `flock` on
// the file's `.lock` until it is done. Waits for the copies, so the next run finds the cache the
// last one wrote, and answers how long that took.
function settle() {
  const started = process.hrtime.bigint();
  const caches = join(tree, 'build', 'cache');
  if (!existsSync(caches)) return 0;
  const locks = readdirSync(caches, { recursive: true }).filter((name) => name.endsWith('.lock')).map((name) => join(caches, name));
  if (locks.length === 0) return 0;
  const waited = spawnSync('python3', ['-c', 'import fcntl, sys\nfor path in sys.argv[1:]:\n    fcntl.flock(open(path), fcntl.LOCK_SH)', ...locks], { encoding: 'utf8' });
  if (waited.status !== 0) throw new Error(`cannot wait for the cache writers: ${waited.stderr}`);
  return Number(process.hrtime.bigint() - started) / 1e9;
}

// Ends the check servers this run left: the copies of the compiler whose command line names this
// run's standard library.
function endServers() {
  const pattern = stdlib.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  spawnSync('pkill', ['-f', pattern]);
  for (let tries = 0; tries < 100 && spawnSync('pgrep', ['-f', pattern]).status === 0; tries += 1) spawnSync('sleep', ['0.1']);
  for (const name of readdirSync(sockets)) rmSync(join(sockets, name), { force: true });
}

// A workspace's members are selected by name; a package that is the whole tree needs no selection.
const selection = (name) => (/^\[workspace\]/m.test(readFileSync(join(tree, 'silk.toml'), 'utf8')) ? ['--package', name] : []);

let runs = 0;
// Runs `command` on `name` and keeps the sample. The output goes to a file, never a pipe: the
// copies a run leaves behind (the cache writer, the check server) would hold a pipe open and the
// run would seem to last as long as they do.
function run(name, command, edit, state, text) {
  runs += 1;
  const log = join(logs, `${String(runs).padStart(4, '0')}-${name}-${command}-${edit ?? 'none'}-${state}.txt`);
  const { verb, options: extra, test } = commands[command];
  const args = [verb, ...selection(name), '--stdlib', stdlib, '--progress', 'plain', ...(test ? packages[name].test : []), ...extra];
  const out = openSync(log, 'w');
  const started = process.hrtime.bigint();
  const ran = spawnSync(silk, args, { cwd: tree, env: environment, stdio: ['ignore', out, out] });
  const seconds = Number((Number(process.hrtime.bigint() - started) / 1e9).toFixed(3));
  closeSync(out);
  const writer = settle();
  const output = readFileSync(log, 'utf8');
  // The rows of a plain progress report: a phase, what it covered, and its seconds.
  // `counts` holds the first number of what each covered: the functions codegen emitted, say.
  const rows = {};
  const counts = {};
  // A time is seconds (`0.28s`), milliseconds (`12ms`) or, from a minute on, `2m 05s`.
  for (const row of output.matchAll(/^ {2}(\w+) +(.*?) +(?:(\d+)m )?(\d+(?:\.\d+)?)(m?)s$/gm)) {
    rows[row[1]] = Number(row[3] ?? 0) * 60 + Number(row[4]) / (row[5] === 'm' ? 1000 : 1);
    const count = /\d[\d,]*/.exec(row[2]);
    if (count) counts[row[1]] = Number(count[0].replaceAll(',', ''));
  }
  // The line that counts a test run's tests, or the line that ends any other run.
  const last = /^Tests .*$/m.exec(output)?.[0] ?? output.trimEnd().split('\n').at(-1);
  const sample = { package: name, command, edit, state, text, seconds, writer: Number(writer.toFixed(3)), status: ran.status, rows, counts, last, log: relative(work, log) };
  appendFileSync(samples, `${JSON.stringify(sample)}\n`);
  console.log(`${name} ${command}: ${edit ?? 'no edit'}, ${state}: ${seconds.toFixed(2)} s`);
  if (ran.status !== 0) {
    endServers();
    stop(`${silk} ${args.join(' ')} left status ${ran.status} after ${text ?? 'no edit'}; its output is in ${log}`);
  }
  if (test && state === 'cold' && !/[1-9]\d* executed/.test(last)) stop(`${silk} ${args.join(' ')} ran no test; its output is in ${log}`);
  return sample;
}

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const report = [];
for (const name of chosenPackages) {
  const sites = Object.entries(packages[name].edits)
    .filter(([edit]) => options.edits === undefined || options.edits.split(',').includes(edit))
    .map(([edit, site]) => ({ ...site, edit, marks: [fresh()] }));
  for (const edit of options.edits?.split(',') ?? []) if (!Object.values(packages).some((listed) => Object.hasOwn(listed.edits, edit))) stop(`unknown edit ${edit}; ${name}'s edits are ${Object.keys(packages[name].edits).join(', ')}`);
  if (sites.length === 0) stop(`--edits names none of ${name}'s edits; they are ${Object.keys(packages[name].edits).join(', ')}`);
  // Each site starts with its first text in place, so a round changes a line and adds none.
  const reset = () => {
    for (const site of sites) site.marks.length = 1;
    write(sites);
  };
  for (const command of chosenCommands) {
    if (commands[command].test && packages[name].test === undefined) {
      report.push(`\n${name}, ${command}: not timed, no tests are listed for the package`);
      continue;
    }
    reset();
    rmSync(join(tree, 'build'), { recursive: true, force: true });
    const cold = run(name, command, undefined, 'cold');
    rmSync(snapshot, { recursive: true, force: true });
    cpSync(join(tree, 'build'), snapshot, { recursive: true, preserveTimestamps: true });
    const unchanged = run(name, command, undefined, 'unchanged');
    report.push(`\n${name}, ${command}: cold ${cold.seconds.toFixed(2)} s, nothing changed ${unchanged.seconds.toFixed(2)} s`);
    report.push(`  ${'edit'.padEnd(10)} ${'first edit'.padStart(10)} ${'later edits'.padStart(11)} ${'emitted'.padStart(8)}   each later edit`);
    for (const site of sites) {
      if (commands[command].served) endServers();
      reset();
      rmSync(join(tree, 'build'), { recursive: true, force: true });
      cpSync(snapshot, join(tree, 'build'), { recursive: true, preserveTimestamps: true });
      // A check that asks a server needs one: this run starts it from the cold run's cache.
      if (commands[command].served) run(name, command, site.edit, 'server start');
      const timed = [];
      for (let round = 0; round <= rounds; round += 1) {
        site.marks.push(fresh());
        write(sites);
        const text = `${site.kind} ${site.marks.at(-1)} at \`${site.at.trim()}\` in ${site.file}`;
        timed.push(run(name, command, site.edit, round === 0 ? 'first edit' : 'later edit', text));
      }
      const later = timed.slice(1).map((sample) => sample.seconds);
      // The functions the last edit's codegen emitted, for the commands that report it.
      const emitted = String(timed.at(-1).counts.codegen ?? '');
      report.push(`  ${site.edit.padEnd(10)} ${timed[0].seconds.toFixed(2).padStart(10)} ${median(later).toFixed(2).padStart(11)} ${emitted.padStart(8)}   ${later.map((seconds) => seconds.toFixed(2)).join(' ')}`);
    }
    if (commands[command].served) endServers();
  }
}
console.log(`${report.join('\n')}\n\nSeconds of wall time; later edits is the median. Every sample is in ${samples}.`);
