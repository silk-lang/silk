import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import * as Corpus from './CorpusOutcomeReceipt.js'
import * as Tir from '../../packages/compiler/src/Tir.js'
import { SeedSchema } from './NativeSeed.mjs'
import { InputSnapshotSchema } from './SourceSnapshot.mjs'

export class ValidationError extends Data.TaggedError('StrictMeasurementReportError')<{
  readonly phase: 'Transport' | 'Coverage' | 'Identity' | 'Pins' | 'Corpus' | 'Previous'
  readonly message: string
  readonly cause?: unknown
}> {}
const reject = (phase: ValidationError['phase'], message: string) =>
  new ValidationError({ phase, message })
const decode = Effect.fnUntraced(function* <A>(schema: Schema.Decoder<A>, input: unknown) {
  return yield* Schema.decodeUnknownEffect(schema)(input, { onExcessProperty: 'error' }).pipe(
    Effect.mapError(
      (cause) => new ValidationError({ phase: 'Transport', message: cause.message, cause }),
    ),
  )
})
const parse = Effect.fnUntraced(function* (text: string) {
  return yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
    Effect.mapError(
      (cause) => new ValidationError({ phase: 'Transport', message: 'Malformed JSON', cause }),
    ),
  )
})
const hash = Effect.fnUntraced(function* (bytes: string | Uint8Array) {
  return yield* Effect.try({
    try: () => createHash('sha256').update(bytes).digest('hex'),
    catch: (cause) =>
      new ValidationError({ phase: 'Pins', message: 'Could not hash exact bytes', cause }),
  })
})
const S = Schema.String
const N = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const U = Schema.Json
const nullable = <A extends Schema.Top>(schema: A) => Schema.Union([schema, Schema.Null])
const object = Schema.Record(S, U)
const Span = Schema.Struct({ start: N, end: N })
const Module = Schema.Struct({ origin: S, package: S, path: S })
const Declaration = Schema.Struct({
  module: Module,
  owners: Schema.NonEmptyArray(Schema.Struct({ kind: S, name: nullable(S), occurrence: N })),
})
const Fact = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('signature'),
    parameters: N,
    type_parameters: N,
    lifetime_parameters: N,
    row_parameters: N,
    constraints: N,
    effect: Schema.Boolean,
    unsafe: Schema.Boolean,
    static: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal('body'),
    checking_stage: Schema.Literals(['fully-checked', 'contract-typed']),
    borrow_status: Schema.Literal('not-checked'),
  }),
  Schema.Struct({ kind: Schema.Literal('rejected'), code: S, module: Module, span: Span }),
  Schema.Struct({
    kind: Schema.Literal('unsupported'),
    code: S,
    module: Module,
    span: Span,
    diagnostic_code: Schema.optionalKey(S),
  }),
  Schema.Struct({ kind: Schema.Literal('query-error'), code: S }),
  Schema.Struct({ kind: Schema.Literal('wrong-value') }),
])
const Header = { schema: Schema.Literal('silk.strict-inventory'), version: Schema.Literal(1) }
const FunctionRow = Schema.Struct({
  ...Header,
  record: Schema.Literal('function'),
  declaration: Declaration,
  span: Span,
  header_span: Span,
  name_span: Span,
  source_observation: Schema.Struct({
    module: Module,
    present: Schema.Boolean,
    sha256: nullable(S),
    revision: N,
  }),
  phase: Schema.Literals(['signature', 'body']),
  eligibility: Schema.Literals([
    'eligible',
    'inactive',
    'no-body',
    'missing-source',
    'condition-rejected',
  ]),
  has_body: Schema.Boolean,
  fact: Fact,
})
const ModuleRow = Schema.Struct({
  ...Header,
  record: Schema.Literal('module'),
  module: Module,
  source_file: S,
  physical_source_file: S,
  role: Schema.Literals(['compiler-subject', 'stdlib-input', 'other-input']),
  present: Schema.Boolean,
  sha256: nullable(S),
  revision: N,
  functions: N,
  excluded_anonymous: N,
  excluded_damaged: N,
  status: S,
})
const ImportRow = Schema.Struct({
  ...Header,
  record: Schema.Literal('import'),
  declaration: Declaration,
  fact: Fact,
})
const Profile = Schema.Struct({ optimization: S, debug: Schema.Boolean })
const Footer = Schema.Struct({
  ...Header,
  record: Schema.Literal('footer'),
  coverage_complete: Schema.Boolean,
  strict_success: Schema.Boolean,
  modules: nullable(N),
  functions: nullable(N),
  records: nullable(N),
  expected_records: nullable(N),
  revision: N,
  collection_passes: N,
  phase_demands_with_publications: N,
  input_observation_sha256: S,
  target: S,
  profile: Profile,
  request_policy: Schema.Literal('fresh-after-publication'),
  recovery: Schema.Literal(false),
  producer: Schema.Struct({
    kind: Schema.Literal('bootstrap-built-diagnostic'),
    file: S,
    sha256: S,
  }),
  seed_receipt_sha256: S,
  consumed_seed_receipt_raw: S,
})
const NativeRow = Schema.Union([FunctionRow, ModuleRow, ImportRow, Footer])
type NativeFunction = Schema.Schema.Type<typeof FunctionRow>
type NativeModule = Schema.Schema.Type<typeof ModuleRow>
const Canonical = Schema.TaggedStruct('CanonicalDeclarationId', { module: S, name: S })
const Id = Schema.TaggedStruct('DeclarationId', { sourceId: S, ordinal: N })
const SourceSpan = Schema.Struct({ sourceId: S, start: N, end: N })
const Owner = Schema.TaggedStruct('AuthoredIdentity', {
  namespace: S,
  module: S,
  path: Schema.Array(
    Schema.TaggedStruct('OwnerSegment', {
      kind: S,
      name: Schema.optionalKey(S),
      role: Schema.optionalKey(S),
      occurrence: N,
    }),
  ),
})
const Anchor = Schema.TaggedStruct('AuthoredAnchor', {
  owner: Owner,
  path: Schema.Array(Schema.TaggedStruct('LocalSegment', { role: S, occurrence: N })),
})
const Location = Schema.Union([
  Schema.TaggedStruct('At', { anchor: Anchor, edge: Schema.optionalKey(Schema.Literal('End')) }),
  Schema.TaggedStruct('In', {
    parts: Schema.Array(
      Schema.Union([
        Schema.TaggedStruct('Literal', { at: Anchor, range: Span }),
        Schema.TaggedStruct('Parameter', { scope: Schema.optionalKey(S), ordinal: N, range: Span }),
      ]),
    ),
    fallback: Anchor,
  }),
])
const CanonicalState = Schema.Union([
  Schema.TaggedStruct('Canonical', { id: Canonical }),
  Schema.TaggedStruct('Duplicate', {
    original: Canonical,
    cause: Schema.TaggedStruct('DiagnosticIdentity', {
      phase: Schema.Literals(['lexical', 'parser', 'module', 'semantic', 'ownership', 'layout']),
      code: S,
      span: Location,
      ordinal: N,
    }),
  }),
  Schema.TaggedStruct('Unidentified', {}),
])
const Authored = Schema.Struct({
  id: Id,
  canonical: CanonicalState,
  lookupName: Schema.optionalKey(S),
  owner: Owner,
  anchor: Anchor,
  declarationSpan: SourceSpan,
  name: Schema.Struct({ spelling: S, anchor: Anchor, span: SourceSpan }),
})
const Key = Schema.Struct({
  identity: S,
  declaration: Schema.TaggedStruct('CanonicalDeclarationId', {
    module: S,
    name: S,
  }),
  typeArguments: Schema.Array(S),
  staticArguments: Schema.Array(S),
  contractRow: Schema.Array(S),
  evidence: Schema.Array(S),
})
const Artifact = Schema.Struct({
  owner: Owner,
  request: Schema.Union([
    Schema.TaggedStruct('Check', {}),
    Schema.TaggedStruct('Specialize', { application: S }),
  ]),
  parent: Schema.optionalKey(object),
})
const Origin = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('Authored'), declaration: Id }),
  Schema.Struct({ kind: Schema.Literal('Generated'), owner: Owner }),
  Schema.Struct({ kind: Schema.Literal('MissingAuthoredProvenance'), declaration: Id }),
])
const Site = Schema.Struct({
  evidence: Schema.Literal('PRESENT_IN_SELECTED_RESIDUAL_BODY'),
  node: Schema.TaggedStruct('TirNode', { ordinal: N }),
  tag: S,
  origin: Schema.Union([
    Schema.TaggedStruct('Authored', { anchor: Anchor }),
    Schema.TaggedStruct('Synthetic', { anchor: Anchor, role: S, occurrence: N }),
  ]),
  span: SourceSpan,
})
const Instance = Schema.Struct({
  key: Key,
  origin: Origin,
  artifact: Schema.optionalKey(Artifact),
  originalDeclaration: Schema.optionalKey(Id),
  originalDeclarationSpan: Schema.optionalKey(SourceSpan),
  residualBodySites: Schema.Array(Site),
})
const Selected = Schema.Struct({
  status: Schema.Literals(['Complete', 'Incomplete']),
  residualSiteScope: Schema.Literal('PARENT_INSTANCE_ARTIFACT_AND_ORIGINAL_DECLARATION'),
  executionKeyScope: Schema.Literal('LOCAL_COMPLETE_KEY_RECORDS'),
  executionKeys: Schema.Array(Key),
  reachedExecutionEdges: Schema.Array(
    Schema.Struct({
      kind: S,
      owner: N,
      target: N,
      providers: Schema.Array(Schema.Struct({ capability: S, providerType: S, role: S })),
    }),
  ),
  selectedAuthoredFunctions: Schema.Array(Authored),
  instances: Schema.Array(Instance),
  reachedIntrinsics: Schema.Array(Schema.Struct({ operation: S, span: SourceSpan })),
  missingProvenance: Schema.Array(S),
  unavailableOwnership: Schema.Array(U),
  specializationFailures: Schema.Array(U),
  violations: Schema.Array(U),
  retention: Schema.Array(U),
})
const Bootstrap = Schema.Struct({ commit: S, runId: S, file: S, sha256: S, stdlibDigest: S })
const Graph = Schema.TaggedStruct('ToolchainIdentityGraph', {
  schema: Schema.Literal('silk-toolchain-v1'),
  digest: S,
  components: Schema.Array(
    Schema.Struct({ kind: S, id: S, digest: S, dependencies: Schema.Array(S) }),
  ),
})
const Compilation = Schema.Struct({
  manifest: S,
  root: S,
  requestedProfile: object,
  bindings: Schema.Array(U),
  modules: Schema.Array(U),
  requestedComposition: Schema.optionalKey(U),
  requestedCompositionOrigin: Schema.optionalKey(U),
  profile: Schema.optionalKey(Schema.Struct({ identity: S, input: object })),
  package: Schema.optionalKey(S),
  artifact: S,
  stage: Schema.optionalKey(S),
  composition: U,
  artifactIdentity: Schema.optionalKey(S),
})
const Inventory = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  evidence: Schema.Literal('SELECTED_ANALYSIS_CLOSURE_ONLY'),
  status: Schema.Literals(['Complete', 'Incomplete']),
  inputs: InputSnapshotSchema,
  bootstrap: Bootstrap,
  analysisToolchain: Graph,
  failure: Schema.optionalKey(Schema.Struct({ stage: S, message: S })),
  compilation: Schema.optionalKey(Compilation),
  consumedSources: Schema.optionalKey(
    Schema.Array(Schema.Struct({ module: S, path: S, sha256: S })),
  ),
  diagnostics: Schema.optionalKey(
    Schema.Array(Schema.Struct({ code: S, severity: S, span: SourceSpan })),
  ),
  selected: Schema.optionalKey(Selected),
})
const Stage = Schema.Struct({
  name: S,
  command: Schema.NonEmptyArray(S),
  measurementCommand: Schema.NonEmptyArray(S),
  cwd: S,
  linkerEnvironment: nullable(Schema.Struct({ SILKC_CLANG: S })),
  exitCode: nullable(N),
  signal: nullable(S),
  stdout: S,
  stderr: S,
  error: nullable(S),
  wallTimeMs: Schema.Finite,
  peakRss: Schema.Struct({ value: nullable(N), unit: Schema.Literal('KiB'), metric: S, scope: S }),
})
const Smoke = Schema.Struct({
  name: Schema.Literal('trivial-features'),
  corpusSource: S,
  corpusSha256: S,
  sourceSha256: S,
  expectedExitCode: Schema.Literal(42),
  expectedStdout: Schema.Literal(''),
  outputSha256: Schema.optionalKey(S),
})
const Generation = Schema.Struct({ generation: S, path: S, sha256: nullable(S) })
const Build = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  status: Schema.Literals(['passed', 'failed']),
  failure: nullable(Schema.Struct({ stage: S, message: S })),
  target: S,
  profile: Profile,
  seed: Generation,
  output: Generation,
  inputs: nullable(
    Schema.Struct({
      directory: S,
      sourceCommit: S,
      normalizedDigest: S,
      archiveSha256: S,
      compiler: Schema.Struct({ sha256: S, files: InputSnapshotSchema.fields.files }),
      stdlib: Schema.Struct({ sha256: S, files: InputSnapshotSchema.fields.files }),
    }),
  ),
  linker: nullable(
    Schema.Struct({
      requestedPath: S,
      path: S,
      sha256: S,
      version: S,
      expected: Schema.Struct({ sha256: S, version: S }),
      matchesSeed: Schema.Boolean,
      seedReceiptSha256: S,
      seedProfile: SeedSchema.fields.profile,
      linkProfile: Schema.Struct({ target: S, optimization: S, debug: Schema.Boolean }),
      environmentPolicy: Schema.Literal('standard-host-with-verified-clang'),
    }),
  ),
  smoke: nullable(Smoke),
  stages: Schema.Array(Stage),
})

