// The playground archive the docs site runs Silk from: the compiler built for wasm32-wasip1, the
// standard library, and the examples the site can build and run in a browser, with
// `manifest.json` naming the release and each example's title, target and source. Programs in the
// playground build with `--backend direct`, so the browser needs no LLVM.
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import { type Entry, ReleaseArchiveError, tar, tree } from './ReleaseArchive.ts'
import { isVersion } from './SemVer.mjs'

// Examples that log through `silk.io.logger_console` run as bare modules; the rest are WASI
// commands. An example missing here needs something a browser cannot give it, such as sockets.
const EXAMPLE_TARGETS: ReadonlyArray<readonly [string, string]> = [
  ['algorithms/breadth-first-search', 'wasm32-wasip1'],
  ['algorithms/crc-32', 'wasm32-wasip1'],
  ['algorithms/fft', 'wasm32-wasip1'],
  ['algorithms/game-of-life', 'wasm32-wasip1'],
  ['algorithms/matrix-multiplication', 'wasm32-wasip1'],
  ['algorithms/quicksort', 'wasm32-wasip1'],
  ['algorithms/sieve', 'wasm32-wasip1'],
  ['file-system', 'wasm32-wasip1'],
  ['language-pressure/lexer', 'wasm32-wasip1'],
  ['language-pressure/local-shared-slp1', 'wasm32-wasip1'],
  ['language-pressure/stack-vm', 'wasm32-wasip1'],
  ['the-conductor', 'wasm32-unknown-unknown'],
  ['warp-and-weft', 'wasm32-unknown-unknown'],
]

export interface PlaygroundOptions {
  /** The compiler built with `--target wasm32-wasip1`. */
  readonly compiler: string
  readonly standardLibrary: string
  /** The repository's `examples` directory. */
  readonly examples: string
  readonly version: string
  readonly outputDirectory: string
}

const decoder = new TextDecoder()
const encoder = new TextEncoder()

// An example's title: `title` from its example.json, or else its README's first heading.
const title = Effect.fnUntraced(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem
  const described = join(directory, 'example.json')
  if (yield* fs.exists(described)) {
    const parsed: unknown = JSON.parse(decoder.decode(yield* fs.readFile(described)))
    if (typeof parsed === 'object' && parsed !== null && 'title' in parsed && typeof parsed.title === 'string')
      return parsed.title
  }
  const readme = decoder.decode(yield* fs.readFile(join(directory, 'README.md')))
  const heading = readme.match(/^# (.+)$/m)?.[1]
  if (heading === undefined)
    return yield* new ReleaseArchiveError({ message: `${directory} has no example.json title or README heading` })
  return heading
})

/** Writes `silk-<version>-playground.tar.gz` into the output directory and answers its path. */
export const write = Effect.fn('PlaygroundArchive.write')(function* (options: PlaygroundOptions) {
  if (!isVersion(options.version))
    return yield* new ReleaseArchiveError({ message: 'Release version must be valid SemVer' })
  const fs = yield* FileSystem.FileSystem
  const top = `silk-${options.version}-playground`
  const examples: Array<{ id: string; title: string; target: string; path: string }> = []
  const sources: Array<Entry> = []
  for (const [id, target] of EXAMPLE_TARGETS) {
    const directory = join(options.examples, id)
    const path = `examples/${id}/main.silk`
    examples.push({ id, title: yield* title(directory), target, path })
    sources.push({ _tag: 'File', path: `${top}/${path}`, bytes: yield* fs.readFile(join(directory, 'main.silk')), executable: false })
  }
  const manifest = { schemaVersion: 1, version: options.version, examples }
  const entries: Array<Entry> = [
    { _tag: 'Directory', path: top },
    { _tag: 'File', path: `${top}/manifest.json`, bytes: encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`), executable: false },
    { _tag: 'File', path: `${top}/silkc.wasm`, bytes: yield* fs.readFile(options.compiler), executable: false },
    ...(yield* tree(options.standardLibrary, `${top}/stdlib`)),
    ...sources,
  ]
  const archive = tar(entries)
  if (archive === undefined)
    return yield* new ReleaseArchiveError({ message: 'Archive names, sizes, or member count exceed the format limits' })
  const path = join(options.outputDirectory, `${top}.tar.gz`)
  yield* fs.writeFile(path, gzipSync(archive, { level: 9 }), { flag: 'wx' })
  return path
})

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const usage =
    'usage: node compiler/scripts/PlaygroundArchive.ts --compiler <silkc.wasm> --stdlib <directory> --examples <directory> --version <version> --output <directory>'
  const cli = Effect.gen(function* () {
    const { values } = yield* Effect.try({
      try: () =>
        parseArgs({
          options: {
            compiler: { type: 'string' },
            stdlib: { type: 'string' },
            examples: { type: 'string' },
            output: { type: 'string' },
            version: { type: 'string' },
          },
        }),
      catch: (cause) => new ReleaseArchiveError({ message: usage, cause }),
    })
    if (!values.compiler || !values.stdlib || !values.examples || !values.output || !values.version)
      return yield* new ReleaseArchiveError({ message: usage })
    const path = yield* write({
      compiler: resolve(values.compiler),
      standardLibrary: resolve(values.stdlib),
      examples: resolve(values.examples),
      version: values.version,
      outputDirectory: resolve(values.output),
    })
    yield* Effect.sync(() => process.stdout.write(`${path}\n`))
  })
  const require = createRequire(new URL('../../package.json', import.meta.url))
  const { NodeServices }: typeof import('@effect/platform-node') = await import(
    pathToFileURL(require.resolve('@effect/platform-node')).href
  )
  await Effect.runPromise(
    cli.pipe(
      Effect.provide(NodeServices.layer),
      Effect.catch((error) =>
        Effect.sync(() => {
          process.stderr.write(`${error.message}\n`)
          process.exitCode = 1
        }),
      ),
    ),
  )
}
