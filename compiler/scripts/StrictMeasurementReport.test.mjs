import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import * as Report from './StrictMeasurementReport.ts'
import * as Snapshot from './SourceSnapshot.mjs'
import * as Analysis from '../../packages/compiler/src/Analysis.js'
import * as Option from 'effect/Option'
import * as SourceFile from '../../packages/compiler/src/SourceFile.js'

// Deliberate wire controls, not historical frontend output or native-generation proof.
// The original paired482bca source is unavailable; these exact token sites test the join
// contract without pretending that local ordinal, method spelling or a supplied flag is authority.
const fixture = () => {
  const sourceId = 'fixture/main'
  let source = 'fn ordinary() -> i32 { return 1 }\nstruct Left {}\nstruct Right {}\nimpl Left {\n'
  source +=
    ' '.repeat(121 - Buffer.byteLength(source)) + 'fn same() -> i32 { return 2 } }\nimpl Right {\n'
  source += ' '.repeat(190 - Buffer.byteLength(source)) + 'fn same() -> i32 { return 3 } }\n'
  const sources = [
    { path: 'compiler/src/main.silk', bytes: Buffer.from(source) },
    {
      path: 'packages/compiler/stdlib/identity.silk',
      bytes: Buffer.from('pub fn identity() {}\n'),
    },
  ]
  const files = sources.map(({ path, bytes }) => ({
    path,
    mode: '100644',
    sha256: Snapshot.hash(bytes),
  }))
  const snapshot = {
    schemaVersion: 1,
    sourceCommit: 'a'.repeat(40),
    roots: Snapshot.roots,
    files,
    normalizedDigest: Snapshot.fileDigest(files),
    compilerDigest: Snapshot.fileDigest(files.filter((f) => f.path.startsWith('compiler/'))),
    stdlibDigest: Snapshot.fileDigest(files.filter((f) => f.path.startsWith('packages/'))),
    archive: 'authored-inputs.tar',
    archiveSha256: Snapshot.hash('synthetic archive control'),
  }
  const bootstrap = {
    commit: 'b'.repeat(40),
    runId: '123',
    file: '/verified/bootstrap',
    sha256: 'c'.repeat(64),
    stdlibDigest: snapshot.stdlibDigest,
  }
  const seed = {
    schemaVersion: 1,
    stage: 'N0',
    sourceCommit: snapshot.sourceCommit,
    binary: { path: 'N0', mode: '0555', sha256: 'd'.repeat(64) },
    inputSnapshot: {
      normalizedDigest: snapshot.normalizedDigest,
      archiveSha256: snapshot.archiveSha256,
      compilerDigest: snapshot.compilerDigest,
      stdlibDigest: snapshot.stdlibDigest,
    },
    bootstrap: {
      commit: bootstrap.commit,
      runId: bootstrap.runId,
      sha256: bootstrap.sha256,
      stdlib: { authority: 'embedded-verified-main', normalizedDigest: snapshot.stdlibDigest },
    },
    toolchain: {
      clang: { sha256: 'e'.repeat(64), version: 'fixture clang' },
      llvmAr: { sha256: 'f'.repeat(64), version: 'fixture ar' },
    },
    profile: {
      target: 'x86_64-unknown-linux-gnu',
      name: 'release-with-debug',
      optimization: 'speed',
      debug: true,
    },
    command: ['synthetic-producer-control'],
  }
  const rawSeed = JSON.stringify(seed) + '\n'
  const module = { origin: 'file', package: '/fixture/compiler', path: 'main.silk' }
  const library = { origin: 'file', package: '/fixture/stdlib', path: 'identity.silk' }
  const moduleRows = [
    {
      schema: 'silk.strict-inventory',
      version: 1,
      record: 'module',
      module,
      source_file: sources[0].path,
      physical_source_file: '/fixture/main.silk',
      role: 'compiler-subject',
      present: true,
      sha256: files[0].sha256,
      revision: 2,
      functions: 3,
      excluded_anonymous: 0,
      excluded_damaged: 0,
      status: 'present',
    },
    {
      schema: 'silk.strict-inventory',
      version: 1,
      record: 'module',
      module: library,
      source_file: sources[1].path,
      physical_source_file: '/fixture/identity.silk',
      role: 'stdlib-input',
      present: true,
      sha256: files[1].sha256,
      revision: 2,
      functions: 1,
      excluded_anonymous: 0,
      excluded_damaged: 0,
      status: 'present',
    },
  ]
  const functions = [
    [3, 11, 'ordinary', null, 101],
    [124, 128, 'same', 'Left', 203],
    [193, 197, 'same', 'Right', 307],
  ].map(([start, end, name, owner, ordinal]) => {
    const owners = [
      ...(owner === null ? [] : [{ kind: 'Implementation', name: owner, occurrence: 0 }]),
      { kind: 'Function', name, occurrence: 0 },
    ]
    const path = [
      ...(owner === null
        ? []
        : [{ _tag: 'OwnerSegment', kind: 'Implementation', name: owner, occurrence: 0 }]),
      { _tag: 'OwnerSegment', kind: 'Function', name, occurrence: 0 },
    ]
    const bootstrapOwner = {
      _tag: 'AuthoredIdentity',
      namespace: 'fixture',
      module: sourceId,
      path,
    }
    const anchor = { _tag: 'AuthoredAnchor', owner: bootstrapOwner, path: [] }
    const nameAnchor = {
      _tag: 'AuthoredAnchor',
      owner: bootstrapOwner,
      path: [{ _tag: 'LocalSegment', role: 'name', occurrence: 0 }],
    }
    const declarationSpan = { sourceId, start: Math.max(0, start - 3), end: source.length }
    const original = {
      id: { _tag: 'DeclarationId', sourceId, ordinal },
      canonical: {
        _tag: 'Canonical',
        id: { _tag: 'CanonicalDeclarationId', module: sourceId, name },
      },
      owner: bootstrapOwner,
      anchor,
      declarationSpan,
      name: { spelling: name, anchor: nameAnchor, span: { sourceId, start, end } },
    }
    const base = {
      schema: 'silk.strict-inventory',
      version: 1,
      record: 'function',
      declaration: { module, owners },
      span: { start: declarationSpan.start, end: declarationSpan.end },
      header_span: { start: declarationSpan.start, end: end + 9 },
      name_span: { start, end },
      source_observation: { module, present: true, sha256: files[0].sha256, revision: 2 },
      eligibility: 'eligible',
      has_body: true,
    }
    return { original, base }
  })
  const siteSpan = { start: 15, end: 18 }
  const phaseRows = functions.flatMap(({ base }) =>
    ['signature', 'body'].map((phase) => ({
      ...base,
      phase,
      fact: { kind: 'rejected', code: 'Unsupported', module, span: siteSpan },
    })),
  )
  const footer = {
    schema: 'silk.strict-inventory',
    version: 1,
    record: 'footer',
    coverage_complete: true,
    strict_success: false,
    modules: 2,
    functions: 3,
    records: 6,
    expected_records: 6,
    revision: 2,
    collection_passes: 2,
    phase_demands_with_publications: 1,
    input_observation_sha256: Snapshot.hash(
      moduleRows
        .map(
          (m) =>
            JSON.stringify({
              source_file: m.source_file,
              role: m.role,
              present: m.present,
              sha256: m.sha256,
            }) + '\n',
        )
        .join(''),
    ),
    target: seed.profile.target,
    profile: { optimization: 'speed', debug: true },
    request_policy: 'fresh-after-publication',
    recovery: false,
    producer: {
      kind: 'bootstrap-built-diagnostic',
      file: '/fixture/diagnostic',
      sha256: '1'.repeat(64),
    },
    seed_receipt_sha256: Snapshot.hash(rawSeed),
    consumed_seed_receipt_raw: rawSeed,
  }
  const analysisToolchain = {
    _tag: 'ToolchainIdentityGraph',
    schema: 'silk-toolchain-v1',
    digest: '2'.repeat(64),
    components: [{ kind: 'Compiler', id: 'compiler', digest: '3'.repeat(64), dependencies: [] }],
  }
  const compilation = {
    manifest: 'compiler/silk.toml',
    root: 'src/main.silk',
    requestedProfile: { target: seed.profile.target, optimization: 'speed', debug: true },
    bindings: [],
    modules: [],
    profile: {
      identity: 'fixture-profile',
      input: { target: seed.profile.target, optimization: 'speed', debug: true },
    },
    artifact: 'NativeExecutable',
    composition: { runtimes: [], globals: [] },
    artifactIdentity: 'fixture-artifact',
  }
  const keys = functions.map(({ original }, at) => ({
    identity: 'same-flat-control',
    declaration: { _tag: 'CanonicalDeclarationId', module: sourceId, name: original.name.spelling },
    typeArguments: [],
    staticArguments: [],
    contractRow: [],
    evidence: [`full-${at}`],
  }))
  const selected = {
    status: 'Complete',
    residualSiteScope: 'PARENT_INSTANCE_ARTIFACT_AND_ORIGINAL_DECLARATION',
    executionKeyScope: 'LOCAL_COMPLETE_KEY_RECORDS',
    executionKeys: keys,
    reachedExecutionEdges: [
      {
        kind: 'Runtime',
        owner: 0,
        target: 1,
        providers: [{ capability: 'C', providerType: 'P', role: 'provider' }],
      },
      { kind: 'Runtime', owner: 0, target: 1, providers: [] },
    ],
    selectedAuthoredFunctions: functions.map((f) => f.original),
    instances: functions.map(({ original }, at) => ({
      key: keys[at],
      origin: { kind: 'Authored', declaration: original.id },
      artifact: { owner: original.owner, request: { _tag: 'Check' } },
      originalDeclaration: original.id,
      originalDeclarationSpan: original.declarationSpan,
      residualBodySites: [
        {
          evidence: 'PRESENT_IN_SELECTED_RESIDUAL_BODY',
          node: { _tag: 'TirNode', ordinal: 0 },
          tag: 'IntegerLiteral',
          origin: {
            _tag: 'Synthetic',
            anchor: original.anchor,
            role: 'after-return',
            occurrence: 0,
          },
          span: { sourceId, ...siteSpan },
        },
      ],
    })),
    reachedIntrinsics: [],
    missingProvenance: [],
    unavailableOwnership: [],
    specializationFailures: [],
    violations: [],
    retention: [],
  }
  const inventory = {
    schemaVersion: 1,
    evidence: 'SELECTED_ANALYSIS_CLOSURE_ONLY',
    status: 'Complete',
    inputs: snapshot,
    bootstrap,
    analysisToolchain,
    compilation,
    consumedSources: [
      { module: sourceId, path: sources[0].path, sha256: files[0].sha256 },
      { module: 'fixture/library', path: sources[1].path, sha256: files[1].sha256 },
    ],
    diagnostics: [],
    selected,
  }
  const buildProfile = { optimization: 'speed', debug: false }
  const build = {
    schemaVersion: 1,
    status: 'failed',
    failure: { stage: 'native-build', message: 'actual refusal control' },
    target: seed.profile.target,
    profile: buildProfile,
    seed: { generation: 'N0', path: 'N0', sha256: seed.binary.sha256 },
    output: { generation: 'N1', path: 'N1', sha256: null },
    inputs: {
      directory: '/fixture/snapshot',
      sourceCommit: snapshot.sourceCommit,
      normalizedDigest: snapshot.normalizedDigest,
      archiveSha256: snapshot.archiveSha256,
      compiler: {
        sha256: snapshot.compilerDigest,
        files: files.filter((f) => f.path.startsWith('compiler/')),
      },
      stdlib: {
        sha256: snapshot.stdlibDigest,
        files: files.filter((f) => f.path.startsWith('packages/')),
      },
    },
    linker: {
      requestedPath: '/verified/clang',
      path: '/verified/clang-22',
      sha256: seed.toolchain.clang.sha256,
      version: seed.toolchain.clang.version,
      expected: seed.toolchain.clang,
      matchesSeed: true,
      seedReceiptSha256: footer.seed_receipt_sha256,
      seedProfile: seed.profile,
      linkProfile: { target: seed.profile.target, ...buildProfile },
      environmentPolicy: 'standard-host-with-verified-clang',
    },
    smoke: null,
    stages: [],
  }
  const manifest = {
    schemaVersion: 1,
    mode: 'corpus-full',
    required: ['pinned'],
    programs: ['pinned', 'other'].map((name) => ({
      name,
      profiles: [{ name: 'optimized', optimization: 'speed', debug: false }],
      runs: [{ arguments: [], closeStderr: false }],
      expected: { _tag: 'Completes', result: 0 },
    })),
  }
  const output = `SELFHOST_CORPUS_MANIFEST=${JSON.stringify(manifest)}\nSELFHOST_CASE_TIMING={"name":"pinned","elapsedMs":1}\nSELFHOST_CASE_TIMING={"name":"other","elapsedMs":1}\nPASS pinned\nPASS other\nSelfhost corpus: pass=2 fail=0 unsupported=0 track=1\n`
  const input = {
    native: '',
    bootstrap: inventory,
    build,
    sources,
    expected: {
      snapshot,
      diagnosticSha256: footer.producer.sha256,
      analysisToolchain,
      compilation,
      buildProfile,
    },
    corpus: {
      expected: { manifest, selection: 'full' },
      output,
      pins: {
        sourceCommit: snapshot.sourceCommit,
        compilerSha256: seed.binary.sha256,
        target: build.target,
        profile: buildProfile,
      },
    },
  }
  const encode = () => {
    input.native = [...moduleRows, ...phaseRows, footer]
      .map((r) => JSON.stringify(r) + '\n')
      .join('')
    return input
  }
  return {
    input: encode(),
    encode,
    footer,
    moduleRows,
    phaseRows,
    functions,
    inventory,
    keys,
    seed,
    rawSeed,
  }
}
const refuses = Effect.fnUntraced(
  /** @param {import('./StrictMeasurementReport.ts').Input} input */
  function* (input) {
    const result = yield* Effect.result(Report.report(input))
    assert.isTrue(Result.isFailure(result))
    if (Result.isFailure(result)) assert.instanceOf(result.failure, Report.ValidationError)
  },
)

