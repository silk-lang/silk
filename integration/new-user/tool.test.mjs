// The silk tool, the front door: `silk use` and `silk set` for Silk versions, and every other
// command forwarded to the compiler (`silkc`) of the version a directory selects. Runs when the
// installed release ships the tool, or with SILK_NEW_USER_TOOL naming a local build of tool/;
// skipped otherwise.
//
// Installing a second version needs its release assets: SILK_NEW_USER_MIRROR and
// SILK_NEW_USER_SECOND, as in toolchain.test.mjs.
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { rmSync } from 'node:fs'
import { addLocalTool, existsSync, freshHome, initPackage, install, join, read, show, silk, userEnv, write } from './lib.mjs'
import { startServer } from './lsp.mjs'

const mirror = process.env.SILK_NEW_USER_MIRROR
const second = process.env.SILK_NEW_USER_SECOND
const needsMirror = mirror === undefined || second === undefined ? 'set SILK_NEW_USER_MIRROR and SILK_NEW_USER_SECOND' : false

function home() {
  const h = freshHome()
  const result = install(h)
  if (result.status !== 0) throw new Error(show(result))
  h.tool = addLocalTool(h)
  h.version = silk(h, ['--version']).stdout.trim().replace(/^silk v/, '')
  return h
}

// One installed home decides whether these tests can run at all.
const probe = home()
const skip = probe.tool ? false : 'the installed release has no silk tool; set SILK_NEW_USER_TOOL to a local build of tool/'
const escaped = (text) => text.replace(/[.+*?^${}()|[\]\\]/g, '\\$&')
const withMirror = (h, extra = {}) => ({ env: userEnv(h, { SILK_TOOLCHAIN_MIRROR: mirror, ...extra }) })

test('silk --version reports the version this directory selects', { skip }, () => {
  const h = home()
  const reported = silk(h, ['--version'])
  assert.equal(reported.status, 0, show(reported))
  assert.match(reported.stdout, /^silk v\S+\n$/)
  assert.ok(existsSync(join(h.silkHome, 'toolchains', h.version, 'bin/silkc')) || existsSync(join(h.silkHome, 'toolchains', h.version, 'bin/silk')))
})

test('silk use list and which describe the installed default', { skip }, () => {
  const h = home()
  const list = JSON.parse(silk(h, ['use', 'list', '--json']).stdout)
  assert.equal(list.toolchains.length, 1)
  assert.equal(list.toolchains[0].version, h.version)
  assert.equal(list.toolchains[0].default, true)
  const which = JSON.parse(silk(h, ['use', 'which', '--json']).stdout)
  assert.equal(which.origin, 'default')
  assert.equal(which.installed, true)
  assert.match(silk(h, ['use', 'which']).stdout, new RegExp(`^${escaped(h.version)} \\(default in settings\\.toml\\)\\n`))
})

test('silk init pins the running version, and commands dispatch on the pin', { skip }, () => {
  const h = home()
  const created = silk(h, ['init', 'app'])
  assert.equal(created.status, 0, show(created))
  const app = join(h.work, 'app')
  assert.match(read(join(app, 'silk.toml')), new RegExp(`silk-version = "${escaped(h.version)}"`))
  const which = JSON.parse(silk(h, ['use', 'which', '--json'], { cwd: app }).stdout)
  assert.equal(which.origin, 'package')
  const result = silk(h, ['run', '--quiet'], { cwd: app })
  assert.equal(result.status, 0, show(result))
  assert.match(result.stdout, /Hello, world!/)
})

