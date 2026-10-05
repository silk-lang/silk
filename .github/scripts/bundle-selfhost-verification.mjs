import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createRequire, isBuiltin } from 'node:module'
import { relative, resolve } from 'node:path'
const { build } = createRequire(new URL('../../packages/cli/package.json', import.meta.url))(
  'esbuild',
)

// This packages the CI harness only. It never builds the TypeScript bootstrap compiler.
const repository = resolve('.')
const result = await build({
  stdin: {
    contents: `
      import * as Effect from 'effect/Effect'
      import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
      import * as NodeServices from '@effect/platform-node/NodeServices'
      import * as Verification from '../../compiler/scripts/FormatterVerification.js'
      NodeRuntime.runMain(Verification.runConfigured(process.execPath).pipe(Effect.provide(NodeServices.layer)))
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
