// One release archive per target: the native compiler as `bin/silkc`, the silk tool as `bin/silk`,
// and the standard library at `lib/silk/stdlib`, the layout an installed compiler finds its library
// in without `--stdlib`.
import { createRequire } from 'node:module'
import { join, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { crc32, deflateRawSync, gzipSync } from 'node:zlib'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import { isVersion } from './SemVer.mjs'

export class ReleaseArchiveError extends Data.TaggedError('ReleaseArchiveError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

/** One archive member: a directory, or a file with its bytes and whether it is executable. */
export type Entry =
  | { readonly _tag: 'Directory'; readonly path: string }
  | {
      readonly _tag: 'File'
      readonly path: string
      readonly bytes: Uint8Array
      readonly executable: boolean
    }

export interface ArchiveOptions {
  /** The native compiler executable, installed as `bin/silkc`. */
  readonly compiler: string
  /** The silk tool built from the same sources, installed as `bin/silk`. Releases without one,
   * such as the bootstrap's n0, hold only the compiler. */
  readonly tool?: string | undefined
  /** The standard-library root, installed as `lib/silk/stdlib`. */
  readonly standardLibrary: string
  /** The target triple the compiler runs on, named in the archive. */
  readonly target: string
  /** The release version, named in the archive. */
  readonly version: string
  /** An existing directory that receives a Windows .zip or Unix .tar.gz archive. */
  readonly outputDirectory: string
  /** Immutable native release metadata, embedded verbatim without executing the compiler. */
  readonly snapshot?: string | undefined
}

const encoder = new TextEncoder()

// Splits a member path into the ustar `prefix` and `name` fields (155 and 100 bytes).
const splitName = (path: string): readonly [string, string] | undefined => {
  if (encoder.encode(path).length <= 100) return ['', path]
  for (let at = path.indexOf('/'); at !== -1; at = path.indexOf('/', at + 1)) {
    const prefix = path.slice(0, at)
    const name = path.slice(at + 1)
    if (encoder.encode(prefix).length <= 155 && encoder.encode(name).length <= 100)
      return [prefix, name]
  }
  return undefined
}

const octal = (header: Uint8Array, offset: number, width: number, value: number) => {
  header.set(encoder.encode(value.toString(8).padStart(width - 1, '0')), offset)
}

// One 512-byte ustar header. Owner, group and time are zero, so equal inputs give equal bytes.
const header = (entry: Entry): Uint8Array | undefined => {
  const path = entry._tag === 'Directory' ? `${entry.path}/` : entry.path
  const split = splitName(path)
  if (split === undefined) return undefined
  const [prefix, name] = split
  const block = new Uint8Array(512)
  block.set(encoder.encode(name), 0)
  octal(block, 100, 8, entry._tag === 'File' && !entry.executable ? 0o644 : 0o755)
  octal(block, 108, 8, 0)
  octal(block, 116, 8, 0)
  octal(block, 124, 12, entry._tag === 'File' ? entry.bytes.length : 0)
  octal(block, 136, 12, 0)
  block.fill(0x20, 148, 156)
  block[156] = entry._tag === 'File' ? 0x30 : 0x35
  block.set(encoder.encode('ustar\u000000'), 257)
  block.set(encoder.encode(prefix), 345)
  const checksum = block.reduce((sum, byte) => sum + byte, 0)
  block.set(encoder.encode(`${checksum.toString(8).padStart(6, '0')}\u0000 `), 148)
  return block
}

/** Encodes members, in the given order, as one uncompressed ustar archive. */
export const tar = (entries: ReadonlyArray<Entry>): Uint8Array | undefined => {
  const blocks: Array<Uint8Array> = []
  for (const entry of entries) {
    const encoded = header(entry)
    if (encoded === undefined) return undefined
    blocks.push(encoded)
    if (entry._tag === 'File') {
      blocks.push(entry.bytes)
      const padding = (512 - (entry.bytes.length % 512)) % 512
      if (padding > 0) blocks.push(new Uint8Array(padding))
    }
  }
  blocks.push(new Uint8Array(1024))
  const archive = new Uint8Array(blocks.reduce((size, block) => size + block.length, 0))
  let at = 0
  for (const block of blocks) {
    archive.set(block, at)
    at += block.length
  }
  return archive
}

// ZIP32 with UTF-8 names, raw DEFLATE, no data descriptors, and a fixed DOS epoch.
// Keeping sizes in both headers lets ordinary Windows tools and the native installer validate it.
const zip = (entries: ReadonlyArray<Entry>): Uint8Array | undefined => {
  if (entries.length > 0xffff) return undefined
  const local: Array<Uint8Array> = []
  const central: Array<Uint8Array> = []
  let offset = 0
  let centralSize = 0
  for (const entry of entries) {
    const directory = entry._tag === 'Directory'
    const name = encoder.encode(directory ? `${entry.path}/` : entry.path)
    if (name.length > 0xffff) return undefined
    const input = entry._tag === 'File' ? entry.bytes : new Uint8Array(0)
    const content = directory ? input : deflateRawSync(input, { level: 9 })
    if (input.length > 0xffffffff || content.length > 0xffffffff) return undefined
    const checksum = crc32(input)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x800, 6)
    header.writeUInt16LE(directory ? 0 : 8, 8)
    header.writeUInt16LE(0x21, 12)
    header.writeUInt32LE(checksum, 14)
    header.writeUInt32LE(content.length, 18)
    header.writeUInt32LE(input.length, 22)
    header.writeUInt16LE(name.length, 26)
    const index = Buffer.alloc(46)
    index.writeUInt32LE(0x02014b50, 0)
    index.writeUInt16LE(20, 4)
    index.set(header.subarray(4, 30), 6)
    index.writeUInt32LE(directory ? 0x10 : 0, 38)
    index.writeUInt32LE(offset, 42)
    local.push(header, name, content)
    central.push(index, name)
    offset += header.length + name.length + content.length
    centralSize += index.length + name.length
    if (offset + centralSize + 22 > 0xffffffff) return undefined
  }
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, ...central, end])
}

