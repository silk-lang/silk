import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const library = fileURLToPath(new URL('../../stdlib/', import.meta.url))
const fixture = new URL('../../compiler/fixtures/stdlib-root/stdlib_check.silk', import.meta.url)
const manifest = JSON.parse(readFileSync(`${library}manifest.json`, 'utf8'))
const modules = manifest.map((entry) => entry.module)
const files = readdirSync(`${library}silk`, { recursive: true })
  .filter((name) => name.endsWith('.silk'))
  .map((name) => `silk/${name.slice(0, -'.silk'.length).replaceAll('\\', '/')}`)
  .sort()

if (
  new Set(modules).size !== modules.length ||
  files.join('\n') !==
    [...modules].sort((left, right) => Number(left > right) - Number(left < right)).join('\n')
) {
  throw new Error('The standard-library manifest must list each silk/*.silk module exactly once')
}

// These source entries depend on particular application main signatures. The selected hosted
// runtime and the existing bootstrap conformance builds exercise their compositions. The test
// runner is the application `silk test` selects: its test catalog exists only in a test build, so
// an ordinary check reports its `Intrinsic.tests()` queries (TEST-003).
const startup = new Set([
  'silk/platform/native/start',
  'silk/platform/native/start_sync',
  'silk/platform/linux/start',
  'silk/platform/wasm/start',
  'silk/platform/wasi/start',
  'silk/testing/runner',
])
for (const module of startup) {
  if (!modules.includes(module)) throw new Error(`Missing startup module ${module}`)
}

// Modules in different directories share final segments (`json.value`, `toml.value`), so each
// module binds its whole path below `silk`. The `_` prefix marks a binding nothing names, so the
// root itself reports no unused import (MOD0007) and a stdlib module's own warnings stand out.
const importOf = (module) => `import ${module.replaceAll('/', '.')} as _${module.split('/').slice(1).join('_')}`

const source = [
  '//! Ordinary package root that loads every standard-library module except application startup',
  '//! and the test runner.',
  '//! Regenerate with `node .github/scripts/generate-stdlib-root.mjs`.',
  '',
  ...modules
    .filter((module) => !startup.has(module))
    .sort()
    .map(importOf),
  '',
  'pub fn main() -> i32 { return 0 }',
  '',
].join('\n')

writeFileSync(fixture, source)
