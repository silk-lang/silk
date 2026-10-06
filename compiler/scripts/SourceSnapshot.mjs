// Authored inputs are exported from Git objects, never from a formatter-mutated checkout.
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Schema from 'effect/Schema'
import * as Console from 'effect/Console'
import * as NativeProcess from './NativeProcess.ts'

export class SourceSnapshotError extends Data.TaggedError('SourceSnapshotError') {}
const invalid = (message) => Effect.fail(new SourceSnapshotError({ message }))
export const roots = ['compiler', 'packages/compiler/stdlib']
export const InputSnapshotSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sourceCommit: Schema.String,
  roots: Schema.Array(Schema.String),
  files: Schema.Array(
    Schema.Struct({ path: Schema.String, mode: Schema.String, sha256: Schema.String }),
  ),
  normalizedDigest: Schema.String,
  compilerDigest: Schema.String,
  stdlibDigest: Schema.String,
  archive: Schema.String,
  archiveSha256: Schema.String,
})
/** @typedef {import('effect/Schema').Schema.Type<typeof InputSnapshotSchema>} SnapshotReceipt */
export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
export const fileDigest = (files) =>
  hash(files.map(({ path, mode, sha256 }) => `${path}\0${mode}\0${sha256}\n`).join(''))
const compare = (a, b) => {
  if (a.path < b.path) return -1
  if (a.path > b.path) return 1
  return 0
}
const git = Effect.fnUntraced(
  /** @param {string} repository @param {string[]} args */
  function* (repository, args) {
    const result = yield* NativeProcess.execute('git', args, { cwd: repository })
    if (result.status !== 0 || result.signal !== null)
      return yield* invalid(`Git snapshot operation failed: ${result.stderr.toString()}`)
    return result.stdout
  },
)
const archive = Effect.fnUntraced(
  /** @param {string[]} args @param {{cwd?:string,input?:Buffer}} options */
  function* (args, options = {}) {
    const result = yield* NativeProcess.execute('tar', args, options)
    if (result.status !== 0 || result.signal !== null)
      return yield* invalid(`Snapshot archive operation failed: ${result.stderr.toString()}`)
  },
)
const json = Schema.decodeEffect(Schema.fromJsonString(InputSnapshotSchema))

export const committedFiles = Effect.fn('SourceSnapshot.committedFiles')(
  /** @param {string} repository @param {string} revision @param {string[]} paths */
  function* (repository, revision, paths = roots) {
    const listing = yield* git(repository, ['ls-tree', '-r', '-z', revision, '--', ...paths])
    const files = []
    for (const entry of listing.toString().split('\0').filter(Boolean)) {
      const [header, path] = entry.split('\t')
      const [mode, type, object] = header.split(' ')
      if (type !== 'blob' || !['100644', '100755'].includes(mode))
        return yield* invalid(`Unsupported snapshot entry: ${entry}`)
      files.push({
        path,
        mode,
        sha256: hash(yield* git(repository, ['cat-file', 'blob', object])),
        object,
      })
    }
    return files.sort(compare)
  },
)

export const createSnapshot = Effect.fn('SourceSnapshot.createSnapshot')(
  /** @param {{repository?:string,revision?:string,directory:string}} options */
  function* ({ repository = '.', revision = 'HEAD', directory }) {
    const fs = yield* FileSystem.FileSystem
    const sourceCommit = (yield* git(repository, ['rev-parse', '--verify', `${revision}^{commit}`]))
      .toString()
      .trim()
    const entries = yield* committedFiles(repository, sourceCommit)
    if (
      !entries.some(({ path }) => path === 'compiler/silk.toml') ||
      !entries.some(({ path }) => path === 'compiler/src/main.silk') ||
      !entries.some(({ path }) => path.startsWith('packages/compiler/stdlib/'))
    )
      return yield* invalid('Incomplete compiler/manifest/stdlib closure')
    yield* fs.makeDirectory(directory, { recursive: true })
    if ((yield* fs.readDirectory(directory)).length !== 0)
      return yield* invalid('Snapshot export requires an empty directory')
    const files = []
    for (const { object, ...file } of entries) {
      const target = join(directory, file.path)
      yield* fs.makeDirectory(join(target, '..'), { recursive: true })
      yield* fs.writeFile(target, yield* git(repository, ['cat-file', 'blob', object]))
      yield* fs.chmod(target, Number.parseInt(file.mode.slice(3), 8))
      files.push(file)
    }
    yield* archive(
      [
        '--create',
        '--file',
        join(resolve(directory), 'authored-inputs.tar'),
        '--mtime=@0',
        '--owner=0',
        '--group=0',
        '--numeric-owner',
        '--null',
        '--files-from=-',
      ],
      { cwd: directory, input: Buffer.from(files.map(({ path }) => `${path}\0`).join('')) },
    )
    const receipt = {
      schemaVersion: 1,
      sourceCommit,
      roots,
      files,
      normalizedDigest: fileDigest(files),
      compilerDigest: fileDigest(files.filter(({ path }) => path.startsWith('compiler/'))),
      stdlibDigest: fileDigest(
        files.filter(({ path }) => path.startsWith('packages/compiler/stdlib/')),
      ),
      archive: 'authored-inputs.tar',
      archiveSha256: hash(yield* fs.readFile(join(directory, 'authored-inputs.tar'))),
    }
    yield* fs.writeFileString(
      join(directory, 'input-snapshot.json'),
      (yield* Schema.encodeEffect(Schema.fromJsonString(InputSnapshotSchema))(receipt)) + '\n',
    )
    return yield* verifySnapshot({ directory })
  },
)

