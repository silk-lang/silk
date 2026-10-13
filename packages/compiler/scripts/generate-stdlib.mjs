import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const stdlibRoot = join(packageRoot, 'stdlib')
const manifestPath = join(stdlibRoot, 'manifest.json')
const outputPath = join(packageRoot, 'src', 'Stdlib.generated.ts')

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const canonicalModule = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/
const staticIntrinsics = new Set([
  'targetArchitecture',
  'targetOperatingSystem',
  'targetAbi',
  'targetObjectFormat',
  'targetEndianness',
  'targetPointerBits',
  'targetPointerAlignment',
  'profileText',
  'profileFlag',
  'profileContains',
])
const modules = []

const sourceLiteral = (source) => {
  const singleQuotes = [...source].filter((character) => character === "'").length
  const doubleQuotes = [...source].filter((character) => character === '"').length
  if (singleQuotes > doubleQuotes) return JSON.stringify(source)
  return `'${JSON.stringify(source).slice(1, -1).replaceAll('\\"', '"').replaceAll("'", "\\'")}'`
}

const aliasesLiteral = (aliases, inlineLimit = 80) => {
  const quoted = aliases.map((alias) => `'${alias}'`)
  const inline = `[${quoted.join(', ')}]`
  if (inline.length <= inlineLimit) return inline
  return `[\n${quoted.map((alias) => `      ${alias},`).join('\n')}\n    ]`
}

for (const [index, entry] of manifest.entries()) {
  if (
    typeof entry?.module !== 'string' ||
    typeof entry?.path !== 'string' ||
    Object.keys(entry).some((key) => !['module', 'path', 'namespace', 'aliases'].includes(key)) ||
    (entry.namespace !== undefined && typeof entry.namespace !== 'string') ||
    (entry.namespace !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.namespace)) ||
    (entry.aliases !== undefined &&
      (!Array.isArray(entry.aliases) ||
        entry.aliases.some(
          (alias) => typeof alias !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias),
        ))) ||
    !canonicalModule.test(entry.module) ||
    entry.path !== `${entry.module}.silk`
  ) {
    throw new Error(`Invalid standard-library manifest entry at index ${index}`)
  }
  if (index > 0 && manifest[index - 1].module >= entry.module) {
    throw new Error('Standard-library manifest must be strictly ordered by canonical module')
  }
  const source = await readFile(join(stdlibRoot, entry.path), 'utf8')
  const intrinsicInventory = [
    ...new Set(
      [...source.matchAll(/\bIntrinsic\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]),
    ),
  ].sort((left, right) => {
    if (left < right) return -1
    if (left > right) return 1
    return 0
  })
  const staticInventory = intrinsicInventory.filter((operation) => staticIntrinsics.has(operation))
  const runtimeInventory = intrinsicInventory.filter(
    (operation) => !staticIntrinsics.has(operation),
  )
  modules.push({
    ...entry,
    sourceIdentity: entry.module,
    digest: createHash('sha256').update(source).digest('hex'),
    documentation: entry.path,
    staticInventory,
    runtimeInventory,
    source,
  })
}

const entries = modules
  .map(
    (entry) => `  {
    module: '${entry.module}',
    path: '${entry.path}',
    sourceIdentity: '${entry.sourceIdentity}',
    digest: '${entry.digest}',
    documentation: '${entry.documentation}',
    staticInventory: ${aliasesLiteral(entry.staticInventory, 78)},
    runtimeInventory: ${aliasesLiteral(entry.runtimeInventory, 77)},
    ${entry.namespace === undefined ? '' : `namespace: '${entry.namespace}',\n    `}${entry.aliases === undefined ? '' : `aliases: ${aliasesLiteral(entry.aliases, 86)},\n    `}source:
      ${sourceLiteral(entry.source)},
  },`,
  )
  .join('\n')
const compositions = JSON.parse(await readFile(join(stdlibRoot, 'compositions.json'), 'utf8'))
const exactFields = (value, fields) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => fields.includes(key))
if (
  !exactFields(compositions, ['runtimes', 'components']) ||
  !Array.isArray(compositions.runtimes) ||
  !Array.isArray(compositions.components)
)
  throw new Error('Invalid installed composition catalog')
