import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const library = fileURLToPath(new URL('../../packages/compiler/stdlib/', import.meta.url))
const fixture = new URL('../../compiler/fixtures/stdlib-root/stdlib_check.silk', import.meta.url)
const manifest = JSON.parse(readFileSync(`${library}manifest.json`, 'utf8'))
const modules = manifest.map((entry) => entry.module)
const files = readdirSync(`${library}silk`, { recursive: true })
  .filter((name) => name.endsWith('.silk'))
  .map((name) => `silk/${name.slice(0, -'.silk'.length).replaceAll('\\', '/')}`)
  .sort()

if (
  new Set(modules).size !== modules.length ||
  files.join('\n') !== [...modules].sort().join('\n')
) {
  throw new Error('The standard-library manifest must list each silk/*.silk module exactly once')
}

// These source entries depend on particular application main signatures. The selected hosted
// runtime and the existing bootstrap conformance builds exercise their compositions.
const startup = new Set([
  'silk/native_start',
  'silk/native_start_sync',
  'silk/raw_start',
  'silk/wasm_start',
])
for (const module of startup) {
  if (!modules.includes(module)) throw new Error(`Missing startup module ${module}`)
}

// A keyword-spelled final segment cannot become the implicit binding (IMPORT-007, PAR0004).
const keywords = new Set(
  'pub struct enum union type service interface role effect fn run fail drop unsafe impl for return import as let const mut once move match if else while break continue true false'.split(
    ' ',
  ),
)
const importOf = (module) => {
  const segment = module.slice(module.lastIndexOf('/') + 1)
  const path = module.replaceAll('/', '.')
  return keywords.has(segment) ? `import ${path} as ${segment}Module` : `import ${path}`
}

const source = [
  '//! Ordinary package root that loads every standard-library module except application startup.',
  '//! Regenerate with `node .github/scripts/check-stdlib-root.mjs --write`.',
  '',
  ...modules
    .filter((module) => !startup.has(module))
    .sort()
    .map(importOf),
  '',
  'pub fn main() -> i32 { return 0 }',
  '',
].join('\n')

if (process.argv[2] === '--write' && process.argv.length === 3) {
  writeFileSync(fixture, source)
} else if (process.argv.length === 2) {
  if (readFileSync(fixture, 'utf8') !== source) {
    throw new Error('Stdlib root imports differ from the module inventory; run with --write')
  }
} else {
  throw new Error('Usage: node .github/scripts/check-stdlib-root.mjs [--write]')
}
