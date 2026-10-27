// A new user's first hour: make a package, run it, pass arguments, check, build, test, format,
// add a dependency and grow it into a workspace. Each test follows the Get started and Projects
// pages of the docs.
import { strict as assert } from 'node:assert'
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { existsSync, here, initPackage, join, read, sh, sharedHome, show, silk, write } from './lib.mjs'

const h = sharedHome()
let serial = 0
// A package name no other test in this file uses.
const fresh = (stem) => `${stem}-${++serial}`

const argumentProgram = `import silk.allocator { Allocator, OutOfMemoryError }
import silk.bytes { Bytes }
import silk.effect { Effect }
import silk.host_input { HostInput, HostInputError }
import silk.logger { LogError }
import silk.option { Option }
import silk.os_logger { StdoutLogger }
import silk.result { Result }
import silk.string { String, InvalidUtf8 }

pub effect fn main() -> i32
  ! LogError | HostInputError | OutOfMemoryError
  ? &mut HostInput {
  let mut logger = StdoutLogger.make()
  let mut allocator = Allocator.systemAllocatorProvider()

  let first = run HostInput.argument(1) |> Effect.provideMut<Allocator>(&mut allocator)
  let name = match move first {
    Option<Bytes>.Some { value } => move value
    Option<Bytes>.None => {
      run Effect.log("usage: hello <name>\\n", &()) |> Effect.provideMut(&mut logger)
      return 2
    }
  }
  let text = match String.fromUtf8(Bytes.asSlice(&name)) {
    Result<string, InvalidUtf8>.Success { value } => value
    Result<string, InvalidUtf8>.Failure { .. } => "stranger"
  }

  run Effect.log("Hello, {name}!\\n", &.{ name: text }) |> Effect.provideMut(&mut logger)
  return 0
}
`

test('silk init makes a package that runs and prints Hello, world!', () => {
  const name = fresh('hello')
  const created = silk(h, ['init', name])
  assert.equal(created.status, 0, show(created))
  assert.match(created.stdout, new RegExp(`^Initialized Silk project ${name} at `))
  const dir = join(h.work, name)
  assert.deepEqual(readdirSync(dir).sort(), ['.gitignore', 'silk.toml', 'src'])
  assert.equal(read(join(dir, '.gitignore')), '/build/\n')
  assert.match(read(join(dir, 'silk.toml')), new RegExp(`^\\[package\\]\\nname = "${name}"\\nversion = "0.1.0"\\nsilk-version = "[^"]+"\\n$`))

  const ran = silk(h, ['run'], { cwd: dir })
  assert.equal(ran.status, 0, show(ran))
  assert.equal(ran.stdout, 'Hello, world!\n', 'the program output alone is on stdout')
  assert.match(ran.stderr, /^Compiling .*\n(  \w+ .*\n)+Finished build\/llvm\/[^/]+\/debug\/hello-\d+ in /)

  const quiet = silk(h, ['run', '--quiet'], { cwd: dir })
  assert.match(quiet.stderr, /^Finished \S+ in \S+\n$/, '--quiet keeps only the Finished line')
})

test('silk init refuses an existing package and names it', () => {
  const name = fresh('twice')
  initPackage(h, name)
  const again = silk(h, ['init', name])
  assert.equal(again.status, 2)
  assert.match(again.stdout + again.stderr, /Refusing to overwrite existing project file .*silk\.toml/)
})

test('silk init explains names it cannot use', () => {
  const digits = silk(h, ['init', '2app'])
  assert.equal(digits.status, 2)
  assert.match(digits.stdout + digits.stderr, /Cannot derive a portable package name from 2app; pass --name/)
  const spaces = silk(h, ['init', '--name', 'Bad Name', fresh('x')])
  assert.equal(spaces.status, 2)
  assert.match(spaces.stdout + spaces.stderr, /must start with a lowercase letter/)
})