it.effect(
  'joins exact NAME bytes despite repeated method names and differing ordinals, keeps strict/native RED and static presence distinct',
  () =>
    Effect.gen(function* () {
      const f = fixture()
      const { json, markdown } = yield* Report.report(f.input)
      assert.strictEqual(json.status, 'Complete')
      assert.isFalse(json.strictSuccess)
      assert.isFalse(json.accepted)
      assert.strictEqual(json.originalStage.status, 'failed')
      assert.deepEqual(
        json.evidence.joins.map((j) => j.nameSpan),
        [
          { start: 3, end: 11 },
          { start: 124, end: 128 },
          { start: 193, end: 197 },
        ],
      )
      assert.deepEqual(
        json.evidence.joins.map((j) => j.bootstrap.id.ordinal),
        [101, 203, 307],
      )
      assert.strictEqual(json.evidence.sites.length, 3)
      assert.isTrue(
        json.evidence.sites.every(
          (s) => s.phases.length === 2 && s.evidence.includes('PRESENT_IN_SELECTED_RESIDUAL_BODY'),
        ),
      )
      assert.deepEqual(json.ranks, [
        { code: 'Unsupported', selectedFunctions: 3, selectedSites: 3, allSites: 3 },
      ])
      assert.deepEqual(json.staticExecutionEvidence.executionKeys, f.keys)
      assert.strictEqual(json.staticExecutionEvidence.edges.length, 2)
      assert.strictEqual(json.staticExecutionEvidence.scope, 'STATIC_DISCOVERY_ONLY')
      assert.isTrue(Object.isFrozen(json.evidence.joins[0].bootstrap.owner))
      assert.isFalse(Object.isFrozen(f.inventory))
      assert.include(markdown, 'original native stage failed')
      assert.include(markdown, 'downstream')
    }),
)