export interface Input {
  readonly native: string
  readonly bootstrap: unknown
  readonly build: unknown
  readonly sources: ReadonlyArray<{ readonly path: string; readonly bytes: Uint8Array }>
  readonly expected: {
    readonly snapshot: unknown
    readonly diagnosticSha256: string
    readonly analysisToolchain: unknown
    readonly compilation: unknown
    readonly buildProfile: { readonly optimization: string; readonly debug: boolean }
  }
  readonly corpus: {
    readonly expected: Corpus.Expected
    readonly output: string
    readonly previous?: Corpus.Previous
    readonly pins: {
      readonly sourceCommit: string
      readonly compilerSha256: string
      readonly target: string
      readonly profile: Input['expected']['buildProfile']
    }
  }
  readonly previous?: Omit<Input, 'previous'>
}
// Only validated JSON records and scalar key tuples enter this private encoder.
// Full record structure is retained: short identity strings are never equality authority.
const text = (value: unknown): string => {
  if (typeof value === 'string') return quote(value)
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return '[' + value.map(text).join(',') + ']'
  if (typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => compareBytes(a, b))
        .map(([k, v]) => quote(k) + ':' + text(v))
        .join(',') +
      '}'
    )
  return 'invalid-json'
}
const same = (a: unknown, b: unknown): boolean => text(a) === text(b)
const graphPins = (graph: Schema.Schema.Type<typeof Graph>) => ({
  ...graph,
  components: [...graph.components]
    .map((c) => ({ ...c, dependencies: [...c.dependencies].sort(compareBytes) }))
    .sort((a, b) => compareBytes(a.id, b.id) || compareBytes(a.kind, b.kind)),
})
const nat = (n: number): boolean => Number.isSafeInteger(n) && n >= 0
const spanOK = (s: { start: number; end: number }, size: number): boolean =>
  nat(s.start) && nat(s.end) && s.start <= s.end && s.end <= size
