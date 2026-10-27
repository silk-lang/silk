// Stability checks found by the stability rounds: parser and type-check corners, symbolic links,
// incremental rebuilds that must give the same answer as a clean build, hung tests, concurrent
// builds and stack overflows.
import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { cpSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { initPackage, join, read, sh, sharedHome, show, silk, userEnv, write } from './lib.mjs'
import { startServer, uriOf } from './lsp.mjs'

const h = sharedHome()

const logging = `import silk.effect { Effect }
import silk.logger { LogError }
import silk.os_logger { StdoutLogger }

pub effect fn main() -> () ! LogError {
  let mut logger = StdoutLogger.make()
`

// Runs a main body that computes `v` and logs it, returning the command result.
function runValue(body) {
  const dir = initPackage(h, `value${Math.random().toString(36).slice(2, 8)}`)
  write(join(dir, 'src/main.silk'), `${logging}${body}\n  run Effect.log("{v}\\n", &.{ v: v }) |> Effect.provideMut(&mut logger)\n}\n`)
  return silk(h, ['run', '--quiet'], { cwd: dir })
}

test('a literal sum on the left of == takes the other operand\'s type', () => {
  const result = runValue('  let x: i64 = 3\n  let v = (1 + 2) == x')
  assert.equal(result.status, 0, show(result))
  assert.equal(result.stdout, 'true\n')
})

test('a literal sum on the right of == takes the other operand\'s type', () => {
  const result = runValue('  let x: i64 = 3\n  let v = x == (1 + 2)')
  assert.equal(result.status, 0, show(result))
  assert.equal(result.stdout, 'true\n')
})

test('a < b && c > (d) parses as two comparisons', () => {
  const result = runValue('  let x: i64 = 3\n  let y: i64 = 4\n  let v = x < y && y > (x + 1)')
  assert.equal(result.status, 0, show(result))
  assert.equal(result.stdout, 'false\n')
})

test('a < b && c > d without parentheses parses', () => {
  const result = runValue('  let x: i64 = 3\n  let y: i64 = 4\n  let v = x < y && y > x + 1')
  assert.equal(result.status, 0, show(result))
  assert.equal(result.stdout, 'false\n')
})

// A library `d` in its own folder, used by `app`.
function library(root) {
  write(join(root, 'd/silk.toml'), '[package]\nname = "d"\nversion = "0.1.0"\nkind = "library"\nexports = ["money"]\n')
  write(join(root, 'd/src/money.silk'), 'pub fn cents() -> i32 {\n  return 275\n}\n')
  write(join(root, 'app/silk.toml'), '[package]\nname = "app"\nversion = "0.1.0"\n')
  write(join(root, 'app/src/main.silk'), 'import d.money { cents }\n\npub fn main() -> i32 {\n  return cents() - 275\n}\n')
}

test('two dependents reach one library through differently spelled paths', () => {
  const root = join(h.work, 'diamond')
  library(root)
  write(join(root, 'b/silk.toml'), '[package]\nname = "b"\nversion = "0.1.0"\nkind = "library"\nexports = ["one"]\n\n[dependencies]\nd = { path = "../d" }\n')
  write(join(root, 'b/src/one.silk'), 'import d.money { cents }\n\npub fn one() -> i32 {\n  return cents()\n}\n')
  write(join(root, 'c/silk.toml'), '[package]\nname = "c"\nversion = "0.1.0"\nkind = "library"\nexports = ["two"]\n\n[dependencies]\nd = { path = "../b/../d" }\n')
  write(join(root, 'c/src/two.silk'), 'import d.money { cents }\n\npub fn two() -> i32 {\n  return cents()\n}\n')
  write(join(root, 'app/silk.toml'), '[package]\nname = "app"\nversion = "0.1.0"\n\n[dependencies]\nb = { path = "../b" }\nc = { path = "../c" }\n')
  write(join(root, 'app/src/main.silk'), 'import b.one { one }\nimport c.two { two }\n\npub fn main() -> i32 {\n  return one() - two()\n}\n')
  const result = silk(h, ['run', '--quiet'], { cwd: join(root, 'app') })
  assert.equal(result.status, 0, show(result))
})

test('a dependency reached through a symbolic link builds', () => {
  const root = join(h.work, 'linked-dependency')
  library(root)
  symlinkSync('d', join(root, 'dlink'))
  write(join(root, 'app/silk.toml'), '[package]\nname = "app"\nversion = "0.1.0"\n\n[dependencies]\nd = { path = "../dlink" }\n')
  const result = silk(h, ['run', '--quiet'], { cwd: join(root, 'app') })
  assert.equal(result.status, 0, show(result))
})

test('a source module that is a symbolic link builds', () => {
  const dir = initPackage(h, 'linked-module')
  write(join(h.work, 'shared/helper.silk'), 'pub fn seven() -> i32 {\n  return 7\n}\n')
  symlinkSync('../../shared/helper.silk', join(dir, 'src/helper.silk'))
  write(join(dir, 'src/main.silk'), 'import helper { seven }\n\npub fn main() -> i32 {\n  return seven() - 7\n}\n')
  const result = silk(h, ['run', '--quiet'], { cwd: dir })
  assert.equal(result.status, 0, show(result))
})

test('a project opened through a symbolic link builds', () => {
  const dir = initPackage(h, 'linked-project')
  symlinkSync(dir, join(h.work, 'project-link'))
  const result = silk(h, ['run', '--quiet'], { cwd: join(h.work, 'project-link') })
  assert.equal(result.status, 0, show(result))
})

// [what the newcomer did, program, pattern the first error must match]
const unclear = [
  ['called a method the type lacks', null, 'import silk.allocator { Allocator, OutOfMemoryError }\nimport silk.list { List }\n\neffect fn fill() -> () ! OutOfMemoryError ? &mut Allocator {\n  let mut list = List<i32>.make()\n  run list.push(1)\n}\n\npub fn main() -> i32 {\n  return 0\n}\n', /push/],
  ['used List without importing it', null, 'struct Tags {\n  names: List<i32>,\n}\n\npub fn main() -> i32 {\n  return 0\n}\n', /List/],
  ['wrote a tuple return type', null, 'fn pair() -> (i32, i32) {\n  return (1, 2)\n}\n\npub fn main() -> i32 {\n  return 0\n}\n', /tuple/],
  ['saved the file with a byte order mark', null, '﻿pub fn main() -> i32 {\n  return 0\n}\n', null],
]

for (const [what, finding, source, wanted] of unclear) {
  test(`a newcomer who ${what} is told what to fix`, { todo: finding ?? undefined }, () => {
    const dir = initPackage(h, `unclear${unclear.findIndex((entry) => entry[0] === what)}`)
    write(join(dir, 'src/main.silk'), source)
    const result = silk(h, ['check', '--quiet'], { cwd: dir })
    if (wanted === null) {
      assert.equal(result.status, 0, show(result))
      return
    }
    const errors = result.stderr.split('\n').filter((line) => /error\[/.test(line))
    assert.match(errors[0] ?? '', wanted, show(result))
  })
}

// Incremental rebuilds: each step edits the package, then a warm `silk run` must match a run of a
// fresh copy with no build folder.
test('warm rebuilds after edits match clean builds', () => {
  const dir = initPackage(h, 'incremental')
  const cold = join(h.work, 'incremental-cold')
  const file = (name) => join(dir, 'src', name)
  const edit = (name, from, to) => {
    const text = read(file(name))
    assert.ok(text.includes(from), `${from} not in ${name}`)
    writeFileSync(file(name), text.replace(from, to))
  }
  write(file('main.silk'), `import util { scale, LIMIT }
import geometry { Point, area }
${logging}  let a = area(Point { x: 3, y: 4 })
  let s = scale(a)
  let l = LIMIT
  run Effect.log("{a} {s} {l}\\n", &.{ a: a, s: s, l: l }) |> Effect.provideMut(&mut logger)
}
`)
  write(file('util.silk'), 'pub const LIMIT: i32 = 10\n\npub fn scale(v: i32) -> i32 {\n  return v * 2\n}\n')
  write(file('geometry.silk'), 'pub struct Point {\n  pub x: i32,\n  pub y: i32,\n}\n\npub fn area(p: Point) -> i32 {\n  return p.x * p.y\n}\n')
  const steps = [
    ['baseline', () => {}],
    ['constant value', () => edit('util.silk', '= 10', '= 11')],
    ['function body', () => edit('util.silk', 'v * 2', 'v * 3')],
    ['parameter added, caller now wrong', () => edit('util.silk', 'scale(v: i32)', 'scale(v: i32, k: i32)')],
    ['caller fixed', () => edit('main.silk', 'scale(a)', 'scale(a, 1)')],
    ['new parameter used', () => edit('util.silk', 'v * 3', 'v * 3 + k')],
    ['field renamed, user now wrong', () => edit('geometry.silk', 'pub x: i32', 'pub px: i32')],
    ['field renamed back', () => edit('geometry.silk', 'pub px: i32', 'pub x: i32')],
    ['field made private', () => edit('geometry.silk', 'pub y: i32', 'y: i32')],
    ['field public again', () => edit('geometry.silk', '  y: i32', '  pub y: i32')],
    ['syntax error', () => edit('util.silk', 'v * 3 + k', 'v * * 3 + k')],
    ['syntax fixed', () => edit('util.silk', 'v * * 3 + k', 'v * 3 + k')],
    ['module added', () => {
      write(file('extra.silk'), 'pub fn bonus() -> i32 {\n  return 7\n}\n')
      edit('main.silk', 'import util', 'import extra { bonus }\nimport util')
      edit('main.silk', 'let l = LIMIT', 'let l = LIMIT + bonus()')
    }],
    ['added module changed', () => edit('extra.silk', 'return 7', 'return 8')],
    ['module deleted', () => rmSync(file('extra.silk'))],
    ['module restored', () => write(file('extra.silk'), 'pub fn bonus() -> i32 {\n  return 9\n}\n')],
    ['module renamed', () => renameSync(file('extra.silk'), file('more.silk'))],
    ['import follows the rename', () => edit('main.silk', 'import extra', 'import more')],
  ]
  const outcome = (cwd) => {
    const result = silk(h, ['run', '--quiet'], { cwd })
    const errors = [...result.stderr.matchAll(/^(\S+:\d+:\d+: error\[\w+\])/gm)].map((match) => match[1]).sort()
    return { status: result.status, stdout: result.stdout, errors }
  }
  const seen = []
  for (const [name, change] of steps) {
    change()
    const warm = outcome(dir)
    rmSync(cold, { recursive: true, force: true })
    mkdirSync(cold)
    cpSync(dir, cold, { recursive: true, filter: (path) => !path.startsWith(join(dir, 'build')) })
    const clean = outcome(cold)
    assert.deepEqual(warm, clean, `after "${name}"`)
    seen.push(`${name}: ${warm.status === 0 ? warm.stdout.trim() : warm.errors.join(', ')}`)
  }
  // The edits really changed the output, so the comparison above tested something.
  assert.match(seen.at(-1), /: 12 37 20$/, seen.join('\n'))
})

test('a test that never finishes is stopped and named, and the others still report', () => {
  const dir = initPackage(h, 'spinning')
  write(join(dir, 'src/main.silk'), 'pub fn main() -> i32 {\n  return 0\n}\n\ntest fn quick() {\n  let x: i64 = 1\n}\n\ntest fn spins() {\n  let mut i: i64 = 0\n  while i >= 0 {\n    i = i - 1 + 1\n  }\n}\n')
  // Bounded here so a hang fails the test instead of the suite; the spinning test process is
  // cleaned up afterwards.
  const result = sh(h, 'timeout 120 silk test --no-cache; status=$?; pkill -f "debug/spinning" || true; exit $status', { cwd: dir })
  assert.notEqual(result.status, 124, `silk test hung\n${show(result)}`)
  assert.match(result.stdout + result.stderr, /main::spins[\s\S]*(time|took|timeout)/i, show(result))
  assert.match(result.stdout + result.stderr, /main::quick\s+PASS/, show(result))
})

test('two builds of one package at the same time both succeed', async () => {
  const dir = initPackage(h, 'together')
  const failures = []
  for (let round = 0; round < 4; round++) {
    rmSync(join(dir, 'build'), { recursive: true, force: true })
    const results = await Promise.all([['build', '--quiet'], ['run', '--quiet']].map((args) => new Promise((done) => {
      const child = spawn('silk', args, { cwd: dir, env: userEnv(h) })
      let stderr = ''
      child.stderr.on('data', (chunk) => (stderr += chunk))
      child.on('close', (status) => done({ status, stderr }))
    })))
    for (const result of results) if (result.status !== 0) failures.push(result.stderr)
  }
  assert.deepEqual(failures, [])
})

test('a stack overflow says so instead of a bare segmentation fault', () => {
  const dir = initPackage(h, 'deep')
  write(join(dir, 'src/main.silk'), 'fn deep(n: i64) -> i64 {\n  if n == 0 {\n    return 0\n  }\n  return deep(n - 1) + 1\n}\n\npub fn main() -> i32 {\n  if deep(100000000) == 0 {\n    return 1\n  }\n  return 0\n}\n')
  const result = silk(h, ['run', '--quiet'], { cwd: dir })
  assert.match(result.stderr, /stack overflow/i, show(result))
})

test('a small float rounded to a precision prints zeros, not a leading 1', () => {
  const dir = initPackage(h, 'smallfloat')
  write(join(dir, 'src/main.silk'), `${logging}  let a: f64 = 0.000001
  let b: f64 = 0.000000006
  let c: f64 = 1.0e-7
  run Effect.log("{a:.3} {b:.2} {c:+.11}\\n", &.{ a: a, b: b, c: c }) |> Effect.provideMut(&mut logger)
}
`)
  const result = silk(h, ['run', '--quiet'], { cwd: dir })
  assert.equal(result.status, 0, show(result))
  assert.equal(result.stdout, '0.000 0.00 +0.00000010000\n')
})

test('checking a module with 100 log calls takes a few seconds at most', { todo: 'finding 41' }, () => {
  const dir = initPackage(h, 'manylogs')
  let body = ''
  for (let i = 0; i < 100; i++) body += `  run Effect.log("line ${i}: {v}\\n", &.{ v: ${i} }) |> Effect.provideMut(&mut logger)\n`
  write(join(dir, 'src/main.silk'), `${logging}${body}}\n`)
  const start = Date.now()
  const result = silk(h, ['check'], { cwd: dir })
  const seconds = (Date.now() - start) / 1000
  assert.equal(result.status, 0, show(result))
  assert.ok(seconds < 3, `silk check took ${seconds.toFixed(1)} s`)
})

test('spawning a task that can fail names the call and the fix', () => {
  const dir = initPackage(h, 'spawnfail')
  write(join(dir, 'src/main.silk'), `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.native_thread { SpawnError }
import silk.thread_pool { Pool, ThreadPool }

effect fn work(pool: Pool, n: i64) -> i64
  ! OutOfMemoryError {
  if n < 2 {
    return n
  }
  let left = run pool.spawn(work(pool.clone(), n - 1))
  let leftValue = run left.join()
  return leftValue + n
}

pub fn main() -> i32 {
  return 0
}
`)
  const result = silk(h, ['check'], { cwd: dir })
  assert.notEqual(result.status, 0, show(result))
  assert.match(result.stderr, /spawn/, show(result))
  assert.match(result.stderr, /Effect\.result/, show(result))
})

test('an unhandled error prints its fields, not only its type', () => {
  const dir = initPackage(h, 'unhandledjson')
  write(join(dir, 'src/main.silk'), `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.json_scanner { JsonError }
import silk.json_value { Json }

pub effect fn main() -> i32
  ! JsonError | OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let document = run Json.parse(b"{\\"a\\":1,\\"a\\":2}")
    |> Effect.provideMut<Allocator>(&mut allocator)
  return 0
}
`)
  const result = silk(h, ['run', '--quiet'], { cwd: dir })
  assert.equal(result.status, 1, show(result))
  assert.match(result.stderr, /offset/, show(result))
})

// Since #2354 an if with a final else is an expression; without one it is PAR0009.
test('an if with a final else works as a value', () => {
  const dir = initPackage(h, 'ifvalue')
  write(join(dir, 'src/main.silk'), 'pub fn main() -> i32 {\n  let found = true\n  let first = if found { 0 } else { 2 }\n  return first\n}\n')
  const result = silk(h, ['run'], { cwd: dir })
  assert.equal(result.status, 0, show(result))
})

test('an if used as a value without else asks for a final else', () => {
  const dir = initPackage(h, 'ifnoelse')
  write(join(dir, 'src/main.silk'), 'pub fn main() -> i32 {\n  let found = true\n  let first = if found { 1 }\n  return first\n}\n')
  const result = silk(h, ['check'], { cwd: dir })
  assert.match(result.stderr, /error\[PAR0009\] An `if` used as a value needs a final `else` branch/, show(result))
})


test('the native resolver finds localhost', () => {
  const dir = initPackage(h, 'resolvelocal')
  write(join(dir, 'src/main.silk'), "import silk.allocator { Allocator, OutOfMemoryError }\nimport silk.effect { Effect }\nimport silk.monotonic_clock { MonotonicClock }\nimport silk.native_resolver { NativeSystemResolver }\nimport silk.network_address { AddressError, Host, Port }\nimport silk.option { Option }\nimport silk.os_monotonic_clock { OsMonotonicClock }\nimport silk.result { Result }\nimport silk.resolver { FamilySelection, ResolveRequest, ResolvedEndpoints, Resolver, ResolverError }\nimport silk.system_clock { Instant, SystemClock }\nimport silk.os_writer { StderrWriter }\n\nfn request(name: string, deadline: Option<Instant>) -> Option<ResolveRequest> {\n  let host = match Host.parse(name) {\n    Result<Host, AddressError>.Success { value } => value\n    Result<Host, AddressError>.Failure { error: _ } => {\n      return Option<ResolveRequest>.none()\n    }\n  }\n  return match ResolveRequest.make(host, Port.fromU16(443), FamilySelection.Any, 8, move deadline) {\n    Result<ResolveRequest, ResolverError>.Success { value } => Option<ResolveRequest>.some(\n      move value\n    )\n    Result<ResolveRequest, ResolverError>.Failure { error: _ } => Option<ResolveRequest>.none()\n  }\n}\n\n// Returns the number of endpoints of `name`. It blocks until the system lookup ends.\neffect fn countEndpoints(name: string) -> usize\n  ! ResolverError | OutOfMemoryError\n  ? &mut Resolver | &mut MonotonicClock | &mut Allocator {\n  let lookup = match request(name, Option<Instant>.none()) {\n    Option.Some { value } => move value\n    Option.None => {\n      return 0\n    }\n  }\n  let endpoints = run Resolver.resolve(&lookup)\n  return ResolvedEndpoints.length(&endpoints)\n}\n\npub fn main() -> i32 {\n  let mut allocator = Allocator.systemAllocatorProvider()\n  let mut resolver = NativeSystemResolver.make()\n  let mut clock = OsMonotonicClock.make()\n  let names: [string; 4] = [\"localhost\", \"127.0.0.1\", \"api.anthropic.com\", \"vm\"]\n  let mut i: usize = 0\n  while i < 4 {\n    let name = names[i]\n    let found = run Effect.result(countEndpoints(name))\n      |> Effect.provideMut<Resolver>(&mut resolver)\n      |> Effect.provideMut<MonotonicClock>(&mut clock)\n      |> Effect.provideMut<Allocator>(&mut allocator)\n    match move found {\n      Result.Success { value } => StderrWriter.print(\"{name}: {n} endpoints\\n\", &.{ name: name, n: value })\n      Result.Failure { error } => {\n        drop error\n        StderrWriter.print(\"{name}: failed\\n\", &.{ name: name })\n      }\n    }\n    i = i + 1\n  }\n  return 0\n}\n")
  const result = silk(h, ['run', '--quiet'], { cwd: dir })
  assert.equal(result.status, 0, show(result))
  assert.match(result.stderr, /localhost: 1 endpoints/, show(result))
})

test('a library with 600 tests builds and runs them all', () => {
  const dir = initPackage(h, 'manytests', ['--lib'])
  let body = "import silk.testing { AssertionError, Testing }\n\npub fn twice(x: i32) -> i32 {\n  return x * 2\n}\n"
  for (let i = 0; i < 600; i++) body += `\ntest effect fn case${i}() -> ()\n  ! AssertionError<'static> {\n  run Testing.expect(twice(${i}) == ${2 * i}, "twice ${i}")\n}\n`
  write(join(dir, 'src/lib.silk'), body)
  const result = silk(h, ['test', '--no-cache'], { cwd: dir })
  assert.equal(result.status, 0, show(result))
  assert.match(result.stdout, /Tests  600 passed, 0 failed/)
})

test('a call with too few arguments is reported as SEM0007', () => {
  const dir = initPackage(h, 'fewargs')
  write(join(dir, 'src/main.silk'), 'fn add(a: i32, b: i32, c: i32) -> i32 {\n  return a + b + c\n}\n\npub fn main() -> i32 {\n  return add(2, 3)\n}\n')
  const result = silk(h, ['check'], { cwd: dir })
  assert.match(result.stderr, /src\/main\.silk:6:10: error\[SEM0007\] Expected 3 arguments but received 2/, show(result))
})

test('in a workspace, the editor sees a saved change to another member', async () => {
  const root = join(h.work, 'lspshop')
  for (const [args, cwd] of [[['init', '--workspace', 'lspshop'], h.work], [['init', '--lib', 'pricing'], root], [['init', 'store'], root], [['add', '../pricing'], join(root, 'store')]]) {
    const result = silk(h, args, { cwd })
    assert.equal(result.status, 0, show(result))
  }
  const store = join(root, 'store/src/main.silk')
  const lib = join(root, 'pricing/src/lib.silk')
  write(store, 'import pricing.lib { add }\n\npub fn main() -> i32 {\n  return add(2, 3) - 5\n}\n')
  const server = startServer(h, root)
  await server.initialize(root)
  for (const file of [store, lib]) server.notify('textDocument/didOpen', { textDocument: { uri: uriOf(file), languageId: 'silk', version: 1, text: read(file) } })
  assert.deepEqual(await server.diagnostics(uriOf(store), 120_000), [])
  const hidden = read(lib).replace('pub fn add', 'fn add')
  write(lib, hidden)
  server.notify('textDocument/didChange', { textDocument: { uri: uriOf(lib), version: 2 }, contentChanges: [{ text: hidden }] })
  server.notify('textDocument/didSave', { textDocument: { uri: uriOf(lib) } })
  server.notify('textDocument/didChange', { textDocument: { uri: uriOf(store), version: 2 }, contentChanges: [{ text: read(store) + '\n' }] })
  let codes = []
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline && !codes.includes('SEM0015')) {
    codes = (await server.diagnostics(uriOf(store), 20_000).catch(() => [])).map((diagnostic) => diagnostic.code)
  }
  await server.shutdown()
  assert.ok(codes.includes('SEM0015'), JSON.stringify(codes))
})

// A package of `modules` modules with `functions` functions each, all reachable from main.
function generatedPackage(name, modules, functions) {
  const dir = initPackage(h, name)
  for (let m = 0; m < modules; m++) {
    let text = `pub struct Point {\n  pub x: i64,\n  pub y: i64,\n}\n\npub union Shape {\n  Circle {\n    pub radius: i64,\n  },\n  Rect {\n    pub width: i64,\n    pub height: i64,\n  },\n  Empty\n}\n`
    for (let f = 0; f < functions; f++) {
      text += `\npub fn f${f}(seed: i64) -> i64 {\n  let point = Point { x: seed + ${f}, y: seed * 2 }\n  let shape = match seed % 3 {\n    0 => Shape.Circle { radius: point.x }\n    1 => Shape.Rect { width: point.x, height: point.y }\n    _ => Shape.Empty\n  }\n  let value = match move shape {\n    Shape.Circle { radius } => radius * 3\n    Shape.Rect { width, height } => width * height\n    Shape.Empty => ${f}\n  }\n  return value % 1000\n}\n`
    }
    text += `\npub fn all(seed: i64) -> i64 {\n  let mut total: i64 = 0\n${Array.from({ length: functions }, (_, f) => `  total = total + f${f}(seed)\n`).join('')}  return total\n}\n`
    write(join(dir, `src/gen/m${m}.silk`), text)
  }
  const imports = Array.from({ length: modules }, (_, m) => `import gen.m${m} as M${m}\n`).join('')
  const sum = Array.from({ length: modules }, (_, m) => `M${m}.all(1)`).join(' + ')
  write(join(dir, 'src/main.silk'), `${imports}\npub fn main() -> i32 {\n  let total: i64 = ${sum}\n  if total > 0 {\n    return 0\n  }\n  return 1\n}\n`)
  return dir
}

const loadSeconds = (result) => Number(/^  load +.* +([\d.]+)s$/m.exec(result.stderr)?.[1] ?? NaN)
const checkSeconds = (result) => Number(/^  check +\d+ modules? +([\d.]+)s$/m.exec(result.stderr)?.[1] ?? NaN)

test('a one-line edit in one module of a big package rechecks far less than a cold check', () => {
  const dir = generatedPackage('bigedit', 10, 90)
  rmSync(join(dir, 'build'), { recursive: true, force: true })
  const cold = silk(h, ['check'], { cwd: dir })
  assert.equal(cold.status, 0, show(cold))
  write(join(dir, 'src/main.silk'), read(join(dir, 'src/main.silk')).replace('return 1\n', 'return 2\n'))
  const edited = silk(h, ['check'], { cwd: dir })
  assert.equal(edited.status, 0, show(edited))
  // Since #2305 an unchanged file is not parsed at load, and the edited one is parsed during check,
  // so compare load and check together.
  const work = (result) => loadSeconds(result) + checkSeconds(result)
  assert.ok(work(edited) < work(cold) / 2, `cold ${work(cold)} s, after editing main ${work(edited)} s (load + check)`)
})

test('commas between struct fields are accepted, as in union variants', () => {
  const dir = initPackage(h, 'structcomma')
  write(join(dir, 'src/main.silk'), 'struct P {\n  x: i32,\n  y: i32,\n}\n\npub fn main() -> i32 {\n  let p = P { x: 40, y: 2 }\n  return p.x + p.y\n}\n')
  const result = silk(h, ['run', '--quiet'], { cwd: dir })
  assert.equal(result.status, 42, show(result))
})

test('passing a &mut binding to a call suggests lending it again with &mut', () => {
  const dir = initPackage(h, 'reborrowhint')
  write(join(dir, 'src/main.silk'), 'fn bump(v: &mut i32) -> () {\n  v.* = v.* + 1\n}\n\npub fn main() -> i32 {\n  let mut n: i32 = 0\n  let r = &mut n\n  bump(r)\n  bump(r)\n  return n - 2\n}\n')
  const result = silk(h, ['check'], { cwd: dir })
  assert.match(result.stderr, /error\[OWN0003\].*&mut r/, show(result))
})

test('an error in a typed let does not hide later errors that use the binding', () => {
  const dir = initPackage(h, 'typedlet')
  write(join(dir, 'src/main.silk'), 'pub fn main() -> i32 {\n  let a: i32 = "s"\n  let b: bool = true\n  let d = a + b\n  return 0\n}\n')
  const result = silk(h, ['check'], { cwd: dir })
  assert.match(result.stderr, /2:16: error\[SEM0037\]/, show(result))
  assert.match(result.stderr, /4:\d+: error\[SEM0135\]/, show(result))
})

test('a long postfix chain is refused with PAR0005, not a crash', () => {
  const dir = initPackage(h, 'postfixchain')
  for (const [name, link] of [['field', '.inner'], ['method', '.f()'], ['index', '[0]']]) {
    write(join(dir, 'src/main.silk'), `fn f(v: i32) -> i32 {\n  return v\n}\n\npub fn main() -> i32 {\n  let b: i32 = 0\n  return b${link.repeat(1000)}\n}\n`)
    const result = silk(h, ['check'], { cwd: dir })
    assert.equal(result.signal, null, `${name} chain: ${show(result)}`)
    assert.equal(result.status, 1, `${name} chain: ${show(result)}`)
    assert.match(result.stderr, /error\[PAR0005\]/, `${name} chain: ${show(result)}`)
  }
})

test('an index out of bounds inside a fiber reports the trap like the main task does', () => {
  const dir = initPackage(h, 'fibertrap')
  write(join(dir, 'src/main.silk'), `import silk.allocator { OutOfMemoryError }
import silk.effect { Effect }
import silk.fiber { Fiber, Cancelled }
import silk.local_scheduler { LocalScheduler, StalledError }
import silk.monotonic_clock { MonotonicClock }
import silk.os_monotonic_clock { OsMonotonicClock }
import silk.scheduler { Scheduler, TaskIdExhaustedError }

effect fn bad(index: usize) -> i32 {
  run Fiber.yieldNow()
  let values: [i32; 2] = [1, 2]
  return values[index]
}

effect fn root() -> i32
  ! OutOfMemoryError | TaskIdExhaustedError | Cancelled
  ? &mut Scheduler | &mut MonotonicClock {
  let child = run Fiber<i32, never>.forkChild(bad(7))
  return run Fiber.join(move child)
}

pub effect fn main() -> i32
  ! OutOfMemoryError | TaskIdExhaustedError | Cancelled | StalledError {
  let mut scheduler = LocalScheduler.make()
  let mut clock = OsMonotonicClock.make()
  return run LocalScheduler.execute(&mut scheduler, root())
    |> Effect.provideMut<MonotonicClock>(&mut clock)
}
`)
  for (const flags of [[], ['--release']]) {
    const result = silk(h, ['run', '--quiet', ...flags], { cwd: dir })
    assert.match(result.stderr, /fatal trap: index out of bounds\n  at main\.bad \(main:12:10\)/, `${flags.join(' ') || 'debug'}: ${show(result)}`)
  }
})

test('a HashMap that inserts and removes one key at a time keeps a small table', () => {
  const dir = initPackage(h, 'map-churn')
  write(join(dir, 'src/main.silk'), `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.hash { Hash, Word }
import silk.hash_map { HashMap }
import silk.usize

pub effect fn main() -> i32
  ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut map = HashMap<Word, i64>.make(Hash.seed(17))
  let mut i: u64 = 0
  while i < 100000 {
    drop run HashMap<Word, i64>.insert(&mut map, Hash.word(i), 1)
      |> Effect.provideMut<Allocator>(&mut allocator)
    drop HashMap<Word, i64>.remove(&mut map, Hash.word(i))
    i = i + 1
  }
  // The map never holds more than one entry.
  if HashMap<Word, i64>.bucketCount(&map) > 64 {
    return 1
  }
  return 0
}
`)
  const ran = silk(h, ['run', '--quiet', '--release'], { cwd: dir })
  assert.equal(ran.status, 0, show(ran))
})

test('let _ = names drop as the way to discard a value', () => {
  const dir = initPackage(h, 'let-underscore')
  write(join(dir, 'src/main.silk'), 'fn value() -> i32 {\n  return 1\n}\n\npub fn main() -> i32 {\n  let _ = value()\n  return 0\n}\n')
  const checked = silk(h, ['check'], { cwd: dir })
  assert.match(checked.stderr, /main\.silk:6:\d+: error\[SEM0087\]/, show(checked))
  assert.match(checked.stderr, /drop/, show(checked))
})

test('an effect call that is never run says to write run or drop', () => {
  const dir = initPackage(h, 'effect-not-run')
  write(join(dir, 'src/main.silk'), 'effect fn greet() -> () {\n  return ()\n}\n\npub effect fn main() -> () {\n  greet()\n}\n')
  const checked = silk(h, ['check'], { cwd: dir })
  assert.match(checked.stderr, /main\.silk:6:3: error\[SEM0087\] .*never run.*`run`/, show(checked))
})

test('a pipe compared without parentheses hints at the precedence of |>', () => {
  const dir = initPackage(h, 'pipe-precedence')
  write(join(dir, 'src/main.silk'), 'fn add(a: i32, b: i32) -> i32 {\n  return a + b\n}\n\npub fn main() -> i32 {\n  if 1 |> add(2) != 3 {\n    return 1\n  }\n  return 0\n}\n')
  const checked = silk(h, ['check'], { cwd: dir })
  assert.notEqual(checked.status, 0, show(checked))
  assert.match(checked.stderr, /\(.*\|>.*\)|parenthes/, show(checked))
})

// Silk checks a generic body once with T abstract, so the error names T, not an instance.
test('a type mismatch inside a generic body names the type parameter', () => {
  const dir = initPackage(h, 'generic-mismatch')
  write(join(dir, 'src/main.silk'), 'fn f(a: bool) -> i32 {\n  return 0\n}\n\nfn g<T>(value: T) -> i32 {\n  return f(value)\n}\n\npub fn main() -> i32 {\n  return g<i32>(1)\n}\n')
  const checked = silk(h, ['check'], { cwd: dir })
  assert.match(checked.stderr, /main\.silk:6:\d+: error\[SEM0012\] Expected bool but received T/, show(checked))
})

test('the mismatch says T is a type parameter of g', () => {
  const dir = initPackage(h, 'generic-mismatch-note')
  write(join(dir, 'src/main.silk'), 'fn f(a: bool) -> i32 {\n  return 0\n}\n\nfn g<T>(value: T) -> i32 {\n  return f(value)\n}\n\npub fn main() -> i32 {\n  return 0\n}\n')
  const checked = silk(h, ['check'], { cwd: dir })
  assert.match(checked.stderr, /`T` is a type parameter of `g`, so it can be any type/, show(checked))
})

// One static for over the fields of a struct: doubling the fields should about double the time.
// Finding 175: 1,600 fields check in about 1 s and 3,200 in about 2.6 s, up from 1.9 s in round 50.
test('a static for over 3,200 fields checks in a few seconds', { todo: 'finding 175' }, () => {
  const dir = initPackage(h, 'wide-reflect')
  const fields = Array.from({ length: 3200 }, (_, i) => `f${i}`)
  write(join(dir, 'src/main.silk'), `import silk.reflect { Reflect }

struct Wide {
${fields.map((f) => `  pub ${f}: i32,`).join('\n')}
}

fn total<T>(value: &T) -> i32 {
  let mut acc = 0
  static for field in Reflect.fields<T>() {
    acc = acc + Reflect.borrowField<T, i32>(value, field).*
  }
  return acc
}

pub fn main() -> i32 {
  let w = Wide {
${fields.map((f) => `    ${f}: 1,`).join('\n')}
  }
  return total(&w) - 3200
}
`)
  const checked = silk(h, ['check'], { cwd: dir })
  assert.equal(checked.status, 0, show(checked))
  assert.ok(checkSeconds(checked) < 3, `check took ${checkSeconds(checked)} s`)
})

// The formatter may lay the call out differently; the comments must survive and a second pass must agree.
test('silk format keeps a comment after the last statement of a closure passed as an argument', () => {
  const dir = initPackage(h, 'closure-comment')
  const source = 'fn call<F: mut fn() -> ()>(mut f: F) -> F {\n  f()\n  return move f\n}\n\npub fn main() -> i32 {\n  let mut n = 0\n  drop call(fn() -> () {\n    n = n + 1 // counted\n  })\n  drop call(fn() -> () {\n    n = n + 1\n    // after the last statement\n  })\n  return n - 2\n}\n'
  write(join(dir, 'src/main.silk'), source)
  const formatted = silk(h, ['format'], { cwd: dir })
  assert.equal(formatted.status, 0, show(formatted))
  const once = read(join(dir, 'src/main.silk'))
  for (const comment of ['// counted', '// after the last statement']) assert.ok(once.includes(comment), once)
  const again = silk(h, ['format'], { cwd: dir })
  assert.equal(again.status, 0, show(again))
  assert.equal(read(join(dir, 'src/main.silk')), once)
  const run = silk(h, ['run'], { cwd: dir })
  assert.equal(run.status, 0, show(run))
})

test('silk format keeps a comment after a bare return', () => {
  const dir = initPackage(h, 'return-comment')
  const source = 'fn f(n: i32) -> () {\n  if n > 2 {\n    return // nothing to do\n  }\n}\n\npub fn main() -> i32 {\n  f(1)\n  return 0\n}\n'
  write(join(dir, 'src/main.silk'), source)
  const formatted = silk(h, ['format'], { cwd: dir })
  assert.equal(formatted.status, 0, show(formatted))
  assert.equal(read(join(dir, 'src/main.silk')), source)
})

// Finding 131: messages after a module moves or is renamed.
test('a stale import of a moved module suggests its new dotted path', () => {
  const dir = initPackage(h, 'moved-module')
  write(join(dir, 'src/util/helper.silk'), 'pub fn twice(x: i32) -> i32 {\n  return x * 2\n}\n')
  write(join(dir, 'src/main.silk'), 'import helper { twice }\n\npub fn main() -> i32 {\n  return twice(21)\n}\n')
  const result = silk(h, ['check'], { cwd: dir })
  assert.notEqual(result.status, 0, show(result))
  assert.match(result.stderr, /MOD0001\][^\n]*helper/, show(result))
  assert.match(result.stderr, /util\.helper/, show(result))
})

