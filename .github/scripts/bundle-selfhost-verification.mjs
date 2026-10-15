import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createRequire, isBuiltin } from 'node:module'
import { relative, resolve } from 'node:path'
const { build } = createRequire(new URL('../../packages/cli/package.json', import.meta.url))(
  'esbuild',
)

// Usage: bundle-selfhost-verification.mjs [harness|inventory|all]
//
// `harness` writes `.scratch/selfhost-verification.mjs`, the formatter and corpus verification
// that selfhost CI builds from its own checkout. It must not depend on the TypeScript compiler, so
// it builds from a checkout with installed dependencies and no compiler build. `inventory` writes
// `.scratch/inventory-verification.mjs`, which captures the TypeScript bootstrap's closure and so
// needs the built compiler package. `all` (the default) writes both.
const selection = process.argv[2] ?? 'all'
if (!['harness', 'inventory', 'all'].includes(selection) || process.argv.length > 3)
  throw new Error('Usage: bundle-selfhost-verification.mjs [harness|inventory|all]')

const repository = resolve('.')

const runner = (imports, dispatch) => `
  import { realpathSync } from 'node:fs'
  import { pathToFileURL } from 'node:url'
  import * as Effect from 'effect/Effect'
  import * as Console from 'effect/Console'
  import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
  import * as NodeServices from '@effect/platform-node/NodeServices'
  ${imports}
  if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
    const args = process.argv.slice(2)
    ${dispatch}
  }
`

const harness = runner(
  `
  import * as Verification from '../../compiler/scripts/FormatterVerification.js'
  import * as CorpusVerification from '../../compiler/scripts/CorpusVerification.js'
  `,
  `
  let mode = args.length === 0 ? 'formatter' : undefined
  if (args.length === 2 && args[0] === '--mode') mode = args[1]
  const verification = Effect.gen(function* () {
    if (mode === 'formatter') return yield* Verification.runConfigured()
    if (mode === 'corpus') return yield* CorpusVerification.runConfigured()
    if (mode === 'corpus-full') return yield* CorpusVerification.runConfigured('corpus-full')
    return yield* new CorpusVerification.VerificationError({
      operation: 'select verification mode',
      message: 'Usage: selfhost-verification.mjs [--mode formatter|corpus|corpus-full]',
      reason: { _tag: 'InvalidInput' },
    })
  })
  NodeRuntime.runMain(verification.pipe(Effect.provide(NodeServices.layer)))
  `,
)

const inventory = runner(
  `
  import * as InventoryVerification from '../../compiler/scripts/InventoryVerification.js'
  `,
  `
  const verification = Effect.gen(function* () {
    if (args.length !== 2 || args[0] !== '--mode' || args[1] !== 'inventory')
      return yield* Effect.fail(new Error('Usage: inventory-verification.mjs --mode inventory'))
    return yield* InventoryVerification.runConfigured()
  }).pipe(Effect.tapError((error) => Console.error(error.message)))
  // Keep inventory stdout a single parseable JSON transport, including red Incomplete.
  NodeRuntime.runMain(verification.pipe(Effect.provide(NodeServices.layer)), {
    disableErrorReporting: true,
  })
  `,
)

const bundle = async (contents, sourcefile, outfile) => {
  const result = await build({
    stdin: { contents, resolveDir: resolve('packages/compiler'), sourcefile, loader: 'js' },
    outfile,
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
          build.onLoad({ filter: /\.m?[jt]s$/ }, async ({ path }) => {
            if (path.includes('/node_modules/')) return undefined
            const source = await readFile(path, 'utf8')
            // The corpus, its fixtures and live stdlib lookups retain their original source
            // locations when the bundle is downloaded into a different checkout or directory.
            return {
              contents: source.replaceAll(
                'import.meta.url',
                `new URL(${JSON.stringify(relative(repository, path))}, selfhostRepositoryUrl).href`,
              ),
              loader: path.endsWith('.ts') ? 'ts' : 'js',
            }
          })
        },
      },
    ],
  })
  if (result.outputFiles.length !== 1) throw new Error(`Expected one bundle for ${sourcefile}`)
  for (const output of Object.values(result.metafile.outputs)) {
    for (const dependency of output.imports) {
      if (!dependency.external || !isBuiltin(dependency.path))
        throw new Error(`Unbundled verification dependency: ${dependency.path}`)
    }
  }
  await mkdir('.scratch', { recursive: true })
  for (const output of result.outputFiles) await writeFile(output.path, output.contents)
  return Object.keys(result.metafile.inputs)
}

if (selection !== 'inventory') {
  const inputs = await bundle(
    harness,
    'selfhost-verification.mjs',
    '.scratch/selfhost-verification.mjs',
  )
  const compiler = inputs.filter(
    (input) =>
      input.startsWith('packages/compiler/src/') ||
      input.startsWith('packages/compiler/dist/') ||
      input.includes('@silklang/compiler'),
  )
  if (compiler.length > 0)
    throw new Error(
      `The selfhost harness must not depend on the TypeScript compiler: ${compiler.join(', ')}`,
    )
}
if (selection !== 'harness')
  await bundle(inventory, 'inventory-verification.mjs', '.scratch/inventory-verification.mjs')
