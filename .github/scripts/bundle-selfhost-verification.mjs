import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createRequire, isBuiltin } from 'node:module'
import { relative, resolve } from 'node:path'
const { build } = createRequire(new URL('../../packages/cli/package.json', import.meta.url))(
  'esbuild',
)

// Publish reusable verification tooling from main; consumer feature promises stay in its checkout.
const repository = resolve('.')
const result = await build({
  stdin: {
    contents: `
      import { realpathSync } from 'node:fs'
      import { pathToFileURL } from 'node:url'
      import * as Effect from 'effect/Effect'
      import * as Console from 'effect/Console'
      import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
      import * as NodeServices from '@effect/platform-node/NodeServices'
      import * as Verification from '../../compiler/scripts/FormatterVerification.js'
      import * as CorpusVerification from '../../compiler/scripts/CorpusVerification.js'
      import * as InventoryVerification from '../../compiler/scripts/InventoryVerification.js'
      export const runtimeIntrinsicNames = Verification.runtimeIntrinsicNames
      if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
        const args = process.argv.slice(2)
        let mode = args.length === 0 ? 'formatter' : undefined
        if (args.length === 2 && args[0] === '--mode') mode = args[1]
        const verification = Effect.gen(function* () {
          if (mode === 'formatter') return yield* Verification.runConfigured(process.execPath)
          if (mode === 'corpus') return yield* CorpusVerification.runConfigured()
          if (mode === 'inventory') return yield* InventoryVerification.runConfigured().pipe(
            Effect.tapError((error) => Console.error(error.message)),
          )
          if (mode === 'corpus-full') return yield* CorpusVerification.runConfigured('corpus-full')
          return yield* new CorpusVerification.VerificationError({
            operation: 'select verification mode',
            message: 'Usage: selfhost-verification.mjs [--mode formatter|corpus|corpus-full|inventory]',
            reason: { _tag: 'InvalidInput' },
          })
        })
        // Keep inventory stdout a single parseable JSON transport, including red Incomplete.
        NodeRuntime.runMain(verification.pipe(Effect.provide(NodeServices.layer)), {
          disableErrorReporting: mode === 'inventory',
        })
      }
    `,
    resolveDir: resolve('packages/compiler'),
    sourcefile: 'selfhost-verification.mjs',
    loader: 'js',
  },
  outfile: '.scratch/selfhost-verification.mjs',
  bundle: true,
  nodePaths: [resolve('packages/compiler/node_modules')],
  splitting: false,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  metafile: true,
  write: false,
  banner: {
    js: "import { createRequire as selfhostCreateRequire } from 'node:module'; import { pathToFileURL as selfhostPathToFileURL } from 'node:url'; const require = selfhostCreateRequire(import.meta.url); const selfhostRepositoryUrl = selfhostPathToFileURL(process.cwd() + '/');",
  },
  plugins: [
    {
      name: 'repository-source-urls',
      setup(build) {
        build.onLoad({ filter: /\.ts$/ }, async ({ path }) => {
          if (path.includes('/node_modules/')) return undefined
          const source = await readFile(path, 'utf8')
          // Corpus fixtures and live stdlib lookups retain their original source locations when
          // the bundle is downloaded into a different checkout or directory.
          return {
            contents: source.replaceAll(
              'import.meta.url',
              `new URL(${JSON.stringify(relative(repository, path))}, selfhostRepositoryUrl).href`,
            ),
            loader: 'ts',
          }
        })
      },
    },
  ],
})
if (result.outputFiles.length !== 1) throw new Error('Expected one verification bundle')
for (const output of Object.values(result.metafile.outputs)) {
  for (const dependency of output.imports) {
    if (!dependency.external || !isBuiltin(dependency.path))
      throw new Error(`Unbundled verification dependency: ${dependency.path}`)
  }
}
await mkdir('.scratch', { recursive: true })
for (const output of result.outputFiles) await writeFile(output.path, output.contents)
