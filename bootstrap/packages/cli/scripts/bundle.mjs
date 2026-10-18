import { writeFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

// Bundle the normal application edge after the dependency-ordered library build. In particular,
// Stdlib.generated and ToolchainIntegrity.generated must describe the same compiler distribution.
const result = await build({
  absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
  entryPoints: ['dist/bin.js'],
  outfile: 'dist/silk.mjs',
  bundle: true,
  splitting: false,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  // CommonJS dependencies may require Node builtins from inside an ESM bundle.
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  legalComments: 'inline',
  metafile: true,
  write: false,
})

// The bundle must not silently grow another asset, chunk, or runtime package dependency.
if (result.outputFiles.length !== 1) throw new Error('The CLI bundle must contain exactly one file')
for (const output of Object.values(result.metafile.outputs)) {
  for (const dependency of output.imports) {
    if (!dependency.external || !isBuiltin(dependency.path)) {
      throw new Error(`Unbundled CLI dependency: ${dependency.path}`)
    }
  }
}
for (const output of result.outputFiles) await writeFile(output.path, output.contents)