test('a missing member names its module with dots', () => {
  const dir = initPackage(h, 'renamed-member')
  write(join(dir, 'src/util/helper.silk'), 'pub fn double(x: i32) -> i32 {\n  return x * 2\n}\n')
  write(join(dir, 'src/main.silk'), 'import util.helper { twice }\n\npub fn main() -> i32 {\n  return twice(21)\n}\n')
  const result = silk(h, ['check'], { cwd: dir })
  assert.match(result.stderr, /SEM0014\][^\n]*util\.helper/, show(result))
  assert.doesNotMatch(result.stderr, /util\/helper/, show(result))
})

// Finding 132: a plain struct passed by value to C.
test('a plain struct passed to a C function gets a coded error that says to use extern "C" struct', () => {
  const dir = initPackage(h, 'plain-struct-to-c')
  write(join(dir, 'src/main.silk'), 'struct Point {\n  x: f64,\n  y: f64,\n}\n\nunsafe extern "C" fn midpoint(p: Point, q: Point) -> Point\n\npub fn main() -> i32 {\n  let m = unsafe midpoint(Point { x: 0.0, y: 0.0 }, Point { x: 4.0, y: 6.0 })\n  return 0\n}\n')
  const result = silk(h, ['check'], { cwd: dir })
  assert.match(result.stderr, /error\[SEM\d+\][^\n]*Point/, show(result))
  assert.match(result.stderr, /extern "C" struct/, show(result))
  assert.doesNotMatch(result.stderr, /not supported by the native compiler yet/, show(result))
})

