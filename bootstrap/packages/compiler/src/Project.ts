import * as PlatformSupply from './PlatformSupply.js'
import * as NativeRequirementBinding from './NativeRequirementBinding.js'
import * as NativeRequirement from './NativeRequirement.js'
import * as ArtifactComposition from './ArtifactComposition.js'
import type * as ArtifactPlan from './ArtifactPlan.js'
import * as ProjectProfile from './ProjectProfile.js'
import * as ConfigurationOrigin from './ConfigurationOrigin.js'
import type * as ConfigurationError from './ConfigurationError.js'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import { parse, TomlDate, type TomlTable, type TomlValue } from 'smol-toml'
import * as ArtifactKind from './ArtifactKind.js'
import * as NativeLinkInput from './NativeLinkInput.js'
import * as SourceEntry from './SourceEntry.js'
import * as TargetSelector from './TargetSelector.js'

/** The conventional project manifest name used by upward discovery. */
export const manifestName = 'silk.toml'

/** A loaded project with every manifest-relative path made absolute and its entry materialized. */
export interface Project {
  readonly _tag: 'Project'
  readonly name: string
  readonly version: string
  readonly manifestPath: string
  readonly directory: string
  readonly entry: SourceEntry.SourceEntry
  readonly profiles?: ProjectProfile.Catalog
  readonly build: BuildConfiguration
}

/** Materialized project build defaults, including an absolute manifest-relative output root. */
export interface BuildConfiguration {
  readonly platformSupply?: PlatformSupply.Request

  readonly nativeBindings?: ReadonlyArray<NativeRequirementBinding.NativeRequirementBinding>
  readonly stage?: ArtifactPlan.Stage
  readonly composition?: ArtifactComposition.Input
  readonly targets: ReadonlyArray<TargetSelector.TargetSelector>
  readonly outputDirectory: string
  readonly artifact: Exclude<ArtifactKind.ArtifactKind, 'WebAssemblyModule'>
  readonly nativeLinkInputs: ReadonlyArray<NativeLinkInput.NativeLinkInput>
}

export type ProjectErrorReason =
  | { readonly _tag: 'InvalidProfile'; readonly error: ConfigurationError.ConfigurationError }
  | { readonly _tag: 'ManifestNotFound'; readonly startDirectory: string }
  | { readonly _tag: 'InvalidManifest'; readonly detail: string }
  | { readonly _tag: 'InvalidEntry'; readonly error: SourceEntry.SourceEntryError }
  | { readonly _tag: 'WrappedFailure'; readonly cause: unknown }

/** Project discovery, decoding, validation, or entry materialization failed. */
export class ProjectError extends Data.TaggedError('ProjectError')<{
  readonly operation: 'Project.discover' | 'Project.load'
  readonly manifestPath: string
  readonly message: string
  readonly reason: ProjectErrorReason
}> {}

export interface LoadOptions {
  readonly workingDirectory?: string
  readonly manifestPath?: string
}

const packageNamePattern = /^[a-z][a-z0-9-]*$/
const semanticVersionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

/** Whether a name is portable across the initial artifact and package conventions. */
export const isPackageName = (name: string): boolean => packageNamePattern.test(name)

/** Whether a package version is a complete Semantic Versioning 2.0.0 value. */
export const isSemanticVersion = (version: string): boolean => semanticVersionPattern.test(version)

const isNativeName = (value: TomlValue | undefined): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  !value.startsWith('-') &&
  !/[\s\0/\\]/.test(value)

const isTable = (value: TomlValue | undefined): value is TomlTable =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof TomlDate)

const isSafeRelativePath = (value: TomlValue | undefined): value is string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\0') ||
    value.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(value)
  )
    return false
  let depth = 0
  for (const segment of value.split(/[\\/]+/)) {
    if (segment === '' || segment === '.') continue
    depth += segment === '..' ? -1 : 1
    if (depth < 0) return false
  }
  return true
}

