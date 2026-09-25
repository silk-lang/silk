import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { expect, test } from 'vitest'

const workspaceRoot = resolve(dirname(new URL(import.meta.url).pathname), '..')
const packageRoot = resolve(workspaceRoot, 'packages/llvm')
const compilerPackageRoot = resolve(workspaceRoot, 'packages/compiler')
const cliPackageRoot = resolve(workspaceRoot, 'packages/cli')
const docgenPackageRoot = resolve(workspaceRoot, 'packages/docgen')
const formatterPackageRoot = resolve(workspaceRoot, 'packages/formatter')
const lspPackageRoot = resolve(workspaceRoot, 'packages/lsp')
const webContainerPackageRoot = resolve(workspaceRoot, 'packages/platform-webcontainer')

// Consumers install with --offline, so an override may only name a version the workspace store
// already holds. A caret range resolves fresh against the registry and picks whatever is newest,
// which is not what was installed — so every ranged dependency needs an exact override here.
// Read each from its installed copy rather than pinning a literal, which silently drifts out of
// the store the next time the dependency is bumped.
// pnpm's isolated store keeps these under the package that declares them, not the workspace root.
const installedVersion = (packageRoot: string, name: string): string =>
  JSON.parse(readFileSync(resolve(packageRoot, `node_modules/${name}/package.json`), 'utf8'))
    .version

const installedPackageRoot = (name: string): string =>
  realpathSync(resolve(cliPackageRoot, `node_modules/${name}`))

const lspInstalledVersion = (name: string): string =>
  JSON.parse(readFileSync(resolve(lspPackageRoot, `node_modules/${name}/package.json`), 'utf8'))
    .version

interface InstalledDependencyParent {
  readonly name: string
  readonly root: string
}

const installedDependencyRoot = (parent: InstalledDependencyParent, name: string): string =>
  realpathSync(resolve(parent.root, ...parent.name.split('/').map(() => '..'), name))

const installedDependencyNames = (parent: InstalledDependencyParent): ReadonlyArray<string> =>
  Object.keys(
    JSON.parse(readFileSync(resolve(parent.root, 'package.json'), 'utf8')).dependencies ?? {},
  ).sort()

const installedDependencyVersion = (parent: InstalledDependencyParent, name: string): string =>
  JSON.parse(readFileSync(resolve(installedDependencyRoot(parent, name), 'package.json'), 'utf8'))
    .version

const platformNodeParent: InstalledDependencyParent = Object.freeze({
  name: '@effect/platform-node',
  root: installedPackageRoot('@effect/platform-node'),
})

const platformNodeSharedParent: InstalledDependencyParent = Object.freeze({
  name: '@effect/platform-node-shared',
  root: installedDependencyRoot(platformNodeParent, '@effect/platform-node-shared'),
})

const consumerDependencyParents: ReadonlyArray<InstalledDependencyParent> = Object.freeze([
  { name: 'effect', root: installedPackageRoot('effect') },
  platformNodeParent,
  platformNodeSharedParent,
  {
    name: '@types/ws',
    root: installedDependencyRoot(platformNodeSharedParent, '@types/ws'),
  },
])

const consumerDependencyVersions = new Map<string, string>()
for (const parent of consumerDependencyParents) {
  for (const name of installedDependencyNames(parent)) {
    const version = installedDependencyVersion(parent, name)
    const existing = consumerDependencyVersions.get(name)
    if (existing !== undefined && existing !== version)
      throw new Error(
        `packed consumer dependency ${name} has incompatible installed versions ${existing} and ${version}`,
      )
    consumerDependencyVersions.set(name, version)
  }
}

const consumerDependencyOverrides = Array.from(consumerDependencyVersions)
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([name, version]) => `  '${name}': ${version}`)

const consumerWorkspace = (configuration = ''): string =>
  `overrides:\n${consumerDependencyOverrides.join('\n')}\n${configuration}`

test('consumer workspaces pin runtime transitive ranges to installed versions', () => {
  const workspace = consumerWorkspace()
  for (const parent of consumerDependencyParents) {
    for (const name of installedDependencyNames(parent))
      expect(workspace).toContain(`  '${name}': ${installedDependencyVersion(parent, name)}`)
  }
  expect(consumerDependencyOverrides).toHaveLength(consumerDependencyVersions.size)
})

const installConsumer = (cwd: string): void => {
  const result = spawnSync('pnpm', ['install', '--ignore-scripts', '--offline'], {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
  })
  if (result.status === 0) return
  throw new Error(`pnpm install failed in ${cwd}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`)
}

type NonActorExportKind =
  | 'binary'
  | 'bundle'
  | 'registration-side-effect'
  | 'direct-class'
  | 'other-non-actor'

interface NonActorExport {
  readonly packageName: string
  readonly path: `./${string}`
  readonly kind: NonActorExportKind
  readonly reason: string
}

// Actor parity deliberately excludes only entry points whose shape is not a root actor namespace.
// Keep every exception exact and explained: a removed path makes the parity assertion reject the
// stale exclusion instead of silently broadening this list.
const nonActorExports: ReadonlyArray<NonActorExport> = Object.freeze([
  {
    packageName: '@silklang/compiler',
    path: './Driver',
    kind: 'other-non-actor',
    reason: 'standalone artifact-producing orchestration entry point',
  },
  {
    packageName: '@silklang/compiler',
    path: './NativeToolchain',
    kind: 'other-non-actor',
    reason: 'Node-native toolchain boundary',
  },
  ...(['Linker', 'ObjectEmission'] as const).map((name): NonActorExport => ({
    packageName: '@silklang/compiler',
    path: `./${name}`,
    kind: 'other-non-actor',
    reason: 'Node-native artifact boundary excluded from the browser-safe root',
  })),
  {
    packageName: '@silklang/compiler',
    path: './NodeHeapObservation',
    kind: 'other-non-actor',
    reason: 'Node platform layer',
  },
  ...(['CTranslationUnitResolver', 'NativeLinkResolver', 'PlatformSupplyResolver'] as const).map(
    (name): NonActorExport => ({
      packageName: '@silklang/compiler',
      path: `./${name}`,
      kind: 'other-non-actor',
      reason: 'Node-native resolution boundary excluded from the browser-safe root',
    }),
  ),
  {
    packageName: '@silklang/editor-support',
    path: './bundle',
    kind: 'bundle',
    reason: 'prebuilt browser bundle',
  },
  {
    packageName: '@silklang/editor-support',
    path: './register',
    kind: 'registration-side-effect',
    reason: 'self-registering custom-element entry point',
  },
  {
    packageName: '@silklang/llvm',
    path: './LlvmError',
    kind: 'direct-class',
    reason: 'direct error-class export mirrored as a root class rather than a namespace',
  },
  {
    packageName: '@silklang/lsp',
    path: './bin',
    kind: 'binary',
    reason: 'stdio executable entry point',
  },
])

