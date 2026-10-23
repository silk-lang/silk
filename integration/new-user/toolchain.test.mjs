// Switching Silk versions: `silk toolchain` and a package's `silk-version` pin.
//
// Installing a second version needs its release assets. SILK_NEW_USER_MIRROR names a directory
// in SILK_TOOLCHAIN_MIRROR layout (`v<version>/` per release) and SILK_NEW_USER_SECOND the full
// version in it to install; without them the tests that install a second version are skipped.
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { freshHome, hasSew, initPackage, install, join, read, sewBinary, show, silk, userEnv, write } from './lib.mjs'

const mirror = process.env.SILK_NEW_USER_MIRROR
const second = process.env.SILK_NEW_USER_SECOND
const needsMirror = mirror === undefined || second === undefined ? 'set SILK_NEW_USER_MIRROR and SILK_NEW_USER_SECOND' : false

function home() {
  const h = freshHome()
  const result = install(h)
  if (result.status !== 0) throw new Error(show(result))
  h.version = silk(h, ['--version']).stdout.trim().replace(/^silk v/, '')
  return h
}

// A release that ships sew has no `silk toolchain`; sew.test.mjs covers versions then.
const probe = freshHome()
const probed = install(probe)
const replaced = sewBinary !== '' || (probed.status === 0 && hasSew(probe)) ? 'sew replaces silk toolchain; see sew.test.mjs' : false

const withMirror = (h, extra = {}) => ({ env: userEnv(h, { SILK_TOOLCHAIN_MIRROR: mirror, ...extra }) })

test('toolchain list and which describe the installed default', { skip: replaced }, () => {
  const h = home()
  const list = silk(h, ['toolchain', 'list'])
  assert.equal(list.status, 0, show(list))
  assert.match(list.stdout, new RegExp(`^\\* ${h.version.replaceAll('+', '\\+')}  \\(default, running\\)`, 'm'))
  const which = JSON.parse(silk(h, ['toolchain', 'which', '--json']).stdout)
  assert.equal(which.version, h.version)
  assert.equal(which.origin, 'default')
  assert.equal(which.installed, true)
})

test('toolchain help works in every spelling', { skip: replaced }, () => {
  const h = home()
  for (const spelling of [['toolchain', 'help'], ['toolchain', '--help'], ['toolchain', '-h']]) {
    const result = silk(h, spelling)
    assert.equal(result.status, 0, show(result))
    assert.match(result.stdout, /usage: silk toolchain list/)
  }
})

test('silk init pins the running version, and commands dispatch on the pin', { skip: replaced }, () => {
  const h = home()
  const app = initPackage(h, 'app')
  assert.match(read(join(app, 'silk.toml')), new RegExp(`silk-version = "${h.version.replaceAll('+', '\\+')}"`))
  const which = JSON.parse(silk(h, ['toolchain', 'which', '--json'], { cwd: app }).stdout)
  assert.equal(which.origin, 'package')
})

test('a pin that is not installed stops with exit 3 and names the install command', { skip: replaced }, () => {
  const h = home()
  const app = initPackage(h, 'app')
  const manifest = join(app, 'silk.toml')
  write(manifest, read(manifest).replace(/^silk-version = .*$/m, 'silk-version = "0.3.0"'))
  for (const command of [['check'], ['run'], ['build'], ['format', '--check']]) {
    const result = silk(h, command, { cwd: app })
    assert.equal(result.status, 3, show(result))
    assert.match(result.stderr, /Silk 0\.3\.0 \(package silk-version in .*silk\.toml\) is not installed\.\nInstall it with: silk toolchain install 0\.3\.0/)
  }
})

test('an invalid pin is a manifest error', { skip: replaced }, () => {
  const h = home()
  const app = initPackage(h, 'app')
  const manifest = join(app, 'silk.toml')
  write(manifest, read(manifest).replace(/^silk-version = .*$/m, 'silk-version = "banana"'))
  const result = silk(h, ['check'], { cwd: app })
  assert.equal(result.status, 2, show(result))
  assert.match(result.stderr, /package\.silk-version must be a valid semantic version/)
})

test('toolchain use outside a package says to run silk init', { skip: replaced }, () => {
  const h = home()
  const result = silk(h, ['toolchain', 'use', h.version])
  assert.equal(result.status, 1, show(result))
  assert.match(result.stderr, /no silk\.toml here or above; run `silk init` first/)
})