const hasExactKeys = (table: TomlTable, keys: ReadonlyArray<string>): boolean => {
  const actual = Object.keys(table).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

const buildKeys = [
  'targets',
  'output-dir',
  'artifact',
  'native-link-inputs',
  'platform-supply',
  'native-bindings',
  'stage',
  'composition',
  'profile',
  'bindings',
]

const decodeNativeLinkInput = (value: TomlValue): NativeLinkInput.NativeLinkInput | undefined => {
  if (!isTable(value)) return undefined
  if (hasExactKeys(value, ['linker-script']) && isSafeRelativePath(value['linker-script']))
    return NativeLinkInput.linkerScript(value['linker-script'])
  if (hasExactKeys(value, ['object']) && isSafeRelativePath(value.object))
    return NativeLinkInput.object(value.object)
  if (hasExactKeys(value, ['static-archive']) && isSafeRelativePath(value['static-archive']))
    return NativeLinkInput.staticArchive(value['static-archive'])
  if (hasExactKeys(value, ['search-path']) && isSafeRelativePath(value['search-path']))
    return NativeLinkInput.searchPath(value['search-path'])
  if (hasExactKeys(value, ['framework']) && isNativeName(value.framework))
    return NativeLinkInput.framework(value.framework)
  if (
    hasExactKeys(value, ['library', 'mode']) &&
    isNativeName(value.library) &&
    (value.mode === 'static' || value.mode === 'dynamic')
  )
    return NativeLinkInput.library(value.library, value.mode === 'static' ? 'Static' : 'Dynamic')
  return undefined
}

const resolveNativeLinkInput = (
  directory: string,
  input: NativeLinkInput.NativeLinkInput,
  resolvePath: (...paths: ReadonlyArray<string>) => string,
): NativeLinkInput.NativeLinkInput => {
  switch (input._tag) {
    case 'LinkerScript':
      return NativeLinkInput.linkerScript(resolvePath(directory, input.path))
    case 'Object':
      return NativeLinkInput.object(resolvePath(directory, input.path))
    case 'StaticArchive':
      return NativeLinkInput.staticArchive(resolvePath(directory, input.path))
    case 'SearchPath':
      return NativeLinkInput.searchPath(resolvePath(directory, input.path))
    case 'Library':
    case 'Framework':
      return input
  }
}

const invalidManifest = (manifestPath: string, detail: string): ProjectError =>
  new ProjectError({
    operation: 'Project.load',
    manifestPath,
    message: `Invalid Silk project manifest ${manifestPath}: ${detail}`,
    reason: { _tag: 'InvalidManifest', detail },
  })

const decodeManifest = Effect.fnUntraced(function* (manifestPath: string, text: string) {
  const document = yield* Effect.try({
    try: () => parse(text),
    catch: (cause) =>
      new ProjectError({
        operation: 'Project.load',
        manifestPath,
        message: `Cannot parse Silk project manifest ${manifestPath}`,
        reason: { _tag: 'WrappedFailure', cause },
      }),
  })
  const packageTable = document.package
  if (!isTable(packageTable)) return yield* invalidManifest(manifestPath, 'missing [package] table')

  const name = packageTable.name
  if (typeof name !== 'string' || !isPackageName(name)) {
    return yield* invalidManifest(
      manifestPath,
      'package.name must start with a lowercase letter and contain only lowercase letters, digits, or hyphens',
    )
  }
  const root = packageTable.root
  if (typeof root !== 'string' || root.length === 0) {
    return yield* invalidManifest(manifestPath, 'package.root must be a non-empty string')
  }
  const sourceRoot = packageTable['source-root']
  if (sourceRoot !== undefined && (typeof sourceRoot !== 'string' || sourceRoot.length === 0)) {
    return yield* invalidManifest(manifestPath, 'package.source-root must be a non-empty string')
  }
  const version = packageTable.version
  if (typeof version !== 'string' || !isSemanticVersion(version)) {
    return yield* invalidManifest(manifestPath, 'package.version must be a valid semantic version')
  }

  const buildTable = document.build
  if (buildTable !== undefined && !isTable(buildTable)) {
    return yield* invalidManifest(manifestPath, '[build] must be a table')
  }
  const unsupportedBuildKey =
    buildTable === undefined
      ? undefined
      : Object.keys(buildTable).find((key) => !buildKeys.includes(key))
  if (unsupportedBuildKey !== undefined)
    return yield* invalidManifest(
      manifestPath,
      `build.${unsupportedBuildKey} is not a supported field`,
    )
  const stages: ReadonlyArray<ArtifactPlan.Stage> = [
    'final',
    'llvm-ir',
    'llvm-bitcode',
    'assembly',
    'object',
  ]
  const stage = stages.find((candidate) => candidate === (buildTable?.stage ?? 'final'))
  if (stage === undefined)
    return yield* invalidManifest(manifestPath, 'build.stage is not an admitted emission stage')
  const composition =
    buildTable?.composition === undefined
      ? undefined
      : yield* ArtifactComposition.decode(
          buildTable.composition,
          ConfigurationOrigin.literal(`${manifestPath}:build.composition`),
        ).pipe(
          Effect.map(ArtifactComposition.input),
          Effect.mapError(
            (error) =>
              new ProjectError({
                operation: 'Project.load',
                manifestPath,
                message: error.message,
                reason: { _tag: 'InvalidProfile', error },
              }),
          ),
        )
  const defaultTargets: ReadonlyArray<TargetSelector.TargetSelector> = ['host']
  const profiles = yield* ProjectProfile.catalog(
    document.profiles,
    buildTable?.profile,
    buildTable?.bindings,
    ConfigurationOrigin.literal(manifestPath),
  ).pipe(
    Effect.mapError(
      (error) =>
        new ProjectError({
          operation: 'Project.load',
          manifestPath,
          message: error.message,
          reason: { _tag: 'InvalidProfile', error },
        }),
    ),
  )
  const targetsValue = buildTable?.targets ?? defaultTargets
  if (
    !Array.isArray(targetsValue) ||
    targetsValue.length === 0 ||
    targetsValue.some(
      (target) => typeof target !== 'string' || !TargetSelector.isTargetSelector(target),
    )
  ) {
    return yield* invalidManifest(
      manifestPath,
      'build.targets must be a non-empty array of host or canonical target ids',
    )
  }
  const outputDirectory = buildTable?.['output-dir'] ?? 'build'
  let outputDepth = 0
  let outputEscapes = false
  if (typeof outputDirectory === 'string') {
    for (const segment of outputDirectory.split(/[\\/]+/)) {
      if (segment === '' || segment === '.') continue
      outputDepth += segment === '..' ? -1 : 1
      if (outputDepth < 0) outputEscapes = true
    }
  }
  if (
    typeof outputDirectory !== 'string' ||
    outputDirectory.length === 0 ||
    outputDirectory.includes('\0') ||
    outputDirectory.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(outputDirectory) ||
    outputEscapes
  ) {
    return yield* invalidManifest(
      manifestPath,
      'build.output-dir must be a non-empty manifest-relative directory that does not escape the project',
    )
  }
  const artifactValue = buildTable?.artifact ?? 'executable'
  const artifact =
    typeof artifactValue === 'string' ? ArtifactKind.fromManifest(artifactValue) : undefined
  if (artifact === undefined || artifact === 'WebAssemblyModule') {
    return yield* invalidManifest(
      manifestPath,
      'build.artifact must be executable, shared-library, static-library, or object',
    )
  }
  const bindingInputs = buildTable?.['native-bindings'] ?? []
  if (!Array.isArray(bindingInputs))
    return yield* invalidManifest(manifestPath, 'build.native-bindings must be an array')
  const nativeBindings: Array<NativeRequirementBinding.NativeRequirementBinding> = []
  for (const [ordinal, candidate] of bindingInputs.entries()) {
    if (
      !isTable(candidate) ||
      !hasExactKeys(candidate, ['kind', 'name', 'alternative', 'inputs']) ||
      typeof candidate.alternative !== 'string' ||
      !NativeRequirement.isIdentity(candidate.alternative) ||
      !Array.isArray(candidate.inputs)
    )
      return yield* invalidManifest(
        manifestPath,
        'native binding requires kind, name, alternative and typed inputs',
      )
    const origin = ConfigurationOrigin.literal(`${manifestPath}:build.native-bindings[${ordinal}]`)
    const requirement = yield* NativeRequirement.decode(
      { kind: candidate.kind, name: candidate.name },
      { kind: 'artifact' },
      origin,
    ).pipe(
      Effect.mapError(
        (error) =>
          new ProjectError({
            operation: 'Project.load',
            manifestPath,
            message: error.message,
            reason: { _tag: 'InvalidProfile', error },
          }),
      ),
    )
    const inputs = candidate.inputs.map(decodeNativeLinkInput)
    if (inputs.length === 0 || inputs.some((input) => input === undefined))
      return yield* invalidManifest(
        manifestPath,
        'native binding inputs must be a nonempty typed input list',
      )
    nativeBindings.push({
      kind: requirement.kind,
      name: requirement.name,
      alternative: candidate.alternative,
      inputs: inputs.flatMap((input) => (input === undefined ? [] : [input])),
      origin,
    })
  }
  const platformSupplyValue = buildTable?.['platform-supply']
  const platformSupply =
    platformSupplyValue === undefined
      ? undefined
      : yield* PlatformSupply.decode(
          platformSupplyValue,
          `${manifestPath}:build.platform-supply`,
        ).pipe(Effect.mapError((error) => invalidManifest(manifestPath, error.message)))
  const nativeLinkInputsValue = buildTable?.['native-link-inputs'] ?? []
  if (!Array.isArray(nativeLinkInputsValue))
    return yield* invalidManifest(manifestPath, 'build.native-link-inputs must be an array')
  const nativeLinkInputs = nativeLinkInputsValue.map(decodeNativeLinkInput)
  if (nativeLinkInputs.some((input) => input === undefined)) {
    return yield* invalidManifest(
      manifestPath,
      'build.native-link-inputs entries must be exactly one object, static-archive, search-path, or framework value, or one library with static or dynamic mode',
    )
  }
  return {
    name,
    version,
    profiles,
    root,
    sourceRoot,
    targets: [...targetsValue] as ReadonlyArray<TargetSelector.TargetSelector>,
    outputDirectory,
    artifact,
    stage,
    ...(composition === undefined ? {} : { composition }),
    ...(platformSupply === undefined ? {} : { platformSupply }),
    nativeBindings: nativeBindings,
    nativeLinkInputs: nativeLinkInputs.flatMap((input) => (input === undefined ? [] : [input])),
  }
})

/** Finds the nearest ancestor `silk.toml`, beginning at the selected working directory. */
export const discover = Effect.fn('Project.discover')(function* (
  workingDirectory = '.',
): Effect.fn.Return<string, ProjectError, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const startDirectory = path.resolve(workingDirectory)
  let directory = startDirectory

  while (true) {
    const candidate = path.join(directory, manifestName)
    const exists = yield* fileSystem.exists(candidate).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectError({
            operation: 'Project.discover',
            manifestPath: candidate,
            message: `Cannot inspect ${candidate} while discovering a Silk project`,
            reason: { _tag: 'WrappedFailure', cause },
          }),
      ),
    )
    if (exists) return candidate
    const parent = path.dirname(directory)
    if (parent === directory) {
      return yield* new ProjectError({
        operation: 'Project.discover',
        manifestPath: path.join(startDirectory, manifestName),
        message: `No ${manifestName} found from ${startDirectory}; create one or pass --manifest-path`,
        reason: { _tag: 'ManifestNotFound', startDirectory },
      })
    }
    directory = parent
  }
})