const excludedActorPaths = (packageName: string): ReadonlyArray<string> =>
  nonActorExports
    .filter((entry) => entry.packageName === packageName)
    .map((entry) => entry.path)
    .sort()

const actorNamesOf = (
  packageName: string,
  deepPaths: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const excluded = excludedActorPaths(packageName)
  const stale = excluded.filter((path) => !deepPaths.includes(path))
  if (stale.length > 0)
    throw new Error(`${packageName} has stale non-actor export exclusions: ${stale.join(', ')}`)
  const excludedSet = new Set(excluded)
  return deepPaths
    .filter((path) => path.startsWith('./') && !excludedSet.has(path))
    .map((path) => path.slice(2))
    .sort()
}

const assertActorSurfaceParity = (
  packageName: string,
  rootNames: ReadonlyArray<string>,
  deepPaths: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const actorNames = actorNamesOf(packageName, deepPaths)
  const rootSet = new Set(rootNames)
  const actorSet = new Set(actorNames)
  const rootOnly = rootNames.filter((name) => !actorSet.has(name)).sort()
  const deepOnly = actorNames.filter((name) => !rootSet.has(name)).sort()
  if (rootOnly.length > 0 || deepOnly.length > 0)
    throw new Error(
      `${packageName} actor export drift: root-only [${rootOnly.join(', ')}], deep-only [${deepOnly.join(', ')}]`,
    )
  return actorNames
}

const assertRuntimePathsNotExported = (
  cwd: string,
  packageName: string,
  names: ReadonlyArray<string>,
): void => {
  for (const name of names) {
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', `await import('${packageName}/${name}')`],
      { cwd, encoding: 'utf8' },
    )
    if (result.status === 0)
      throw new Error(`${packageName}/${name} unexpectedly resolved from the packed package`)
    if (!result.stderr.includes('ERR_PACKAGE_PATH_NOT_EXPORTED'))
      throw new Error(
        `${packageName}/${name} failed for the wrong reason\n${result.stdout}\n${result.stderr}`,
      )
  }
}

const assertTypeScriptActorSurfaceParity = (options: {
  readonly cwd: string
  readonly packageName: string
  readonly actorNames: ReadonlyArray<string>
  readonly forbiddenNames: ReadonlyArray<string>
}): void => {
  const positiveImports = options.actorNames.flatMap((name, index) => [
    `import { ${name} as Root${index} } from '${options.packageName}'`,
    `import * as Deep${index} from '${options.packageName}/${name}'`,
    `const rootToDeep${index}: typeof Deep${index} = Root${index}`,
    `const deepToRoot${index}: typeof Root${index} = Deep${index}`,
    `void rootToDeep${index}`,
    `void deepToRoot${index}`,
  ])
  const negativeImports = options.forbiddenNames.flatMap((name, index) => [
    `// @ts-expect-error ${name} is intentionally absent from the package subpaths`,
    `import * as ForbiddenDeep${index} from '${options.packageName}/${name}'`,
    `// @ts-expect-error ${name} is intentionally absent from the package root`,
    `const forbiddenRoot${index} = Root.${name}`,
    `void ForbiddenDeep${index}`,
    `void forbiddenRoot${index}`,
  ])
  writeFileSync(
    resolve(options.cwd, 'actor-surface.ts'),
    [`import * as Root from '${options.packageName}'`, ...positiveImports, ...negativeImports].join(
      '\n',
    ),
  )
  writeFileSync(
    resolve(options.cwd, 'tsconfig.actor-surface.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: [],
      },
      files: ['actor-surface.ts'],
    }),
  )
  const result = spawnSync(
    resolve(workspaceRoot, 'node_modules/.bin/tsc'),
    ['-p', 'tsconfig.actor-surface.json'],
    { cwd: options.cwd, encoding: 'utf8', timeout: 60_000 },
  )
  if (result.status === 0) return
  throw new Error(
    `TypeScript actor parity failed for ${options.packageName}\n${result.stdout}\n${result.stderr}`,
  )
}

test('actor parity rejects a root-only actor fixture', () => {
  expect(() => assertActorSurfaceParity('@fixture/root-only', ['Visible'], [])).toThrow(
    'root-only [Visible]',
  )
})

test('actor parity rejects a deep-only actor fixture', () => {
  expect(() => assertActorSurfaceParity('@fixture/deep-only', [], ['./Visible'])).toThrow(
    'deep-only [Visible]',
  )
})