const pathOK = (path: string): boolean =>
  !path.startsWith('/') &&
  !path.includes('\\') &&
  path.split('/').every((part) => part !== '' && part !== '.' && part !== '..') &&
  !/^[A-Za-z]:/u.test(path)
const digestOK = (digest: string): boolean => /^[a-f0-9]{64}$/u.test(digest)
const moduleKey = (value: Schema.Schema.Type<typeof Module>) =>
  text([value.origin, value.package, value.path])
const functionKey = (value: NativeFunction['declaration']) =>
  text([moduleKey(value.module), value.owners.map((o) => [o.kind, o.name, o.occurrence])])
const idKey = (value: Schema.Schema.Type<typeof Id>) => text([value.sourceId, value.ordinal])
const compareFilePaths = (a: string, b: string): number => {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}
const compareBytes = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b))
const compareModules = (a: NativeModule, b: NativeModule): number => {
  const compilerA = a.source_file.startsWith('compiler/src/')
  const compilerB = b.source_file.startsWith('compiler/src/')
  if (compilerA !== compilerB) return compilerA ? -1 : 1
  const path = compareBytes(a.module.path, b.module.path)
  if (path !== 0) return path
  if ((a.role === 'compiler-subject') !== (b.role === 'compiler-subject'))
    return a.role === 'compiler-subject' ? -1 : 1
  return (
    compareBytes(a.module.origin, b.module.origin) ||
    compareBytes(a.module.package, b.module.package)
  )
}
const quote = (value: string): string => {
  let result = '"'
  for (const c of value) {
    if (c === '"' || c === '\\') result += '\\' + c
    else if (c.charCodeAt(0) < 32) result += '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')
    else result += c
  }
  return result + '"'
}
const observation = (m: NativeModule) =>
  `{"source_file":${quote(m.source_file)},"role":${quote(m.role)},"present":${m.present},"sha256":${m.sha256 === null ? 'null' : quote(m.sha256)}}\n`
