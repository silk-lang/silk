// A Scoop manifest for the exact Windows ZIP being published. No placeholders or skipped hashes.
import { createRequire } from 'node:module'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import { isVersion } from './SemVer.mjs'
import { hash } from './SourceSnapshot.mjs'

export class ScoopManifestError extends Data.TaggedError('ScoopManifestError') {}

export const write = Effect.fn('ScoopManifest.write')(function* (version, archive, destination) {
  if (!isVersion(version)) return yield* new ScoopManifestError({ message: 'Invalid release version' })
  const top = `silk-${version}-x86_64-pc-windows-msvc`
  if (basename(archive) !== `${top}.zip`)
    return yield* new ScoopManifestError({ message: 'The ZIP filename must match the release version and Windows target' })
  const fs = yield* FileSystem.FileSystem
  const digest = hash(yield* fs.readFile(archive))
  const manifest = {
    version,
    description: 'The Silk compiler and toolchain manager',
    homepage: 'https://github.com/silk-lang/silk',
    license: 'MIT',
    architecture: {
      '64bit': {
        url: `https://github.com/silk-lang/silk/releases/download/v${encodeURIComponent(version)}/${encodeURIComponent(top)}.zip`,
        hash: digest,
        extract_dir: top,
      },
    },
    bin: ['bin/silk.exe', 'bin/silkc.exe'],
    notes: 'Building programs requires LLVM 22 or newer on PATH, or SILK_CLANG set to clang.exe.',
    checkver: { github: 'https://github.com/silk-lang/silk' },
    autoupdate: {
      architecture: {
        '64bit': {
          url: 'https://github.com/silk-lang/silk/releases/download/v$version/silk-$version-x86_64-pc-windows-msvc.zip',
          extract_dir: 'silk-$version-x86_64-pc-windows-msvc',
        },
      },
    },
  }
  yield* fs.writeFileString(destination, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
})

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [version, archive, destination, ...extra] = process.argv.slice(2)
  const require = createRequire(new URL('../../package.json', import.meta.url))
  const { NodeServices } = await import(pathToFileURL(require.resolve('@effect/platform-node')).href)
  const program = version && archive && destination && extra.length === 0
    ? write(version, archive, destination)
    : Effect.fail(new ScoopManifestError({ message: 'usage: node ScoopManifest.mjs <version> <Windows ZIP> <manifest.json>' }))
  await Effect.runPromise(program.pipe(Effect.provide(NodeServices.layer)))
}