it.effect(
  'rejects malformed/duplicate/truncated coverage, wrong phases, revisions, source bytes and tool/profile pins',
  () =>
    Effect.gen(function* () {
      for (const mutate of [
        (f) => {
          f.input.native = f.input.native.slice(0, -1)
        },
        (f) => {
          f.input.native += JSON.stringify(f.footer) + '\n'
        },
        (f) => {
          f.phaseRows.push(f.phaseRows[0])
          f.encode()
        },
        (f) => {
          f.footer.records = 5
          f.encode()
        },
        (f) => {
          f.footer.extra = 'unversioned field'
          f.encode()
        },
        (f) => {
          f.inventory.unversioned = true
        },
        (f) => {
          f.inventory.compilation.root = 'src/other-root.silk'
        },
        (f) => {
          f.inventory.selected.instances.splice(0, 1)
        },
        (f) => {
          f.footer.strict_success = true
          f.encode()
        },
        (f) => {
          f.phaseRows[0].source_observation.revision = 1
          f.encode()
        },
        (f) => {
          f.phaseRows[0].fact = {
            kind: 'body',
            checking_stage: 'fully-checked',
            borrow_status: 'not-checked',
          }
          f.encode()
        },
        (f) => {
          f.input.sources[0].bytes = Buffer.from('wrong source')
        },
        (f) => {
          f.footer.profile.debug = false
          f.encode()
        },
        (f) => {
          f.inventory.bootstrap.sha256 = '9'.repeat(64)
        },
        (f) => {
          f.inventory.compilation.profile.input.debug = false
        },
        (f) => {
          f.inventory.compilation.requestedProfile.target = 'other-target'
        },
        (f) => {
          f.footer.consumed_seed_receipt_raw = f.rawSeed.trimEnd()
          f.encode()
        },
        (f) => {
          f.footer.consumed_seed_receipt_raw = JSON.parse(f.rawSeed)
          f.encode()
        },
        (f) => {
          f.footer.input_observation_sha256 = '9'.repeat(64)
          f.encode()
        },
        (f) => {
          f.inventory.selected.reachedExecutionEdges[0].target = 3
        },
        (f) => {
          f.inventory.selected.reachedExecutionEdges[0].owner = -1
        },
        (f) => {
          f.inventory.selected.reachedExecutionEdges[0].target = 0.5
        },
        (f) => {
          f.inventory.selected.executionKeyScope = 'HASH_ONLY'
        },
        (f) => {
          delete f.inventory.selected.instances[0].originalDeclarationSpan
        },
        (f) => {
          f.inventory.selected.instances[0].origin = {
            kind: 'Generated',
            owner: f.functions[0].original.owner,
          }
        },
      ]) {
        const f = fixture()
        mutate(f)
        yield* refuses(f.input)
      }
    }),
)

