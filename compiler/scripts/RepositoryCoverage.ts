import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as Console from 'effect/Console'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Schema from 'effect/Schema'
import * as NativeProcess from './NativeProcess.ts'

export class CoverageError extends Data.TaggedError('RepositoryCoverageError')<{
  readonly message: string
  readonly cause?: unknown
}> {}
export interface Program {
  readonly id: string
  readonly path: string
  readonly source: string
  readonly line?: number
}
export interface Outcome {
  readonly id: string
  readonly status: 'PASS' | 'UNSUPPORTED' | 'REJECTED'
  readonly codes: ReadonlyArray<string>
  readonly gaps?: ReadonlyArray<string>
}
interface Options {
  readonly repository: string
  readonly compiler: string
  readonly output: string
  readonly baseline?: boolean
}
interface Receipt {
  readonly outcomes: ReadonlyArray<Outcome>
}

const invalid = (message: string) => new CoverageError({ message })
const require = createRequire(new URL('../../packages/cli/package.json', import.meta.url))
const esbuild: typeof import('../../packages/cli/node_modules/esbuild/lib/main.js') = require('esbuild')
const hash = (source: string) => createHash('sha256').update(source.trim()).digest('hex')

/** Remove comments and quoted literals before recognizing an exported entry declaration. */
export const hasMain = (source: string) => {
  const masked = source.replace(
    /\/\/[^\n]*|\/\*[\s\S]*?\*\/|\br"""[\s\S]*?"""|"""(?:\\[\s\S]|(?!""")[\s\S])*"""|"(?:\\.|[^"\\])*"|'(?:\\(?:u\{[0-9a-f]+\}|x[0-9a-f]{2}|.)|[^'\\\r\n])'/giu,
    (text) => text.replace(/[^\n]/g, ' '),
  )
  let depth = 0
  const tokens = masked.matchAll(/\{|\}|\bpub\s+(?:effect\s+)?fn\s+main\s*\(/g)
  for (const [token] of tokens) {
    if (token === '{') depth++
    else if (token === '}') depth--
    else if (depth === 0) return true
  }
  return false
}

/** Flat, source-owned /// and //! fences; unsupported markup fails discovery rather than vanishing. */
export const docPrograms = Effect.fn('RepositoryCoverage.docPrograms')(function* (
  path: string,
  source: string,
): Effect.fn.Return<Array<Program>, CoverageError> {
  const programs: Array<Program> = []
  let fence:
    | {
        marker: string
        length: number
        prefix: string
        line: number
        active: boolean
        body: Array<string>
      }
    | undefined
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const comment = /^\s*(\/\/[/!])(?: ?)(.*)$/.exec(line)
    if (comment === null) {
      if (fence !== undefined)
        return yield* invalid(`Unclosed documentation fence: ${path}:${fence.line}`)
      continue
    }
    const text = comment[2] ?? ''
    if (fence !== undefined) {
      if (comment[1] !== fence.prefix)
        return yield* invalid(`Mixed documentation comment prefixes: ${path}:${index + 1}`)
      if (new RegExp(`^ {0,3}${fence.marker}{${fence.length},}\\s*$`).test(text)) {
        if (fence.active)
          programs.push({
            id: `${path}#doc-${programs.length + 1}`,
            path,
            line: fence.line,
            source: fence.body.join('\n') + '\n',
          })
        fence = undefined
      } else fence.body.push(text)
      continue
    }
    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text)
    if (opening !== null) {
      const marker = opening[1] ?? ''
      const info = (opening[2] ?? '').trim().split(/\s+/)
      if (info[0] === 'silk' && info.slice(1).some((attribute) => attribute !== 'ignore'))
        return yield* invalid(`Unknown documentation fence attribute: ${path}:${index + 1}`)
      fence = {
        marker: marker[0] ?? '`',
        length: marker.length,
        prefix: comment[1] ?? '//!',
        line: index + 1,
        active: info[0] === 'silk' && !info.includes('ignore'),
        body: [],
      }
    } else if (/(?:`{3,}|~{3,})silk\b/.test(text)) {
      return yield* invalid(
        `Nested documentation fence needs a discovery rule: ${path}:${index + 1}`,
      )
    }
  }
  if (fence !== undefined)
    return yield* invalid(`Unclosed documentation fence: ${path}:${fence.line}`)
  return programs
})

export const exclusion = (path: string) => {
  if (path === 'packages/compiler/test/goldens/canonical.silk')
    return 'Virtual Core.* modules in a canonicalization golden.'
  if (
    path === 'packages/compiler/test/fixtures/complete-interface-contracts/provider-equality.silk'
  )
    return 'Analysis-only fixture with a private main.'
  if (path.startsWith('openspec/'))
    return 'Archived OpenSpec evidence, including captured-resource; not a current program.'
  if (path.startsWith('compiler/src/'))
    return 'Compiler implementation and source cases; covered by self-build and native-cases.'
  if (path.startsWith('compiler/fixtures/'))
    return 'Lexer/parser input or the separately gated stdlib-root fixture.'
  if (path.startsWith('compiler/docs/')) return 'Compiler design probes; documentation evidence.'
  return undefined
}

/** Materialize the actual corpus, without building or invoking the TypeScript compiler. */
const corpusHashes = Effect.fnUntraced(function* (repository: string, temporary: string) {
  const fs = yield* FileSystem.FileSystem
  // The corpus and its fixture-reading support actors share this source directory.
  const sourceUrl = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(
    pathToFileURL(join(repository, 'packages/compiler/test/support/corpus.ts')).href,
  )
  const bundled = yield* Effect.tryPromise({
    try: () =>
      esbuild.build({
        absWorkingDir: repository,
        entryPoints: ['packages/compiler/test/support/corpus.ts'],
        bundle: true,
        platform: 'node',
        format: 'esm',
        write: false,
        define: { 'import.meta.url': sourceUrl },
        banner: {
          js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
        },
      }),
    catch: (cause) => new CoverageError({ message: 'Could not materialize the corpus', cause }),
  })
  // corpus.ts resolves its authored fixtures relative to import.meta.url, even when bundled.
  const code = bundled.outputFiles.at(0)?.text
  if (code === undefined) return yield* invalid('Corpus bundle has no output')
  const entry = join(temporary, 'corpus.mjs')
  yield* fs.writeFileString(entry, code)
  const corpus = yield* Effect.tryPromise({
    try: () => import(pathToFileURL(entry).href),
    catch: (cause) => new CoverageError({ message: 'Could not load the corpus inventory', cause }),
  })
  const sources = yield* Schema.decodeUnknownEffect(
    Schema.NonEmptyArray(Schema.Struct({ source: Schema.String })),
  )(corpus.nativeCorpus)
  return new Set(sources.map(({ source }) => hash(source)))
})

export const discover = Effect.fn('RepositoryCoverage.discover')(function* (
  repository: string,
  corpus: ReadonlySet<string>,
) {
  const fs = yield* FileSystem.FileSystem
  const tracked = yield* NativeProcess.execute('git', ['ls-files', '-z', '--', '*.silk'], {
    cwd: repository,
  })
  if (tracked.status !== 0) return yield* invalid('Could not discover tracked Silk sources')
  const files = tracked.stdout.toString('utf8').split('\0').filter(Boolean).sort()
  const programs: Array<Program> = []
  const excluded: Array<{ path: string; reason: string }> = []
  for (const path of files) {
    const source = yield* fs.readFileString(join(repository, path))
    const reason = exclusion(path)
    if (reason !== undefined) excluded.push({ path, reason })
    else if (path.startsWith('packages/compiler/stdlib/')) {
      programs.push(...(yield* docPrograms(path, source)))
      excluded.push({
        path,
        reason: 'Library module; active documentation examples are discovered separately.',
      })
    } else if (corpus.has(hash(source)))
      excluded.push({
        path,
        reason: 'Exact source already measured by the native corpus (outer whitespace ignored).',
      })
    else if (path.startsWith('packages/compiler/conformance/') || hasMain(source))
      programs.push({ id: path, path, source })
    else
      excluded.push({
        path,
        reason: 'Support module or analysis/parser fixture with no exported top-level main.',
      })
  }
  if (programs.length === 0) return yield* invalid('Discovery found no repository programs')
  return { files, programs, excluded }
})

const GapReceipt = Schema.fromJsonString(
  Schema.Struct({ gaps: Schema.NonEmptyArray(Schema.Struct({ code: Schema.NonEmptyString })) }),
)
const RejectionReceipt = Schema.fromJsonString(Schema.Struct({ code: Schema.NonEmptyString }))
const Pins = Schema.fromJsonString(Schema.NonEmptyArray(Schema.NonEmptyString))

/** Exit status and structured stderr must agree; crashes and missing receipts are harness failures. */
export const classify = Effect.fn('RepositoryCoverage.classify')(function* (
  result: NativeProcess.ProcessOutcome,
  emitted: boolean,
): Effect.fn.Return<Omit<Outcome, 'id'>, CoverageError | Schema.SchemaError> {
  if (result.signal !== null || result.deadline?.expired)
    return yield* invalid('Compiler crashed or timed out')
  const stderr = result.stderr.toString('utf8')
  const unsupported = stderr.split('\n').filter((line) => line.startsWith('SILK_UNSUPPORTED_JSON='))
  const rejected = stderr.split('\n').filter((line) => line.startsWith('SILK_BUILD_ERROR='))
  if (result.status === 0 && emitted && unsupported.length === 0 && rejected.length === 0)
    return { status: 'PASS', codes: [] }
  const gaps = yield* Effect.forEach(unsupported, (line) =>
    Schema.decodeEffect(GapReceipt)(line.slice('SILK_UNSUPPORTED_JSON='.length)),
  )
  const diagnostics = yield* Effect.forEach(rejected, (line) =>
    Schema.decodeEffect(RejectionReceipt)(line.slice('SILK_BUILD_ERROR='.length)),
  )
  const gapCodes = [...new Set(gaps.flatMap(({ gaps }) => gaps.map(({ code }) => code)))].sort(
    (left, right) => left.localeCompare(right, 'en'),
  )
  if (result.status === 2 && gapCodes.length > 0 && rejected.length === 0)
    return { status: 'UNSUPPORTED', codes: gapCodes }
  if (result.status === 1 && diagnostics.length > 0)
    return {
      status: 'REJECTED',
      codes: [...new Set(diagnostics.map(({ code }) => code))].sort((left, right) =>
        left.localeCompare(right, 'en'),
      ),
      gaps: gapCodes,
    }
  return yield* invalid(
    `Invalid compiler outcome: exit=${result.status}, emitted=${emitted}, stderr=${stderr}`,
  )
})

export const regressions = (
  programs: ReadonlyArray<{ readonly id: string }>,
  outcomes: ReadonlyArray<Outcome>,
  pins: ReadonlyArray<string>,
) => {
  const discovered = new Set(programs.map(({ id }) => id))
  const passed = new Set(outcomes.filter(({ status }) => status === 'PASS').map(({ id }) => id))
  return pins.filter((id) => !discovered.has(id) || !passed.has(id))
}

export const markdown = (receipt: Receipt) =>
  [
    '| Program | Outcome | Gap / diagnostic code |',
    '| --- | --- | --- |',
    ...receipt.outcomes.map(
      ({ id, status, codes, gaps = [] }) =>
        `| \`${id}\` | ${status} | ${[...codes, ...gaps.map((code) => `gap:${code}`)].join(', ') || '—'} |`,
    ),
  ].join('\n') + '\n'

export const run = Effect.fn('RepositoryCoverage.run')(function* ({
  repository,
  compiler,
  output,
  baseline = false,
}: Options) {
  const fs = yield* FileSystem.FileSystem
  yield* fs.makeDirectory(output, { recursive: true })
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const temporary = yield* fs.makeTempDirectoryScoped({ prefix: 'silk-repository-coverage-' })
      const corpus = yield* corpusHashes(repository, temporary)
      const inventory = yield* discover(repository, corpus)
      const tree = join(temporary, 'repository')
      // Preserve sibling module paths. Each entry receives an isolated, synthetic package manifest.
      for (const path of inventory.files) {
        const destination = join(tree, path)
        yield* fs.makeDirectory(dirname(destination), { recursive: true })
        yield* fs.copyFile(join(repository, path), destination)
      }
      const outcomes: Array<Outcome> = []
      for (const [index, program] of inventory.programs.entries()) {
        const root =
          program.line === undefined
            ? dirname(join(tree, program.path))
            : join(temporary, `doc-${index}`)
        yield* fs.makeDirectory(root, { recursive: true })
        const source =
          program.line === undefined ? join(tree, program.path) : join(root, 'main.silk')
        if (program.line !== undefined) yield* fs.writeFileString(source, program.source)
        yield* fs.writeFileString(
          join(root, 'silk.toml'),
          `[package]\nname = "repository-coverage"\nroot = ${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(basename(source))}\n`,
        )
        const ir = join(temporary, 'program.ll')
        yield* fs.remove(ir, { force: true })
        const result = yield* NativeProcess.execute(
          compiler,
          [
            'build',
            source,
            '-o',
            ir,
            '--emit',
            'llvm-ir',
            '--stdlib',
            join(repository, 'packages/compiler/stdlib'),
          ],
          { cwd: root, timeoutMs: 120000 },
        )
        yield* fs.writeFile(join(output, `${index}.stderr`), result.stderr)
        yield* fs.writeFile(join(output, `${index}.stdout`), result.stdout)
        const outcome = { id: program.id, ...(yield* classify(result, yield* fs.exists(ir))) }
        outcomes.push(outcome)
        yield* Console.log(
          `${outcome.status} ${outcome.id}${outcome.codes.length ? ` codes=${outcome.codes.join(',')}` : ''}`,
        )
      }
      const pinsPath = join(repository, 'compiler/scripts/repository-coverage-track.json')
      const pins = baseline
        ? []
        : yield* Schema.decodeEffect(Pins)(yield* fs.readFileString(pinsPath))
      if (new Set(pins).size !== pins.length)
        return yield* invalid('Duplicate repository coverage pins')
      const lost = regressions(inventory.programs, outcomes, pins)
      const revision = yield* NativeProcess.execute('git', ['rev-parse', 'HEAD'], {
        cwd: repository,
      })
      if (revision.status !== 0) return yield* invalid('Could not read the source revision')
      const receipt = {
        schemaVersion: 1,
        sourceCommit: revision.stdout.toString('utf8').trim(),
        compilerSha256: createHash('sha256')
          .update(yield* fs.readFile(compiler))
          .digest('hex'),
        emit: 'llvm-ir',
        outcomes,
        excluded: inventory.excluded,
        regressions: lost,
        summary: {
          pass: outcomes.filter(({ status }) => status === 'PASS').length,
          unsupported: outcomes.filter(({ status }) => status === 'UNSUPPORTED').length,
          rejected: outcomes.filter(({ status }) => status === 'REJECTED').length,
          track: pins.length,
        },
      }
      yield* fs.writeFileString(
        join(output, 'receipt.json'),
        (yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }))(receipt)) +
          '\n',
      )
      yield* fs.writeFileString(join(output, 'baseline.md'), markdown(receipt))
      if (baseline)
        yield* fs.writeFileString(
          join(output, 'track.json'),
          (yield* Schema.encodeEffect(
            Schema.fromJsonString(Schema.Array(Schema.NonEmptyString), { space: 2 }),
          )(outcomes.filter(({ status }) => status === 'PASS').map(({ id }) => id))) + '\n',
        )
      yield* Console.log(
        `Repository coverage: pass=${receipt.summary.pass} unsupported=${receipt.summary.unsupported} rejected=${receipt.summary.rejected} track=${receipt.summary.track}`,
      )
      if (lost.length > 0)
        return yield* invalid(`Pinned programs no longer pass or were removed: ${lost.join(', ')}`)
      return receipt
    }),
  )
})

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const {
    NodeServices,
  }: typeof import('../../packages/cli/node_modules/@effect/platform-node/dist/index.js') =
    await import(pathToFileURL(require.resolve('@effect/platform-node')).href)
  const [compiler, output, mode] = process.argv.slice(2)
  await Effect.runPromise(
    Effect.gen(function* () {
      if (!compiler || !output || (mode !== undefined && mode !== '--baseline'))
        return yield* invalid(
          'Usage: node RepositoryCoverage.ts <silkc> <output-directory> [--baseline]',
        )
      return yield* run({
        repository: resolve('.'),
        compiler: resolve(compiler),
        output: resolve(output),
        baseline: mode === '--baseline',
      })
    }).pipe(Effect.provide(NodeServices.layer)),
  )
}