// Finding 135: removing one of two dependency names for the same package.
test('silk check after removing a second name for a dependency reports the stale import', () => {
  const root = join(h.work, `alias${Math.random().toString(36).slice(2, 8)}`)
  write(join(root, 'lb/silk.toml'), '[package]\nname = "lb"\nversion = "0.1.0"\nkind = "library"\nexports = ["lib"]\n')
  write(join(root, 'lb/src/lib.silk'), 'pub fn one() -> i32 {\n  return 1\n}\n\npub fn two() -> i32 {\n  return 2\n}\n')
  write(join(root, 'ap/silk.toml'), '[package]\nname = "ap"\nversion = "0.1.0"\n\n[dependencies]\nlb = { path = "../lb" }\nl2 = { path = "../lb", package = "lb" }\n')
  write(join(root, 'ap/src/main.silk'), 'import lb.lib { one }\nimport l2.lib { two }\n\npub fn main() -> i32 {\n  return one() + two() - 3\n}\n')
  const dir = join(root, 'ap')
  assert.equal(silk(h, ['check'], { cwd: dir }).status, 0)
  assert.equal(silk(h, ['remove', 'l2'], { cwd: dir }).status, 0)
  const result = silk(h, ['check'], { cwd: dir })
  assert.notEqual(result.status, 0, show(result))
  assert.match(result.stderr, /MOD0001\][^\n]*l2\.lib/, show(result))
})