export const verifySnapshot = Effect.fn('SourceSnapshot.verifySnapshot')(
  /** @param {{directory:string,receipt?:SnapshotReceipt}} options
   * @returns {import('effect/Effect').fn.Return<SnapshotReceipt, SourceSnapshotError | import('effect/PlatformError').PlatformError | import('effect/Schema').SchemaError, import('effect/FileSystem').FileSystem>} */
  function* ({ directory, receipt: supplied }) {
    const fs = yield* FileSystem.FileSystem
    const receipt =
      supplied ?? (yield* json(yield* fs.readFileString(join(directory, 'input-snapshot.json'))))
    if (
      receipt.schemaVersion !== 1 ||
      receipt.roots.join('\0') !== roots.join('\0') ||
      receipt.archive !== 'authored-inputs.tar' ||
      !/^[a-f0-9]{40}$/.test(receipt.sourceCommit) ||
      !Array.isArray(receipt.files) ||
      receipt.files.length === 0
    )
      return yield* invalid('Invalid input snapshot receipt')
    const expected = new Set()
    for (const file of receipt.files) {
      if (
        typeof file.path !== 'string' ||
        file.path
          .split('/')
          .some((component) => component === '..' || component === '.' || component === '') ||
        !roots.some((root) => file.path.startsWith(`${root}/`)) ||
        !['100644', '100755'].includes(file.mode) ||
        !/^[a-f0-9]{64}$/.test(file.sha256) ||
        expected.has(file.path)
      )
        return yield* invalid('Invalid snapshot file')
      expected.add(file.path)
      const target = join(directory, file.path)
      const info = yield* fs.stat(target)
      if (
        info.type !== 'File' ||
        (info.mode & 0o777) !== Number.parseInt(file.mode.slice(3), 8) ||
        hash(yield* fs.readFile(target)) !== file.sha256
      )
        return yield* invalid(`Snapshot bytes or mode changed: ${file.path}`)
    }
    const walk = Effect.fnUntraced(
      /** @param {string} path @returns {import('effect/Effect').fn.Return<void,SourceSnapshotError|import('effect/PlatformError').PlatformError>} */
      function* (path) {
        // The bootstrap creates only compiler/build; this output is outside the authored input set.
        if (path === 'compiler/build') return
        const info = yield* fs.stat(join(directory, path))
        if (info.type === 'Directory')
          for (const child of yield* fs.readDirectory(join(directory, path)))
            yield* walk(`${path}/${child}`)
        else if (!expected.has(path)) return yield* invalid(`Unrecorded snapshot input: ${path}`)
      },
    )
    for (const root of roots) yield* walk(root)
    const ordered = [...receipt.files].sort(compare)
    if (
      ordered.some((file, index) => file !== receipt.files[index]) ||
      fileDigest(ordered) !== receipt.normalizedDigest ||
      fileDigest(ordered.filter(({ path }) => path.startsWith('compiler/'))) !==
        receipt.compilerDigest ||
      fileDigest(ordered.filter(({ path }) => path.startsWith('packages/compiler/stdlib/'))) !==
        receipt.stdlibDigest ||
      hash(yield* fs.readFile(join(directory, receipt.archive))) !== receipt.archiveSha256
    )
      return yield* invalid('Snapshot digest mismatch')
    return receipt
  },
)

export const restoreSnapshot = Effect.fn('SourceSnapshot.restoreSnapshot')(
  /** @param {{artifact:string,directory:string}} options */
  function* ({ artifact, directory }) {
    const fs = yield* FileSystem.FileSystem
    const receipt = yield* json(yield* fs.readFileString(join(artifact, 'input-snapshot.json')))
    if (
      receipt.archive !== 'authored-inputs.tar' ||
      hash(yield* fs.readFile(join(artifact, 'authored-inputs.tar'))) !== receipt.archiveSha256
    )
      return yield* invalid('Snapshot archive digest mismatch')
    yield* fs.makeDirectory(directory, { recursive: true })
    if ((yield* fs.readDirectory(directory)).length !== 0)
      return yield* invalid('Snapshot restore requires an empty directory')
    yield* archive([
      '--extract',
      '--same-permissions',
      '--file',
      join(resolve(artifact), 'authored-inputs.tar'),
      '--directory',
      directory,
    ])
    yield* fs.copyFile(
      join(artifact, 'authored-inputs.tar'),
      join(directory, 'authored-inputs.tar'),
    )
    yield* fs.copyFile(
      join(artifact, 'input-snapshot.json'),
      join(directory, 'input-snapshot.json'),
    )
    return yield* verifySnapshot({ directory })
  },
)

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, directory, revision = 'HEAD'] = process.argv.slice(2)
  const require = createRequire(new URL('../../packages/cli/package.json', import.meta.url))
  /** @type {{ NodeServices: {layer: import('effect/Layer').Layer<import('effect/FileSystem').FileSystem>} }} */
  const { NodeServices } = await import(
    pathToFileURL(require.resolve('@effect/platform-node')).href
  )
  const program =
    directory && command === 'create'
      ? createSnapshot({ directory, revision })
      : invalid('usage: node SourceSnapshot.mjs create <directory> [revision]')
  await Effect.runPromise(
    program.pipe(
      Effect.flatMap((receipt) =>
        Schema.encodeEffect(Schema.fromJsonString(InputSnapshotSchema))(receipt),
      ),
      Effect.flatMap(Console.log),
      Effect.provide(NodeServices.layer),
    ),
  )
}
