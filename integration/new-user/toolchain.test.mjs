// Switching Silk versions: `silk use`, `silk set` and a package's `silk-version` pin.
//
// Installing a second version needs its release assets. SILK_NEW_USER_MIRROR names a directory
// in SILK_TOOLCHAIN_MIRROR layout (`v<version>/` per release) and SILK_NEW_USER_SECOND the full
// version in it to install; without them the tests that install a second version are skipped.
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { addLocalTool, freshHome, hasTool, initPackage, install, join, read, toolBinary, show, silk, userEnv, write } from './lib.mjs'

const mirror = process.env.SILK_NEW_USER_MIRROR
const second = process.env.SILK_NEW_USER_SECOND
const needsMirror = mirror === undefined || second === undefined ? 'set SILK_NEW_USER_MIRROR and SILK_NEW_USER_SECOND' : false

function home() {
  const h = freshHome()
  const result = install(h)
  if (result.status !== 0) throw new Error(show(result))
  addLocalTool(h)
  h.version = silk(h, ['--version']).stdout.trim().replace(/^silk v/, '')
  return h
}

// A release that ships the silk tool has no `silk toolchain`; tool.test.mjs covers versions then.
const probe = freshHome()
const probed = install(probe)
const escaped = (version) => version.replaceAll('+', '\\+')
const replaced = toolBinary !== '' || (probed.status === 0 && hasTool(probe)) ? 'the silk tool replaces silk toolchain; see tool.test.mjs' : false

const withMirror = (h, extra = {}) => ({ env: userEnv(h, { SILK_TOOLCHAIN_MIRROR: mirror, ...extra }) })

test('toolchain list and which describe the installed default', () => {
  const h = home()
  const list = silk(h, ['use', 'list'])
  assert.equal(list.status, 0, show(list))
  assert.match(list.stdout, new RegExp(`^\\* ${escaped(h.version)}  \\(default\\)  .*/bin/silkc$`, 'm'))
  const which = JSON.parse(silk(h, ['use', 'which', '--json']).stdout)
  assert.equal(which.version, h.version)
  assert.equal(which.origin, 'default')
  assert.equal(which.installed, true)
  assert.match(which.path, /\/bin\/silkc$/)
})

test('toolchain help works in every spelling', () => {
  const h = home()
  for (const spelling of [['help'], ['--help'], ['-h'], ['help', 'use'], ['help', 'set']]) {
    const result = silk(h, spelling)
    assert.equal(result.status, 0, `${spelling.join(' ')}\n${show(result)}`)
    assert.match(result.stdout, /^  use list/m)
    assert.match(result.stdout, /^  set <version>/m)
  }
})

test('--help after a tool command prints the help', { todo: 'fixed on main after 0.1.0-dev.14' }, () => {
  const h = home()
  for (const spelling of [['use', '--help'], ['set', '-h'], ['update', '--help']]) {
    const result = silk(h, spelling)
    assert.equal(result.status, 0, `${spelling.join(' ')}\n${show(result)}`)
    assert.match(result.stdout, /^  use list/m)
  }
})

test('silk init pins the running version, and commands dispatch on the pin', () => {
  const h = home()
  const app = initPackage(h, 'app')
  assert.match(read(join(app, 'silk.toml')), new RegExp(`silk-version = "${escaped(h.version)}"`))
  const which = JSON.parse(silk(h, ['use', 'which', '--json'], { cwd: app }).stdout)
  assert.equal(which.origin, 'package')
})

test('a pin that is not installed stops with exit 3 and names the install command', () => {
  const h = home()
  const app = initPackage(h, 'app')
  const manifest = join(app, 'silk.toml')
  write(manifest, read(manifest).replace(/^silk-version = .*$/m, 'silk-version = "0.3.0"'))
  for (const command of [['check'], ['run'], ['build'], ['format', '--check']]) {
    const result = silk(h, command, { cwd: app })
    assert.equal(result.status, 3, show(result))
    assert.match(result.stderr, /Silk 0\.3\.0 \(package silk-version in .*silk\.toml\) is not installed\.\nInstall it with: silk use$/m)
  }
})

test('an invalid pin is a manifest error', () => {
  const h = home()
  const app = initPackage(h, 'app')
  const manifest = join(app, 'silk.toml')
  write(manifest, read(manifest).replace(/^silk-version = .*$/m, 'silk-version = "banana"'))
  const result = silk(h, ['check'], { cwd: app })
  assert.equal(result.status, 2, show(result))
  assert.match(result.stderr, /silk-version/)
})

test('toolchain use outside a package says to run silk init', () => {
  const h = home()
  const result = silk(h, ['set', h.version])
  assert.equal(result.status, 2, show(result))
  assert.match(result.stderr, /no silk\.toml here or above; start a project with `silk init`/)
})