test('the llvm release candidate is a self-contained ESM package', () => {
  const temporary = mkdtempSync(resolve(tmpdir(), 'silklang-release-candidate-'))

  try {
    const archiveRoot = resolve(temporary, 'archives')
    const unpackRoot = resolve(temporary, 'unpacked')
    mkdirSync(archiveRoot)
    mkdirSync(unpackRoot)

    execFileSync('pnpm', ['pack', '--pack-destination', archiveRoot], {
      cwd: packageRoot,
      stdio: 'pipe',
    })
    const archive = readdirSync(archiveRoot).find((file) => file.endsWith('.tgz'))
    expect(archive).toBeDefined()
    execFileSync('tar', ['-xzf', resolve(archiveRoot, archive ?? ''), '-C', unpackRoot])

    const packedRoot = resolve(unpackRoot, 'package')
    const manifest = JSON.parse(readFileSync(resolve(packedRoot, 'package.json'), 'utf8'))

    expect(manifest.name).toBe('@silklang/llvm')
    expect(manifest.private).not.toBe(true)
    expect(existsSync(resolve(packedRoot, 'dist/index.js'))).toBe(true)
    expect(existsSync(resolve(packedRoot, 'dist/index.d.ts'))).toBe(true)
    expect(existsSync(resolve(packedRoot, 'README.md'))).toBe(true)
    expect(existsSync(resolve(packedRoot, 'docs/reference/actors.md'))).toBe(true)
    expect(existsSync(resolve(packedRoot, 'docs/explanation/effect-native-builder.md'))).toBe(true)
    expect(existsSync(resolve(packedRoot, 'LICENSE'))).toBe(true)
    expect(existsSync(resolve(packedRoot, 'THIRD_PARTY_NOTICES.md'))).toBe(true)
    expect(existsSync(resolve(packedRoot, 'UPSTREAM.md'))).toBe(true)
    expect(existsSync(resolve(packedRoot, 'src'))).toBe(false)
    expect(existsSync(resolve(packedRoot, 'dist/LlvmError.js'))).toBe(true)
    expect(readFileSync(resolve(packedRoot, 'README.md'), 'utf8')).toContain('LlvmError')
    expect(readFileSync(resolve(packedRoot, 'docs/reference/actors.md'), 'utf8')).toContain(
      'WrappedFailure',
    )
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(['effect'])
    const packedFiles = (directory: string): ReadonlyArray<string> =>
      readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = resolve(directory, entry.name)
        return entry.isDirectory() ? packedFiles(path) : [path]
      })
    expect(
      packedFiles(packedRoot).filter(
        (file) =>
          file.endsWith('.zig') ||
          (file.endsWith('.ts') && !file.endsWith('.d.ts')) ||
          file.endsWith('/llvm-as') ||
          file.endsWith('/zig'),
      ),
    ).toEqual([])

    expect(Object.keys(manifest.exports).sort()).toEqual([
      '.',
      './AddrSpace',
      './Alias',
      './Alignment',
      './Attribute',
      './Bitcode',
      './Block',
      './Builder',
      './ByteString',
      './Constant',
      './DIFlags',
      './DISPFlags',
      './DataLayout',
      './Emitter',
      './FastMath',
      './Function',
      './FunctionBody',
      './Global',
      './IntegerMath',
      './Intrinsic',
      './IrText',
      './LlvmError',
      './MemoryAccess',
      './Metadata',
      './Type',
      './Value',
      './Variable',
      './Verify',
    ])

    const consumerRoot = resolve(temporary, 'consumer')
    mkdirSync(consumerRoot)
    writeFileSync(
      resolve(consumerRoot, 'package.json'),
      JSON.stringify({
        private: true,
        type: 'module',
        dependencies: { '@silklang/llvm': `file:${resolve(archiveRoot, archive ?? '')}` },
      }),
    )
    writeFileSync(resolve(consumerRoot, 'pnpm-workspace.yaml'), consumerWorkspace())
    installConsumer(consumerRoot)

    const deepPaths = Object.keys(manifest.exports)
      .filter((path) => path !== '.')
      .sort()
    const inspectApi = () =>
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `import * as api from '@silklang/llvm'; const paths = ${JSON.stringify(deepPaths)}; const modules = await Promise.all(paths.map((path) => import(\`@silklang/llvm/\${path.slice(2)}\`))); console.log(JSON.stringify({ root: Object.keys(api).sort(), rootNamespaces: Object.fromEntries(paths.filter((path) => path !== './LlvmError').map((path) => [path, Object.keys(api[path.slice(2)]).sort()])), deep: Object.fromEntries(paths.map((path, index) => [path, Object.keys(modules[index]).sort()])) }))`,
        ],
        {
          cwd: consumerRoot,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: dirname(process.execPath),
            ZIG_EXE: '/unavailable/zig',
            LLVM_AS: '/unavailable/llvm-as',
            LLVM_DIS: '/unavailable/llvm-dis',
            LLVM_OPT: '/unavailable/opt',
            LLVM_BCANALYZER: '/unavailable/llvm-bcanalyzer',
          },
        },
      )

    const first = inspectApi()
    const second = inspectApi()
    expect(first).toBe(second)
    const api = JSON.parse(first)
    expect(api.root).toEqual([
      'AddrSpace',
      'Alias',
      'Alignment',
      'Attribute',
      'Bitcode',
      'Block',
      'Builder',
      'ByteString',
      'Constant',
      'DIFlags',
      'DISPFlags',
      'DataLayout',
      'Emitter',
      'FastMath',
      'Function',
      'FunctionBody',
      'Global',
      'IntegerMath',
      'Intrinsic',
      'IrText',
      'LlvmError',
      'MemoryAccess',
      'Metadata',
      'Type',
      'Value',
      'Variable',
      'Verify',
    ])
    for (const [path, exports] of Object.entries(api.deep) as ReadonlyArray<
      readonly [string, ReadonlyArray<string>]
    >) {
      expect(exports.length, `${path} has no exports`).toBeGreaterThan(0)
      const rootName = path.slice(2)
      if (rootName === 'LlvmError') expect(exports).toContain('LlvmError')
      else expect(api.rootNamespaces[path]).toEqual(exports)
    }
    expect(api.deep['./Builder']).toContain('make')
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})