const validUTF8 = (value: string): boolean => Buffer.from(value).toString('utf8') === value
const freeze = <A>(value: A): A => {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

const collect = Effect.fnUntraced(function* (input: Input) {
  if (!input.native.endsWith('\n')) return yield* reject('Transport', 'Truncated native JSONL')
  if (input.corpus.expected.selection !== 'full')
    return yield* reject('Corpus', 'Report requires full regular corpus coverage')
  const rows = []
  for (const line of input.native.slice(0, -1).split('\n'))
    rows.push(yield* decode(NativeRow, yield* parse(line)))
  const footer = rows.at(-1)
  if (footer?.record !== 'footer' || rows.slice(0, -1).some((r) => r.record === 'footer'))
    return yield* reject('Coverage', 'Native needs exactly one final footer')
  const modules = rows.filter((r) => r.record === 'module')
  const functions = rows.filter((r) => r.record === 'function')
  const imports = rows.filter((r) => r.record === 'import')
  const snapshot = yield* decode(InputSnapshotSchema, input.expected.snapshot)
  const inventory = yield* decode(Inventory, input.bootstrap)
  const build = yield* decode(Build, input.build)
  const expectedGraph = yield* decode(Graph, input.expected.analysisToolchain)
  if (
    !validUTF8(footer.consumed_seed_receipt_raw) ||
    (yield* hash(footer.consumed_seed_receipt_raw)) !== footer.seed_receipt_sha256
  )
    return yield* reject('Pins', 'Raw seed receipt SHA mismatch')
  const seed = yield* decode(SeedSchema, yield* parse(footer.consumed_seed_receipt_raw))
  if (
    !/^[a-f0-9]{40}$/.test(snapshot.sourceCommit) ||
    !/^[a-f0-9]{40}$/.test(seed.bootstrap.commit) ||
    !/^\d+$/.test(seed.bootstrap.runId) ||
    !digestOK(seed.binary.sha256) ||
    !digestOK(seed.bootstrap.sha256) ||
    !digestOK(seed.toolchain.clang.sha256) ||
    !digestOK(seed.toolchain.llvmAr.sha256) ||
    !digestOK(snapshot.archiveSha256) ||
    snapshot.archive !== 'authored-inputs.tar' ||
    !same(snapshot.roots, ['compiler', 'packages/compiler/stdlib'])
  )
    return yield* reject('Pins', 'Invalid exact source/bootstrap/seed authority')
  const componentIds = new Set(inventory.analysisToolchain.components.map((c) => c.id))
  if (
    componentIds.size !== inventory.analysisToolchain.components.length ||
    !digestOK(inventory.analysisToolchain.digest) ||
    inventory.analysisToolchain.components.some(
      (c) =>
        !digestOK(c.digest) ||
        new Set(c.dependencies).size !== c.dependencies.length ||
        c.dependencies.some((id) => !componentIds.has(id)),
    )
  )
    return yield* reject('Pins', 'Malformed analysis toolchain component graph')
  const sortedFiles = [...snapshot.files].sort((a, b) => compareFilePaths(a.path, b.path))
  if (
    !same(sortedFiles, snapshot.files) ||
    new Set(snapshot.files.map((f) => f.path)).size !== snapshot.files.length ||
    snapshot.files.some(
      (f) => !pathOK(f.path) || !digestOK(f.sha256) || !['100644', '100755'].includes(f.mode),
    )
  )
    return yield* reject('Pins', 'Invalid snapshot file authority')
  const fileDigest = Effect.fnUntraced(function* (files: typeof sortedFiles) {
    return yield* hash(files.map((f) => `${f.path}\0${f.mode}\0${f.sha256}\n`).join(''))
  })
  if (
    !same(inventory.inputs, snapshot) ||
    snapshot.normalizedDigest !== (yield* fileDigest(sortedFiles)) ||
    snapshot.compilerDigest !==
      (yield* fileDigest(sortedFiles.filter((f) => f.path.startsWith('compiler/')))) ||
    snapshot.stdlibDigest !==
      (yield* fileDigest(sortedFiles.filter((f) => f.path.startsWith('packages/compiler/stdlib/'))))
  )
    return yield* reject('Pins', 'Snapshot digests differ')
  if (
    seed.stage !== 'N0' ||
    seed.binary.path !== 'N0' ||
    seed.binary.mode !== '0555' ||
    seed.sourceCommit !== snapshot.sourceCommit ||
    seed.inputSnapshot.normalizedDigest !== snapshot.normalizedDigest ||
    seed.inputSnapshot.archiveSha256 !== snapshot.archiveSha256 ||
    seed.inputSnapshot.compilerDigest !== snapshot.compilerDigest ||
    seed.inputSnapshot.stdlibDigest !== snapshot.stdlibDigest ||
    seed.bootstrap.stdlib.authority !== 'embedded-verified-main' ||
    seed.bootstrap.stdlib.normalizedDigest !== snapshot.stdlibDigest ||
    seed.profile.name !== 'release-with-debug' ||
    seed.profile.optimization !== 'speed' ||
    !seed.profile.debug ||
    footer.target !== seed.profile.target ||
    !same(footer.profile, { optimization: seed.profile.optimization, debug: seed.profile.debug }) ||
    footer.producer.sha256 !== input.expected.diagnosticSha256 ||
    !digestOK(footer.producer.sha256)
  )
    return yield* reject('Pins', 'Native source/producer/profile pins differ')
  if (
    inventory.bootstrap.commit !== seed.bootstrap.commit ||
    inventory.bootstrap.runId !== seed.bootstrap.runId ||
    inventory.bootstrap.sha256 !== seed.bootstrap.sha256 ||
    inventory.bootstrap.stdlibDigest !== snapshot.stdlibDigest ||
    !same(graphPins(inventory.analysisToolchain), graphPins(expectedGraph)) ||
    (inventory.compilation !== undefined &&
      (!same(inventory.compilation, input.expected.compilation) ||
        inventory.compilation.requestedProfile.target !== footer.target ||
        inventory.compilation.requestedProfile.optimization !== footer.profile.optimization ||
        inventory.compilation.requestedProfile.debug !== footer.profile.debug ||
        (inventory.compilation.profile !== undefined &&
          (inventory.compilation.profile.input.target !== footer.target ||
            inventory.compilation.profile.input.optimization !== footer.profile.optimization ||
            inventory.compilation.profile.input.debug !== footer.profile.debug))))
  )
    return yield* reject('Pins', 'Bootstrap/toolchain/compilation pins differ')
  if (
    build.target !== footer.target ||
    !same(build.profile, input.expected.buildProfile) ||
    build.seed.generation !== 'N0' ||
    build.seed.sha256 !== seed.binary.sha256 ||
    build.output.generation !== 'N1' ||
    (build.status === 'passed' &&
      (build.failure !== null || build.output.sha256 === null || build.smoke === null)) ||
    (build.status === 'failed' && build.failure === null)
  )
    return yield* reject('Pins', 'Original NativeBuild identity/status differs')
  if (
    build.inputs !== null &&
    (build.inputs.sourceCommit !== snapshot.sourceCommit ||
      build.inputs.normalizedDigest !== snapshot.normalizedDigest ||
      build.inputs.archiveSha256 !== snapshot.archiveSha256 ||
      build.inputs.compiler.sha256 !== snapshot.compilerDigest ||
      build.inputs.stdlib.sha256 !== snapshot.stdlibDigest ||
      !same(
        [...build.inputs.compiler.files, ...build.inputs.stdlib.files].sort((a, b) =>
          compareFilePaths(a.path, b.path),
        ),
        sortedFiles,
      ))
  )
    return yield* reject('Pins', 'Original NativeBuild snapshot differs')
  if (
    build.linker !== null &&
    (!build.linker.matchesSeed ||
      build.linker.seedReceiptSha256 !== footer.seed_receipt_sha256 ||
      build.linker.sha256 !== seed.toolchain.clang.sha256 ||
      build.linker.version !== seed.toolchain.clang.version ||
      !same(build.linker.expected, seed.toolchain.clang) ||
      !same(build.linker.seedProfile, seed.profile) ||
      !same(build.linker.linkProfile, { target: build.target, ...build.profile }))
  )
    return yield* reject('Pins', 'Original NativeBuild tool binding differs')
  const stageNames = ['native-build', 'smoke-build', 'smoke-run']
  for (const [at, stage] of build.stages.entries()) {
    const snapshotDirectory = build.inputs?.directory
    const smokeDirectory = join(dirname(build.output.path), 'smoke')
    const expectedCommand =
      at < 2 && snapshotDirectory !== undefined
        ? [
            at === 0 ? build.seed.path : build.output.path,
            'build',
            at === 0
              ? join(snapshotDirectory, 'compiler/src/main.silk')
              : join(smokeDirectory, 'main.silk'),
            '-o',
            at === 0 ? build.output.path : join(smokeDirectory, 'program'),
            '--stdlib',
            join(snapshotDirectory, 'packages/compiler/stdlib'),
            '--optimization',
            build.profile.optimization,
            '--debug',
            String(build.profile.debug),
          ]
        : [join(smokeDirectory, 'program')]
    if (
      stage.name !== stageNames[at] ||
      !same(stage.command, expectedCommand) ||
      (at < 2 && snapshotDirectory === undefined) ||
      stage.wallTimeMs < 0 ||
      !same(stage.measurementCommand.slice(6), stage.command) ||
      (build.linker !== null && stage.linkerEnvironment?.SILKC_CLANG !== build.linker.path)
    )
      return yield* reject('Pins', 'Original stage command/order/measurement binding differs')
  }
  if (build.stages[0] !== undefined && build.stages[0].command[0] !== build.seed.path)
    return yield* reject('Pins', 'Native build did not consume original N0')
  if (build.stages[1] !== undefined && build.stages[1].command[0] !== build.output.path)
    return yield* reject('Pins', 'Smoke compile did not consume fresh N1')
  if (
    build.status === 'passed' &&
    (build.inputs === null ||
      build.linker === null ||
      build.stages.length !== 3 ||
      !digestOK(build.output.sha256 ?? '') ||
      build.smoke === null ||
      !digestOK(build.smoke.outputSha256 ?? '') ||
      !digestOK(build.smoke.corpusSha256) ||
      !digestOK(build.smoke.sourceSha256) ||
      build.stages.some(
        (stage, at) =>
          stage.exitCode !== [0, 0, 42][at] ||
          stage.signal !== null ||
          stage.error !== null ||
          stage.peakRss.value === null ||
          (at === 2 && stage.stdout !== ''),
      ))
  )
    return yield* reject('Pins', 'Passed build lacks exact successful build/smoke evidence')
  const files = new Map(snapshot.files.map((f) => [f.path, f]))
  const sources = new Map<string, Uint8Array>()
  for (const source of input.sources) {
    if (sources.has(source.path) || files.get(source.path)?.sha256 !== (yield* hash(source.bytes)))
      return yield* reject('Pins', 'Source bytes differ from snapshot')
    sources.set(source.path, source.bytes)
  }
  const seenModules = new Map<string, NativeModule>()
  for (const m of modules) {
    const key = moduleKey(m.module)
    const path =
      (m.role === 'stdlib-input' ? 'packages/compiler/stdlib/' : 'compiler/src/') + m.module.path
    if (
      seenModules.has(key) ||
      m.source_file !== path ||
      !pathOK(path) ||
      m.revision !== footer.revision ||
      !nat(m.functions) ||
      !nat(m.excluded_anonymous) ||
      !nat(m.excluded_damaged) ||
      m.present !== (m.sha256 !== null) ||
      (m.present && files.get(path)?.sha256 !== m.sha256)
    )
      return yield* reject('Coverage', 'Invalid module census/source observation')
    seenModules.set(key, m)
  }
  if (
    !same([...modules].sort(compareModules), modules) ||
    (yield* hash(modules.map(observation).join(''))) !== footer.input_observation_sha256
  )
    return yield* reject('Pins', 'Observed input digest/order differs')
  const pairs = new Map<string, NativeFunction[]>()
  for (const row of functions) {
    const key = functionKey(row.declaration)
    const m = seenModules.get(moduleKey(row.declaration.module))
    const bytes = m === undefined ? undefined : sources.get(m.source_file)
    if (
      m === undefined ||
      m.role !== 'compiler-subject' ||
      bytes === undefined ||
      !m.present ||
      !same(row.source_observation.module, m.module) ||
      row.source_observation.sha256 !== m.sha256 ||
      !row.source_observation.present ||
      row.source_observation.revision !== footer.revision ||
      !spanOK(row.span, bytes.length) ||
      !spanOK(row.header_span, bytes.length) ||
      !spanOK(row.name_span, bytes.length) ||
      row.name_span.start === row.name_span.end ||
      row.name_span.start < row.header_span.start ||
      row.name_span.end > row.header_span.end ||
      row.header_span.start < row.span.start ||
      row.header_span.end > row.span.end ||
      row.declaration.owners.some((o) => !nat(o.occurrence))
    )
      return yield* reject('Identity', 'Function source/span/revision is unauthenticated')
    const leaf = row.declaration.owners.at(-1)
    if (
      leaf?.kind !== 'Function' ||
      Buffer.from(bytes.slice(row.name_span.start, row.name_span.end)).toString('utf8') !==
        leaf.name
    )
      return yield* reject('Identity', 'Function NAME token differs from authored owner')
    const list = pairs.get(key) ?? []
    if (
      list.some((other) => other.phase === row.phase) ||
      list.some(
        (other) =>
          !same(other.name_span, row.name_span) ||
          other.has_body !== row.has_body ||
          other.eligibility !== row.eligibility,
      )
    )
      return yield* reject('Coverage', 'Duplicate or inconsistent canonical phase')
    if (
      (row.fact.kind === 'signature' && row.phase !== 'signature') ||
      (row.fact.kind === 'body' && (row.phase !== 'body' || !row.has_body))
    )
      return yield* reject('Coverage', 'Wrong phase success discriminator')
    if (row.fact.kind === 'rejected' || row.fact.kind === 'unsupported') {
      const diagnosticModule = seenModules.get(moduleKey(row.fact.module))
      const diagnosticBytes =
        diagnosticModule === undefined ? undefined : sources.get(diagnosticModule.source_file)
      if (diagnosticBytes === undefined || !spanOK(row.fact.span, diagnosticBytes.length))
        return yield* reject('Identity', 'Original diagnostic module/span is uncovered')
    }
    list.push(row)
    pairs.set(key, list)
  }
  const completeNative = footer.coverage_complete
  if (
    !nat(footer.revision) ||
    !nat(footer.collection_passes) ||
    !nat(footer.phase_demands_with_publications) ||
    (completeNative &&
      (footer.modules !== modules.length ||
        footer.functions !== pairs.size ||
        footer.records !== functions.length ||
        footer.expected_records !== pairs.size * 2 ||
        [...pairs.values()].some((p) => p.length !== 2) ||
        modules.some(
          (m) =>
            !m.present ||
            m.status !== 'present' ||
            (m.role === 'compiler-subject' &&
              m.functions !==
                functions.filter(
                  (f) =>
                    moduleKey(f.declaration.module) === moduleKey(m.module) &&
                    f.phase === 'signature',
                ).length),
        ))) ||
    (!completeNative &&
      (footer.modules !== null ||
        footer.functions !== null ||
        footer.expected_records !== null ||
        footer.strict_success)) ||
    (footer.strict_success &&
      (functions.some((f) => f.fact.kind !== f.phase) ||
        imports.length > 0 ||
        modules.some((m) => m.role === 'compiler-subject' && m.excluded_damaged > 0)))
  )
    return yield* reject('Coverage', 'Footer coverage/strict status does not match actual rows')
  const bootstrapSources = new Map<string, { path: string; sha256: string }>()
  for (const source of inventory.consumedSources ?? []) {
    if (
      bootstrapSources.has(source.module) ||
      !pathOK(source.path) ||
      files.get(source.path)?.sha256 !== source.sha256 ||
      sources.get(source.path) === undefined
    )
      return yield* reject('Identity', 'Bootstrap consumed source mapping differs')
    bootstrapSources.set(source.module, source)
  }
  const originals = new Map<string, Schema.Schema.Type<typeof Authored>>()
  const selected = inventory.selected
  for (const original of selected?.selectedAuthoredFunctions ?? []) {
    const source = bootstrapSources.get(original.id.sourceId)
    const bytes = source === undefined ? undefined : sources.get(source.path)
    if (
      originals.has(idKey(original.id)) ||
      !nat(original.id.ordinal) ||
      bytes === undefined ||
      original.owner.module !== original.id.sourceId ||
      original.name.span.sourceId !== original.id.sourceId ||
      original.declarationSpan.sourceId !== original.id.sourceId ||
      !same(original.anchor.owner, original.owner) ||
      !same(original.name.anchor.owner, original.owner) ||
      !spanOK(original.declarationSpan, bytes.length) ||
      !spanOK(original.name.span, bytes.length) ||
      original.name.span.start === original.name.span.end ||
      original.name.span.start < original.declarationSpan.start ||
      original.name.span.end > original.declarationSpan.end ||
      Buffer.from(bytes.slice(original.name.span.start, original.name.span.end)).toString(
        'utf8',
      ) !== original.name.spelling ||
      original.owner.path.some((p) => !nat(p.occurrence))
    )
      return yield* reject('Identity', 'Bootstrap authored NAME/source/owner differs')
    originals.set(idKey(original.id), original)
  }
  const instances = new Set<string>()
  const selectedOriginalIds = new Set<string>()
  for (const instance of selected?.instances ?? []) {
    const k = text([instance.key, instance.artifact])
    if (instances.has(k))
      return yield* reject('Identity', 'Duplicate complete instance/artifact identity')
    instances.add(k)
    if (
      instance.origin.kind !== 'Authored' &&
      (instance.originalDeclaration !== undefined || instance.originalDeclarationSpan !== undefined)
    )
      return yield* reject('Identity', 'Non-authored instance carries original authored provenance')
    if (
      instance.origin.kind === 'Generated' &&
      instance.artifact?.parent === undefined &&
      !Tir.isAnonymousCallableId(instance.key.declaration)
    )
      return yield* reject(
        'Identity',
        'Generated instance lacks existing positive generated authority',
      )
    let artifact = instance.artifact
    while (artifact?.parent !== undefined) artifact = yield* decode(Artifact, artifact.parent)
    if (instance.origin.kind === 'Authored') {
      const original = originals.get(idKey(instance.origin.declaration))
      if (original !== undefined && original.canonical._tag === 'Canonical') {
        const canonical = yield* decode(Canonical, original.canonical.id)
        if (
          !same(canonical, instance.key.declaration) ||
          (instance.artifact !== undefined && !same(instance.artifact.owner, original.owner))
        )
          return yield* reject(
            'Identity',
            'Complete key/artifact differs from original canonical owner',
          )
      }
      if (
        original === undefined ||
        instance.originalDeclaration === undefined ||
        !same(instance.originalDeclaration, original.id) ||
        !same(instance.originalDeclarationSpan, original.declarationSpan)
      )
        return yield* reject('Identity', 'Residual parent original provenance differs')
      if (instance.artifact !== undefined) selectedOriginalIds.add(idKey(original.id))
    }
    const nodes = new Set<number>()
    for (const site of instance.residualBodySites) {
      const source = bootstrapSources.get(site.span.sourceId)
      const bytes = source === undefined ? undefined : sources.get(source.path)
      if (
        bytes === undefined ||
        !spanOK(site.span, bytes.length) ||
        !nat(site.node.ordinal) ||
        nodes.has(site.node.ordinal) ||
        site.origin.anchor.owner.module !== site.span.sourceId
      )
        return yield* reject('Identity', 'Residual node source/context differs')
      nodes.add(site.node.ordinal)
    }
  }
  if (
    selected !== undefined &&
    new Set(selected.executionKeys.map(text)).size !== selected.executionKeys.length
  )
    return yield* reject('Identity', 'Duplicate complete execution key records')
  for (const edge of selected?.reachedExecutionEdges ?? [])
    if (
      !nat(edge.owner) ||
      !nat(edge.target) ||
      selected?.executionKeys[edge.owner] === undefined ||
      selected.executionKeys[edge.target] === undefined
    )
      return yield* reject('Identity', 'Invalid local complete execution key reference')
  for (const intrinsic of selected?.reachedIntrinsics ?? []) {
    const source = bootstrapSources.get(intrinsic.span.sourceId)
    const bytes = source === undefined ? undefined : sources.get(source.path)
    if (bytes === undefined || !spanOK(intrinsic.span, bytes.length))
      return yield* reject('Identity', 'Intrinsic source span differs')
  }
  const completeBootstrap = inventory.status === 'Complete'
  if (
    completeBootstrap &&
    (inventory.failure !== undefined ||
      inventory.compilation?.profile === undefined ||
      inventory.compilation.artifactIdentity === undefined ||
      !pathOK('compiler/' + inventory.compilation.root) ||
      !modules.some(
        (module) =>
          module.role === 'compiler-subject' &&
          module.present &&
          module.source_file === 'compiler/' + inventory.compilation?.root,
      ) ||
      inventory.consumedSources === undefined ||
      inventory.diagnostics === undefined ||
      inventory.diagnostics.some((d) => d.severity === 'error') ||
      selected === undefined ||
      selected.status !== 'Complete' ||
      selected.missingProvenance.length > 0 ||
      selected.unavailableOwnership.length > 0 ||
      selected.specializationFailures.length > 0 ||
      selected.violations.length > 0 ||
      selected.selectedAuthoredFunctions.some(
        (original) => original.canonical._tag !== 'Canonical',
      ) ||
      selected.selectedAuthoredFunctions.some(
        (original) => !selectedOriginalIds.has(idKey(original.id)),
      ) ||
      selected.instances.some(
        (i) => i.origin.kind === 'MissingAuthoredProvenance' || i.artifact === undefined,
      ))
  )
    return yield* reject('Coverage', 'Closed bootstrap JSON is not a Complete inventory')
  const corpusPins = input.corpus.pins
  if (
    corpusPins.sourceCommit !== snapshot.sourceCommit ||
    corpusPins.compilerSha256 !== seed.binary.sha256 ||
    corpusPins.target !== build.target ||
    !same(corpusPins.profile, build.profile)
  )
    return yield* reject('Pins', 'Corpus run authority differs')
  const corpus = yield* Effect.result(
    Corpus.read(input.corpus.expected, input.corpus.output, input.corpus.previous),
  )
  if (
    Result.isFailure(corpus) &&
    (corpus.failure.kind !== 'Policy' || corpus.failure.receipt === undefined)
  )
    return yield* reject('Corpus', 'Corpus transcript or previous authority is malformed')
  return {
    footer,
    modules,
    pairs,
    inventory,
    build,
    snapshot,
    bootstrapSources,
    originals,
    complete: completeNative && completeBootstrap,
    corpus: Result.isSuccess(corpus)
      ? {
          status: 'passed' as const,
          receipt: corpus.success,
          failures: [],
          pinGaps: [],
          lostPasses: [],
        }
      : {
          status: 'failed' as const,
          receipt: corpus.failure.receipt,
          failures: corpus.failure.failures ?? [],
          pinGaps: corpus.failure.pinGaps ?? [],
          lostPasses: corpus.failure.lostPasses ?? [],
        },
  }
})

const rank = (data: Effect.Success<ReturnType<typeof collect>>) => {
  const nameBuckets = new Map<string, string[]>()
  for (const [key, pair] of data.pairs) {
    const row = pair[0]
    if (row === undefined) continue
    const module = data.modules.find(
      (m) => moduleKey(m.module) === moduleKey(row.declaration.module),
    )
    if (module === undefined) continue
    const keyBySource = text([
      module.source_file,
      module.sha256,
      row.name_span.start,
      row.name_span.end,
    ])
    nameBuckets.set(keyBySource, [...(nameBuckets.get(keyBySource) ?? []), key])
  }
  const originalBuckets = new Map<string, number>()
  for (const original of data.originals.values()) {
    const source = data.bootstrapSources.get(original.id.sourceId)
    if (source === undefined) continue
    const k = text([source.path, source.sha256, original.name.span.start, original.name.span.end])
    originalBuckets.set(k, (originalBuckets.get(k) ?? 0) + 1)
  }
  const joins = []
  const selectedKeys = new Set<string>()
  const uncovered = []
  const selectedOriginals = new Set(
    (data.inventory.selected?.instances ?? [])
      .filter((instance) => instance.origin.kind === 'Authored' && instance.artifact !== undefined)
      .flatMap((instance) =>
        instance.originalDeclaration === undefined ? [] : [idKey(instance.originalDeclaration)],
      ),
  )
  for (const original of data.originals.values()) {
    if (original.canonical._tag !== 'Canonical') {
      uncovered.push({ original, reason: 'non-canonical-authored-state' })
      continue
    }
    if (!selectedOriginals.has(idKey(original.id))) {
      uncovered.push({ original, reason: 'NO_SELECTED_AUTHORED_INSTANCE' })
      continue
    }
    const source = data.bootstrapSources.get(original.id.sourceId)
    const candidates =
      source === undefined
        ? []
        : (nameBuckets.get(
            text([source.path, source.sha256, original.name.span.start, original.name.span.end]),
          ) ?? [])
    const sourceKey =
      source === undefined
        ? ''
        : text([source.path, source.sha256, original.name.span.start, original.name.span.end])
    const key =
      candidates.length === 1 && originalBuckets.get(sourceKey) === 1 ? candidates[0] : undefined
    if (key === undefined) {
      uncovered.push({
        original,
        reason:
          candidates.length > 1 || (originalBuckets.get(sourceKey) ?? 0) > 1
            ? 'ambiguous'
            : 'unmatched',
      })
      continue
    }
    const row = data.pairs.get(key)?.[0]
    if (row === undefined) continue
    joins.push({ native: row.declaration, nameSpan: row.name_span, bootstrap: original })
    selectedKeys.add(key)
  }
  const originalToNative = new Map(
    joins.map((join) => [idKey(join.bootstrap.id), functionKey(join.native)]),
  )
  const wantedPresence = new Set<string>()
  for (const [key, pair] of data.pairs)
    if (selectedKeys.has(key))
      for (const row of pair) {
        if (row.fact.kind !== 'rejected' && row.fact.kind !== 'unsupported') continue
        const m = data.modules.find(
          (m) =>
            moduleKey(m.module) ===
            moduleKey(
              row.fact.kind === 'rejected' || row.fact.kind === 'unsupported'
                ? row.fact.module
                : row.declaration.module,
            ),
        )
        if (m !== undefined)
          wantedPresence.add(text([key, m.source_file, row.fact.span.start, row.fact.span.end]))
      }
  const presence = new Set<string>()
  for (const instance of data.inventory.selected?.instances ?? []) {
    if (instance.artifact === undefined || instance.originalDeclaration === undefined) continue
    const key = originalToNative.get(idKey(instance.originalDeclaration))
    if (key === undefined) continue
    for (const site of instance.residualBodySites) {
      const source = data.bootstrapSources.get(site.span.sourceId)
      if (source === undefined) continue
      const k = text([key, source.path, site.span.start, site.span.end])
      if (wantedPresence.has(k)) presence.add(k)
    }
  }
  const sites = new Map<
    string,
    {
      function: NativeFunction['declaration']
      code: string
      module: Schema.Schema.Type<typeof Module>
      span: Schema.Schema.Type<typeof Span>
      phases: string[]
      selected: boolean
      evidence: string[]
    }
  >()
  const noSite = []
  const phaseOutcomes = []
  for (const [key, pair] of data.pairs)
    for (const row of pair) {
      phaseOutcomes.push({
        declaration: row.declaration,
        phase: row.phase,
        eligibility: row.eligibility,
        fact: row.fact,
      })
      if (row.fact.kind === 'query-error' || row.fact.kind === 'wrong-value') {
        noSite.push({ declaration: row.declaration, phase: row.phase, fact: row.fact })
        continue
      }
      if (row.fact.kind !== 'rejected' && row.fact.kind !== 'unsupported') continue
      const code =
        row.fact.kind === 'unsupported'
          ? (row.fact.diagnostic_code ?? row.fact.code)
          : row.fact.code
      const siteKey = text([
        key,
        code,
        moduleKey(row.fact.module),
        row.fact.span.start,
        row.fact.span.end,
      ])
      const selected = selectedKeys.has(key)
      const previous = sites.get(siteKey)
      if (previous !== undefined) {
        previous.phases.push(row.phase)
        continue
      }
      const evidence = selected ? ['STRICT_REFUSAL_IN_SELECTED_ORIGINAL_FUNCTION'] : []
      const diagnosticSource = data.modules.find(
        (m) =>
          moduleKey(m.module) ===
          moduleKey(
            row.fact.kind === 'rejected' || row.fact.kind === 'unsupported'
              ? row.fact.module
              : row.declaration.module,
          ),
      )
      if (
        selected &&
        diagnosticSource !== undefined &&
        presence.has(
          text([key, diagnosticSource.source_file, row.fact.span.start, row.fact.span.end]),
        )
      )
        evidence.push('PRESENT_IN_SELECTED_RESIDUAL_BODY')
      sites.set(siteKey, {
        function: row.declaration,
        code,
        module: row.fact.module,
        span: row.fact.span,
        phases: [row.phase],
        selected,
        evidence,
      })
    }
  const rankings = [...new Set([...sites.values()].map((s) => s.code))]
    .map((code) => {
      const all = [...sites.values()].filter((s) => s.code === code)
      return {
        code,
        selectedFunctions: new Set(
          all.filter((s) => s.selected).map((s) => functionKey(s.function)),
        ).size,
        selectedSites: all.filter((s) => s.selected).length,
        allSites: all.length,
      }
    })
    .sort(
      (a, b) =>
        b.selectedFunctions - a.selectedFunctions ||
        b.selectedSites - a.selectedSites ||
        b.allSites - a.allSites ||
        compareBytes(a.code, b.code),
    )
  return {
    joins,
    uncovered,
    unselectedNativeFunctions: [...data.pairs.entries()]
      .filter(([key]) => !selectedKeys.has(key))
      .flatMap(([, pair]) =>
        pair.slice(0, 1).map((row) => ({
          declaration: row.declaration,
          nameSpan: row.name_span,
          source_observation: row.source_observation,
          reason: 'NOT_JOINED_TO_SELECTED_ORIGINAL',
        })),
      ),
    sites: [...sites.values()],
    noSite,
    phaseOutcomes,
    rankings,
    incompleteAuthoredInstances: (data.inventory.selected?.instances ?? [])
      .filter((instance) => instance.origin.kind === 'Authored' && instance.artifact === undefined)
      .map((instance) => ({
        key: instance.key,
        origin: instance.origin,
        originalDeclaration: instance.originalDeclaration,
        originalDeclarationSpan: instance.originalDeclarationSpan,
        reason: 'MISSING_SELECTED_ARTIFACT',
        observedSites: instance.residualBodySites.length,
        presenceCredit: false,
      })),
    nonAuthoredInstances: (data.inventory.selected?.instances ?? [])
      .filter((i) => i.origin.kind !== 'Authored')
      .map((i) => ({ key: i.key, artifact: i.artifact, origin: i.origin })),
    generatedInstances:
      data.inventory.selected?.instances.filter((i) => i.origin.kind === 'Generated').length ?? 0,
  }
}

/** Collector completion, semantic success, original generation and corpus policy are independent. */
export const report = Effect.fn('StrictMeasurementReport.report')(function* (input: Input) {
  const baseline =
    input.previous === undefined
      ? undefined
      : { expected: input.previous.corpus.expected, output: input.previous.corpus.output }
  if (
    baseline !== undefined &&
    input.corpus.previous !== undefined &&
    !same(baseline, input.corpus.previous)
  )
    return yield* reject('Previous', 'Conflicting corpus baselines')
  const data = yield* collect(
    baseline === undefined ? input : { ...input, corpus: { ...input.corpus, previous: baseline } },
  )
  const evidence = rank(data)
  let difference: { added: string[]; removed: string[] } | null = null
  if (input.previous !== undefined) {
    const previous = yield* collect(input.previous).pipe(
      Effect.mapError(
        (cause) =>
          new ValidationError({
            phase: 'Previous',
            message: 'Previous measurement is invalid',
            cause,
          }),
      ),
    )
    if (
      !data.complete ||
      !previous.complete ||
      data.footer.target !== previous.footer.target ||
      !same(data.footer.profile, previous.footer.profile) ||
      !same(data.build.profile, previous.build.profile)
    )
      return yield* reject('Previous', 'Measurements have incompatible coverage/method/profile')
    const old = rank(previous).rankings.map((r) => r.code)
    const current = evidence.rankings.map((r) => r.code)
    difference = {
      added: current.filter((code) => !old.includes(code)),
      removed: old.filter((code) => !current.includes(code)),
    }
  }
  const strictSuccess = data.complete && data.footer.strict_success
  const result = {
    schemaVersion: 1,
    status: data.complete ? 'Complete' : 'Incomplete',
    strictSuccess,
    originalStage: data.build,
    corpus: data.corpus,
    pins: {
      snapshot: data.snapshot,
      diagnostic: data.footer.producer,
      seedReceiptSha256: data.footer.seed_receipt_sha256,
      consumedSeedReceiptRaw: data.footer.consumed_seed_receipt_raw,
      bootstrap: data.inventory.bootstrap,
      analysisToolchain: data.inventory.analysisToolchain,
      compilation: data.inventory.compilation,
      nativeProfile: data.footer.profile,
      linkProfile: data.build.profile,
      observedInputSha256: data.footer.input_observation_sha256,
      revision: data.footer.revision,
      requestPolicy: data.footer.request_policy,
    },
    bootstrapAudit: {
      failure: data.inventory.failure,
      diagnostics: data.inventory.diagnostics,
      missingProvenance: data.inventory.selected?.missingProvenance,
      unavailableOwnership: data.inventory.selected?.unavailableOwnership,
      specializationFailures: data.inventory.selected?.specializationFailures,
      violations: data.inventory.selected?.violations,
      retention: data.inventory.selected?.retention,
    },
    coverage: {
      native: data.footer.coverage_complete,
      bootstrap: data.inventory.status,
      namedFunctions: data.footer.coverage_complete ? data.pairs.size : null,
      selectedOriginalFunctions: data.inventory.status === 'Complete' ? data.originals.size : null,
      instances: data.inventory.selected?.instances.length ?? null,
      exclusions: data.modules.map((m) => ({
        module: m.module,
        role: m.role,
        anonymous: m.excluded_anonymous,
        damaged: m.excluded_damaged,
      })),
      bodyGuarantees: {
        fullyChecked: evidence.phaseOutcomes.filter(
          (p) => p.fact.kind === 'body' && p.fact.checking_stage === 'fully-checked',
        ).length,
        contractTyped: evidence.phaseOutcomes.filter(
          (p) => p.fact.kind === 'body' && p.fact.checking_stage === 'contract-typed',
        ).length,
        borrowStatus: 'not-checked',
      },
    },
    ranks: data.complete ? evidence.rankings : null,
    evidence: {
      ...evidence,
      rankings: data.complete ? evidence.rankings : null,
      scope: data.complete ? 'COMPLETE_CENSUS' : 'PARTIAL_OBSERVATIONS',
    },
    staticExecutionEvidence:
      data.inventory.selected === undefined
        ? null
        : {
            scope: 'STATIC_DISCOVERY_ONLY',
            executionKeyScope: data.inventory.selected.executionKeyScope,
            executionKeys: data.inventory.selected.executionKeys,
            edges: data.inventory.selected.reachedExecutionEdges,
            intrinsics: data.inventory.selected.reachedIntrinsics,
          },
    difference,
    lowerBound:
      'Earlier refusals may hide downstream sites. Residual presence and static discovery do not prove dynamic execution; body guarantees do not certify borrow checking.',
    accepted: strictSuccess && data.build.status === 'passed' && data.corpus.status === 'passed',
  }
  const owned = yield* Effect.try({
    try: () => freeze(structuredClone(result)),
    catch: (cause) =>
      new ValidationError({
        phase: 'Transport',
        message: 'Could not retain immutable report',
        cause,
      }),
  })
  const markdown = `Strict measurement: ${owned.status}; strict ${strictSuccess ? 'PASS' : 'RED'}; original native stage ${data.build.status}; corpus ${data.corpus.status}.\n\nSource ${data.snapshot.sourceCommit}; diagnostic ${data.footer.producer.sha256}; bootstrap ${data.inventory.bootstrap.commit}.\n\n${data.complete ? evidence.rankings.map((r) => `- ${r.code}: ${r.selectedFunctions} selected original functions, ${r.selectedSites} selected sites, ${r.allSites} all sites.`).join('\n') : 'Complete ranking unavailable; producer coverage is incomplete.'}\n\n${owned.lowerBound}\n`
  return freeze({ json: owned, markdown })
})