/** Discovers or selects a manifest, validates it, and materializes its canonical root entry. */
export const load = Effect.fn('Project.load')(function* (
  options: LoadOptions = {},
): Effect.fn.Return<Project, ProjectError, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const manifestPath =
    options.manifestPath === undefined
      ? yield* discover(options.workingDirectory)
      : path.resolve(options.workingDirectory ?? '.', options.manifestPath)

  const text = yield* fileSystem.readFileString(manifestPath).pipe(
    Effect.mapError(
      (cause) =>
        new ProjectError({
          operation: 'Project.load',
          manifestPath,
          message: `Cannot read Silk project manifest ${manifestPath}`,
          reason: { _tag: 'WrappedFailure', cause },
        }),
    ),
  )
  const manifest = yield* decodeManifest(manifestPath, text)
  const directory = path.dirname(manifestPath)
  const entryPath = path.resolve(directory, manifest.root)
  const selectedSourceRoot =
    manifest.sourceRoot === undefined
      ? path.dirname(entryPath)
      : path.resolve(directory, manifest.sourceRoot)
  const entry = yield* SourceEntry.select(entryPath, selectedSourceRoot).pipe(
    Effect.mapError(
      (error) =>
        new ProjectError({
          operation: 'Project.load',
          manifestPath,
          message: `Cannot load root source for Silk project ${manifest.name}`,
          reason: { _tag: 'InvalidEntry', error },
        }),
    ),
  )

  return {
    _tag: 'Project' as const,
    name: manifest.name,
    version: manifest.version,
    profiles: manifest.profiles,
    manifestPath,
    directory,
    entry,
    build: {
      targets: manifest.targets,
      outputDirectory: path.resolve(directory, manifest.outputDirectory),
      artifact: manifest.artifact,
      ...(manifest.platformSupply === undefined
        ? {}
        : {
            platformSupply:
              manifest.platformSupply.kind !== 'explicit'
                ? manifest.platformSupply
                : {
                    ...manifest.platformSupply,
                    root: path.resolve(directory, manifest.platformSupply.root),
                    linker: path.resolve(directory, manifest.platformSupply.linker),
                    ...(manifest.platformSupply.support === undefined
                      ? {}
                      : {
                          support: manifest.platformSupply.support.map((item) => ({
                            ...item,
                            root: path.resolve(directory, item.root),
                          })),
                        }),
                  },
          }),
      stage: manifest.stage,
      ...(manifest.composition === undefined ? {} : { composition: manifest.composition }),
      nativeBindings: manifest.nativeBindings.map((binding) => ({
        ...binding,
        inputs: binding.inputs.map((input) =>
          resolveNativeLinkInput(directory, input, path.resolve),
        ),
      })),
      nativeLinkInputs: manifest.nativeLinkInputs.map((input) =>
        resolveNativeLinkInput(directory, input, path.resolve),
      ),
    },
  }
})