test('the compiler release candidate exposes only its LLVM compiler actors', () => {
  const temporary = mkdtempSync(resolve(tmpdir(), 'silklang-compiler-release-candidate-'))
  try {
    const archiveRoot = resolve(temporary, 'archives')
    const unpackRoot = resolve(temporary, 'unpacked')
    mkdirSync(archiveRoot)
    mkdirSync(unpackRoot)
    for (const root of [compilerPackageRoot, packageRoot])
      execFileSync('pnpm', ['pack', '--pack-destination', archiveRoot], {
        cwd: root,
        stdio: 'pipe',
      })

    const archives = readdirSync(archiveRoot)
    const archive = archives.find((file) => file.startsWith('silklang-compiler-'))
    const llvmArchive = archives.find((file) => file.startsWith('silklang-llvm-'))
    expect(archive).toBeDefined()
    expect(llvmArchive).toBeDefined()
    execFileSync('tar', ['-xzf', resolve(archiveRoot, archive ?? ''), '-C', unpackRoot])

    const packedRoot = resolve(unpackRoot, 'package')
    const manifest = JSON.parse(readFileSync(resolve(packedRoot, 'package.json'), 'utf8'))
    expect(manifest.name).toBe('@silklang/compiler')
    expect(manifest.private).not.toBe(true)
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      '@effect/platform-node',
      '@silklang/llvm',
      'effect',
      'smol-toml',
    ])
    const deepPaths = Object.keys(manifest.exports)
      .filter((entry) => entry !== '.')
      .sort()
    expect(deepPaths).toEqual([
      './AggregateIdentity',
      './Analysis',
      './ArtifactComposition',
      './ArtifactKind',
      './ArtifactPlan',
      './AuthoredEncoding',
      './AuthoredHir',
      './AuthoredIdentity',
      './AuthoredModule',
      './AuthoredPool',
      './AuthoredPresentation',
      './AutoImport',
      './Backend',
      './CTranslationUnit',
      './CTranslationUnitResolver',
      './CallableContract',
      './CleanupPlan',
      './CompilationProfile',
      './Completion',
      './ConfigurationError',
      './ConfigurationOrigin',
      './ConfigurationValue',
      './ConformanceGoal',
      './ConformanceHead',
      './Constraint',
      './DeclarationFacts',
      './DeclarationIndex',
      './Diagnostic',
      './DocBlock',
      './Driver',
      './Elaboration',
      './Evaluation',
      './ExecutableProperty',
      './ExecutionAffinity',
      './ExecutionBoundary',
      './ExecutionLifecycle',
      './ExecutionPackage',
      './FieldRealization',
      './FileSourceResolver',
      './FiniteRow',
      './FloatingPoint',
      './ForeignContract',
      './FormattedDocument',
      './HeapObservation',
      './HelperCapability',
      './HelperSource',
      './Hir',
      './ImportPath',
      './ImportPlan',
      './ImportUsage',
      './InspectorFlowModel',
      './InspectorPanels',
      './InspectorProjectBackend',
      './InspectorProjectSyntax',
      './InspectorRegistry',
      './InspectorRow',
      './Instances',
      './InterfaceWitnessCompatibility',
      './Intrinsic',
      './IntrinsicAvailability',
      './Layout',
      './LayoutEncode',
      './LayoutVerify',
      './Lexer',
      './LifetimeElision',
      './Linker',
      './LiteralForm',
      './LlvmBackend',
      './LocalSharedOwnership',
      './Lower',
      './MachineFunction',
      './Match',
      './Mir',
      './MirEncoding',
      './MirVerification',
      './ModuleClosure',
      './ModuleSelection',
      './ModuleSemantics',
      './ModuleSummary',
      './ModuleSurface',
      './ModuleTooling',
      './NameResolution',
      './NativeAssembly',
      './NativeLinkInput',
      './NativeLinkPlan',
      './NativeLinkResolver',
      './NativeRequirement',
      './NativeRequirementBinding',
      './NativeToolchain',
      './NodeHeapObservation',
      './ObjectEmission',
      './Operator',
      './Ownership',
      './PackageConfiguration',
      './PackageParameter',
      './Parser',
      './PhaseReport',
      './PlatformCatalog',
      './PlatformSupply',
      './PlatformSupplyResolver',
      './Preparation',
      './ProfileBootstrap',
      './Project',
      './ProjectAnalysis',
      './ProjectProfile',
      './ProviderSelection',
      './RepresentationField',
      './RequirementRow',
      './Residualization',
      './RowAlgebra',
      './RuntimeComponent',
      './Scalar',
      './Semantic',
      './SemanticContext',
      './SemanticDisplay',
      './SemanticInvalidation',
      './SemanticOccurrence',
      './SemanticPersistence',
      './SemanticQuery',
      './Source',
      './SourceAction',
      './SourceCatalog',
      './SourceEntry',
      './SourceFile',
      './SourceOrigin',
      './SourceResolver',
      './SourceSpan',
      './StaticValue',
      './Stdlib',
      './Storage',
      './SuspensionMode',
      './SyntaxFile',
      './SyntaxFormatter',
      './SyntaxTree',
      './Target',
      './TargetSelector',
      './TestDiscovery',
      './TestExecution',
      './Tir',
      './Token',
      './ToolchainIntegrity',
      './ToolchainPlan',
      './Transcendental',
      './Type',
      './TypeCompatibility',
      './TypeHint',
      './WorkspaceInventory',
    ])
    for (const removed of [
      './AuthoredLowering',
      './BackendRegistry',
      './BootstrapEvaluation',
      './ChildProcess',
      './ForeignHost',
      './HostInput',
      './MonotonicClock',
      './RandomHost',
      './StandardInput',
      './StandardStreams',
      './StaticEvaluation',
      './WasmBackend',
    ])
      expect(deepPaths).not.toContain(removed)
    expect(deepPaths).toContain('./Evaluation')
    expect(deepPaths).toContain('./LlvmBackend')
    expect(existsSync(resolve(packedRoot, 'dist/index.js'))).toBe(true)
    expect(existsSync(resolve(packedRoot, 'dist/index.d.ts'))).toBe(true)
    expect(existsSync(resolve(packedRoot, 'README.md'))).toBe(true)
    expect(existsSync(resolve(packedRoot, 'LICENSE'))).toBe(true)
    expect(existsSync(resolve(packedRoot, 'stdlib/manifest.json'))).toBe(true)
    expect(existsSync(resolve(packedRoot, 'stdlib/silk/allocator.silk'))).toBe(true)
    expect(existsSync(resolve(packedRoot, 'stdlib/silk/effect.silk'))).toBe(true)
    expect(existsSync(resolve(packedRoot, 'stdlib/silk/logger.silk'))).toBe(true)
    expect(existsSync(resolve(packedRoot, 'stdlib/silk/numeric.silk'))).toBe(true)
    expect(existsSync(resolve(packedRoot, 'stdlib/silk/compilation.silk'))).toBe(true)
    expect(existsSync(resolve(packedRoot, 'stdlib/silk/os_filesystem.silk'))).toBe(true)
    expect(existsSync(resolve(packedRoot, 'stdlib/silk/option.silk'))).toBe(true)
    expect(existsSync(resolve(packedRoot, 'stdlib/silk/result.silk'))).toBe(true)
    expect(existsSync(resolve(packedRoot, 'stdlib/silk/writer.silk'))).toBe(true)
    expect(existsSync(resolve(packedRoot, 'stdlib/silk/vector.silk'))).toBe(true)
    expect(existsSync(resolve(packedRoot, 'stdlib/silk/core.silk'))).toBe(false)
    expect(existsSync(resolve(packedRoot, 'stdlib/silk/logging.silk'))).toBe(false)
    expect(existsSync(resolve(packedRoot, 'src'))).toBe(false)
    const sourceStdlibManifest = JSON.parse(
      readFileSync(resolve(compilerPackageRoot, 'stdlib/manifest.json'), 'utf8'),
    ) as ReadonlyArray<{ readonly path: string }>
    expect(JSON.parse(readFileSync(resolve(packedRoot, 'stdlib/manifest.json'), 'utf8'))).toEqual(
      sourceStdlibManifest,
    )
    for (const entry of sourceStdlibManifest) {
      expect(existsSync(resolve(packedRoot, 'stdlib', entry.path))).toBe(true)
    }
    expect(readFileSync(resolve(packedRoot, 'stdlib/silk/effect.silk'), 'utf8')).toContain(
      'pub effect fn mapBoth',
    )
    expect(readFileSync(resolve(packedRoot, 'stdlib/silk/allocator.silk'), 'utf8')).toContain(
      'pub service Allocator',
    )
    expect(readFileSync(resolve(packedRoot, 'stdlib/silk/logger.silk'), 'utf8')).toContain(
      'pub service Logger',
    )
    expect(readFileSync(resolve(packedRoot, 'stdlib/silk/option.silk'), 'utf8')).toContain(
      'pub union Option<T>',
    )
    expect(readFileSync(resolve(packedRoot, 'stdlib/silk/os_filesystem.silk'), 'utf8')).toContain(
      'pub struct OsFileSystem',
    )
    expect(readFileSync(resolve(packedRoot, 'stdlib/silk/result.silk'), 'utf8')).toContain(
      'pub union Result<A, F>',
    )
    expect(readFileSync(resolve(packedRoot, 'stdlib/silk/writer.silk'), 'utf8')).toContain(
      'pub service Writer',
    )
    expect(readFileSync(resolve(packedRoot, 'stdlib/silk/vector.silk'), 'utf8')).toContain(
      'pub struct Vector<T>',
    )

    const packedFiles = (directory: string): ReadonlyArray<string> =>
      readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = resolve(directory, entry.name)
        return entry.isDirectory() ? packedFiles(path) : [path]
      })
    const compilerFiles = packedFiles(packedRoot)
    expect(compilerFiles.filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'))).toEqual(
      [],
    )
    expect(compilerFiles.filter((file) => file.includes('syntax-inspector'))).toEqual([])

    const consumerRoot = resolve(temporary, 'consumer')
    mkdirSync(consumerRoot)
    writeFileSync(
      resolve(consumerRoot, 'package.json'),
      JSON.stringify({
        private: true,
        type: 'module',
        dependencies: {
          '@silklang/compiler': `file:${resolve(archiveRoot, archive ?? '')}`,
          effect: manifest.dependencies.effect,
        },
      }),
    )
    writeFileSync(
      resolve(consumerRoot, 'pnpm-workspace.yaml'),
      consumerWorkspace(
        `  '@silklang/llvm': file:${resolve(archiveRoot, llvmArchive ?? '')}\n  smol-toml: ${installedVersion(compilerPackageRoot, 'smol-toml')}\n`,
      ),
    )
    installConsumer(consumerRoot)
    const inspected = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `import * as api from '@silklang/compiler'; const paths = ${JSON.stringify(deepPaths)}; const modules = await Promise.all(paths.map((entry) => import('@silklang/compiler/' + entry.slice(2)))); console.log(JSON.stringify({ root: Object.keys(api).sort(), deep: modules.map((entry) => Object.keys(entry).sort()) }));`,
      ],
      {
        cwd: consumerRoot,
        encoding: 'utf8',
        env: { ...process.env, PATH: dirname(process.execPath) },
      },
    )
    const api = JSON.parse(inspected)
    expect(api.root).not.toContain('BootstrapEvaluation')
    expect(api.root).not.toContain('WasmBackend')
    expect(api.root).toContain('Evaluation')
    expect(api.root).not.toContain('AuthoredLowering')
    expect(api.root).not.toContain('StaticEvaluation')
    expect(api.deep).toHaveLength(deepPaths.length)
    for (const [index, exports] of api.deep.entries()) {
      const path = deepPaths[index]
      if (path === './CTranslationUnit' || path === './NativeLinkPlan') {
        expect(exports).toEqual([])
        expect(readFileSync(resolve(packedRoot, `dist/${path.slice(2)}.d.ts`), 'utf8')).toContain(
          `export interface ${path.slice(2)}`,
        )
      } else expect(exports.length, `${path} has no exports`).toBeGreaterThan(0)
    }
    assertActorSurfaceParity('@silklang/compiler', api.root, deepPaths)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}, 30_000)

