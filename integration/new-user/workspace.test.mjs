// The Workspaces page: one root, two members, commands from the root and from a member.
import { strict as assert } from 'node:assert'
import { before, test } from 'node:test'
import { existsSync, join, read, sharedHome, show, silk, write } from './lib.mjs'

const h = sharedHome()
let shop

before(() => {
  shop = join(h.work, 'shop')
  for (const [args, cwd] of [[['init', '--workspace', 'shop'], h.work], [['init', '--lib', 'pricing'], shop], [['init', 'store'], shop], [['add', '../pricing'], join(shop, 'store')]]) {
    const result = silk(h, args, { cwd })
    if (result.status !== 0) throw new Error(show(result))
  }
})

test('init inside a workspace registers members', () => {
  assert.equal(read(join(shop, 'silk.toml')), '[workspace]\nmembers = ["pricing", "store"]\n')
  assert.ok(existsSync(join(shop, '.gitignore')))
  assert.ok(!existsSync(join(shop, 'store/.gitignore')), 'members get no .gitignore of their own')
  assert.match(read(join(shop, 'store/silk.toml')), /\[dependencies\]\npricing = \{ path = "\.\.\/pricing" \}/)
})

test('build at the root builds every member in dependency order', () => {
  const result = silk(h, ['build'], { cwd: shop })
  assert.equal(result.status, 0, show(result))
  assert.ok(result.stderr.indexOf('Compiling pricing') < result.stderr.indexOf('Compiling store'))
  assert.match(result.stderr, /Finished pricing in /)
  assert.match(result.stderr, /Finished build\/llvm\/\S+\/debug\/store in /)
})

test('build at the root ends with a package count', () => {
  const result = silk(h, ['build'], { cwd: shop })
  assert.match(result.stderr, /Finished 2 packages in \S+\n$/)
})

test('check -p picks one member', () => {
  const result = silk(h, ['check', '-p', 'store'], { cwd: shop })
  assert.equal(result.status, 0, show(result))
  assert.doesNotMatch(result.stderr, /Checking pricing/)
  assert.match(result.stderr, /Finished 1 package in /)
})

test('a member built from inside it prints its full output path', () => {
  const result = silk(h, ['build'], { cwd: join(shop, 'store') })
  assert.equal(result.status, 0, show(result))
  assert.match(result.stderr, new RegExp(`Finished ${shop.replaceAll('.', '\\.')}/build/llvm/\\S+/debug/store in `))
})

test('test at the root runs each member and summarizes', () => {
  const result = silk(h, ['test', '--no-cache'], { cwd: shop })
  assert.equal(result.status, 0, show(result))
  assert.match(result.stdout, /Package pricing \(/)
  assert.match(result.stdout, /Package store \(/)
  assert.match(result.stdout, /Workspace summary: 2 packages succeeded, 0 failed/)
})

test('a filter that matches in one member succeeds', () => {
  const result = silk(h, ['test', '--no-cache', '--filter', 'adds'], { cwd: shop })
  assert.equal(result.status, 0, show(result))
})

test('a failing member test fails the workspace run', () => {
  const lib = join(shop, 'pricing/src/lib.silk')
  const original = read(lib)
  write(lib, `${original}\ntest effect fn wrong() -> ()\n  ! AssertionError<'static> {\n  run Testing.expect(add(2, 2) == 5, "2 + 2 is 5")\n}\n`)
  try {
    const result = silk(h, ['test', '--no-cache'], { cwd: shop })
    assert.equal(result.status, 1, show(result))
    assert.match(result.stdout, /Workspace summary: 1 package succeeded, 1 failed/)
  } finally {
    write(lib, original)
  }
})

test('format, doc and clean cover every member', () => {
  const formatted = silk(h, ['format', '--check'], { cwd: shop })
  assert.equal(formatted.status, 0, show(formatted))
  assert.match(formatted.stdout + formatted.stderr, /pricing\/src\/lib\.silk: unchanged/)
  assert.match(formatted.stdout + formatted.stderr, /store\/src\/main\.silk: unchanged/)
  const documented = silk(h, ['doc'], { cwd: shop })
  assert.equal(documented.status, 0, show(documented))
  assert.ok(existsSync(join(shop, 'build/documentation/pricing.json')))
  assert.ok(existsSync(join(shop, 'build/documentation/store.json')))
  const cleaned = silk(h, ['clean'], { cwd: shop })
  assert.equal(cleaned.status, 0)
  assert.ok(!existsSync(join(shop, 'build')))
})

test('manifest mistakes name the entry', () => {
  const manifest = join(shop, 'silk.toml')
  const original = read(manifest)
  try {
    for (const [members, message] of [
      ['["pricing", "store", "store"]', /workspace\.members entry `store` names a member that another entry already lists/],
      ['["pricing", "store", "missing"]', /workspace\.members entry `missing` names a directory without a silk\.toml/],
      ['["pricing", "store", "../elsewhere"]', /workspace\.members entry `\.\.\/elsewhere` must name a directory inside the workspace/],
    ]) {
      write(manifest, `[workspace]\nmembers = ${members}\n`)
      const result = silk(h, ['check'], { cwd: shop })
      assert.notEqual(result.status, 0)
      assert.match(result.stdout + result.stderr, message)
    }
  } finally {
    write(manifest, original)
  }
})

test('doctest and format of `.` at the root cover every member, as doc and format do', () => {
  const doctest = silk(h, ['doctest'], { cwd: shop })
  assert.doesNotMatch(doctest.stderr, /pass --manifest-path/, show(doctest))
  // Neither member has doc examples, and a run that verifies nothing exits 1 on purpose.
  assert.match(doctest.stdout, /^Package pricing\n[\s\S]*^Package store\n/m, show(doctest))
  const formatted = silk(h, ['format', '--check', '.'], { cwd: shop })
  assert.equal(formatted.status, 0, show(formatted))
})

test('silk add of a workspace root says which members it could add', () => {
  const outside = join(h.work, 'outside-app')
  assert.equal(silk(h, ['init', 'outside-app'], { cwd: h.work }).status, 0)
  const added = silk(h, ['add', shop], { cwd: outside })
  assert.notEqual(added.status, 0)
  assert.match(added.stdout + added.stderr, /workspace/, show(added))
  assert.match(added.stdout + added.stderr, /pricing/, show(added))
})