test('toolchain use 0.0.0 explains that 0.0.0 cannot be pinned', { skip: replaced, todo: 'finding 12: the message calls 0.0.0 not a semantic version' }, () => {
  const h = home()
  const app = initPackage(h, 'app')
  const result = silk(h, ['toolchain', 'use', '0.0.0'], { cwd: app })
  assert.notEqual(result.status, 0)
  assert.doesNotMatch(result.stderr, /must be latest, dev or a semantic version/)
  assert.match(result.stderr, /0\.0\.0/)
})

test('uninstall refuses the toolchain bin/silk runs, and ignores unknown versions', { skip: replaced }, () => {
  const h = home()
  const refused = silk(h, ['toolchain', 'uninstall', h.version])
  assert.equal(refused.status, 1, show(refused))
  const unknown = silk(h, ['toolchain', 'uninstall', '0.5.0'])
  assert.equal(unknown.status, 0, show(unknown))
  assert.match(unknown.stdout, /0\.5\.0 is not installed; nothing to remove/)
})

test('+version rejects garbage', { skip: replaced }, () => {
  const h = home()
  const result = silk(h, ['+garbage', '--version'])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /`\+garbage` is not a Silk version/)
})

test('install, pin, dispatch and uninstall a second version', { skip: replaced || needsMirror }, () => {
  const h = home()
  const installed = silk(h, ['toolchain', 'install', second], withMirror(h))
  assert.equal(installed.status, 0, show(installed))
  const again = silk(h, ['toolchain', 'install', second, '--json'], withMirror(h))
  assert.equal(JSON.parse(again.stdout).changed, false)

  const app = initPackage(h, 'app')
  const pinned = silk(h, ['toolchain', 'use', second], { cwd: app, ...withMirror(h) })
  assert.equal(pinned.status, 0, show(pinned))
  assert.equal(silk(h, ['--version'], { cwd: app }).stdout.trim(), `silk v${second}`)
  assert.equal(silk(h, ['--version']).stdout.trim(), `silk v${h.version}`, 'outside the package the default runs')
  assert.equal(silk(h, [`+${h.version}`, '--version'], { cwd: app }).stdout.trim(), `silk v${h.version}`)
  const ran = silk(h, ['run', '--quiet'], { cwd: app })
  assert.equal(ran.status, 0, show(ran))

  assert.equal(silk(h, ['toolchain', 'uninstall', second]).status, 0)
  const missing = silk(h, ['check'], { cwd: app })
  assert.equal(missing.status, 3, show(missing))
  const autoInPackage = silk(h, ['check', '--quiet'], { cwd: app, ...withMirror(h, { SILK_AUTO_INSTALL: '1' }) })
  assert.equal(autoInPackage.status, 0, show(autoInPackage))
  assert.match(autoInPackage.stderr, /installing Silk .* \(auto-install is on\)/)
})

test('latest and dev resolve through the mirror', { skip: replaced || needsMirror }, () => {
  const h = home()
  for (const alias of ['latest', 'dev']) {
    const result = silk(h, ['toolchain', 'install', alias], withMirror(h))
    assert.equal(result.status, 0, show(result))
  }
  const app = initPackage(h, 'app')
  const pinned = silk(h, ['toolchain', 'use', 'latest'], { cwd: app, ...withMirror(h) })
  assert.equal(pinned.status, 0, show(pinned))
  assert.match(read(join(app, 'silk.toml')), /silk-version = "\d+\.\d+\.\d+[^"]*\+[0-9a-f]+"/, 'use latest pins a full version')
})

test('toolchain default switches the version used outside packages', { skip: replaced || needsMirror }, () => {
  const h = home()
  assert.equal(silk(h, ['toolchain', 'install', second], withMirror(h)).status, 0)
  const switched = silk(h, ['toolchain', 'default', second])
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

test('toolchain install of a partial version honors HTTPS_PROXY', { skip: replaced, todo: 'finding 6: the release listing connects directly' }, () => {
  // Only meaningful on a machine whose direct egress is blocked and HTTPS_PROXY is set.
  if (process.env.HTTPS_PROXY === undefined) return
  const h = home()
  const result = silk(h, ['toolchain', 'install', 'latest'])
  assert.equal(result.status, 0, show(result))
})