test('the docgen release candidate exposes all documentation actors', () => {
  const temporary = mkdtempSync(resolve(tmpdir(), 'silklang-docgen-release-candidate-'))

  try {
    const archiveRoot = resolve(temporary, 'archives')
    const unpackRoot = resolve(temporary, 'unpacked')
    mkdirSync(archiveRoot)
    mkdirSync(unpackRoot)
    for (const root of [docgenPackageRoot, compilerPackageRoot, packageRoot])
      execFileSync('pnpm', ['pack', '--pack-destination', archiveRoot], {
        cwd: root,
        stdio: 'pipe',
      })

    const archives = readdirSync(archiveRoot)
    const archive = archives.find((file) => file.startsWith('silklang-docgen-'))
    const compilerArchive = archives.find(
      (file) => file.startsWith('silklang-compiler-') && !file.includes('-cli-'),
    )
    const llvmArchive = archives.find((file) => file.startsWith('silklang-llvm-'))
    expect(archive).toBeDefined()
    execFileSync('tar', ['-xzf', resolve(archiveRoot, archive ?? ''), '-C', unpackRoot])

    const packedRoot = resolve(unpackRoot, 'package')
    const manifest = JSON.parse(readFileSync(resolve(packedRoot, 'package.json'), 'utf8'))
    expect(manifest.name).toBe('@silklang/docgen')
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      '@silklang/compiler',
      'effect',
      'mdast-util-from-markdown',
    ])
    expect(Object.keys(manifest.exports).sort()).toEqual([
      '.',
      './CodeFence',
      './Doctest',
      './Document',
      './Example',
      './Highlight',
      './Html',
      './Json',
      './Model',
      './Project',
      './Prose',
      './Report',
      './Search',
      './Site',
      './Sources',
      './Stdlib',
    ])
    expect(existsSync(resolve(packedRoot, 'dist/index.js'))).toBe(true)
    expect(existsSync(resolve(packedRoot, 'dist/index.d.ts'))).toBe(true)
    expect(existsSync(resolve(packedRoot, 'README.md'))).toBe(true)
    expect(existsSync(resolve(packedRoot, 'LICENSE'))).toBe(true)
    expect(existsSync(resolve(packedRoot, 'src'))).toBe(false)
    expect(existsSync(resolve(packedRoot, 'test'))).toBe(false)

    const consumerRoot = resolve(temporary, 'consumer')
    mkdirSync(consumerRoot)
    writeFileSync(
      resolve(consumerRoot, 'package.json'),
      JSON.stringify({
        private: true,
        type: 'module',
        dependencies: {
          '@silklang/docgen': `file:${resolve(archiveRoot, archive ?? '')}`,
        },
      }),
    )
    writeFileSync(
      resolve(consumerRoot, 'pnpm-workspace.yaml'),
      consumerWorkspace(
        `  '@silklang/compiler': file:${resolve(archiveRoot, compilerArchive ?? '')}\n  '@silklang/llvm': file:${resolve(archiveRoot, llvmArchive ?? '')}\n  smol-toml: ${installedVersion(compilerPackageRoot, 'smol-toml')}\n`,
      ),
    )
    installConsumer(consumerRoot)
    const api = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `import * as api from '@silklang/docgen'; console.log(JSON.stringify(Object.keys(api).sort()))`,
        ],
        { cwd: consumerRoot, encoding: 'utf8' },
      ),
    )
    expect(api).toEqual([
      'CodeFence',
      'Doctest',
      'Document',
      'Example',
      'Highlight',
      'Html',
      'Json',
      'Model',
      'Project',
      'Prose',
      'Report',
      'Search',
      'Site',
      'Sources',
      'Stdlib',
    ])
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}, 30_000)