it.effect('stdlib named census remains input-only and damaged syntax prevents strict success', () =>
  Effect.gen(function* () {
    const f = fixture()
    assert.strictEqual(f.moduleRows[1].functions, 1)
    const result = yield* Report.report(f.input)
    assert.strictEqual(result.json.coverage.namedFunctions, 3)
    for (const row of f.phaseRows)
      row.fact =
        row.phase === 'signature'
          ? {
              kind: 'signature',
              parameters: 0,
              type_parameters: 0,
              lifetime_parameters: 0,
              row_parameters: 0,
              constraints: 0,
              effect: false,
              unsafe: false,
              static: false,
            }
          : { kind: 'body', checking_stage: 'contract-typed', borrow_status: 'not-checked' }
    f.footer.strict_success = true
    f.moduleRows[0].excluded_damaged = 1
    f.encode()
    yield* refuses(f.input)
    f.footer.strict_success = false
    f.encode()
    const damaged = yield* Report.report(f.input)
    assert.isFalse(damaged.json.strictSuccess)
    assert.strictEqual(
      damaged.json.evidence.phaseOutcomes.find((p) => p.phase === 'body').fact.checking_stage,
      'contract-typed',
    )
  }),
)

it.effect(
  'Incomplete exposes partial audit without either complete-ranking table and refuses malformed Complete promotion',
  () =>
    Effect.gen(function* () {
      const f = fixture()
      f.inventory.status = 'Incomplete'
      f.inventory.selected.status = 'Incomplete'
      f.inventory.selected.missingProvenance = ['missing-original']
      const result = yield* Report.report(f.input)
      assert.strictEqual(result.json.status, 'Incomplete')
      assert.isNull(result.json.ranks)
      assert.isNull(result.json.evidence.rankings)
      assert.isNull(result.json.coverage.selectedOriginalFunctions)
      f.inventory.status = 'Complete'
      yield* refuses(f.input)
      const n = fixture()
      n.footer.coverage_complete = false
      n.footer.modules = null
      n.footer.functions = null
      n.footer.expected_records = null
      n.encode()
      const nativeIncomplete = yield* Report.report(n.input)
      assert.isNull(nativeIncomplete.json.coverage.namedFunctions)
      assert.isNull(nativeIncomplete.json.ranks)
      const orphan = fixture()
      orphan.inventory.selected.instances.splice(0, 1)
      orphan.inventory.status = 'Incomplete'
      orphan.inventory.selected.status = 'Incomplete'
      const partial = yield* Report.report(orphan.input)
      assert.isNull(partial.json.ranks)
      assert.strictEqual(partial.json.evidence.joins.length, 2)
      assert.strictEqual(partial.json.evidence.uncovered[0].reason, 'NO_SELECTED_AUTHORED_INSTANCE')
      const missingArtifact = fixture()
      delete missingArtifact.inventory.selected.instances[0].artifact
      missingArtifact.inventory.status = 'Incomplete'
      missingArtifact.inventory.selected.status = 'Incomplete'
      missingArtifact.inventory.selected.missingProvenance = ['actual-missing-artifact']
      const audit = yield* Report.report(missingArtifact.input)
      assert.isNull(audit.json.ranks)
      assert.strictEqual(audit.json.evidence.joins.length, 2)
      assert.strictEqual(audit.json.evidence.uncovered[0].reason, 'NO_SELECTED_AUTHORED_INSTANCE')
      assert.strictEqual(
        audit.json.evidence.incompleteAuthoredInstances[0].reason,
        'MISSING_SELECTED_ARTIFACT',
      )
      assert.deepEqual(
        audit.json.evidence.incompleteAuthoredInstances[0].key,
        missingArtifact.inventory.selected.instances[0].key,
      )
      const sibling = fixture()
      const artifactless = structuredClone(sibling.inventory.selected.instances[0])
      delete artifactless.artifact
      artifactless.key.evidence = ['artifactless-context']
      sibling.inventory.selected.instances[0].residualBodySites = []
      sibling.inventory.selected.instances.push(artifactless)
      sibling.inventory.status = 'Incomplete'
      sibling.inventory.selected.status = 'Incomplete'
      sibling.inventory.selected.missingProvenance = ['artifactless-sibling']
      const noCredit = yield* Report.report(sibling.input)
      const ordinarySites = noCredit.json.evidence.sites.filter(
        (site) => site.function.owners.at(-1).name === 'ordinary',
      )
      assert.isNotEmpty(ordinarySites)
      assert.isTrue(
        ordinarySites.every((site) => !site.evidence.includes('PRESENT_IN_SELECTED_RESIDUAL_BODY')),
      )
      missingArtifact.inventory.status = 'Complete'
      missingArtifact.inventory.selected.status = 'Complete'
      missingArtifact.inventory.selected.missingProvenance = []
      yield* refuses(missingArtifact.input)
    }),
)

it.effect('only complete canonical authored states authorize selected joins', () =>
  Effect.gen(function* () {
    for (const kind of ['Unidentified', 'Duplicate']) {
      const f = fixture()
      const original = f.functions[0].original
      const canonical = original.canonical.id
      original.canonical =
        kind === 'Unidentified'
          ? { _tag: kind }
          : {
              _tag: kind,
              original: canonical,
              cause: {
                _tag: 'DiagnosticIdentity',
                phase: 'semantic',
                code: 'SEM0001',
                span: { _tag: 'At', anchor: original.anchor },
                ordinal: 0,
              },
            }
      yield* refuses(f.input)
      f.inventory.status = 'Incomplete'
      f.inventory.selected.status = 'Incomplete'
      const result = yield* Report.report(f.input)
      assert.isNull(result.json.ranks)
      assert.strictEqual(result.json.evidence.joins.length, 2)
      assert.deepEqual(result.json.evidence.unselectedNativeFunctions, [
        {
          declaration: f.phaseRows[0].declaration,
          nameSpan: f.phaseRows[0].name_span,
          source_observation: f.phaseRows[0].source_observation,
          reason: 'NOT_JOINED_TO_SELECTED_ORIGINAL',
        },
      ])
      assert.strictEqual(result.json.evidence.uncovered[0].reason, 'non-canonical-authored-state')
      assert.deepEqual(result.json.evidence.uncovered[0].original.canonical, original.canonical)
    }
    const f = fixture()
    f.functions[0].original.canonical = { _tag: 'Canonical', id: { module: 'guessed' } }
    yield* refuses(f.input)
  }),
)

