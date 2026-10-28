// A new user's first hour: make a package, run it, pass arguments, check, build, test, format,
// add a dependency and grow it into a workspace. Each test follows the Get started and Projects
// pages of the docs.
import { strict as assert } from 'node:assert'
import { readdirSync } from 'node:fs'
import { test } from 'node:test'
import { existsSync, initPackage, join, read, sh, sharedHome, show, silk, write } from './lib.mjs'

const h = sharedHome()
let serial = 0
// A package name no other test in this file uses.
const fresh = (stem) => `${stem}-${++serial}`

const argumentProgram = `import silk.mem.allocator { Allocator, OutOfMemoryError }
import silk.collections.bytes { Bytes }
import silk.core.effect { Effect }
import silk.system.host_input { HostInput, HostInputError }
import silk.io.logger { LogError }
import silk.option { Option }
import silk.io.logger_native { StdoutLogger }
import silk.core.result { Result }
import silk.text.string { String, InvalidUtf8 }

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
  assert.equal(ran.stdout, 'Hello, world!', 'the program output alone is on stdout')
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
  assert.equal(own.stdout, 'Hello, world!', 'the executable runs without silk')

  const release = silk(h, ['build', '--release'], { cwd: dir })
  assert.equal(release.status, 0, show(release))
  assert.ok(existsSync(join(dir, 'build/llvm', target, 'release', name)))

  const cleaned = silk(h, ['clean'], { cwd: dir })
  assert.equal(cleaned.status, 0)
  assert.match(cleaned.stdout + cleaned.stderr, /^Removed .*\/build$/m)
  assert.ok(!existsSync(join(dir, 'build')))
})

test('silk clean with nothing to remove does not claim it removed something', { todo: 'finding 14' }, () => {
  const dir = initPackage(h, fresh('clean'))
  const result = silk(h, ['clean'], { cwd: dir })
  assert.equal(result.status, 0)
  assert.doesNotMatch(result.stdout + result.stderr, /^Removed /m)
})

test('commands outside a package say how to make one', { todo: 'finding 17: the message says "create one" without naming silk init' }, () => {
  for (const command of [['run'], ['build'], ['check']]) {
    const result = silk(h, command)
    assert.equal(result.status, 2)
    assert.match(result.stderr + result.stdout, /silk init/)
  }
})

test('silk help and silk --help', { todo: 'finding 11: silk help is an unknown command' }, () => {
  const help = silk(h, ['--help'])
  assert.equal(help.status, 0)
  const word = silk(h, ['help'])
  assert.equal(word.status, 0, show(word))
})

test('an unknown flag is named in the error', { todo: 'finding 16: the global usage is printed instead' }, () => {
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

test('silk format ends a broken parameter list with a comma', () => {
  const dir = initPackage(h, fresh('fmtcomma'))
  const main = join(dir, 'src/main.silk')
  const names = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel']
  write(main, `fn long(${names.map((n) => `${n}: i32`).join(', ')}) -> i32 { return alpha }\n\npub fn main() -> i32 {\n  return 0\n}\n`)
  const formatted = silk(h, ['format'], { cwd: dir })
  assert.equal(formatted.status, 0, show(formatted))
  assert.match(read(main), /^fn long\(\n(  [a-z]+: i32,\n){8}\) -> i32 \{\n/)
})

test('silk format keeps an arm body after a comment indented', () => {
  const dir = initPackage(h, fresh('fmtarm'))
  const main = join(dir, 'src/main.silk')
  write(main, 'pub fn main() -> i32 {\n  return match 0 {\n    0 =>\n      // zero\n      10\n    _ => 20\n  }\n}\n')
  const formatted = silk(h, ['format'], { cwd: dir })
  assert.equal(formatted.status, 0, show(formatted))
  assert.match(read(main), /    0 =>\n      \/\/ zero\n      10\n    _ => 20\n/)
})

test('silk format leaves a file with syntax errors alone', () => {
  const dir = initPackage(h, fresh('damaged'))
  write(join(dir, 'src/bad.silk'), 'fn broken( {\n')
  const result = silk(h, ['format'], { cwd: dir })
  assert.equal(result.status, 1)
  assert.match(result.stdout + result.stderr, /bad\.silk: cannot format damaged source \(PAR\d{4}\)/)
  assert.equal(read(join(dir, 'src/bad.silk')), 'fn broken( {\n')
})

test('silk format on a missing file says it is missing', { todo: 'finding 22' }, () => {
  const dir = initPackage(h, fresh('missing'))
  const result = silk(h, ['format', 'nope.silk'], { cwd: dir })
  assert.notEqual(result.status, 0)
  assert.doesNotMatch(result.stderr, /outside the package source root/)
})

test('path dependencies with silk add and silk remove', () => {
  const lib = initPackage(h, fresh('text-utils'))
  write(join(lib, 'src/lib.silk'), '/// Counts the spaces in `text`.\npub fn countSpaces(text: &[u8]) -> i32 {\n  let mut count = 0\n  let mut at: usize = 0\n  while at < text.length {\n    if text[at] == \' \' { count = count + 1 }\n    at = at + 1\n  }\n  return count\n}\n', )
  // initPackage made an executable; turn it into the library `silk init --lib` would make.
  const manifest = join(lib, 'silk.toml')
  write(manifest, read(manifest) + 'kind = "library"\nexports = ["lib"]\n')
  const app = initPackage(h, fresh('app'))
  const dependency = lib.split('/').at(-1).replaceAll('-', '_')
  const added = silk(h, ['add', `../${lib.split('/').at(-1)}`], { cwd: app })
  assert.equal(added.status, 0, show(added))
  assert.match(read(join(app, 'silk.toml')), new RegExp(`\\[dependencies\\]\\n${dependency} = \\{ path = "\\.\\./[^"]+", package = "[^"]+" \\}`))
  write(join(app, 'src/main.silk'), `import silk.core.effect { Effect }\nimport silk.io.logger { LogError }\nimport silk.io.logger_native { StdoutLogger }\nimport ${dependency}.lib { countSpaces }\n\npub effect fn main() -> ()\n  ! LogError {\n  let mut logger = StdoutLogger.make()\n  let spaces = countSpaces(b"one two three")\n  run Effect.log("{n} spaces\\n", &.{ n: spaces }) |> Effect.provideMut(&mut logger)\n}\n`)
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

test('a misspelled module path hints at the right case', { todo: 'finding 24' }, () => {
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