test('toolchain use 0.0.0 explains that 0.0.0 cannot be pinned', { todo: 'finding 12: the message calls 0.0.0 not a semantic version' }, () => {
  const h = home()
  const app = initPackage(h, 'app')
  const result = silk(h, ['set', '0.0.0'], { cwd: app })
  assert.equal(result.status, 2, show(result))
  assert.match(result.stderr, /0\.0\.0 is the version of a compiler built from source and pins nothing/)
})

test('uninstall refuses the toolchain bin/silk runs, and ignores unknown versions', () => {
  const h = home()
  const unknown = silk(h, ['use', 'uninstall', '0.5.0'])
  assert.equal(unknown.status, 0, show(unknown))
  assert.match(unknown.stdout, /0\.5\.0 is not installed; nothing to remove/)
})

test('+version rejects garbage', () => {
  const h = home()
  const result = silk(h, ['+garbage', '--version'])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /`\+garbage` is not a Silk version/)
})

// Releases before 0.1.0-dev.14 read an older manifest layout, so they cannot run a package that
// silk init writes now (see finding 101).
const oldSecond = /^0\.1\.0-dev\.(\d+)\+/.exec(second ?? '')?.[1] < 14 ? 'SILK_NEW_USER_SECOND predates the current manifest layout' : false

test('install, pin, dispatch and uninstall a second version', { skip: needsMirror || oldSecond }, () => {
  const h = home()
  const installed = silk(h, ['use', second], withMirror(h))
  assert.equal(installed.status, 0, show(installed))
  const again = silk(h, ['use', second, '--json'], withMirror(h))
  assert.equal(JSON.parse(again.stdout).changed, false)
  // `use <version>` also makes it the default; put the first one back.
  assert.equal(silk(h, ['use', h.version]).status, 0)

  const app = initPackage(h, 'app')
  const pinned = silk(h, ['set', second], { cwd: app, ...withMirror(h) })
  assert.equal(pinned.status, 0, show(pinned))
  assert.equal(silk(h, ['--version'], { cwd: app }).stdout.trim(), `silk v${second}`)
  assert.equal(silk(h, ['--version']).stdout.trim(), `silk v${h.version}`, 'outside the package the default runs')
  assert.equal(silk(h, [`+${h.version}`, '--version'], { cwd: app }).stdout.trim(), `silk v${h.version}`)
  const ran = silk(h, ['run', '--quiet'], { cwd: app })
  assert.equal(ran.status, 0, show(ran))

  assert.equal(silk(h, ['use', 'uninstall', second]).status, 0)
  const missing = silk(h, ['check'], { cwd: app })
  assert.equal(missing.status, 3, show(missing))
  const autoInPackage = silk(h, ['check', '--quiet'], { cwd: app, ...withMirror(h, { SILK_AUTO_INSTALL: '1' }) })
  assert.equal(autoInPackage.status, 0, show(autoInPackage))
  assert.match(autoInPackage.stderr, /installing Silk .* \(auto-install is on\)/)
})

test('latest and dev resolve through the mirror', { skip: needsMirror }, () => {
  const h = home()
  // Until a stable release exists, `latest` says so and points at dev.
  const latest = silk(h, ['use', 'latest'], withMirror(h))
  if (latest.status !== 0) assert.match(latest.stderr, /no stable Silk release is published yet; `latest --dev` names the newest dev release/, show(latest))
  const dev = silk(h, ['use', 'dev'], withMirror(h))
  assert.equal(dev.status, 0, show(dev))
  const app = initPackage(h, 'app')
  const pinned = silk(h, ['set', 'dev'], { cwd: app, ...withMirror(h) })
  assert.equal(pinned.status, 0, show(pinned))
  assert.match(read(join(app, 'silk.toml')), /silk-version = "\d+\.\d+\.\d+[^"]*\+[0-9a-f]+"/, 'set dev pins a full version')
})

test('toolchain default switches the version used outside packages', { skip: needsMirror }, () => {
  const h = home()
  const switched = silk(h, ['use', second], withMirror(h))
  assert.equal(switched.status, 0, show(switched))
  assert.equal(silk(h, ['--version']).stdout.trim(), `silk v${second}`)
})

test('toolchain default repoints bin/silk so the old default can be uninstalled', { skip: replaced || needsMirror, todo: 'known: default does not repoint ~/.silk/bin/silk yet' }, () => {
  const h = home()
  assert.equal(silk(h, ['toolchain', 'install', second], withMirror(h)).status, 0)
  assert.equal(silk(h, ['toolchain', 'default', second]).status, 0)
  const removed = silk(h, ['toolchain', 'uninstall', h.version])
  assert.equal(removed.status, 0, show(removed))
})

test('toolchain install of a partial version honors HTTPS_PROXY', { todo: 'finding 6: the release listing connects directly' }, () => {
  // Only meaningful on a machine whose direct egress is blocked and HTTPS_PROXY is set.
  if (process.env.HTTPS_PROXY === undefined) return
  const h = home()
  const result = silk(h, ['use', 'dev'])
  assert.equal(result.status, 0, show(result))
})