// The directory and file members below `root`, as `<base>/<relative path>`, in sorted path order.
const tree = Effect.fnUntraced(function* (root: string, base: string) {
  const fs = yield* FileSystem.FileSystem
  const entries: Array<Entry> = [{ _tag: 'Directory', path: base }]
  const paths = [...(yield* fs.readDirectory(root, { recursive: true }))].sort()
  for (const path of paths) {
    const member = `${base}/${path.split(sep).join('/')}`
    const info = yield* fs.stat(join(root, path))
    if (info.type === 'Directory') entries.push({ _tag: 'Directory', path: member })
    else if (info.type === 'File')
      entries.push({
        _tag: 'File',
        path: member,
        bytes: yield* fs.readFile(join(root, path)),
        executable: false,
      })
    else
      return yield* new ReleaseArchiveError({
        message: `Standard-library entry ${path} is neither a file nor a directory`,
      })
  }
  return entries
})

/** The archive's file name and top-level directory retain the exact release version. */
export const name = (version: string, target: string) => `silk-${version}-${target}`

/** Writes the target's release archive: ZIP on Windows, gzip-compressed ustar elsewhere. */
export const write = Effect.fn('ReleaseArchive.write')(function* (options: ArchiveOptions) {
  if (!isVersion(options.version))
    return yield* new ReleaseArchiveError({ message: 'Release version must be valid SemVer' })
  const fs = yield* FileSystem.FileSystem
  const windows = options.target === 'x86_64-pc-windows-msvc'
  const executable = windows ? '.exe' : ''
  const top = name(options.version, options.target)
  const library = yield* tree(options.standardLibrary, `${top}/lib/silk/stdlib`)
  const entries: Array<Entry> = [
    { _tag: 'Directory', path: top },
    { _tag: 'Directory', path: `${top}/bin` },
    {
      _tag: 'File',
      path: `${top}/bin/silkc${executable}`,
      bytes: yield* fs.readFile(options.compiler),
      executable: true,
    },
    ...(options.tool === undefined
      ? []
      : [
          {
            _tag: 'File' as const,
            path: `${top}/bin/silk${executable}`,
            bytes: yield* fs.readFile(options.tool),
            executable: true,
          },
        ]),
    { _tag: 'Directory', path: `${top}/lib` },
    { _tag: 'Directory', path: `${top}/lib/silk` },
    ...library,
  ]
  if (options.snapshot !== undefined)
    entries.push({
      _tag: 'File',
      path: `${top}/lib/silk/changes-snapshot.toml`,
      bytes: yield* fs.readFile(options.snapshot),
      executable: false,
    })
  const compressed = yield* Effect.try({
    try: () => {
      if (windows) return zip(entries)
      const archive = tar(entries)
      return archive === undefined ? undefined : gzipSync(archive, { level: 9 })
    },
    catch: (cause) => new ReleaseArchiveError({ message: 'Cannot compress the archive', cause }),
  })
  if (compressed === undefined)
    return yield* new ReleaseArchiveError({ message: 'Archive names, sizes, or member count exceed the format limits' })
  const path = join(options.outputDirectory, `${top}.${windows ? 'zip' : 'tar.gz'}`)
  yield* fs.writeFile(path, compressed, { flag: 'wx' })
  return path
})

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const usage =
    'usage: node compiler/scripts/ReleaseArchive.ts --compiler <silkc> [--tool <silk>] --stdlib <directory> --target <triple> --output <directory> --version <version> [--snapshot <TOML-file>]'
  const cli = Effect.gen(function* () {
    const { values } = yield* Effect.try({
      try: () =>
        parseArgs({
          options: {
            compiler: { type: 'string' },
            tool: { type: 'string' },
            stdlib: { type: 'string' },
            target: { type: 'string' },
            output: { type: 'string' },
            version: { type: 'string' },
            snapshot: { type: 'string' },
          },
        }),
      catch: (cause) => new ReleaseArchiveError({ message: usage, cause }),
    })
    if (!values.compiler || !values.stdlib || !values.target || !values.output || !values.version)
      return yield* new ReleaseArchiveError({ message: usage })
    const path = yield* write({
      compiler: resolve(values.compiler),
      tool: values.tool === undefined ? undefined : resolve(values.tool),
      standardLibrary: resolve(values.stdlib),
      target: values.target,
      version: values.version,
      outputDirectory: resolve(values.output),
      snapshot: values.snapshot === undefined ? undefined : resolve(values.snapshot),
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
