// Authored inputs are exported from Git objects, never from a formatter-mutated checkout.
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Schema from 'effect/Schema'
import * as Console from 'effect/Console'
import * as NativeProcess from './NativeProcess.ts'
import { isVersion } from './SemVer.mjs'

export class SourceSnapshotError extends Data.TaggedError('SourceSnapshotError') {}
const invalid = (message) => Effect.fail(new SourceSnapshotError({ message }))
export const roots = ['changes', 'compiler', 'silk.toml', 'stdlib', 'tomledit', 'tool']
/** The compiler package, its source dependencies, and their workspace configuration. */
export const isCompilerInput = (path) =>
  path === 'silk.toml' ||
  path === 'tool/silk.toml' ||
  path === 'changes/silk.toml' ||
  path.startsWith('compiler/') ||
  path.startsWith('tomledit/')
// The release archive's `bin/silk`, the silk tool, is built from the same snapshot, with `changes/` as its
// dependency. Only their manifests, which the workspace needs, are compiler inputs.
const isSnapshotInput = (path) =>
  isCompilerInput(path) || path.startsWith('stdlib/') || path.startsWith('tool/') || path.startsWith('changes/')
const requiredFiles = ['silk.toml', 'compiler/silk.toml', 'compiler/src/main.silk']
const completeClosure = (files) =>
  requiredFiles.every((required) => files.some(({ path }) => path === required)) &&
  files.some(({ path }) => path.startsWith('stdlib/'))