test('the formatter release candidate installs offline with root and deep API parity', () => {
  const temporary = mkdtempSync(resolve(tmpdir(), 'silklang-formatter-release-candidate-'))

  try {
    const archiveRoot = resolve(temporary, 'archives')
    const unpackRoot = resolve(temporary, 'unpacked')
    mkdirSync(archiveRoot)
    mkdirSync(unpackRoot)
    for (const root of [formatterPackageRoot, docgenPackageRoot, compilerPackageRoot, packageRoot])
      execFileSync('pnpm', ['pack', '--pack-destination', archiveRoot], {
        cwd: root,
        stdio: 'pipe',
      })

    const archives = readdirSync(archiveRoot)
    const archive = archives.find((file) => file.startsWith('silklang-formatter-'))
    const docgenArchive = archives.find((file) => file.startsWith('silklang-docgen-'))
    const compilerArchive = archives.find(
      (file) => file.startsWith('silklang-compiler-') && !file.includes('-cli-'),
    )
    const llvmArchive = archives.find((file) => file.startsWith('silklang-llvm-'))
    expect(archive).toBeDefined()
    execFileSync('tar', ['-xzf', resolve(archiveRoot, archive ?? ''), '-C', unpackRoot])

    const packedRoot = resolve(unpackRoot, 'package')
    const manifest = JSON.parse(readFileSync(resolve(packedRoot, 'package.json'), 'utf8'))
    expect(manifest.name).toBe('@silklang/formatter')
    expect(manifest.private).not.toBe(true)
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      '@silklang/compiler',
      '@silklang/docgen',
      'effect',
    ])
    expect(Object.keys(manifest.exports).sort()).toEqual(['.', './Formatter', './FormatterError'])
    expect(existsSync(resolve(packedRoot, 'dist/index.js'))).toBe(true)
    expect(existsSync(resolve(packedRoot, 'dist/index.d.ts'))).toBe(true)
    expect(existsSync(resolve(packedRoot, 'README.md'))).toBe(true)
    expect(existsSync(resolve(packedRoot, 'LICENSE'))).toBe(true)
    expect(existsSync(resolve(packedRoot, 'src'))).toBe(false)
    expect(existsSync(resolve(packedRoot, 'test'))).toBe(false)

    const consumerRoot = resolve(temporary, 'consumer')
    mkdirSync(consumerRoot)
    writeFileSync(
      resolve(consumerRoot, 'package.json'),
      JSON.stringify({
        private: true,
        type: 'module',
        dependencies: {
          '@silklang/formatter': `file:${resolve(archiveRoot, archive ?? '')}`,
        },
      }),
    )
    writeFileSync(
      resolve(consumerRoot, 'pnpm-workspace.yaml'),
      consumerWorkspace(
        `  '@silklang/compiler': file:${resolve(archiveRoot, compilerArchive ?? '')}\n  '@silklang/docgen': file:${resolve(archiveRoot, docgenArchive ?? '')}\n  '@silklang/llvm': file:${resolve(archiveRoot, llvmArchive ?? '')}\n  smol-toml: ${installedVersion(compilerPackageRoot, 'smol-toml')}\n`,
      ),
    )
    installConsumer(consumerRoot)

    const inspected = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `import * as api from '@silklang/formatter';
import * as Formatter from '@silklang/formatter/Formatter';
import * as FormatterError from '@silklang/formatter/FormatterError';
console.log(JSON.stringify({
  root: Object.keys(api).sort(),
  formatterRoot: Object.keys(api.Formatter).sort(),
  formatterDeep: Object.keys(Formatter).sort(),
  errorRoot: Object.keys(api.FormatterError).sort(),
  errorDeep: Object.keys(FormatterError).sort(),
}));`,
        ],
        { cwd: consumerRoot, encoding: 'utf8' },
      ),
    )
    expect(inspected.root).toEqual(['Formatter', 'FormatterError'])
    expect(inspected.formatterRoot).toEqual(inspected.formatterDeep)
    expect(inspected.errorRoot).toEqual(inspected.errorDeep)
    expect(inspected.formatterDeep).toContain('format')
    expect(inspected.errorDeep).toContain('FormatterError')
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}, 30_000)

test('the CLI release candidate installs with its project-first command surface', () => {
  const temporary = mkdtempSync(resolve(tmpdir(), 'silklang-cli-release-candidate-'))

  try {
    const archiveRoot = resolve(temporary, 'archives')
    const unpackRoot = resolve(temporary, 'unpacked')
    mkdirSync(archiveRoot)
    mkdirSync(unpackRoot)

    for (const root of [
      cliPackageRoot,
      compilerPackageRoot,
      docgenPackageRoot,
      formatterPackageRoot,
      packageRoot,
    ]) {
      execFileSync('pnpm', ['pack', '--pack-destination', archiveRoot], {
        cwd: root,
        stdio: 'pipe',
      })
    }

    const archives = readdirSync(archiveRoot)
    const archive = archives.find(
      (file) => file.startsWith('silklang-cli-') && file.endsWith('.tgz'),
    )
    const compilerArchive = archives.find(
      (file) => file.startsWith('silklang-compiler-') && !file.includes('-cli-'),
    )
    const llvmArchive = archives.find((file) => file.startsWith('silklang-llvm-'))
    const docgenArchive = archives.find((file) => file.startsWith('silklang-docgen-'))
    const formatterArchive = archives.find((file) => file.startsWith('silklang-formatter-'))
    expect(archive).toBeDefined()
    expect(compilerArchive).toBeDefined()
    expect(llvmArchive).toBeDefined()
    expect(docgenArchive).toBeDefined()
    expect(formatterArchive).toBeDefined()
    execFileSync('tar', ['-xzf', resolve(archiveRoot, archive ?? ''), '-C', unpackRoot])

    const packedRoot = resolve(unpackRoot, 'package')
    const manifest = JSON.parse(readFileSync(resolve(packedRoot, 'package.json'), 'utf8'))
    expect(manifest.name).toBe('@silklang/cli')
    expect(manifest.private).not.toBe(true)
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      '@effect/platform-node',
      '@silklang/compiler',
      '@silklang/docgen',
      '@silklang/formatter',
      'effect',
    ])
    expect(Object.keys(manifest.exports).sort()).toEqual([
      '.',
      './BuildBatch',
      './BuildCommand',
      './BuildExeCommand',
      './BuildPlan',
      './CheckCommand',
      './Cli',
      './DocCommand',
      './DoctestCommand',
      './DocumentationSiteCommand',
      './DocumentationWorkflow',
      './FormatCommand',
      './FormatWorkflow',
      './InitCommand',
      './Program',
      './ProjectInitializer',
      './ProjectOptions',
      './Report',
      './RunCommand',
      './TestCommand',
      './TestExchange',
      './TestResult',
      './Workflow',
    ])
    expect(manifest.exports).not.toHaveProperty('./CompileCommand')
    expect(manifest.bin).toEqual({ silk: './dist/bin.js' })
    expect(existsSync(resolve(packedRoot, 'dist/bin.js'))).toBe(true)
    expect(existsSync(resolve(packedRoot, 'dist/index.d.ts'))).toBe(true)
    expect(existsSync(resolve(packedRoot, 'README.md'))).toBe(true)
    expect(existsSync(resolve(packedRoot, 'LICENSE'))).toBe(true)
    expect(existsSync(resolve(packedRoot, 'src'))).toBe(false)
    expect(existsSync(resolve(packedRoot, 'test'))).toBe(false)

    const consumerRoot = resolve(temporary, 'consumer')
    mkdirSync(consumerRoot)
    writeFileSync(
      resolve(consumerRoot, 'package.json'),
      JSON.stringify({
        private: true,
        type: 'module',
        dependencies: {
          '@silklang/cli': `file:${resolve(archiveRoot, archive ?? '')}`,
        },
      }),
    )
    writeFileSync(
      resolve(consumerRoot, 'pnpm-workspace.yaml'),
      consumerWorkspace(
        `  '@silklang/compiler': file:${resolve(archiveRoot, compilerArchive ?? '')}\n  '@silklang/docgen': file:${resolve(archiveRoot, docgenArchive ?? '')}\n  '@silklang/formatter': file:${resolve(archiveRoot, formatterArchive ?? '')}\n  '@silklang/llvm': file:${resolve(archiveRoot, llvmArchive ?? '')}\n  smol-toml: ${installedVersion(compilerPackageRoot, 'smol-toml')}\nallowBuilds:\n  msgpackr-extract: false\n  sharp: false\n`,
      ),
    )
    installConsumer(consumerRoot)

    const executable = resolve(consumerRoot, 'node_modules/.bin/silk')
    const help = execFileSync(executable, ['--help'], { cwd: consumerRoot, encoding: 'utf8' })
    expect(help).toContain('build        Build the nearest Silk project.')
    expect(help).toContain('check        Analyze the nearest Silk project')
    expect(help).toContain(
      'doc          Generate experimental formatter-neutral documentation JSON.',
    )
    expect(help).toContain('doctest      Compile the fenced Silk examples')
    expect(help).toContain('docs-site    Render a static HTML documentation site')
    expect(help).toContain(
      'format       Format Silk project source into its canonical representation.',
    )
    expect(help).toContain('run          Build and run the nearest Silk project.')
    expect(help).toContain('build-exe    Build one rooted Silk source graph')
    expect(help).not.toContain('\n  compile ')

    writeFileSync(
      resolve(consumerRoot, 'silk.toml'),
      '[package]\nname = "packed-cli"\nversion = "0.1.0"\nroot = "Main.silk"\n',
    )
    mkdirSync(resolve(consumerRoot, 'silk'))
    writeFileSync(resolve(consumerRoot, 'silk/vector.silk'), 'pub struct Hostile {}')
    writeFileSync(
      resolve(consumerRoot, 'Main.silk'),
      'import silk.vector { Vector }\npub fn main() -> i32 { return 42 }',
    )
    execFileSync(executable, ['check'], { cwd: consumerRoot, stdio: 'pipe' })
    expect(existsSync(resolve(consumerRoot, '.silk'))).toBe(false)

    const api = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `import * as api from '@silklang/cli'; console.log(JSON.stringify(Object.keys(api).sort()))`,
        ],
        { cwd: consumerRoot, encoding: 'utf8' },
      ),
    )
    expect(api).toEqual([
      'BuildBatch',
      'BuildCommand',
      'BuildExeCommand',
      'BuildPlan',
      'CheckCommand',
      'Cli',
      'DocCommand',
      'DoctestCommand',
      'DocumentationSiteCommand',
      'DocumentationWorkflow',
      'FormatCommand',
      'FormatWorkflow',
      'InitCommand',
      'Program',
      'ProjectInitializer',
      'ProjectOptions',
      'Report',
      'RunCommand',
      'TestCommand',
      'TestExchange',
      'TestResult',
      'Workflow',
    ])
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}, 30_000)