test('arguments after -- reach the program, and main sets the exit status', () => {
  const dir = initPackage(h, fresh('args'))
  write(join(dir, 'src/main.silk'), argumentProgram)
  const greeted = silk(h, ['run', '--quiet', '--', 'Ada'], { cwd: dir })
  assert.equal(greeted.status, 0, show(greeted))
  assert.equal(greeted.stdout, 'Hello, Ada!\n')
  const flag = silk(h, ['run', '--quiet', '--', '--release'], { cwd: dir })
  assert.equal(flag.stdout, 'Hello, --release!\n', 'an argument that looks like a flag still reaches the program')
  const usage = silk(h, ['run', '--quiet'], { cwd: dir })
  assert.equal(usage.status, 2)
  assert.equal(usage.stdout, 'usage: hello <name>\n')
})

test('silk check, build, build --release and clean', () => {
  const name = fresh('steps')
  const dir = initPackage(h, name)
  const checked = silk(h, ['check'], { cwd: dir })
  assert.equal(checked.status, 0, show(checked))
  assert.match(checked.stderr, new RegExp(`^Checking ${name} \\(`))
  assert.match(checked.stderr, new RegExp(`Finished ${name} in `))

  const built = silk(h, ['build'], { cwd: dir })
  assert.equal(built.status, 0, show(built))
  const target = /\((\S+), debug\)/.exec(built.stderr)[1]
  const exe = join(dir, 'build/llvm', target, 'debug', name)
  assert.ok(existsSync(exe), 'the executable is where the Finished line says')
  assert.ok(existsSync(`${exe}.symbols`))
  const own = sh(h, `'${exe}'`)
  assert.equal(own.stdout, 'Hello, world!\n', 'the executable runs without silk')

  const release = silk(h, ['build', '--release'], { cwd: dir })
  assert.equal(release.status, 0, show(release))
  assert.ok(existsSync(join(dir, 'build/llvm', target, 'release', name)))

  const cleaned = silk(h, ['clean'], { cwd: dir })
  assert.equal(cleaned.status, 0)
  assert.match(cleaned.stdout + cleaned.stderr, /^Removed .*\/build$/m)
  assert.ok(!existsSync(join(dir, 'build')))
})

test('silk clean with nothing to remove does not claim it removed something', () => {
  const dir = initPackage(h, fresh('clean'))
  const result = silk(h, ['clean'], { cwd: dir })
  assert.equal(result.status, 0)
  assert.doesNotMatch(result.stdout + result.stderr, /^Removed /m)
})

test('commands outside a package say how to make one', () => {
  for (const command of [['run'], ['build'], ['check']]) {
    const result = silk(h, command)
    assert.equal(result.status, 2)
    assert.match(result.stderr + result.stdout, /silk init/)
  }
})

test('silk help and silk --help', () => {
  const help = silk(h, ['--help'])
  assert.equal(help.status, 0)
  const word = silk(h, ['help'])
  assert.equal(word.status, 0, show(word))
})

test('an unknown flag is named in the error', () => {
  const dir = initPackage(h, fresh('flags'))
  for (const [command, flag] of [['check', '--relase'], ['build', '--bogus'], ['run', '--bogus'], ['test', '--filtr']]) {
    const result = silk(h, [command, flag], { cwd: dir })
    assert.equal(result.status, 2)
    assert.match(result.stderr, new RegExp(flag), `${command} ${flag}\n${show(result)}`)
    assert.ok(result.stderr.split('\n').length < 6, `a short error, not the whole usage\n${result.stderr}`)
  }
})

test('silk format fixes layout and --check reports it', () => {
  const dir = initPackage(h, fresh('fmt'))
  const main = join(dir, 'src/main.silk')
  write(main, 'fn   add(a:i32,b:i32)->i32{return a+b}\npub fn main() -> i32 {\n    return add(1,2) - 3\n}\n')
  const check = silk(h, ['format', '--check'], { cwd: dir })
  assert.equal(check.status, 1, show(check))
  assert.match(check.stdout + check.stderr, /main\.silk: needs formatting/)
  const formatted = silk(h, ['format'], { cwd: dir })
  assert.equal(formatted.status, 0, show(formatted))
  assert.equal(read(main), 'fn add(a: i32, b: i32) -> i32 {\n  return a + b\n}\n\npub fn main() -> i32 {\n  return add(1, 2) - 3\n}\n')
  assert.equal(silk(h, ['format', '--check'], { cwd: dir }).status, 0)
})