const FileSchema = Schema.Struct({
  path: Schema.String,
  mode: Schema.String,
  sha256: Schema.String,
})
const NativeSnapshotSchema = Schema.Struct({
  package: Schema.String,
  version: Schema.String,
  tag: Schema.String,
  prerelease: Schema.Boolean,
  commit: Schema.String,
  notes: Schema.String,
  toml: Schema.String,
  manifest: Schema.String,
  versionFile: Schema.String,
  versionSource: Schema.String,
})
const ProjectionSchema = Schema.Struct({
  baseDigest: Schema.String,
  baseArchiveSha256: Schema.String,
  version: Schema.String,
  tag: Schema.String,
  prerelease: Schema.Boolean,
  commit: Schema.String,
  versionFile: Schema.String,
  snapshotSha256: Schema.String,
  metadataSha256: Schema.String,
  baseFiles: Schema.Array(FileSchema),
})
const ProjectionMaterialSchema = Schema.Struct({
  baseDigest: Schema.String,
  baseArchiveSha256: Schema.String,
  baseManifest: Schema.String,
  baseVersionSource: Schema.String,
  snapshot: NativeSnapshotSchema,
})
export const InputSnapshotSchema = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  sourceCommit: Schema.String,
  roots: Schema.Array(Schema.String),
  files: Schema.Array(FileSchema),
  normalizedDigest: Schema.String,
  compilerDigest: Schema.String,
  stdlibDigest: Schema.String,
  archive: Schema.String,
  archiveSha256: Schema.String,
  projection: Schema.optionalKey(ProjectionSchema),
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
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))
const projectionPath = 'projection.json'
const snapshotPath = 'compiler/changes-snapshot.toml'
const versionPath = 'compiler/src/ReleaseVersion.silk'
// The silk tool reports the release version too, from a copy of the compiler's generated version
// module.
const toolVersionPath = 'tool/src/ReleaseVersion.silk'
const within = (parent, child) => {
  const path = relative(resolve(parent), resolve(child))
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}
const physicalPath = Effect.fnUntraced(function* (path) {
  const fs = yield* FileSystem.FileSystem
  const absolute = resolve(path)
  let ancestor = absolute
  while (!(yield* fs.exists(ancestor))) ancestor = dirname(ancestor)
  return resolve(yield* fs.realPath(ancestor), relative(ancestor, absolute))
})
// This is a byte-level overlay guard, not a second implementation of changes policy.
// The native command alone computes versions, renders modules and serializes history.
const validateProjection = (snapshot, sourceCommit, baseManifest, baseVersionSource) => {
  const packageSection = /^\[package\][ \t]*\r?\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(baseManifest)
  const version =
    packageSection && /^version[ \t]*=[ \t]*(['"])([^'"\r\n]+)\1/m.exec(packageSection[1])
  const packageName =
    packageSection && /^name[ \t]*=[ \t]*(['"])([^'"\r\n]+)\1/m.exec(packageSection[1])
  if (
    !version ||
    !packageName ||
    !isVersion(snapshot.version) ||
    snapshot.commit !== sourceCommit ||
    !/^[a-f0-9]{40}$/.test(snapshot.commit) ||
    snapshot.package !== packageName[2] ||
    snapshot.tag !== `v${snapshot.version}` ||
    snapshot.prerelease !== snapshot.version.split('+')[0].includes('-') ||
    snapshot.versionFile !== 'src/ReleaseVersion.silk' ||
    !/^\[release\][ \t]*\r?\n(?:(?!^\[)[\s\S])*?^version-file[ \t]*=[ \t]*(['"])src\/ReleaseVersion\.silk\1[ \t]*(?:#.*)?$/m.test(
      baseManifest,
    )
  )
    return 'Invalid native snapshot identity or version-file path'
  const start =
    packageSection.index +
    packageSection[0].indexOf(packageSection[1]) +
    version.index +
    version[0].indexOf(version[1])
  const expectedManifest =
    baseManifest.slice(0, start) +
    `"${snapshot.version}"` +
    baseManifest.slice(start + version[2].length + 2)
  const literal = `b"${version[2]}"`
  if (
    !baseVersionSource.includes(literal) ||
    baseVersionSource.indexOf(literal) !== baseVersionSource.lastIndexOf(literal) ||
    snapshot.manifest !== expectedManifest ||
    snapshot.versionSource !== baseVersionSource.replace(literal, `b"${snapshot.version}"`)
  )
    return 'Projection may change only the manifest version and generated version literal'
  const header = snapshot.toml.split(/^\[/m)[0]
  for (const [key, value] of [
    ['schema', 'silk.changes.snapshot'],
    ['package', snapshot.package],
    ['version', snapshot.version],
    ['commit', snapshot.commit],
  ]) {
    const fields = [...header.matchAll(new RegExp(`^${key} = "([^"\\\\\\r\\n]*)"\\r?$`, 'gm'))]
    if (fields.length !== 1 || fields[0][1] !== value)
      return 'Snapshot TOML metadata differs from native snapshot identity'
  }
  const kinds = [...header.matchAll(/^kind = "(stable|dev|prerelease)"\r?$/gm)]
  const kind = kinds[0]?.[1]
  if (
    [...header.matchAll(/^format = 1\r?$/gm)].length !== 1 ||
    kinds.length !== 1 ||
    (snapshot.prerelease ? kind === 'stable' : kind !== 'stable')
  )
    return 'Invalid snapshot TOML kind or format'
  if (
    (kind === 'dev' || snapshot.version.includes('-dev.')) &&
    (kind !== 'dev' ||
      !new RegExp(`-dev\\.[1-9][0-9]*\\+${sourceCommit.slice(0, 12)}$`).test(snapshot.version))
  )
    return 'Snapshot TOML dev identity does not match its source commit'
}

const writeArchive = Effect.fnUntraced(function* (directory, paths) {
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
    { cwd: directory, input: Buffer.from(paths.map((path) => `${path}\0`).join('')) },
  )
})

/** Explicitly project native release metadata onto a fresh committed-input snapshot. */
export const projectSnapshot = Effect.fn('SourceSnapshot.projectSnapshot')(
  /** @param {{base:string,snapshot:string,directory:string}} options */
  function* ({ base, snapshot: snapshotFile, directory }) {
    const fs = yield* FileSystem.FileSystem
    const realBase = yield* physicalPath(base)
    const realOutput = yield* physicalPath(directory)
    const realSnapshot = yield* physicalPath(snapshotFile)
    if (
      within(realBase, realOutput) ||
      within(realOutput, realBase) ||
      within(realOutput, realSnapshot)
    )
      return yield* invalid('Projection output must be separate from its immutable inputs')
    if (within(base, directory) || within(directory, base) || within(directory, snapshotFile))
      return yield* invalid('Projection output must be separate from its immutable inputs')
    const original = yield* verifySnapshot({ directory: base })
    if (original.projection) return yield* invalid('Cannot project an already projected snapshot')
    const snapshot = yield* Schema.decodeEffect(Schema.fromJsonString(NativeSnapshotSchema))(
      yield* fs.readFileString(snapshotFile),
    )
    const baseManifest = yield* fs.readFileString(join(base, 'compiler/silk.toml'))
    const baseVersionSource = yield* fs.readFileString(join(base, versionPath))
    const problem = validateProjection(
      snapshot,
      original.sourceCommit,
      baseManifest,
      baseVersionSource,
    )
    if (problem) return yield* invalid(problem)
    if (original.files.some(({ path }) => path === snapshotPath))
      return yield* invalid('Committed base already contains release snapshot metadata')
    const toolVersion = original.files.some(({ path }) => path === toolVersionPath)
    if (toolVersion && (yield* fs.readFileString(join(base, toolVersionPath))) !== baseVersionSource)
      return yield* invalid(`${toolVersionPath} must match ${versionPath}`)
    const material = {
      baseDigest: original.normalizedDigest,
      baseArchiveSha256: original.archiveSha256,
      baseManifest,
      baseVersionSource,
      snapshot,
    }
    const metadata = (yield* encodeJson(material)) + '\n'
    yield* fs.makeDirectory(directory, { recursive: true })
    if ((yield* fs.readDirectory(directory)).length !== 0)
      return yield* invalid('Projection export requires an empty directory')
    const overlay = new Map([
      ['compiler/silk.toml', snapshot.manifest],
      [versionPath, snapshot.versionSource],
      [snapshotPath, snapshot.toml],
    ])
    if (toolVersion) overlay.set(toolVersionPath, snapshot.versionSource)
    const files = []
    for (const file of original.files) {
      const target = join(directory, file.path)
      const bytes = overlay.has(file.path)
        ? Buffer.from(overlay.get(file.path))
        : yield* fs.readFile(join(base, file.path))
      yield* fs.makeDirectory(join(target, '..'), { recursive: true })
      yield* fs.writeFile(target, bytes)
      yield* fs.chmod(target, Number.parseInt(file.mode.slice(3), 8))
      files.push({ ...file, sha256: hash(bytes) })
    }
    yield* fs.writeFileString(join(directory, snapshotPath), snapshot.toml)
    yield* fs.chmod(join(directory, snapshotPath), 0o644)
    files.push({ path: snapshotPath, mode: '100644', sha256: hash(snapshot.toml) })
    files.sort(compare)
    yield* fs.writeFileString(join(directory, projectionPath), metadata)
    yield* writeArchive(directory, [...files.map(({ path }) => path), projectionPath])
    const receipt = {
      ...original,
      files,
      normalizedDigest: fileDigest(files),
      compilerDigest: fileDigest(files.filter(({ path }) => isCompilerInput(path))),
      archiveSha256: hash(yield* fs.readFile(join(directory, original.archive))),
      projection: {
        baseDigest: original.normalizedDigest,
        baseArchiveSha256: original.archiveSha256,
        version: snapshot.version,
        tag: snapshot.tag,
        prerelease: snapshot.prerelease,
        commit: snapshot.commit,
        versionFile: snapshot.versionFile,
        snapshotSha256: hash(snapshot.toml),
        metadataSha256: hash(metadata),
        baseFiles: original.files,
      },
    }
    yield* fs.writeFileString(
      join(directory, 'input-snapshot.json'),
      (yield* encodeJson(receipt)) + '\n',
    )
    yield* verifySnapshot({ directory: base, receipt: original })
    return yield* verifySnapshot({ directory })
  },
)

const committedFiles = Effect.fnUntraced(
  /** @param {string} repository @param {string} revision */
  function* (repository, revision) {
    const listing = yield* git(repository, ['ls-tree', '-r', '-z', revision, '--', ...roots])
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
    if (!completeClosure(entries))
      return yield* invalid('Incomplete compiler/dependency/workspace/stdlib closure')
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
    yield* writeArchive(
      directory,
      files.map(({ path }) => path),
    )
    const receipt = {
      schemaVersion: 2,
      sourceCommit,
      roots,
      files,
      normalizedDigest: fileDigest(files),
      compilerDigest: fileDigest(files.filter(({ path }) => isCompilerInput(path))),
      stdlibDigest: fileDigest(files.filter(({ path }) => path.startsWith('stdlib/'))),
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
    const stored = yield* json(yield* fs.readFileString(join(directory, 'input-snapshot.json')))
    if (supplied && (yield* encodeJson(supplied)) !== (yield* encodeJson(stored)))
      return yield* invalid('Snapshot receipt changed')
    const receipt = supplied ?? stored
    if (
      receipt.schemaVersion !== 2 ||
      receipt.roots.join('\0') !== roots.join('\0') ||
      receipt.archive !== 'authored-inputs.tar' ||
      !/^[a-f0-9]{40}$/.test(receipt.sourceCommit) ||
      !Array.isArray(receipt.files) ||
      !completeClosure(receipt.files)
    )
      return yield* invalid('Invalid input snapshot receipt')
    const expected = new Set()
    for (const file of receipt.files) {
      if (
        typeof file.path !== 'string' ||
        file.path
          .split('/')
          .some((component) => component === '..' || component === '.' || component === '') ||
        !isSnapshotInput(file.path) ||
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
        // NTFS has no POSIX executable mode. Canonical modes remain authenticated by the
        // archived inputs and receipt digest; native Windows files are checked by type and bytes.
        (process.platform !== 'win32' &&
          (info.mode & 0o777) !== Number.parseInt(file.mode.slice(3), 8)) ||
        hash(yield* fs.readFile(target)) !== file.sha256
      )
        return yield* invalid(`Snapshot bytes or mode changed: ${file.path}`)
    }
    const walk = Effect.fnUntraced(
      /** @param {string} path @returns {import('effect/Effect').fn.Return<void,SourceSnapshotError|import('effect/PlatformError').PlatformError>} */
      function* (path) {
        const info = yield* fs.stat(join(directory, path))
        if (info.type === 'Directory')
          for (const child of yield* fs.readDirectory(join(directory, path)))
            yield* walk(`${path}/${child}`)
        else if (!expected.has(path)) return yield* invalid(`Unrecorded snapshot input: ${path}`)
      },
    )
    // A revision from before a root existed has no files below it.
    for (const root of roots) if (yield* fs.exists(join(directory, root))) yield* walk(root)
    const ordered = [...receipt.files].sort(compare)
    if (
      ordered.some((file, index) => file !== receipt.files[index]) ||
      fileDigest(ordered) !== receipt.normalizedDigest ||
      fileDigest(ordered.filter(({ path }) => isCompilerInput(path))) !== receipt.compilerDigest ||
      fileDigest(ordered.filter(({ path }) => path.startsWith('stdlib/'))) !==
        receipt.stdlibDigest ||
      hash(yield* fs.readFile(join(directory, receipt.archive))) !== receipt.archiveSha256
    )
      return yield* invalid('Snapshot digest mismatch')
    if (receipt.projection) {
      const projection = receipt.projection
      const metadata = yield* fs.readFileString(join(directory, projectionPath))
      if (hash(metadata) !== projection.metadataSha256)
        return yield* invalid('Projection metadata digest mismatch')
      const material = yield* Schema.decodeEffect(Schema.fromJsonString(ProjectionMaterialSchema))(
        metadata,
      )
      const { snapshot, baseManifest, baseVersionSource } = material
      const problem = validateProjection(
        snapshot,
        receipt.sourceCommit,
        baseManifest,
        baseVersionSource,
      )
      if (problem) return yield* invalid(problem)
      const baseFiles = projection.baseFiles
      const overlays = new Map([
        ['compiler/silk.toml', snapshot.manifest],
        [versionPath, snapshot.versionSource],
      ])
      const toolVersion = baseFiles.find(({ path }) => path === toolVersionPath)
      if (toolVersion) overlays.set(toolVersionPath, snapshot.versionSource)
      const projected = baseFiles.map((file) => ({
        ...file,
        sha256: overlays.has(file.path) ? hash(overlays.get(file.path)) : file.sha256,
      }))
      projected.push({ path: snapshotPath, mode: '100644', sha256: hash(snapshot.toml) })
      projected.sort(compare)
      if (
        !completeClosure(baseFiles) ||
        baseFiles.some(({ path }) => path === snapshotPath) ||
        baseFiles.find(({ path }) => path === 'compiler/silk.toml')?.sha256 !==
          hash(baseManifest) ||
        baseFiles.find(({ path }) => path === versionPath)?.sha256 !== hash(baseVersionSource) ||
        (toolVersion !== undefined && toolVersion.sha256 !== hash(baseVersionSource)) ||
        fileDigest(baseFiles) !== projection.baseDigest ||
        material.baseDigest !== projection.baseDigest ||
        material.baseArchiveSha256 !== projection.baseArchiveSha256 ||
        !/^[a-f0-9]{64}$/.test(projection.baseArchiveSha256) ||
        projection.commit !== snapshot.commit ||
        projection.version !== snapshot.version ||
        projection.tag !== snapshot.tag ||
        projection.prerelease !== snapshot.prerelease ||
        projection.versionFile !== snapshot.versionFile ||
        projection.snapshotSha256 !== hash(snapshot.toml) ||
        fileDigest(projected) !== receipt.normalizedDigest
      )
        return yield* invalid('Projection provenance or overlay mismatch')
    } else if (yield* fs.exists(join(directory, projectionPath))) {
      return yield* invalid('Unrecorded projection metadata')
    }
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
  const [command, directory, other, output, ...extra] = process.argv.slice(2)
  const require = createRequire(new URL('../../package.json', import.meta.url))
  /** @type {{ NodeServices: {layer: import('effect/Layer').Layer<import('effect/FileSystem').FileSystem>} }} */
  const { NodeServices } = await import(
    pathToFileURL(require.resolve('@effect/platform-node')).href
  )
  const program = Effect.gen(function* () {
    if (directory && command === 'create' && output === undefined)
      return yield* createSnapshot({ directory, revision: other ?? 'HEAD' })
    if (directory && command === 'verify' && other === undefined)
      return yield* verifySnapshot({ directory })
    if (directory && command === 'restore' && other && output === undefined)
      return yield* restoreSnapshot({ artifact: directory, directory: other })
    if (directory && command === 'project' && other && output && extra.length === 0)
      return yield* projectSnapshot({ base: directory, snapshot: other, directory: output })
    return yield* invalid(
      'usage: node SourceSnapshot.mjs create <directory> [revision] | verify <directory> | restore <artifact> <directory> | project <base> <native-snapshot-json> <directory>',
    )
  })
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
