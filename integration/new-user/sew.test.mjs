// sew, the front door: `sew use` and `sew set` for Silk versions, and `silk` as a proxy that runs
// the version a directory selects. Runs when the installed release ships sew, or with
// SILK_NEW_USER_SEW naming a local sew build; skipped otherwise.
//
// Installing a second version needs its release assets: SILK_NEW_USER_MIRROR and
// SILK_NEW_USER_SECOND, as in toolchain.test.mjs.
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { addLocalSew, existsSync, freshHome, initPackage, install, join, read, sew, show, silk, userEnv, write } from './lib.mjs'
import { startServer } from './lsp.mjs'

const mirror = process.env.SILK_NEW_USER_MIRROR
const second = process.env.SILK_NEW_USER_SECOND
const needsMirror = mirror === undefined || second === undefined ? 'set SILK_NEW_USER_MIRROR and SILK_NEW_USER_SECOND' : false

function home() {
  const h = freshHome()
  const result = install(h)
  if (result.status !== 0) throw new Error(show(result))
  h.sew = addLocalSew(h)
  h.version = silk(h, ['--version']).stdout.trim().replace(/^silk v/, '')
  return h
}

// One installed home decides whether these tests can run at all.
const probe = home()
const skip = probe.sew ? false : 'the installed release has no sew; set SILK_NEW_USER_SEW to a local build'
const escaped = (text) => text.replace(/[.+*?^${}()|[\]\\]/g, '\\$&')
const withMirror = (h, extra = {}) => ({ env: userEnv(h, { SILK_TOOLCHAIN_MIRROR: mirror, ...extra }) })

test('sew and the silk proxy both answer --version', { skip }, () => {
  const h = home()
  const own = sew(h, ['--version'])
  assert.equal(own.status, 0, show(own))
  assert.match(own.stdout, /^sew \S+\n$/)
  const compiler = silk(h, ['--version'])
  assert.equal(compiler.status, 0, show(compiler))
  assert.match(compiler.stdout, /^silk v\S+\n$/)
})

test('sew use list and which describe the installed default', { skip }, () => {
  const h = home()
  const list = JSON.parse(sew(h, ['use', 'list', '--json']).stdout)
  assert.equal(list.toolchains.length, 1)
  assert.equal(list.toolchains[0].version, h.version)
  assert.equal(list.toolchains[0].default, true)
  const which = JSON.parse(sew(h, ['use', 'which', '--json']).stdout)
  assert.equal(which.origin, 'default')
  assert.equal(which.installed, true)
  assert.match(sew(h, ['use', 'which']).stdout, new RegExp(`^${escaped(h.version)} \\(default in settings\\.toml\\)\\n`))
})

test('init through sew pins the running version, and both spellings dispatch on the pin', { skip }, () => {
  const h = home()
  const created = sew(h, ['init', 'app'])
  assert.equal(created.status, 0, show(created))
  const app = join(h.work, 'app')
  assert.match(read(join(app, 'silk.toml')), new RegExp(`silk-version = "${escaped(h.version)}"`))
  const which = JSON.parse(sew(h, ['use', 'which', '--json'], { cwd: app }).stdout)
  assert.equal(which.origin, 'package')
  for (const run of [sew, silk]) {
    const result = run(h, ['run', '--quiet'], { cwd: app })
    assert.equal(result.status, 0, show(result))
    assert.match(result.stdout, /Hello, world!/)
  }
})

test('a pin that is not installed stops with exit 3 and says sew use', { skip }, () => {
  const h = home()
  const app = initPackage(h, 'app')
  const manifest = join(app, 'silk.toml')
  write(manifest, read(manifest).replace(/^silk-version = .*$/m, 'silk-version = "0.3.0"'))
  for (const command of [['check'], ['run'], ['build'], ['format', '--check']]) {
    for (const run of [sew, silk]) {
      const result = run(h, command, { cwd: app })
      assert.equal(result.status, 3, show(result))
      assert.match(result.stderr, /Silk 0\.3\.0 \(package silk-version in .*silk\.toml\) is not installed\.\nInstall it with: sew use\n/)
    }
  }
})