test('a pin that is not installed stops with exit 3 and says silk use', { skip }, () => {
  const h = home()
  const app = initPackage(h, 'app')
  const manifest = join(app, 'silk.toml')
  write(manifest, read(manifest).replace(/^silk-version = .*$/m, 'silk-version = "0.3.0"'))
  for (const command of [['check'], ['run'], ['build'], ['format', '--check']]) {
    {
      const result = silk(h, command, { cwd: app })
      assert.equal(result.status, 3, show(result))
      assert.match(result.stderr, /Silk 0\.3\.0 \(package silk-version in .*silk\.toml\) is not installed\.\nInstall it with: silk use\n/)
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
  assert.match(shown.params.message, /silk use/)
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

test('silk set outside a project says to start one', { skip }, () => {
  const h = home()
  const result = silk(h, ['set', h.version])
  assert.equal(result.status, 2, show(result))
  assert.match(result.stderr, /no silk\.toml here or above; start a project with `silk init`/)
})

test('silk set refuses 0.0.0 and words that are not versions, and leaves the pin alone', { skip }, () => {
  const h = home()
  const app = initPackage(h, 'app')
  const before = read(join(app, 'silk.toml'))
  const zero = silk(h, ['set', '0.0.0'], { cwd: app })
  assert.equal(zero.status, 2, show(zero))
  assert.match(zero.stderr, /0\.0\.0 is the version of a compiler built from source and pins nothing/)
  const banana = silk(h, ['set', 'banana'], { cwd: app })
  assert.equal(banana.status, 2, show(banana))
  assert.match(banana.stderr, /the version must be latest, dev or a semantic version/)
  assert.equal(read(join(app, 'silk.toml')), before)
})

test('+version rejects garbage and runs an installed version', { skip }, () => {
  const h = home()
  const garbage = silk(h, ['+garbage', '--version'])
  assert.equal(garbage.status, 2, show(garbage))
  assert.match(garbage.stderr, /`\+garbage` is not a Silk version/)
  const pinned = silk(h, [`+${h.version}`, '--version'])
  assert.equal(pinned.status, 0, show(pinned))
  assert.equal(pinned.stdout.trim(), `silk v${h.version}`)
})

test('silk use uninstall ignores unknown versions', { skip }, () => {
  const h = home()
  const unknown = silk(h, ['use', 'uninstall', '0.5.0'])
  assert.equal(unknown.status, 0, show(unknown))
  assert.match(unknown.stdout, /0\.5\.0 is not installed; nothing to remove/)
})

test('silk update names what it can update', { skip }, () => {
  const h = home()
  const bare = silk(h, ['update'])
  assert.equal(bare.status, 2, show(bare))
  assert.match(bare.stderr, /silk update self/)
  const compiler = silk(h, ['update', 'silk'])
  assert.equal(compiler.status, 2, show(compiler))
  assert.match(compiler.stderr, /silk use latest/)
})

test('silk help lists the version commands', { skip }, () => {
  const h = home()
  for (const spelling of [['--help'], ['-h'], ['help']]) {
    const result = silk(h, spelling)
    assert.equal(result.status, 0, show(result))
    assert.match(result.stdout, /use list \[--json\]/)
    assert.match(result.stdout, /set <version>/)
  }
})

test('the old silk toolchain command points at silk use', { skip }, () => {
  const h = home()
  const result = silk(h, ['toolchain', 'list'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /silk use/)
})

test('use a second version as the default, pin it, dispatch, and uninstall it', { skip: skip || needsMirror }, () => {
  const h = home()
  const installed = silk(h, ['use', second], withMirror(h))
  assert.equal(installed.status, 0, show(installed))
  assert.equal(silk(h, ['--version']).stdout.trim(), `silk v${second}`)
  const app = initPackage(h, 'app')
  const pinned = silk(h, ['set', h.version], { cwd: app, ...withMirror(h) })
  assert.equal(pinned.status, 0, show(pinned))
  assert.equal(silk(h, ['--version'], { cwd: app }).stdout.trim(), `silk v${h.version}`)
  assert.equal(silk(h, ['use', h.version]).status, 0)
  const removed = silk(h, ['use', 'uninstall', second])
  assert.equal(removed.status, 0, show(removed))
  assert.ok(!existsSync(join(h.silkHome, 'toolchains', second)))
})

test('a mistyped silk command is answered by the tool, with the command it meant', { skip }, () => {
  const h = home()
  const result = silk(h, ['uze', h.version])
  assert.equal(result.status, 2, show(result))
  assert.match(result.stderr, /^silk: /, show(result))
  assert.match(result.stderr, /silk use/, show(result))
  assert.doesNotMatch(result.stderr, /toolchain/, show(result))
})

test('silk use repairs an installed version whose folder lost its compiler', { skip: skip || needsMirror }, () => {
  const h = home()
  const installed = silk(h, ['use', second], withMirror(h))
  assert.equal(installed.status, 0, show(installed))
  const folder = join(h.silkHome, 'toolchains', second)
  rmSync(join(folder, existsSync(join(folder, 'bin/silkc')) ? 'bin/silkc' : 'bin/silk'))
  const missing = silk(h, [`+${second}`, '--version'], withMirror(h))
  assert.equal(missing.status, 3, show(missing))
  const repaired = silk(h, ['use', second], withMirror(h))
  assert.equal(repaired.status, 0, show(repaired))
  const ran = silk(h, [`+${second}`, '--version'], withMirror(h))
  assert.equal(ran.status, 0, show(ran))
})

test('a member pin that disagrees with the workspace pin is reported', { skip }, () => {
  const h = home()
  const created = silk(h, ['init', '--workspace', 'pins'])
  assert.equal(created.status, 0, show(created))
  const root = join(h.work, 'pins')
  const member = silk(h, ['init', 'a'], { cwd: root })
  assert.equal(member.status, 0, show(member))
  const pinned = silk(h, ['set', h.version], { cwd: root })
  assert.equal(pinned.status, 0, show(pinned))
  const manifest = join(root, 'a/silk.toml')
  write(manifest, read(manifest).replace(/^silk-version = .*$/m, 'silk-version = "0.3.0"'))
  const which = silk(h, ['use', 'which'], { cwd: join(root, 'a') })
  assert.match(`${which.stdout}${which.stderr}`, /0\.3\.0/, show(which))
})

test('a command silk set suggests after a change of version works', { skip: skip || needsMirror }, () => {
  const h = home()
  const app = initPackage(h, 'hinted')
  const set = silk(h, ['set', second], { cwd: app, ...withMirror(h) })
  assert.equal(set.status, 0, show(set))
  // Finding 88: the hint named `silk changes since`, which failed in every user project. Any
  // hint printed now must work.
  const hint = /See what changed since then: silk (change since \S+)/.exec(set.stdout + set.stderr)
  if (hint) {
    const followed = silk(h, hint[1].split(' '), { cwd: app })
    assert.equal(followed.status, 0, show(followed))
  }
})
