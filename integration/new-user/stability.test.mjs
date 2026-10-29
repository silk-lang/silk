// Stability checks found by the stability rounds: parser and type-check corners, symbolic links,
// and incremental rebuilds that must give the same answer as a clean build.
import { strict as assert } from 'node:assert'
import { cpSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { initPackage, join, read, sharedHome, show, silk, write } from './lib.mjs'

const h = sharedHome()

const logging = `import silk.core.effect { Effect }
import silk.io.logger { LogError }
import silk.io.logger_native { StdoutLogger }

pub effect fn main() -> () ! LogError {
  let mut logger = StdoutLogger.make()
`

// Runs a main body that computes `v` and logs it, returning the command result.
function runValue(body) {
  const dir = initPackage(h, `value${Math.random().toString(36).slice(2, 8)}`)
  write(join(dir, 'src/main.silk'), `${logging}${body}\n  run Effect.log("{v}\\n", &.{ v: v }) |> Effect.provideMut(&mut logger)\n}\n`)
  return silk(h, ['run', '--quiet'], { cwd: dir })
}

test('a literal sum on the left of == takes the other operand\'s type', { todo: 'finding 28' }, () => {
  const result = runValue('  let x: i64 = 3\n  let v = (1 + 2) == x')
  assert.equal(result.status, 0, show(result))
  assert.equal(result.stdout, 'true\n')
})

test('a literal sum on the right of == takes the other operand\'s type', () => {
  const result = runValue('  let x: i64 = 3\n  let v = x == (1 + 2)')
  assert.equal(result.status, 0, show(result))
  assert.equal(result.stdout, 'true\n')
})

test('a < b && c > (d) parses as two comparisons', { todo: 'finding 29' }, () => {
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
  write(join(root, 'd/silk.toml'), '[package]\nname = "d"\nversion = "0.1.0"\nsource = "src"\nexports = ["money"]\n')
  write(join(root, 'd/src/money.silk'), 'pub fn cents() -> i32 {\n  return 275\n}\n')
  write(join(root, 'app/silk.toml'), '[package]\nname = "app"\nversion = "0.1.0"\n')
  write(join(root, 'app/src/main.silk'), 'import d.money { cents }\n\npub fn main() -> i32 {\n  return cents() - 275\n}\n')
}

test('two dependents reach one library through differently spelled paths', () => {
  const root = join(h.work, 'diamond')
  library(root)
  write(join(root, 'b/silk.toml'), '[package]\nname = "b"\nversion = "0.1.0"\nsource = "src"\nexports = ["one"]\n\n[dependencies]\nd = { path = "../d" }\n')
  write(join(root, 'b/src/one.silk'), 'import d.money { cents }\n\npub fn one() -> i32 {\n  return cents()\n}\n')
  write(join(root, 'c/silk.toml'), '[package]\nname = "c"\nversion = "0.1.0"\nsource = "src"\nexports = ["two"]\n\n[dependencies]\nd = { path = "../b/../d" }\n')
  write(join(root, 'c/src/two.silk'), 'import d.money { cents }\n\npub fn two() -> i32 {\n  return cents()\n}\n')
  write(join(root, 'app/silk.toml'), '[package]\nname = "app"\nversion = "0.1.0"\n\n[dependencies]\nb = { path = "../b" }\nc = { path = "../c" }\n')
  write(join(root, 'app/src/main.silk'), 'import b.one { one }\nimport c.two { two }\n\npub fn main() -> i32 {\n  return one() - two()\n}\n')
  const result = silk(h, ['run', '--quiet'], { cwd: join(root, 'app') })
  assert.equal(result.status, 0, show(result))
})

test('a dependency reached through a symbolic link builds', { todo: 'finding 30' }, () => {
  const root = join(h.work, 'linked-dependency')
  library(root)
  symlinkSync('d', join(root, 'dlink'))
  write(join(root, 'app/silk.toml'), '[package]\nname = "app"\nversion = "0.1.0"\n\n[dependencies]\nd = { path = "../dlink" }\n')
  const result = silk(h, ['run', '--quiet'], { cwd: join(root, 'app') })
  assert.equal(result.status, 0, show(result))
})

test('a source module that is a symbolic link builds', { todo: 'finding 30' }, () => {
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
  ['called a method the type lacks', 'finding 32', 'import silk.mem.allocator { Allocator, OutOfMemoryError }\nimport silk.collections.list { List }\n\neffect fn fill() -> () ! OutOfMemoryError ? &mut Allocator {\n  let mut list = List<i32>.make()\n  run list.push(1)\n}\n\npub fn main() -> i32 {\n  return 0\n}\n', /push/],
  ['used List without importing it', 'finding 32', 'struct Tags {\n  names: List<i32>\n}\n\npub fn main() -> i32 {\n  return 0\n}\n', /List/],
  ['wrote a tuple return type', 'finding 33', 'fn pair() -> (i32, i32) {\n  return (1, 2)\n}\n\npub fn main() -> i32 {\n  return 0\n}\n', /tuple/],
  ['saved the file with a byte order mark', 'finding 34', '﻿pub fn main() -> i32 {\n  return 0\n}\n', null],
]

for (const [what, finding, source, wanted] of unclear) {
  test(`a newcomer who ${what} is told what to fix`, { todo: finding }, () => {
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