test('an editor started in a project with a missing pin gets a server that explains it', { skip }, async () => {
  const h = home()
  const app = initPackage(h, 'editor-unpinned')
  const manifest = join(app, 'silk.toml')
  write(manifest, read(manifest).replace(/^silk-version = .*$/m, 'silk-version = "0.3.0"'))
  const lone = startServer(h, app)
  const init = await lone.initialize(app)
  assert.deepEqual(Object.keys(init.capabilities ?? {}), [])
  const shown = await lone.waitFor((message) => message.method === 'window/showMessage', 'showMessage')
  assert.match(shown.params.message, /0\.3\.0/)
  assert.match(shown.params.message, /sew use/)
  const exited = await lone.shutdown()
  assert.equal(exited.code, 0)
})

test('an invalid pin is a manifest error', { skip }, () => {
  const h = home()
  const app = initPackage(h, 'app')
  const manifest = join(app, 'silk.toml')
  write(manifest, read(manifest).replace(/^silk-version = .*$/m, 'silk-version = "banana"'))
  const result = silk(h, ['check'], { cwd: app })
  assert.equal(result.status, 2, show(result))
  assert.match(result.stderr, /silk-version/)
})

test('sew set outside a project says to start one', { skip }, () => {
  const h = home()
  const result = sew(h, ['set', h.version])
  assert.equal(result.status, 2, show(result))
  assert.match(result.stderr, /no silk\.toml here or above; start a project with `sew init`/)
})

test('sew set refuses 0.0.0 and words that are not versions, and leaves the pin alone', { skip }, () => {
  const h = home()
  const app = initPackage(h, 'app')
  const before = read(join(app, 'silk.toml'))
  const zero = sew(h, ['set', '0.0.0'], { cwd: app })
  assert.equal(zero.status, 2, show(zero))
  assert.match(zero.stderr, /0\.0\.0 is the version of a compiler built from source and pins nothing/)
  const banana = sew(h, ['set', 'banana'], { cwd: app })
  assert.equal(banana.status, 2, show(banana))
  assert.match(banana.stderr, /the version must be latest, dev or a semantic version/)
  assert.equal(read(join(app, 'silk.toml')), before)
})

test('+version rejects garbage and runs an installed version', { skip }, () => {
  const h = home()
  const garbage = sew(h, ['+garbage', '--version'])
  assert.equal(garbage.status, 2, show(garbage))
  assert.match(garbage.stderr, /`\+garbage` is not a Silk version/)
  const pinned = silk(h, [`+${h.version}`, '--version'])
  assert.equal(pinned.status, 0, show(pinned))
  assert.equal(pinned.stdout.trim(), `silk v${h.version}`)
})

test('sew use uninstall ignores unknown versions', { skip }, () => {
  const h = home()
  const unknown = sew(h, ['use', 'uninstall', '0.5.0'])
  assert.equal(unknown.status, 0, show(unknown))
  assert.match(unknown.stdout, /0\.5\.0 is not installed; nothing to remove/)
})

test('sew update names what it can update', { skip }, () => {
  const h = home()
  const bare = sew(h, ['update'])
  assert.equal(bare.status, 2, show(bare))
  assert.match(bare.stderr, /sew update self/)
  const compiler = sew(h, ['update', 'silk'])
  assert.equal(compiler.status, 2, show(compiler))
  assert.match(compiler.stderr, /sew use latest/)
})

test('sew help lists the version commands', { skip }, () => {
  const h = home()
  for (const spelling of [['--help'], ['-h'], ['help']]) {
    const result = sew(h, spelling)
    assert.equal(result.status, 0, show(result))
    assert.match(result.stdout, /use list \[--json\]/)
    assert.match(result.stdout, /set <version>/)
  }
})

test('the old silk toolchain command points at sew', { skip, todo: 'sew feedback: the compiler has no word about toolchain moving to sew' }, () => {
  const h = home()
  const result = silk(h, ['toolchain', 'list'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /sew use/)
})

test('use a second version as the default, pin it, dispatch, and uninstall it', { skip: skip || needsMirror }, () => {
  const h = home()
  const installed = sew(h, ['use', second], withMirror(h))
  assert.equal(installed.status, 0, show(installed))
  assert.equal(silk(h, ['--version']).stdout.trim(), `silk v${second}`)
  const app = initPackage(h, 'app')
  const pinned = sew(h, ['set', h.version], { cwd: app, ...withMirror(h) })
  assert.equal(pinned.status, 0, show(pinned))
  assert.equal(silk(h, ['--version'], { cwd: app }).stdout.trim(), `silk v${h.version}`)
  assert.equal(sew(h, ['use', h.version]).status, 0)
  const removed = sew(h, ['use', 'uninstall', second])
  assert.equal(removed.status, 0, show(removed))
  assert.ok(!existsSync(join(h.silkHome, 'toolchains', second)))
})
