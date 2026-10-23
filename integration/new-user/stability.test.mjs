// Stability checks found by the stability rounds: parser and type-check corners, symbolic links,
// incremental rebuilds that must give the same answer as a clean build, hung tests, concurrent
// builds and stack overflows.
import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { cpSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { initPackage, join, read, sh, sharedHome, show, silk, userEnv, write } from './lib.mjs'

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
  write(join(root, 'd/silk.toml'), '[package]\nname = "d"\nversion = "0.1.0"\nsource-root = "src"\nexports = ["money"]\n')
  write(join(root, 'd/src/money.silk'), 'pub fn cents() -> i32 {\n  return 275\n}\n')
  write(join(root, 'app/silk.toml'), '[package]\nname = "app"\nversion = "0.1.0"\nroot = "src/main.silk"\n')
  write(join(root, 'app/src/main.silk'), 'import d.money { cents }\n\npub fn main() -> i32 {\n  return cents() - 275\n}\n')
}

test('two dependents reach one library through differently spelled paths', () => {
  const root = join(h.work, 'diamond')
  library(root)
  write(join(root, 'b/silk.toml'), '[package]\nname = "b"\nversion = "0.1.0"\nsource-root = "src"\nexports = ["one"]\n\n[dependencies]\nd = { path = "../d" }\n')
  write(join(root, 'b/src/one.silk'), 'import d.money { cents }\n\npub fn one() -> i32 {\n  return cents()\n}\n')
  write(join(root, 'c/silk.toml'), '[package]\nname = "c"\nversion = "0.1.0"\nsource-root = "src"\nexports = ["two"]\n\n[dependencies]\nd = { path = "../b/../d" }\n')
  write(join(root, 'c/src/two.silk'), 'import d.money { cents }\n\npub fn two() -> i32 {\n  return cents()\n}\n')
  write(join(root, 'app/silk.toml'), '[package]\nname = "app"\nversion = "0.1.0"\nroot = "src/main.silk"\n\n[dependencies]\nb = { path = "../b" }\nc = { path = "../c" }\n')
  write(join(root, 'app/src/main.silk'), 'import b.one { one }\nimport c.two { two }\n\npub fn main() -> i32 {\n  return one() - two()\n}\n')
  const result = silk(h, ['run', '--quiet'], { cwd: join(root, 'app') })
  assert.equal(result.status, 0, show(result))
})

test('a dependency reached through a symbolic link builds', () => {
  const root = join(h.work, 'linked-dependency')
  library(root)
  symlinkSync('d', join(root, 'dlink'))
  write(join(root, 'app/silk.toml'), '[package]\nname = "app"\nversion = "0.1.0"\nroot = "src/main.silk"\n\n[dependencies]\nd = { path = "../dlink" }\n')
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
  ['used List without importing it', null, 'struct Tags {\n  names: List<i32>\n}\n\npub fn main() -> i32 {\n  return 0\n}\n', /List/],
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
  write(file('geometry.silk'), 'pub struct Point {\n  pub x: i32\n  pub y: i32\n}\n\npub fn area(p: Point) -> i32 {\n  return p.x * p.y\n}\n')
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

test('a small float rounded to a precision prints zeros, not a leading 1', { todo: 'finding 40' }, () => {
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

test('spawning a task that can fail names the call and the fix', { todo: 'finding 43' }, () => {
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

test('an unhandled error prints its fields, not only its type', { todo: 'finding 44' }, () => {
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

test('an if used as a value explains that if is a statement', { todo: 'finding 48' }, () => {
  const dir = initPackage(h, 'ifvalue')
  write(join(dir, 'src/main.silk'), 'pub fn main() -> i32 {\n  let found = true\n  let first = if found { 1 } else { 2 }\n  return first\n}\n')
  const result = silk(h, ['check'], { cwd: dir })
  assert.notEqual(result.status, 0, show(result))
  assert.match(result.stderr, /`?if`? is a statement/i, show(result))
})


test('the native resolver finds localhost', { todo: 'finding 49' }, () => {
  const dir = initPackage(h, 'resolvelocal')
  write(join(dir, 'src/main.silk'), "import silk.allocator { Allocator, OutOfMemoryError }\nimport silk.effect { Effect }\nimport silk.monotonic_clock { MonotonicClock }\nimport silk.native_resolver { NativeSystemResolver }\nimport silk.network_address { AddressError, Host, Port }\nimport silk.option { Option }\nimport silk.os_monotonic_clock { OsMonotonicClock }\nimport silk.result { Result }\nimport silk.resolver { FamilySelection, ResolveRequest, ResolvedEndpoints, Resolver, ResolverError }\nimport silk.system_clock { Instant, SystemClock }\nimport silk.os_writer { StderrWriter }\n\nfn request(name: string, deadline: Option<Instant>) -> Option<ResolveRequest> {\n  let host = match Host.parse(name) {\n    Result<Host, AddressError>.Success { value } => value\n    Result<Host, AddressError>.Failure { error: _ } => {\n      return Option<ResolveRequest>.none()\n    }\n  }\n  return match ResolveRequest.make(host, Port.fromU16(443), FamilySelection.Any, 8, move deadline) {\n    Result<ResolveRequest, ResolverError>.Success { value } => Option<ResolveRequest>.some(\n      move value\n    )\n    Result<ResolveRequest, ResolverError>.Failure { error: _ } => Option<ResolveRequest>.none()\n  }\n}\n\n// Returns the number of endpoints of `name`. It blocks until the system lookup ends.\neffect fn countEndpoints(name: string) -> usize\n  ! ResolverError | OutOfMemoryError\n  ? &mut Resolver | &mut MonotonicClock | &mut Allocator {\n  let lookup = match request(name, Option<Instant>.none()) {\n    Option.Some { value } => move value\n    Option.None => {\n      return 0\n    }\n  }\n  let endpoints = run Resolver.resolve(&lookup)\n  return ResolvedEndpoints.length(&endpoints)\n}\n\npub fn main() -> i32 {\n  let mut allocator = Allocator.systemAllocatorProvider()\n  let mut resolver = NativeSystemResolver.make()\n  let mut clock = OsMonotonicClock.make()\n  let names: [string; 4] = [\"localhost\", \"127.0.0.1\", \"api.anthropic.com\", \"vm\"]\n  let mut i: usize = 0\n  while i < 4 {\n    let name = names[i]\n    let found = run Effect.result(countEndpoints(name))\n      |> Effect.provideMut<Resolver>(&mut resolver)\n      |> Effect.provideMut<MonotonicClock>(&mut clock)\n      |> Effect.provideMut<Allocator>(&mut allocator)\n    match move found {\n      Result.Success { value } => StderrWriter.print(\"{name}: {n} endpoints\\n\", &.{ name: name, n: value })\n      Result.Failure { error } => {\n        drop error\n        StderrWriter.print(\"{name}: failed\\n\", &.{ name: name })\n      }\n    }\n    i = i + 1\n  }\n  return 0\n}\n")
  const result = silk(h, ['run', '--quiet'], { cwd: dir })
  assert.equal(result.status, 0, show(result))
  assert.match(result.stderr, /localhost: 1 endpoints/, show(result))
})