test('the lsp release candidate installs and answers an initialize request', async () => {
  const temporary = mkdtempSync(resolve(tmpdir(), 'silklang-lsp-release-candidate-'))

  try {
    const archiveRoot = resolve(temporary, 'archives')
    const unpackRoot = resolve(temporary, 'unpacked')
    mkdirSync(archiveRoot)
    mkdirSync(unpackRoot)

    for (const root of [
      lspPackageRoot,
      compilerPackageRoot,
      docgenPackageRoot,
      formatterPackageRoot,
      packageRoot,
    ]) {
      execFileSync('pnpm', ['pack', '--pack-destination', archiveRoot], {
        cwd: root,
        stdio: 'pipe',
      })
    }

    const archives = readdirSync(archiveRoot)
    const archive = archives.find((file) => file.startsWith('silklang-lsp-'))
    const compilerArchive = archives.find(
      (file) => file.startsWith('silklang-compiler-') && !file.includes('-cli-'),
    )
    const llvmArchive = archives.find((file) => file.startsWith('silklang-llvm-'))
    const docgenArchive = archives.find((file) => file.startsWith('silklang-docgen-'))
    const formatterArchive = archives.find((file) => file.startsWith('silklang-formatter-'))
    expect(archive).toBeDefined()
    expect(docgenArchive).toBeDefined()
    expect(formatterArchive).toBeDefined()
    execFileSync('tar', ['-xzf', resolve(archiveRoot, archive ?? ''), '-C', unpackRoot])

    const packedRoot = resolve(unpackRoot, 'package')
    const manifest = JSON.parse(readFileSync(resolve(packedRoot, 'package.json'), 'utf8'))
    expect(manifest.name).toBe('@silklang/lsp')
    expect(manifest.private).not.toBe(true)
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      '@effect/platform-node',
      '@silklang/compiler',
      '@silklang/docgen',
      '@silklang/formatter',
      'effect',
      'vscode-languageserver',
      'vscode-languageserver-textdocument',
      'vscode-languageserver-types',
    ])
    expect(manifest.bin).toEqual({ 'silk-lsp': './dist/bin.js' })
    expect(Object.keys(manifest.exports).sort()).toEqual([
      '.',
      './Document',
      './Inspection',
      './LineIndex',
      './Server',
      './Workspace',
      './bin',
    ])
    expect(existsSync(resolve(packedRoot, 'dist/bin.js'))).toBe(true)
    expect(existsSync(resolve(packedRoot, 'dist/index.d.ts'))).toBe(true)
    expect(existsSync(resolve(packedRoot, 'README.md'))).toBe(true)
    expect(existsSync(resolve(packedRoot, 'LICENSE'))).toBe(true)
    expect(existsSync(resolve(packedRoot, 'src'))).toBe(false)
    expect(existsSync(resolve(packedRoot, 'test'))).toBe(false)

    const consumerRoot = resolve(temporary, 'consumer')
    mkdirSync(consumerRoot)
    writeFileSync(
      resolve(consumerRoot, 'package.json'),
      JSON.stringify({
        private: true,
        type: 'module',
        dependencies: {
          '@silklang/lsp': `file:${resolve(archiveRoot, archive ?? '')}`,
        },
      }),
    )
    writeFileSync(
      resolve(consumerRoot, 'pnpm-workspace.yaml'),
      consumerWorkspace(
        `  '@silklang/compiler': file:${resolve(archiveRoot, compilerArchive ?? '')}\n  '@silklang/docgen': file:${resolve(archiveRoot, docgenArchive ?? '')}\n  '@silklang/formatter': file:${resolve(archiveRoot, formatterArchive ?? '')}\n  '@silklang/llvm': file:${resolve(archiveRoot, llvmArchive ?? '')}\n  smol-toml: ${installedVersion(compilerPackageRoot, 'smol-toml')}\n  vscode-languageserver: ${lspInstalledVersion('vscode-languageserver')}\n  vscode-languageserver-textdocument: ${lspInstalledVersion('vscode-languageserver-textdocument')}\nallowBuilds:\n  msgpackr-extract: false\n  sharp: false\n`,
      ),
    )
    installConsumer(consumerRoot)

    const deepPaths = Object.keys(manifest.exports)
      .filter((path) => path !== '.')
      .sort()
    const actorPaths = actorNamesOf('@silklang/lsp', deepPaths).map((name) => `./${name}`)
    const inspected = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `import * as api from '@silklang/lsp'; const paths = ${JSON.stringify(actorPaths)}; const modules = await Promise.all(paths.map((path) => import(\`@silklang/lsp/\${path.slice(2)}\`))); console.log(JSON.stringify({ root: Object.keys(api).sort(), rootNamespaces: Object.fromEntries(paths.map((path) => [path, Object.keys(api[path.slice(2)]).sort()])), deep: Object.fromEntries(paths.map((path, index) => [path, Object.keys(modules[index]).sort()])) }));`,
        ],
        { cwd: consumerRoot, encoding: 'utf8' },
      ),
    )
    expect(inspected.root).toEqual(['Document', 'Inspection', 'LineIndex', 'Server', 'Workspace'])
    const actorNames = assertActorSurfaceParity('@silklang/lsp', inspected.root, deepPaths)
    for (const path of actorPaths) {
      expect(inspected.deep[path].length, `${path} has no exports`).toBeGreaterThan(0)
      expect(inspected.rootNamespaces[path]).toEqual(inspected.deep[path])
    }
    assertRuntimePathsNotExported(consumerRoot, '@silklang/lsp', ['WorkspaceCatalog'])
    assertTypeScriptActorSurfaceParity({
      cwd: consumerRoot,
      packageName: '@silklang/lsp',
      actorNames,
      forbiddenNames: ['WorkspaceCatalog'],
    })

    const executable = resolve(consumerRoot, 'node_modules/.bin/silk-lsp')
    const initialize = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { processId: null, rootUri: null, capabilities: {} },
    })
    const response = await new Promise<string>((resolvePromise, rejectPromise) => {
      const server = spawn(executable, [], { cwd: consumerRoot })
      let output = ''
      const finish = (): void => {
        server.kill()
        resolvePromise(output)
      }
      const timer = setTimeout(() => {
        server.kill()
        rejectPromise(new Error(`silk-lsp answered nothing; saw: ${output}`))
      }, 15_000)
      server.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8')
        if (output.includes('"capabilities"')) {
          clearTimeout(timer)
          finish()
        }
      })
      server.on('error', (error) => {
        clearTimeout(timer)
        rejectPromise(error)
      })
      server.stdin.write(`Content-Length: ${Buffer.byteLength(initialize)}\r\n\r\n${initialize}`)
    })
    expect(response).toContain('"hoverProvider":true')
    expect(response).toContain('"documentFormattingProvider":true')
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}, 120_000)

