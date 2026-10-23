// Installing Silk the way the Install page says: the install script into an empty home.
import { strict as assert } from 'node:assert'
import { lstatSync, readlinkSync } from 'node:fs'
import { test } from 'node:test'
import { existsSync, freshHome, install, join, read, show, silk } from './lib.mjs'

test('install.sh installs a toolchain, links bin/silk and makes it the default', () => {
  const h = freshHome()
  const result = install(h)
  assert.equal(result.status, 0, show(result))
  assert.match(result.stdout, /^Installed silk v(\S+) to .*\/\.silk\/toolchains\/\S+$/m)
  const version = /^Installed silk v(\S+)/m.exec(result.stdout)[1]
  assert.match(result.stdout, /It is the default toolchain/)
  // The home's bin is not on the user's PATH yet, so the script says which line to add.
  assert.match(result.stdout, /Add Silk to your PATH by adding this line to/)

  const link = join(h.silkHome, 'bin/silk')
  assert.ok(lstatSync(link).isSymbolicLink(), 'bin/silk is a link')
  assert.equal(readlinkSync(link), join(h.silkHome, 'toolchains', version, 'bin/silk'))
  assert.ok(existsSync(join(h.silkHome, 'toolchains', version, 'lib/silk/stdlib')), 'stdlib beside the compiler')
  assert.match(read(join(h.silkHome, 'settings.toml')), new RegExp(`^default = "${version.replaceAll('+', '\\+')}"$`, 'm'))

  const reported = silk(h, ['--version'])
  assert.equal(reported.status, 0, show(reported))
  assert.equal(reported.stdout.trim(), `silk v${version}`)
})

test('running install.sh again keeps a working install', () => {
  const h = freshHome()
  assert.equal(install(h).status, 0)
  const again = install(h)
  assert.equal(again.status, 0, show(again))
  assert.equal(silk(h, ['--version']).status, 0)
  const listed = silk(h, ['toolchain', 'list'])
  assert.equal(listed.stdout.trim().split('\n').length, 1, `one toolchain after reinstalling\n${show(listed)}`)
})

test('install.sh refuses an unknown release tag and installs nothing', () => {
  const h = freshHome()
  const result = install(h, { SILK_RELEASE: 'v9.9.9' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /^silk-install: .*v9\.9\.9/m)
  assert.ok(!existsSync(join(h.silkHome, 'bin/silk')))
})

test('install.sh words a missing tag as the Install page shows', { todo: 'finding 25: prints "silk-lang/silk has no release v9.9.9"' }, () => {
  const result = install(freshHome(), { SILK_RELEASE: 'v9.9.9' })
  assert.match(result.stderr, /silk-install: cannot find release v9\.9\.9/)
})

test('install.sh rejects an unknown channel', () => {
  const h = freshHome()
  const result = install(h, { SILK_CHANNEL: 'nightly' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /SILK_CHANNEL must be auto, stable, or dev/)
})
