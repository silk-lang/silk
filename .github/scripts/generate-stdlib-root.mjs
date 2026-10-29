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

// A directory is one category: every module in it names the same `@category`.
const categories = new Map()
for (const module of modules) {
  const segments = module.split('/')
  if (segments.length < 3) continue
  const header = readFileSync(`${library}${module}.silk`, 'utf8').match(/^\/\/! @category (.+)$/m)
  const category = header ? header[1] : ''
  const directory = segments[1]
  const seen = categories.get(directory)
  if (seen === undefined) categories.set(directory, { category, module })
  else if (seen.category !== category) {
    throw new Error(`${module} has category "${category}", but ${seen.module} in silk/${directory} has "${seen.category}"`)
  }
}

// These source entries depend on particular application main signatures. The selected hosted
// runtime and the existing bootstrap conformance builds exercise their compositions.
const startup = new Set([
  'silk/platform/native/start',
  'silk/platform/native/start_sync',
  'silk/platform/linux/start',
  'silk/platform/wasm/start',
  'silk/platform/wasi/start',
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
// Modules in different directories share final segments (`json.value`, `toml.value`), so a nested
// module binds its whole path below `silk`.
const importOf = (module) => {
  const segments = module.split('/').slice(1)
  const segment = segments[segments.length - 1]
  const path = module.replaceAll('/', '.')
  if (segments.length > 1) return `import ${path} as ${segments.join('_')}`
  return keywords.has(segment) ? `import ${path} as ${segment}Module` : `import ${path}`
}

const source = [
  '//! Ordinary package root that loads every standard-library module except application startup.',
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