test('silk format leaves a file with syntax errors alone', () => {
  const dir = initPackage(h, fresh('damaged'))
  write(join(dir, 'src/bad.silk'), 'fn broken( {\n')
  const result = silk(h, ['format'], { cwd: dir })
  assert.equal(result.status, 1)
  assert.match(result.stdout + result.stderr, /bad\.silk: cannot format damaged source \(PAR\d{4}\)/)
  assert.equal(read(join(dir, 'src/bad.silk')), 'fn broken( {\n')
})

test('silk format on a missing file says it is missing', () => {
  const dir = initPackage(h, fresh('missing'))
  const result = silk(h, ['format', 'nope.silk'], { cwd: dir })
  assert.notEqual(result.status, 0)
  assert.doesNotMatch(result.stderr, /outside the package source root/)
})

test('path dependencies with silk add and silk remove', () => {
  const lib = initPackage(h, fresh('text-utils'), ['--lib'])
  write(join(lib, 'src/lib.silk'), '/// Counts the spaces in `text`.\npub fn countSpaces(text: &[u8]) -> i32 {\n  let mut count = 0\n  let mut at: usize = 0\n  while at < text.length {\n    if text[at] == \' \' { count = count + 1 }\n    at = at + 1\n  }\n  return count\n}\n')
  const app = initPackage(h, fresh('app'))
  const dependency = lib.split('/').at(-1).replaceAll('-', '_')
  const added = silk(h, ['add', `../${lib.split('/').at(-1)}`], { cwd: app })
  assert.equal(added.status, 0, show(added))
  assert.match(read(join(app, 'silk.toml')), new RegExp(`\\[dependencies\\]\\n${dependency} = \\{ path = "\\.\\./[^"]+", package = "[^"]+" \\}`))
  write(join(app, 'src/main.silk'), `import silk.effect { Effect }\nimport silk.logger { LogError }\nimport silk.os_logger { StdoutLogger }\nimport ${dependency}.lib { countSpaces }\n\npub effect fn main() -> ()\n  ! LogError {\n  let mut logger = StdoutLogger.make()\n  let spaces = countSpaces(b"one two three")\n  run Effect.log("{n} spaces\\n", &.{ n: spaces }) |> Effect.provideMut(&mut logger)\n}\n`)
  const ran = silk(h, ['run', '--quiet'], { cwd: app })
  assert.equal(ran.status, 0, show(ran))
  assert.equal(ran.stdout, '2 spaces\n')

  const twice = silk(h, ['add', `../${lib.split('/').at(-1)}`], { cwd: app })
  assert.equal(twice.status, 2)
  assert.match(twice.stderr, /already has a dependency of that name/)
  const removed = silk(h, ['remove', dependency], { cwd: app })
  assert.equal(removed.status, 0, show(removed))
  assert.doesNotMatch(read(join(app, 'silk.toml')), /\[dependencies\]/)
  const gone = silk(h, ['remove', dependency], { cwd: app })
  assert.equal(gone.status, 2)
  assert.match(gone.stderr, /has no dependency of that name/)
})

test('modules in subfolders import by path', () => {
  const dir = initPackage(h, fresh('modules'))
  write(join(dir, 'src/util/Math.silk'), 'pub fn twice(x: i32) -> i32 { return x * 2 }\n')
  write(join(dir, 'src/main.silk'), 'import util.Math { twice }\npub fn main() -> i32 { return twice(21) }\n')
  const ran = silk(h, ['run', '--quiet'], { cwd: dir })
  assert.equal(ran.status, 42, show(ran))
})

test('a misspelled module path hints at the right case', () => {
  const dir = initPackage(h, fresh('casing'))
  write(join(dir, 'src/util/Math.silk'), 'pub fn twice(x: i32) -> i32 { return x * 2 }\n')
  write(join(dir, 'src/main.silk'), 'import util.math { twice }\npub fn main() -> i32 { return twice(21) }\n')
  const result = silk(h, ['check'], { cwd: dir })
  assert.match(result.stderr, /util\.Math/)
})