it.effect('ambiguous and unmatched NAME addresses never choose a flat-name/ordinal match', () =>
  Effect.gen(function* () {
    const f = fixture()
    f.inventory.selected.selectedAuthoredFunctions[2].declarationSpan.start = 121
    f.inventory.selected.instances[2].originalDeclarationSpan.start = 121
    f.inventory.selected.selectedAuthoredFunctions[2].name.span = {
      sourceId: 'fixture/main',
      start: 124,
      end: 128,
    }
    const result = yield* Report.report(f.input)
    // Same token name but different originals may not be silently collapsed onto one native declaration.
    assert.strictEqual(result.json.evidence.uncovered.length, 2)
    assert.strictEqual(result.json.evidence.uncovered[0].reason, 'ambiguous')
    const g = fixture()
    g.inventory.selected.selectedAuthoredFunctions.pop()
    g.inventory.selected.instances.pop()
    const unmatched = yield* Report.report(g.input)
    assert.strictEqual(unmatched.json.evidence.joins.length, 2)
  }),
)

it.effect(
  'retains complete corpus FAIL and prior PASS loss despite child success; malformed protocol refuses',
  () =>
    Effect.gen(function* () {
      const f = fixture()
      const previous = { expected: f.input.corpus.expected, output: f.input.corpus.output }
      f.input.corpus.previous = previous
      f.input.corpus.output =
        f.input.corpus.output
          .replace('PASS other', 'FAIL other: control')
          .replace('pass=2 fail=0', 'pass=1 fail=1') + 'Selfhost failure control: 1\n'
      const result = yield* Report.report(f.input)
      assert.strictEqual(result.json.corpus.status, 'failed')
      assert.deepEqual(result.json.corpus.failures, ['other'])
      assert.deepEqual(result.json.corpus.lostPasses, ['other'])
      f.input.corpus.output = f.input.corpus.output.slice(0, -1)
      yield* refuses(f.input)
    }),
)

it.effect(
  'validates previous measurement under its own pins and compares codes without inferred resolutions',
  () =>
    Effect.gen(function* () {
      const f = fixture()
      const previous = fixture().input
      f.input.previous = previous
      f.phaseRows[0].fact.code = 'UnknownName'
      f.encode()
      const result = yield* Report.report(f.input)
      assert.deepEqual(result.json.difference, { added: ['UnknownName'], removed: [] })
      const g = fixture()
      g.input.previous = {
        ...previous,
        expected: { ...previous.expected, buildProfile: { optimization: 'none', debug: false } },
      }
      yield* refuses(g.input)
    }),
)

it.effect(
  'full previous measurement supplies PASS-loss authority and rejects conflicting baselines',
  () =>
    Effect.gen(function* () {
      const f = fixture()
      const previous = fixture()
      f.input.previous = previous.input
      f.input.corpus.output =
        f.input.corpus.output
          .replace('PASS other', 'UNSUPPORTED other: named-gap')
          .replace('pass=2 fail=0 unsupported=0', 'pass=1 fail=0 unsupported=1') +
        'Selfhost gap named-gap: 1\n'
      const result = yield* Report.report(f.input)
      assert.deepEqual(result.json.corpus.lostPasses, ['other'])
      assert.strictEqual(result.json.corpus.status, 'failed')
      assert.isFalse(result.json.accepted)
      f.input.corpus.previous = {
        expected: previous.input.corpus.expected,
        output: previous.input.corpus.output + 'conflicting extra record\n',
      }
      yield* refuses(f.input)
    }),
)

it.effect(
  'accepts genuine successful receipt shape with exact smoke exit42, and rejects failed measurements/output',
  () =>
    Effect.gen(function* () {
      const f = fixture()
      const makeStage = (name, command, exitCode) => ({
        name,
        command,
        measurementCommand: ['/time', '-f', '%M', '-o', '/rss', '--', ...command],
        cwd: '/fixture',
        linkerEnvironment: { SILKC_CLANG: '/verified/clang-22' },
        exitCode,
        signal: null,
        stdout: '',
        stderr: '',
        error: null,
        wallTimeMs: 1,
        peakRss: {
          value: 1,
          unit: 'KiB',
          metric: 'GNU time %M / Linux ru_maxrss',
          scope: 'maximum RSS of the command and waited children; not summed concurrent RSS',
        },
      })
      f.input.build.status = 'passed'
      f.input.build.failure = null
      f.input.build.output.sha256 = '4'.repeat(64)
      f.input.build.smoke = {
        name: 'trivial-features',
        corpusSource: '/fixture/trivial-features.silk',
        corpusSha256: '5'.repeat(64),
        sourceSha256: '6'.repeat(64),
        expectedExitCode: 42,
        expectedStdout: '',
        outputSha256: '7'.repeat(64),
      }
      f.input.build.stages = [
        makeStage(
          'native-build',
          [
            'N0',
            'build',
            '/fixture/snapshot/compiler/src/main.silk',
            '-o',
            'N1',
            '--stdlib',
            '/fixture/snapshot/packages/compiler/stdlib',
            '--optimization',
            'speed',
            '--debug',
            'false',
          ],
          0,
        ),
        makeStage(
          'smoke-build',
          [
            'N1',
            'build',
            'smoke/main.silk',
            '-o',
            'smoke/program',
            '--stdlib',
            '/fixture/snapshot/packages/compiler/stdlib',
            '--optimization',
            'speed',
            '--debug',
            'false',
          ],
          0,
        ),
        makeStage('smoke-run', ['smoke/program'], 42),
      ]
      const result = yield* Report.report(f.input)
      assert.strictEqual(result.json.originalStage.status, 'passed')
      assert.strictEqual(result.json.originalStage.stages[2].exitCode, 42)
      f.input.build.stages[2].exitCode = 0
      yield* refuses(f.input)
      f.input.build.stages[2].exitCode = 42
      f.input.build.stages[2].stdout = 'unexpected'
      yield* refuses(f.input)
      f.input.build.stages[2].stdout = ''
      f.input.build.stages[0].error = 'measurement failed'
      yield* refuses(f.input)
      f.input.build.stages[0].error = null
      f.input.build.stages[0].command[10] = 'true'
      f.input.build.stages[0].measurementCommand[16] = 'true'
      yield* refuses(f.input)
      f.input.build.stages[0].command[10] = 'false'
      f.input.build.stages[0].measurementCommand[16] = 'false'
      f.input.build.stages[2].command = ['different-program']
      f.input.build.stages[2].measurementCommand = [
        '/time',
        '-f',
        '%M',
        '-o',
        '/rss',
        '--',
        'different-program',
      ]
      yield* refuses(f.input)
    }),
)