test('the WebContainer release candidate exposes every SSR-safe actor subpath', () => {
  const temporary = mkdtempSync(resolve(tmpdir(), 'silklang-webcontainer-release-candidate-'))

  try {
    const archiveRoot = resolve(temporary, 'archives')
    const unpackRoot = resolve(temporary, 'unpacked')
    mkdirSync(archiveRoot)
    mkdirSync(unpackRoot)

    execFileSync('pnpm', ['pack', '--pack-destination', archiveRoot], {
      cwd: webContainerPackageRoot,
      stdio: 'pipe',
    })

    const archive = readdirSync(archiveRoot).find((file) => file.endsWith('.tgz'))
    expect(archive).toBeDefined()
    execFileSync('tar', ['-xzf', resolve(archiveRoot, archive ?? ''), '-C', unpackRoot])

    const packedRoot = resolve(unpackRoot, 'package')
    const manifest = JSON.parse(readFileSync(resolve(packedRoot, 'package.json'), 'utf8'))
    const actorPaths = [
      './WebContainer',
      './WebContainerError',
      './WebContainerEvent',
      './WebContainerFileSystem',
      './WebContainerProcess',
    ]
    expect(manifest.name).toBe('@silklang/platform-webcontainer')
    expect(manifest.private).not.toBe(true)
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(['@webcontainer/api', 'effect'])
    expect(Object.keys(manifest.exports).sort()).toEqual(['.', ...actorPaths])
    expect(existsSync(resolve(packedRoot, 'dist/index.js'))).toBe(true)
    expect(existsSync(resolve(packedRoot, 'dist/index.d.ts'))).toBe(true)
    expect(existsSync(resolve(packedRoot, 'README.md'))).toBe(true)
    expect(existsSync(resolve(packedRoot, 'LICENSE'))).toBe(true)
    expect(existsSync(resolve(packedRoot, 'src'))).toBe(false)
    expect(existsSync(resolve(packedRoot, 'test'))).toBe(false)
    for (const actorPath of actorPaths) {
      const name = actorPath.slice(2)
      expect(existsSync(resolve(packedRoot, `dist/${name}.js`))).toBe(true)
      expect(existsSync(resolve(packedRoot, `dist/${name}.d.ts`))).toBe(true)
    }

    const consumerRoot = resolve(temporary, 'consumer')
    mkdirSync(consumerRoot)
    writeFileSync(
      resolve(consumerRoot, 'package.json'),
      JSON.stringify({
        private: true,
        type: 'module',
        dependencies: {
          '@silklang/platform-webcontainer': `file:${resolve(archiveRoot, archive ?? '')}`,
        },
      }),
    )
    writeFileSync(resolve(consumerRoot, 'pnpm-workspace.yaml'), consumerWorkspace())
    installConsumer(consumerRoot)
    const inspected = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `import * as api from '@silklang/platform-webcontainer'; const paths = ${JSON.stringify(actorPaths)}; const modules = await Promise.all(paths.map((path) => import(\`@silklang/platform-webcontainer/\${path.slice(2)}\`))); console.log(JSON.stringify({ root: Object.keys(api).sort(), deep: Object.fromEntries(paths.map((path, index) => [path, Object.keys(modules[index]).sort()])) }));`,
        ],
        { cwd: consumerRoot, encoding: 'utf8' },
      ),
    )
    expect(inspected.root).toEqual(actorPaths.map((path) => path.slice(2)).sort())
    for (const actorPath of actorPaths) {
      expect(inspected.deep[actorPath].length, `${actorPath} has no exports`).toBeGreaterThan(0)
    }
    expect(inspected.deep['./WebContainer']).toContain('layer')
    expect(inspected.deep['./WebContainerFileSystem']).toContain('layer')
    expect(inspected.deep['./WebContainerProcess']).toContain('fromWebStreams')
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})