test('runtime traps report the kind and place and exit 132', () => {
  const dir = initPackage(h, fresh('trap'))
  for (const [body, kind] of [
    ['let a: i32 = 2147483647\n  return a + 1', 'arithmetic overflow'],
    ['let z = 0\n  return 10 / z', 'division by zero'],
    ['let v: [i32; 2] = [1, 2]\n  let mut i: usize = 3\n  return v[i]', 'index out of bounds'],
  ]) {
    write(join(dir, 'src/main.silk'), `pub fn main() -> i32 {\n  ${body}\n}\n`)
    const ran = silk(h, ['run', '--quiet'], { cwd: dir })
    // `silk run` ends the way the program did: killed by SIGILL, which a shell shows as 132.
    assert.ok(ran.signal === 'SIGILL' || ran.status === 132, show(ran))
    assert.match(ran.stderr, new RegExp(`fatal trap: ${kind}\\n  at main\\.main \\(main:\\d+:\\d+\\)`))
  }
})

// A library with one error that only shows when the app calls into it, and one in a function nobody
// calls. Both are the library's errors and belong to its file.
function brokenDependency(stem) {
  const lib = initPackage(h, fresh(`${stem}-lib`), ['--lib'])
  write(join(lib, 'src/lib.silk'), 'pub fn sum(a: i32, b: i32) -> i32 {\n  let s = a + b\n  return s == 1\n}\n\nfn unused() -> i32 {\n  return true\n}\n')
  const app = initPackage(h, fresh(`${stem}-app`))
  const name = lib.split('/').at(-1)
  const added = silk(h, ['add', `../${name}`], { cwd: app })
  assert.equal(added.status, 0, show(added))
  const dependency = name.replaceAll('-', '_')
  write(join(app, 'src/main.silk'), `import ${dependency}.lib { sum }\n\npub fn main() -> i32 {\n  return sum(40, 2)\n}\n`)
  return { lib, app }
}

test('an error inside a dependency is reported in the dependency file', () => {
  const { app } = brokenDependency('dep-error')
  const checked = silk(h, ['check'], { cwd: app })
  assert.notEqual(checked.status, 0, show(checked))
  assert.match(checked.stderr, /lib\.silk:3:\d+: error\[SEM0129\]/, show(checked))
  assert.doesNotMatch(checked.stderr, /main\.silk:4/, show(checked))
})

test('an error in a dependency function the app does not call still fails the build', () => {
  const { lib, app } = brokenDependency('dep-unused')
  write(join(lib, 'src/lib.silk'), read(join(lib, 'src/lib.silk')).replace('return s == 1', 'return s'))
  const checked = silk(h, ['check'], { cwd: app })
  assert.notEqual(checked.status, 0, show(checked))
  assert.match(checked.stderr, /lib\.silk:7:\d+: error\[SEM0129\]/, show(checked))
})

test('List.get past the end traps with its reason at the caller', () => {
  const dir = initPackage(h, fresh('list-get'))
  write(join(dir, 'src/main.silk'), `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.list { List }

pub effect fn main() -> i32
  ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut values = List<i32>.make()
  run List<i32>.append(&mut values, 10) |> Effect.provideMut<Allocator>(&mut allocator)
  return List<i32>.get(&values, 5)
}
`)
  const ran = silk(h, ['run', '--quiet'], { cwd: dir })
  assert.ok(ran.signal === 'SIGILL' || ran.status === 132, show(ran))
  assert.match(ran.stderr, /fatal trap: List\.get: the index is not less than the length/, show(ran))
  assert.match(ran.stderr, /at main\.main \(main:10:\d+\)/, show(ran))
})

// The install page asks for Clang 22 or newer (#2420). Each Clang found in the usual Debian and
// Ubuntu place, or named in SILK_NEW_USER_CLANGS (separated by colons), builds the same program
// when it is new enough, and an older one is refused up front with the version it found.
const clangs = (process.env.SILK_NEW_USER_CLANGS ?? '').split(':').filter((path) => path !== '')
for (const dir of existsSync('/usr/lib') ? readdirSync('/usr/lib') : []) {
  const match = /^llvm-(\d+)$/.exec(dir)
  if (match && existsSync(`/usr/lib/${dir}/bin/clang`)) clangs.push(`/usr/lib/${dir}/bin/clang`)
}
const clangMajor = (clang) => Number(/clang version (\d+)/.exec(spawnSync(clang, ['--version'], { encoding: 'utf8' }).stdout ?? '')?.[1] ?? 0)

