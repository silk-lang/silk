// One-off migration: writes every program of the TypeScript corpus to `corpus/` and checks that
// the data reloads to the same programs. Removed once the corpus is data.
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  type CorpusProgram,
  invalidGenericCorpus,
  invalidMatchCorpus,
  nativeCorpus,
} from '../test/support/corpus.js'
import {
  corpusRoot,
  expandSplices,
  formatOutcome,
  repositoryRoot,
} from '../../../corpus/corpus.mjs'

const shared: Array<{ readonly file: string; readonly text: string }> = []
const collect = (directory: string, extensions: ReadonlyArray<string>) => {
  for (const entry of readdirSync(join(repositoryRoot, directory))) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const path = join(directory, entry)
    if (statSync(join(repositoryRoot, path)).isDirectory()) collect(path, extensions)
    else if (extensions.some((extension) => entry.endsWith(extension))) {
      const text = readFileSync(join(repositoryRoot, path), 'utf8')
      if (text.length >= 64) shared.push({ file: path, text })
    }
  }
}
for (const directory of [
  'examples',
  'packages/compiler/conformance',
  'packages/compiler/test/fixtures',
  'packages/compiler/stdlib',
])
  collect(directory, ['.silk', '.c'])
// Longest first, so a file that contains another is spliced whole.
shared.sort(
  (left, right) => right.text.length - left.text.length || left.file.localeCompare(right.file),
)

const sections = [
  {
    file: 'packages/compiler/stdlib/silk/aes_gcm.silk',
    from: 'fn lengthsAdmitted(',
    to: 'fn validate(',
  },
  {
    file: 'packages/compiler/stdlib/silk/tls_hkdf.silk',
    from: 'fn sha256MessageLengthAdmitted(',
    to: 'fn validate(',
  },
  { file: 'packages/compiler/stdlib/silk/sha2.silk', declaration: 'struct Length64Transition {' },
  { file: 'packages/compiler/stdlib/silk/sha2.silk', declaration: 'fn length64Transition(' },
]

const directive = (splice: object) => `/*@splice ${JSON.stringify(splice)}*/`
const spliced: Array<string> = []

const template = (text: string, origin: string): string => {
  let result = text
  for (const candidate of shared) {
    if (result.includes(candidate.text)) {
      result = result.split(candidate.text).join(directive({ file: candidate.file }))
      spliced.push(`${origin} <- ${candidate.file}`)
    }
  }
  for (const section of sections) {
    const expanded = expandSplices(directive(section), origin)
    if (result.includes(expanded)) {
      result = result.split(expanded).join(directive(section))
      spliced.push(`${origin} <- ${section.file} ${section.from ?? section.declaration}`)
    }
  }
  if (expandSplices(result, origin) !== text)
    throw new Error(`${origin}: splices do not reproduce the source`)
  return result
}

const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

rmSync(join(corpusRoot, 'native'), { recursive: true, force: true })
rmSync(join(corpusRoot, 'invalid'), { recursive: true, force: true })

const exportNative = (program: CorpusProgram) => {
  const directory = join(corpusRoot, 'native', program.name)
  const main = program.nativeSource ?? program.source
  write(join(directory, 'main.silk'), template(main, program.name))
  if (program.nativeSource !== undefined && program.source !== program.nativeSource)
    write(join(directory, 'reference.silk'), template(program.source, `${program.name} reference`))
  for (const [module, text] of Object.entries(program.nativeImports ?? {}))
    write(join(directory, 'imports', `${module}.silk`), template(text, `${program.name} ${module}`))
  for (const [unit, text] of Object.entries(program.nativeCSources ?? {}))
    write(join(directory, 'c', `${unit}.c`), template(text, `${program.name} ${unit}`))
  if (program.nativeStdout !== undefined)
    write(join(directory, 'expected.stdout'), program.nativeStdout)
  if (program.nativeStderr !== undefined)
    write(join(directory, 'expected.stderr'), program.nativeStderr)
  const outcome: Record<string, unknown> = {
    schemaVersion: 1,
    expected:
      program.expected._tag === 'Completes'
        ? { kind: 'completes', exitCode: program.expected.result }
        : { kind: 'trap' },
  }
  if (program.nativeRuns !== undefined) outcome.runs = program.nativeRuns
  if (program.nativeProfiles !== undefined) outcome.profiles = program.nativeProfiles
  if (program.nativeDynamicLibraries !== undefined)
    outcome.dynamicLibraries = program.nativeDynamicLibraries
  if (program.nativeComponents !== undefined) outcome.components = program.nativeComponents
  write(join(directory, 'outcome.json'), formatOutcome(outcome))
}

for (const program of nativeCorpus) exportNative(program)
for (const program of [...invalidGenericCorpus, ...invalidMatchCorpus]) {
  const directory = join(corpusRoot, 'invalid', program.name)
  write(join(directory, 'main.silk'), template(program.source, program.name))
  write(
    join(directory, 'outcome.json'),
    formatOutcome({ schemaVersion: 1, expected: { kind: 'rejected', codes: program.codes } }),
  )
}
console.log(spliced.join('\n'))
console.log(
  `exported ${nativeCorpus.length} native and ${invalidGenericCorpus.length + invalidMatchCorpus.length} invalid programs`,
)