it.effect(
  'compares pin/profile structural values independently of property order and retains full generated identities',
  () =>
    Effect.gen(function* () {
      const f = fixture()
      f.input.expected.buildProfile = { debug: false, optimization: 'speed' }
      f.input.corpus.pins.profile = { debug: false, optimization: 'speed' }
      f.inventory.analysisToolchain.components.push({
        kind: 'Runtime',
        id: 'runtime',
        digest: '4'.repeat(64),
        dependencies: ['compiler'],
      })
      f.inventory.analysisToolchain.components[0].dependencies = ['compiler', 'runtime']
      f.input.expected.analysisToolchain = structuredClone(f.inventory.analysisToolchain)
      f.input.expected.analysisToolchain.components.reverse()
      f.input.expected.analysisToolchain.components[1].dependencies.reverse()
      const original = f.functions[0].original
      const key = {
        ...f.keys[0],
        identity: 'generated-control',
        evidence: ['different-full-record'],
      }
      const generated = {
        key,
        origin: { kind: 'Generated', owner: original.owner },
        artifact: {
          owner: original.owner,
          request: { _tag: 'Check' },
          parent: { owner: original.owner, request: { _tag: 'Check' } },
        },
        residualBodySites: [],
      }
      f.inventory.selected.instances.push(generated)
      const result = yield* Report.report(f.input)
      assert.strictEqual(result.json.evidence.generatedInstances, 1)
      assert.deepEqual(result.json.evidence.nonAuthoredInstances, [
        { key, artifact: generated.artifact, origin: generated.origin },
      ])
    }),
)

// Actual native V02a rows captured by1004 at04aea4597c, exact source SHA retained.
// Only final-revision/footer/enclosing stage controls below are synthetic, not a full run.
const pairedNativeSource =
  'struct A {}\nstruct B {}\nimpl A { fn same() -> i32 { return 1 } }\nimpl B { fn same() -> i32 { return 2 } }\ninterface Contract { fn absent() -> i32 }\nfn refused() -> i32 { return missing }\nstatic if false { fn inactive() -> i32 { return 3 } }\n'