// Finding 173, settled by #2420: Clang 18 crashed on release bitcode, so older Clangs are refused.
test('a release build works with every Clang 22 or newer, and an older Clang is refused by name', { skip: clangs.length === 0 ? 'no Clang found' : false }, () => {
  const dir = initPackage(h, fresh('clangs'))
  for (const clang of clangs) {
    const major = clangMajor(clang)
    for (const flags of [[], ['--release']]) {
      const result = silk(h, ['run', '--quiet', '--clang', clang, ...flags], { cwd: dir })
      if (major >= 22) {
        assert.equal(result.status, 0, `${clang} ${flags.join(' ')}\n${show(result)}`)
      } else {
        assert.notEqual(result.status, 0, show(result))
        assert.match(result.stderr, new RegExp(`need Clang 22 or newer, but .* is Clang ${major};`), show(result))
      }
    }
  }
})

// Finding 134: formatter layout details.
function formatted(source) {
  const dir = initPackage(h, fresh('fmt134'))
  const main = join(dir, 'src/main.silk')
  write(main, source)
  const result = silk(h, ['format'], { cwd: dir })
  assert.equal(result.status, 0, show(result))
  return read(main)
}

test('a parameter list broken one per line ends with a comma, as a short one that was already broken does', () => {
  const params = Array.from({ length: 11 }, (_, i) => `p${i}: i32`).join(', ')
  const out = formatted(`fn long(${params}) -> i32 {\n  return p0\n}\n\npub fn main() -> i32 {\n  return long(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10)\n}\n`)
  assert.match(out, /\n {2}p10: i32,\n\) -> i32/, out)
})

test('an arm body after a comment stays indented under its pattern', () => {
  const out = formatted('fn pick(n: i32) -> i32 {\n  return match n {\n    0 =>\n      // zero\n      10\n    _ => 20\n  }\n}\n\npub fn main() -> i32 {\n  return pick(1) - 20\n}\n')
  assert.match(out, /\n {4}0 =>\n {6}\/\/ zero\n {6}10\n/, out)
})

// Round 41: a small program written only from the book (chapters 7 to 9): read a file, parse it,
// and turn every failure into an exit status.
test('the CSV summarizer from programs/ handles good and bad input', () => {
  const dir = initPackage(h, fresh('csvsum'))
  write(join(dir, 'src/main.silk'), read(join(here, 'programs/csvsum.silk')))
  for (const [input, status, out] of [
    ['name,qty,price\napple,3,25\npear, 2 ,40\nfig,10,7\n', 0, '3 rows, 15 units, total 225'],
    ['name,qty,price\r\napple,3,25\r\nfig,4,2\r\n', 0, '2 rows, 7 units, total 83'],
    ['name,qty,price\napple,3,25\npear,x,40\n', 2, 'line 3 is not name,qty,price'],
    ['name,qty,price\napple,3\n', 2, 'line 2 is not name,qty,price'],
    [Buffer.from('name,qty,price\n\xff\xfe,1,1\n', 'latin1'), 3, 'data.csv is not UTF-8'],
  ]) {
    write(join(dir, 'data.csv'), input)
    const result = silk(h, ['run', '--quiet'], { cwd: dir })
    assert.equal(result.status, status, show(result))
    assert.match(result.stdout, new RegExp(out), show(result))
  }
})

// Round 42: a word-frequency counter from the book (chapters 6 and 9): HashMap, List, Order, sort.
test('the word counter from programs/ prints the top three words', () => {
  const dir = initPackage(h, fresh('words'))
  write(join(dir, 'src/main.silk'), read(join(here, 'programs/words.silk')))
  const result = silk(h, ['run', '--quiet'], { cwd: dir })
  assert.equal(result.status, 0, show(result))
  assert.equal(result.stdout, 'the 3\nand 2\ncat 2\n', show(result))
})

// Round 43: a fake SystemClock and a service of your own, tested with silk test (book chapter 8).
test('the greeting program in programs/ passes its tests under a fake clock', () => {
  const dir = initPackage(h, fresh('greet'))
  write(join(dir, 'src/main.silk'), read(join(here, 'programs/greet.silk')))
  const result = silk(h, ['test'], { cwd: dir })
  assert.equal(result.status, 0, show(result))
  assert.match(result.stdout + result.stderr, /Tests\s+4 passed, 0 failed/, show(result))
})