const knownModules = new Set(modules.map((entry) => entry.module))
const selections = new Set()
for (const runtime of compositions.runtimes) {
  if (
    !exactFields(runtime, ['targets', 'libc', 'name', 'module']) ||
    !knownModules.has(runtime.module) ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(runtime.name) ||
    !['system', 'gnu', 'none'].includes(runtime.libc) ||
    !Array.isArray(runtime.targets) ||
    runtime.targets.length === 0 ||
    runtime.targets.some((target) => typeof target !== 'string')
  )
    throw new Error('Invalid installed runtime composition')
  for (const target of runtime.targets) {
    const key = `${target}:${runtime.libc}`
    if (selections.has(key)) throw new Error(`Ambiguous installed runtime composition ${key}`)
    selections.add(key)
  }
}
for (const component of compositions.components) {
  if (
    !exactFields(component, ['capability', 'bindings']) ||
    typeof component.capability !== 'string' ||
    !Array.isArray(component.bindings)
  )
    throw new Error('Invalid installed runtime component')
  for (const binding of component.bindings)
    if (
      !exactFields(binding, ['operation', 'module', 'declaration']) ||
      !knownModules.has(binding.module) ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(binding.operation) ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(binding.declaration)
    )
      throw new Error('Invalid installed runtime component binding')
}
const runtimeEntries = compositions.runtimes
  .map(
    (runtime) => `  {
    targets: [${runtime.targets.map((target) => sourceLiteral(target)).join(', ')}],
    libc: ${sourceLiteral(runtime.libc)},
    name: ${sourceLiteral(runtime.name)},
    module: ${sourceLiteral(runtime.module)},
  },`,
  )
  .join('\n')
const componentEntries = compositions.components
  .map(
    (component) => `  {
    capability: ${sourceLiteral(component.capability)},
    bindings: [
${component.bindings
  .map(
    (binding) => `      {
        operation: ${sourceLiteral(binding.operation)},
        module: ${sourceLiteral(binding.module)},
        declaration: ${sourceLiteral(binding.declaration)},
      },`,
  )
  .join('\n')}
    ],
  },`,
  )
  .join('\n')
// The sealed Intrinsic operator source (INTR-007) is not a manifest module: nothing can import it.
const sealedModule = 'intrinsic/operators'
const sealedPath = `${sealedModule}.silk`
const sealedSource = await readFile(join(stdlibRoot, sealedPath), 'utf8')
const sealedMembers = [
  ...sealedSource.matchAll(/^pub (?:interface|enum) ([A-Za-z_][A-Za-z0-9_]*)/gm),
]
  .map((match) => match[1])
  .sort((left, right) => {
    if (left < right) return -1
    if (left > right) return 1
    return 0
  })
const sealedEntry = `export const sealed = {
  module: '${sealedModule}',
  path: '${sealedPath}',
  members: [\n${sealedMembers.map((member) => `    '${member}',`).join('\n')}\n  ],
  digest: '${createHash('sha256').update(sealedSource).digest('hex')}',
  source:
    ${sourceLiteral(sealedSource)},
} as const
`
const generated = `// Generated by scripts/generate-stdlib.mjs. Do not edit.\n\nexport const modules = [\n${entries}\n] as const\n\n${sealedEntry}\nexport const runtimeDefaults = [\n${runtimeEntries}\n] as const\n\nexport const runtimeComponents = [\n${componentEntries}\n] as const\n`
const check = process.argv.includes('--check')
const stdout = process.argv.includes('--stdout')

if (stdout) {
  process.stdout.write(generated)
} else if (check) {
  const current = await readFile(outputPath, 'utf8').catch(() => undefined)
  if (current !== generated) {
    throw new Error('Generated standard-library table is stale; run pnpm stdlib:generate')
  }
} else {
  await writeFile(outputPath, generated)
}