const pairedNativeRows = [
  {
    schema: 'silk.strict-inventory',
    version: 1,
    record: 'function',
    declaration: {
      module: { origin: 'memory', package: 'codec', path: 'result.silk' },
      owners: [
        { kind: 'Implementation', name: 'A', occurrence: 0 },
        { kind: 'Function', name: 'same', occurrence: 0 },
      ],
    },
    span: { start: 33, end: 62 },
    header_span: { start: 33, end: 62 },
    name_span: { start: 36, end: 40 },
    source_observation: {
      module: { origin: 'memory', package: 'codec', path: 'result.silk' },
      present: true,
      sha256: '3154be36e040fdbaa9146d4dcb647b06d89c2d6c69211285f6062958305e0a11',
    },
    phase: 'signature',
    eligibility: 'eligible',
    has_body: true,
    fact: {
      kind: 'signature',
      parameters: 0,
      type_parameters: 0,
      lifetime_parameters: 0,
      row_parameters: 0,
      constraints: 0,
      effect: false,
      unsafe: false,
      static: false,
    },
  },
  {
    schema: 'silk.strict-inventory',
    version: 1,
    record: 'function',
    declaration: {
      module: { origin: 'memory', package: 'codec', path: 'result.silk' },
      owners: [
        { kind: 'Implementation', name: 'A', occurrence: 0 },
        { kind: 'Function', name: 'same', occurrence: 0 },
      ],
    },
    span: { start: 33, end: 62 },
    header_span: { start: 33, end: 62 },
    name_span: { start: 36, end: 40 },
    source_observation: {
      module: { origin: 'memory', package: 'codec', path: 'result.silk' },
      present: true,
      sha256: '3154be36e040fdbaa9146d4dcb647b06d89c2d6c69211285f6062958305e0a11',
    },
    phase: 'body',
    eligibility: 'eligible',
    has_body: true,
    fact: { kind: 'body', checking_stage: 'fully-checked', borrow_status: 'not-checked' },
  },
  {
    schema: 'silk.strict-inventory',
    version: 1,
    record: 'function',
    declaration: {
      module: { origin: 'memory', package: 'codec', path: 'result.silk' },
      owners: [
        { kind: 'Implementation', name: 'B', occurrence: 0 },
        { kind: 'Function', name: 'same', occurrence: 0 },
      ],
    },
    span: { start: 74, end: 103 },
    header_span: { start: 74, end: 103 },
    name_span: { start: 77, end: 81 },
    source_observation: {
      module: { origin: 'memory', package: 'codec', path: 'result.silk' },
      present: true,
      sha256: '3154be36e040fdbaa9146d4dcb647b06d89c2d6c69211285f6062958305e0a11',
    },
    phase: 'signature',
    eligibility: 'eligible',
    has_body: true,
    fact: {
      kind: 'signature',
      parameters: 0,
      type_parameters: 0,
      lifetime_parameters: 0,
      row_parameters: 0,
      constraints: 0,
      effect: false,
      unsafe: false,
      static: false,
    },
  },
  {
    schema: 'silk.strict-inventory',
    version: 1,
    record: 'function',
    declaration: {
      module: { origin: 'memory', package: 'codec', path: 'result.silk' },
      owners: [
        { kind: 'Implementation', name: 'B', occurrence: 0 },
        { kind: 'Function', name: 'same', occurrence: 0 },
      ],
    },
    span: { start: 74, end: 103 },
    header_span: { start: 74, end: 103 },
    name_span: { start: 77, end: 81 },
    source_observation: {
      module: { origin: 'memory', package: 'codec', path: 'result.silk' },
      present: true,
      sha256: '3154be36e040fdbaa9146d4dcb647b06d89c2d6c69211285f6062958305e0a11',
    },
    phase: 'body',
    eligibility: 'eligible',
    has_body: true,
    fact: { kind: 'body', checking_stage: 'fully-checked', borrow_status: 'not-checked' },
  },
  {
    schema: 'silk.strict-inventory',
    version: 1,
    record: 'function',
    declaration: {
      module: { origin: 'memory', package: 'codec', path: 'result.silk' },
      owners: [
        { kind: 'Interface', name: 'Contract', occurrence: 0 },
        { kind: 'Function', name: 'absent', occurrence: 0 },
      ],
    },
    span: { start: 127, end: 145 },
    header_span: { start: 127, end: 145 },
    name_span: { start: 130, end: 136 },
    source_observation: {
      module: { origin: 'memory', package: 'codec', path: 'result.silk' },
      present: true,
      sha256: '3154be36e040fdbaa9146d4dcb647b06d89c2d6c69211285f6062958305e0a11',
    },
    phase: 'signature',
    eligibility: 'no-body',
    has_body: false,
    fact: {
      kind: 'signature',
      parameters: 0,
      type_parameters: 0,
      lifetime_parameters: 0,
      row_parameters: 0,
      constraints: 0,
      effect: false,
      unsafe: false,
      static: false,
    },
  },
  {
    schema: 'silk.strict-inventory',
    version: 1,
    record: 'function',
    declaration: {
      module: { origin: 'memory', package: 'codec', path: 'result.silk' },
      owners: [
        { kind: 'Interface', name: 'Contract', occurrence: 0 },
        { kind: 'Function', name: 'absent', occurrence: 0 },
      ],
    },
    span: { start: 127, end: 145 },
    header_span: { start: 127, end: 145 },
    name_span: { start: 130, end: 136 },
    source_observation: {
      module: { origin: 'memory', package: 'codec', path: 'result.silk' },
      present: true,
      sha256: '3154be36e040fdbaa9146d4dcb647b06d89c2d6c69211285f6062958305e0a11',
    },
    phase: 'body',
    eligibility: 'no-body',
    has_body: false,
    fact: {
      kind: 'rejected',
      code: 'Unsupported',
      module: { origin: 'memory', package: 'codec', path: 'result.silk' },
      span: { start: 127, end: 145 },
    },
  },
  {
    schema: 'silk.strict-inventory',
    version: 1,
    record: 'function',
    declaration: {
      module: { origin: 'memory', package: 'codec', path: 'result.silk' },
      owners: [{ kind: 'Function', name: 'refused', occurrence: 0 }],
    },
    span: { start: 148, end: 186 },
    header_span: { start: 148, end: 186 },
    name_span: { start: 151, end: 158 },
    source_observation: {
      module: { origin: 'memory', package: 'codec', path: 'result.silk' },
      present: true,
      sha256: '3154be36e040fdbaa9146d4dcb647b06d89c2d6c69211285f6062958305e0a11',
    },
    phase: 'signature',
    eligibility: 'eligible',
    has_body: true,
    fact: {
      kind: 'signature',
      parameters: 0,
      type_parameters: 0,
      lifetime_parameters: 0,
      row_parameters: 0,
      constraints: 0,
      effect: false,
      unsafe: false,
      static: false,
    },
  },
  {
    schema: 'silk.strict-inventory',
    version: 1,
    record: 'function',
    declaration: {
      module: { origin: 'memory', package: 'codec', path: 'result.silk' },
      owners: [{ kind: 'Function', name: 'refused', occurrence: 0 }],
    },
    span: { start: 148, end: 186 },
    header_span: { start: 148, end: 186 },
    name_span: { start: 151, end: 158 },
    source_observation: {
      module: { origin: 'memory', package: 'codec', path: 'result.silk' },
      present: true,
      sha256: '3154be36e040fdbaa9146d4dcb647b06d89c2d6c69211285f6062958305e0a11',
    },
    phase: 'body',
    eligibility: 'eligible',
    has_body: true,
    fact: {
      kind: 'rejected',
      code: 'UnknownName',
      module: { origin: 'memory', package: 'codec', path: 'result.silk' },
      span: { start: 177, end: 184 },
    },
  },
  {
    schema: 'silk.strict-inventory',
    version: 1,
    record: 'function',
    declaration: {
      module: { origin: 'memory', package: 'codec', path: 'result.silk' },
      owners: [
        { kind: 'Conditional', name: null, occurrence: 0 },
        { kind: 'Conditional', name: null, occurrence: 1 },
        { kind: 'Function', name: 'inactive', occurrence: 0 },
      ],
    },
    span: { start: 205, end: 238 },
    header_span: { start: 205, end: 238 },
    name_span: { start: 208, end: 216 },
    source_observation: {
      module: { origin: 'memory', package: 'codec', path: 'result.silk' },
      present: true,
      sha256: '3154be36e040fdbaa9146d4dcb647b06d89c2d6c69211285f6062958305e0a11',
    },
    phase: 'signature',
    eligibility: 'inactive',
    has_body: true,
    fact: {
      kind: 'rejected',
      code: 'UnknownMember',
      module: { origin: 'memory', package: 'codec', path: 'result.silk' },
      span: { start: 0, end: 0 },
    },
  },
  {
    schema: 'silk.strict-inventory',
    version: 1,
    record: 'function',
    declaration: {
      module: { origin: 'memory', package: 'codec', path: 'result.silk' },
      owners: [
        { kind: 'Conditional', name: null, occurrence: 0 },
        { kind: 'Conditional', name: null, occurrence: 1 },
        { kind: 'Function', name: 'inactive', occurrence: 0 },
      ],
    },
    span: { start: 205, end: 238 },
    header_span: { start: 205, end: 238 },
    name_span: { start: 208, end: 216 },
    source_observation: {
      module: { origin: 'memory', package: 'codec', path: 'result.silk' },
      present: true,
      sha256: '3154be36e040fdbaa9146d4dcb647b06d89c2d6c69211285f6062958305e0a11',
    },
    phase: 'body',
    eligibility: 'inactive',
    has_body: true,
    fact: {
      kind: 'rejected',
      code: 'UnknownMember',
      module: { origin: 'memory', package: 'codec', path: 'result.silk' },
      span: { start: 0, end: 0 },
    },
  },
]

it.effect(
  'pairs retained actual native A.same/B.same NAME facts with current bootstrap authored anchor contexts',
  () =>
    Effect.gen(function* () {
      const f = fixture()
      const sourceId = 'codec/result'
      const bytes = Buffer.from(pairedNativeSource)
      const front = yield* Analysis.ofSource(sourceId, bytes)
      const source = Analysis.sources(front).get(sourceId)
      assert.isDefined(source)
      if (source === undefined) return
      const originals = []
      for (const module of Analysis.declarationIndex(front).modules)
        for (const declaration of module.members) {
          if (
            declaration._tag !== 'FunctionDeclaration' ||
            declaration.name._tag !== 'Present' ||
            declaration.name.spelling !== 'same'
          )
            continue
          const found = Analysis.declarationForIdentity(front, {
            _tag: 'DeclarationIdentity',
            id: declaration.id,
          })
          assert.strictEqual(found, declaration)
          const contexts = Analysis.nameResolution(front).contexts
          const span = contexts.spanOf(declaration.name.anchor)
          const declarationSpan = contexts.spanOf(declaration.anchor)
          assert.isDefined(span)
          assert.isDefined(declarationSpan)
          if (span === undefined || declarationSpan === undefined) continue
          const spelling = SourceFile.spelling(source, span)
          assert.isTrue(Option.isSome(spelling))
          if (Option.isNone(spelling)) continue
          originals.push({
            id: declaration.id,
            canonical: declaration.canonical,
            owner: declaration.owner,
            anchor: declaration.anchor,
            declarationSpan,
            name: { spelling: spelling.value, anchor: declaration.name.anchor, span },
          })
        }
      assert.strictEqual(originals.length, 2)
      const path = 'compiler/src/result.silk'
      f.input.sources[0] = { path, bytes }
      const snapshot = f.input.expected.snapshot
      snapshot.files[0] = { path, mode: '100644', sha256: Snapshot.hash(bytes) }
      snapshot.normalizedDigest = Snapshot.fileDigest(snapshot.files)
      snapshot.compilerDigest = Snapshot.fileDigest(
        snapshot.files.filter((x) => x.path.startsWith('compiler/')),
      )
      f.seed.sourceCommit = snapshot.sourceCommit
      f.seed.inputSnapshot.normalizedDigest = snapshot.normalizedDigest
      f.seed.inputSnapshot.compilerDigest = snapshot.compilerDigest
      f.footer.consumed_seed_receipt_raw =
        (yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(f.seed)) + '\n'
      f.footer.seed_receipt_sha256 = Snapshot.hash(f.footer.consumed_seed_receipt_raw)
      f.input.build.linker.seedReceiptSha256 = f.footer.seed_receipt_sha256
      f.input.build.inputs.normalizedDigest = snapshot.normalizedDigest
      f.input.build.inputs.compiler.sha256 = snapshot.compilerDigest
      f.input.build.inputs.compiler.files = [snapshot.files[0]]
      const copied = structuredClone(pairedNativeRows)
      for (const row of copied) row.source_observation.revision = 2
      const nativeModule = copied[0].declaration.module
      f.moduleRows[0] = {
        ...f.moduleRows[0],
        module: nativeModule,
        source_file: path,
        functions: 5,
        sha256: Snapshot.hash(bytes),
      }
      f.footer.functions = 5
      f.footer.records = 10
      f.footer.expected_records = 10
      f.footer.input_observation_sha256 = Snapshot.hash(
        f.moduleRows
          .map(
            (m) =>
              JSON.stringify({
                source_file: m.source_file,
                role: m.role,
                present: m.present,
                sha256: m.sha256,
              }) + '\n',
          )
          .join(''),
      )
      f.inventory.compilation.root = 'src/result.silk'
      f.inventory.selected.selectedAuthoredFunctions = originals
      // Synthetic selected containers only: actual public original identity/name bytes above.
      f.inventory.selected.instances = originals.map((original) => ({
        key: {
          identity: 'synthetic-container-control',
          declaration: original.canonical.id,
          typeArguments: [],
          staticArguments: [],
          contractRow: [],
          evidence: [],
        },
        artifact: { owner: original.owner, request: { _tag: 'Check' } },
        origin: { kind: 'Authored', declaration: original.id },
        originalDeclaration: original.id,
        originalDeclarationSpan: original.declarationSpan,
        residualBodySites: [],
      }))
      f.inventory.selected.executionKeys = []
      f.inventory.selected.reachedExecutionEdges = []
      f.inventory.consumedSources[0] = { module: sourceId, path, sha256: Snapshot.hash(bytes) }
      f.input.native = [...f.moduleRows, ...copied, f.footer]
        .map((r) => JSON.stringify(r) + '\n')
        .join('')
      // Match the V03 actor's published JSON transport, which exports span scalar fields.
      const wire = Schema.fromJsonString(Schema.Unknown)
      f.input.bootstrap = yield* Schema.decodeEffect(wire)(
        yield* Schema.encodeEffect(wire)(f.inventory),
      )
      const report = yield* Report.report(f.input)
      assert.strictEqual(report.json.evidence.joins.length, 2)
      assert.deepEqual(
        report.json.evidence.joins.map((j) => j.nameSpan).sort((a, b) => a.start - b.start),
        [
          { start: 36, end: 40 },
          { start: 77, end: 81 },
        ],
      )
      assert.deepEqual(
        report.json.evidence.joins
          .map((j) => j.native.owners[0].name)
          .sort((a, b) => a.localeCompare(b)),
        ['A', 'B'],
      )
      assert.isTrue(
        report.json.evidence.joins.every(
          (j) => j.bootstrap.owner.path.length > 0 && j.bootstrap.id._tag === 'DeclarationId',
        ),
      )
      assert.strictEqual(report.json.coverage.namedFunctions, 5)
    }),
)
