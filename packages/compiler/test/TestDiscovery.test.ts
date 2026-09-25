import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Result from 'effect/Result'
import * as Analysis from '../src/Analysis.js'
import * as CompilationProfile from '../src/CompilationProfile.js'
import * as ConfigurationOrigin from '../src/ConfigurationOrigin.js'
import * as SourceFile from '../src/SourceFile.js'
import * as SourceOrigin from '../src/SourceOrigin.js'
import * as SourceResolver from '../src/SourceResolver.js'
import * as TestExecution from '../src/TestExecution.js'
import * as Tir from '../src/Tir.js'
import * as Type from '../src/Type.js'
import { unreachable } from './support/raise.js'

const encoder = new TextEncoder()

const source = (module: string, text: string) =>
  SourceFile.make(
    module,
    encoder.encode(text),
    SourceOrigin.projectFile(`/project/src/${module}.silk`),
  )

const snapshot = (
  body: string,
  helper: string,
  options: { readonly prelude?: string; readonly qualifier?: 'test' | 'pub test' } = {},
) => {
  const files = [
    source('runner/Main', 'import runner.Support\npub fn main() -> () {}'),
    source('runner/Support', 'test fn runnerOnly() -> () {}'),
    source('suite/Root', 'import suite.Cases\nimport suite.Bridge\nimport dependency.Tests'),
    source('suite/Bridge', 'import suite.Cases\nimport suite.More\nimport suite.Root'),
    source(
      'suite/Cases',
      `${options.prelude ?? ''}${options.qualifier ?? 'test'} fn alpha() -> () { ${body} }
test fn beta() -> () { helper() }
static if false { test fn inactive() {} }
fn helper() -> () { ${helper} }`,
    ),
    source('suite/More', `test fn alpha() -> () { ${body} }`),
    source('dependency/Tests', 'test fn dependencyOnly() -> () {}'),
    source('suite/Neighbor', 'test fn unimported() -> () {}'),
  ]
  return Analysis.make({
    root: 'runner/Main',
    target: 'x86_64-unknown-linux-gnu',
    discovery: {
      root: 'suite/Root',
      logicalRoot: 'src',
      sources: new Map([
        [
          'dependency/Tests',
          { ownership: 'Dependency' as const, logicalPath: 'vendor/dependency/Tests.silk' },
        ],
      ]),
    },
  }).pipe(
    Effect.provide(SourceResolver.overlay(files).pipe(Layer.provideMerge(SourceResolver.empty))),
  )
}

const fingerprintSnapshot = (text: string) =>
  Analysis.make({
    root: 'Cases',
    target: 'x86_64-unknown-linux-gnu',
    discovery: { root: 'Cases' },
  }).pipe(
    Effect.provide(
      SourceResolver.overlay([source('Cases', text)]).pipe(
        Layer.provideMerge(SourceResolver.empty),
      ),
    ),
  )

const defaultEnvironment: TestExecution.Environment = {
  profileIdentity: 'profile-a',
  bootstrapIdentity: 'bootstrap-a',
  runnerIdentity: TestExecution.runnerPolicyIdentity,
  compilerIdentity: 'compiler-a',
  runtimeIdentity: 'runtime-a',
  nativeIdentity: 'native-a',
  complete: true,
}

const manifestOf = Effect.fnUntraced(function* (
  analysis: Analysis.Snapshot,
  environment: TestExecution.Environment,
) {
  const catalog = analysis.testCatalog
  if (catalog === undefined) return unreachable('expected test catalog')
  return TestExecution.make(
    yield* TestExecution.closures(catalog, Analysis.instancesOf(analysis), analysis.results),
    environment,
  )
})

const executionSnapshot = Effect.fnUntraced(function* (
  text: string,
  environment: TestExecution.Environment = defaultEnvironment,
) {
  const analysis = yield* Analysis.makeRealized({
    root: 'Cases',
    target: 'x86_64-unknown-linux-gnu',
    discovery: { root: 'Cases' },
  }).pipe(
    Effect.provide(
      SourceResolver.overlay([source('Cases', text)]).pipe(
        Layer.provideMerge(SourceResolver.empty),
      ),
    ),
  )
  assert.deepEqual(Analysis.diagnostics(analysis), [])
  const manifest = yield* manifestOf(analysis, environment)
  return { analysis, manifest }
})

const executionManifest = Effect.fnUntraced(function* (
  text: string,
  environment: TestExecution.Environment = defaultEnvironment,
) {
  return (yield* executionSnapshot(text, environment)).manifest
})

const eligibleIdentities = (manifest: TestExecution.Manifest): ReadonlyMap<string, string> =>
  new Map(
    manifest.entries.flatMap((entry) =>
      entry.eligibility._tag === 'Eligible'
        ? [[entry.test.name, entry.eligibility.identity] as const]
        : [],
    ),
  )

const runnerExecutionIdentity = Effect.fnUntraced(function* (text: string) {
  const analysis = yield* Analysis.makeRealized({
    root: 'Cases',
    target: 'x86_64-unknown-linux-gnu',
    discovery: { root: 'Cases' },
  }).pipe(
    Effect.provide(
      SourceResolver.overlay([source('Cases', text)]).pipe(
        Layer.provideMerge(SourceResolver.empty),
      ),
    ),
  )
  assert.deepEqual(Analysis.diagnostics(analysis), [])
  const catalog = analysis.testCatalog
  if (catalog === undefined) return unreachable('expected test catalog')
  return yield* TestExecution.runnerIdentity(
    Analysis.instancesOf(analysis),
    analysis.results,
    catalog,
  )
})

it.effect('builds a deterministic project-owned catalog from only the discovery-root closure', () =>
  Effect.gen(function* () {
    const analysis = yield* snapshot('let value = 1 drop value', 'let value = 2 drop value')
    assert.deepEqual(analysis.diagnostics, [])
    const catalog = analysis.testCatalog
    assert.isDefined(catalog)
    assert.deepEqual(
      catalog?.entries.map((entry) => [entry.info.module, entry.info.name, entry.info.path]),
      [
        ['suite/Cases', 'alpha', 'src/suite/Cases.silk'],
        ['suite/Cases', 'beta', 'src/suite/Cases.silk'],
        ['suite/More', 'alpha', 'src/suite/More.silk'],
      ],
    )
    assert.match(catalog?.entries[0]?.info.fingerprint ?? '', /^silk-test-v1:[0-9a-f]{64}$/)
    assert.notStrictEqual(catalog?.entries[0]?.info.identity, catalog?.entries[2]?.info.identity)
  }),
)

it.effect(
  'fingerprints local authored test content without treating helper bodies as dependencies',
  () =>
    Effect.gen(function* () {
      const before = yield* fingerprintSnapshot(`test fn alpha() -> () { let value = 1 drop value }
test fn beta() -> () { helper() }
fn helper() -> () { let value = 2 drop value }`)
      const bodyAndHelperEdit = yield* fingerprintSnapshot(
        `test fn alpha() -> () { let value = 3 drop value }
test fn beta() -> () { helper() }
fn helper() -> () { let value = 4 drop value }`,
      )
      const headerEdit = yield* fingerprintSnapshot(
        `pub test fn alpha() -> () { let value = 1 drop value }
test fn beta() -> () { helper() }
fn helper() -> () { let value = 2 drop value }`,
      )
      const movedAndTriviaEdit = yield* fingerprintSnapshot(`

fn unrelated() {}
test fn alpha() -> () { let value=1
  drop value }
test fn beta() -> () { helper() }
fn helper() -> () { let value = 2 drop value }`)
      const fingerprints = (analysis: Analysis.SingleRootFrontendSnapshot) =>
        new Map(
          analysis.testCatalog?.entries.map((entry) => [
            `${entry.info.module}:${entry.info.name}`,
            entry.info.fingerprint,
          ]),
        )
      assert.notStrictEqual(
        fingerprints(before).get('Cases:alpha'),
        fingerprints(bodyAndHelperEdit).get('Cases:alpha'),
      )
      assert.strictEqual(
        fingerprints(before).get('Cases:beta'),
        fingerprints(bodyAndHelperEdit).get('Cases:beta'),
      )
      assert.notStrictEqual(
        fingerprints(before).get('Cases:alpha'),
        fingerprints(headerEdit).get('Cases:alpha'),
      )
      assert.strictEqual(
        fingerprints(before).get('Cases:beta'),
        fingerprints(headerEdit).get('Cases:beta'),
      )
      assert.strictEqual(
        fingerprints(before).get('Cases:alpha'),
        fingerprints(movedAndTriviaEdit).get('Cases:alpha'),
      )
      assert.notStrictEqual(
        before.testCatalog?.entries[0]?.info.line,
        movedAndTriviaEdit.testCatalog?.entries[0]?.info.line,
      )
      assert.notStrictEqual(before.testCatalog?.identity, bodyAndHelperEdit.testCatalog?.identity)
      assert.notStrictEqual(before.testCatalog?.identity, movedAndTriviaEdit.testCatalog?.identity)
    }),
)

it.effect('attributes observable layouts only to their users', () =>
  Effect.gen(function* () {
    const program = (field: 'i32' | 'i64') => `import silk.layout { Layout }
struct Value { item: ${field} }
test fn alpha() -> () { let layout = Layout.of<Value>() drop layout }
test fn beta() -> () {}
pub fn main() -> () {
  static for descriptor in Intrinsic.tests() {
    let body = Intrinsic.testFunction(descriptor)
    body()
  }
}`
    const before = yield* executionManifest(program('i32'))
    const changed = yield* executionManifest(program('i64'))
    for (const manifest of [before, changed]) {
      assert.deepEqual(
        manifest.entries.map((entry) => entry.test.name),
        ['alpha', 'beta'],
      )
      assert.deepEqual(
        manifest.entries.map((entry) => entry.eligibility._tag),
        ['Eligible', 'Eligible'],
      )
    }
    const beforeIdentities = eligibleIdentities(before)
    const changedIdentities = eligibleIdentities(changed)
    assert.notStrictEqual(changedIdentities.get('alpha'), beforeIdentities.get('alpha'))
    assert.strictEqual(changedIdentities.get('beta'), beforeIdentities.get('beta'))
  }),
)

it.effect('retains folded constant provenance for shared memoized static helpers', () =>
  Effect.gen(function* () {
    const program = (initializer: string) => `const ANSWER: i32 = ${initializer}
static fn leaf() -> i32 { return ANSWER }
test fn alpha() -> () {
  let answer = leaf()
  if answer == 2 { let crash = 1 / 0 drop crash }
}
test fn direct() -> () {
  if ANSWER == 2 { let crash = 1 / 0 drop crash }
}
test fn shared() -> () { let answer = leaf() drop answer }
test fn beta() -> () {}
pub fn main() -> () {
  static for descriptor in Intrinsic.tests() {
    let body = Intrinsic.testFunction(descriptor)
    body()
  }
}`
    const before = yield* executionSnapshot(program('1'))
    const changed = yield* executionSnapshot(program('2'))
    const sameResultEdit = yield* executionSnapshot(program('1 + 0'))
    const beforeIdentities = eligibleIdentities(before.manifest)
    const changedIdentities = eligibleIdentities(changed.manifest)
    const sameResultIdentities = eligibleIdentities(sameResultEdit.manifest)

    for (const snapshot of [before, changed, sameResultEdit]) {
      assert.deepEqual(
        snapshot.manifest.entries.map((entry) => entry.test.name),
        ['alpha', 'beta', 'direct', 'shared'],
      )
      assert.deepEqual(
        snapshot.manifest.entries.map((entry) => entry.eligibility._tag),
        ['Eligible', 'Eligible', 'Eligible', 'Eligible'],
      )
      const dependencies = new Map(
        Analysis.instancesOf(snapshot.analysis).residualBodies.flatMap((body) =>
          body.declaration.module === 'Cases'
            ? body.dependencies
                .filter((dependency) => dependency.declaration.name === 'leaf')
                .map((dependency) => [body.declaration.name, dependency] as const)
            : [],
        ),
      )
      const alpha = dependencies.get('alpha')
      const shared = dependencies.get('shared')
      assert.isDefined(alpha)
      assert.isDefined(shared)
      if (alpha === undefined || shared === undefined)
        return unreachable('expected shared static helper dependencies')
      assert.strictEqual(alpha.application, shared.application)
      for (const dependency of [alpha, shared]) {
        assert.deepEqual(dependency.resolvedConstants, [
          { _tag: 'CanonicalDeclarationId', module: 'Cases', name: 'ANSWER' },
        ])
        assert.include(dependency.resolvedTypes, 'i32')
      }
    }

    for (const name of ['alpha', 'direct', 'shared']) {
      assert.notStrictEqual(changedIdentities.get(name), beforeIdentities.get(name))
      assert.notStrictEqual(sameResultIdentities.get(name), beforeIdentities.get(name))
    }
    assert.strictEqual(changedIdentities.get('beta'), beforeIdentities.get('beta'))
    assert.strictEqual(sameResultIdentities.get('beta'), beforeIdentities.get('beta'))
  }),
)

it.effect('retains resolved scalar types for shared memoized static helpers', () =>
  Effect.gen(function* () {
    const program = (number: 'f32' | 'f64') => `type Number = ${number}
static fn leaf() -> bool {
  let value: Number = 16777216.0
  return value + 1.0 == value
}
fn runtimeValue() -> Number { return 1.0 }
test fn alpha() -> () {
  if leaf() { let crash = 1 / 0 drop crash }
}
test fn runtime() -> () { let value = runtimeValue() drop value }
test fn shared() -> () { let rounded = leaf() drop rounded }
test fn beta() -> () {}
pub fn main() -> () {
  static for descriptor in Intrinsic.tests() {
    let body = Intrinsic.testFunction(descriptor)
    body()
  }
}`
    const before = yield* executionSnapshot(program('f64'))
    const changed = yield* executionSnapshot(program('f32'))
    const beforeIdentities = eligibleIdentities(before.manifest)
    const changedIdentities = eligibleIdentities(changed.manifest)

    for (const [snapshot_, type] of [
      [before, 'builtin:f64'],
      [changed, 'builtin:f32'],
    ] as const) {
      assert.deepEqual(
        snapshot_.manifest.entries.map((entry) => entry.test.name),
        ['alpha', 'beta', 'runtime', 'shared'],
      )
      assert.deepEqual(
        snapshot_.manifest.entries.map((entry) => entry.eligibility._tag),
        ['Eligible', 'Eligible', 'Eligible', 'Eligible'],
      )
      const dependencies = new Map(
        Analysis.instancesOf(snapshot_.analysis).residualBodies.flatMap((body) =>
          body.declaration.module === 'Cases'
            ? body.dependencies
                .filter((dependency) => dependency.declaration.name === 'leaf')
                .map((dependency) => [body.declaration.name, dependency] as const)
            : [],
        ),
      )
      const alpha = dependencies.get('alpha')
      const shared = dependencies.get('shared')
      assert.isDefined(alpha)
      assert.isDefined(shared)
      if (alpha === undefined || shared === undefined)
        return unreachable('expected shared static helper dependencies')
      assert.strictEqual(alpha.application, shared.application)
      for (const dependency of [alpha, shared]) {
        assert.include(dependency.resolvedTypes.map(Type.key), 'builtin:bool')
        assert.include(dependency.resolvedTypes.map(Type.key), type)
      }
    }

    for (const name of ['alpha', 'runtime', 'shared'])
      assert.notStrictEqual(changedIdentities.get(name), beforeIdentities.get(name))
    assert.strictEqual(changedIdentities.get('beta'), beforeIdentities.get('beta'))
  }),
)

it.effect('projects non-nominal composite types into static execution identities', () =>
  Effect.gen(function* () {
    const program = (values: '[i32; 0]' | '[[i32; 1]; 0]') => `type Values = ${values}
static fn leaf() -> bool {
  let values: Values = []
  drop values
  return false
}
test fn alpha() -> () {
  if leaf() { let crash = 1 / 0 drop crash }
}
test fn beta() -> () {}
pub fn main() -> () {
  static for descriptor in Intrinsic.tests() {
    let body = Intrinsic.testFunction(descriptor)
    body()
  }
}`
    const before = yield* executionSnapshot(program('[i32; 0]'))
    const changed = yield* executionSnapshot(program('[[i32; 1]; 0]'))
    const beforeIdentities = eligibleIdentities(before.manifest)
    const changedIdentities = eligibleIdentities(changed.manifest)

    for (const [snapshot_, type] of [
      [before, 'array:0<builtin:i32>'],
      [changed, 'array:0<array:1<builtin:i32>>'],
    ] as const) {
      assert.deepEqual(
        snapshot_.manifest.entries.map((entry) => entry.eligibility._tag),
        ['Eligible', 'Eligible'],
      )
      const dependency = Analysis.instancesOf(snapshot_.analysis)
        .residualBodies.find(
          (body) => body.declaration.module === 'Cases' && body.declaration.name === 'alpha',
        )
        ?.dependencies.find((candidate) => candidate.declaration.name === 'leaf')
      assert.isDefined(dependency)
      assert.include(dependency?.resolvedTypes.map(Type.key) ?? [], type)
    }

    assert.notStrictEqual(changedIdentities.get('alpha'), beforeIdentities.get('alpha'))
    assert.strictEqual(changedIdentities.get('beta'), beforeIdentities.get('beta'))
  }),
)

it.effect('retains folded constant provenance in custom runner work', () =>
  Effect.gen(function* () {
    const program = (initializer: string) => `const ANSWER: i32 = ${initializer}
static fn leaf() -> i32 { return ANSWER }
test fn alpha() -> () {}
test fn beta() -> () {}
pub fn main() -> () {
  let answer = leaf()
  if answer == 2 { let crash = 1 / 0 drop crash }
  static for descriptor in Intrinsic.tests() {
    let body = Intrinsic.testFunction(descriptor)
    body()
  }
}`
    const before = yield* executionSnapshot(program('1'))
    const changed = yield* executionSnapshot(program('2'))
    const sameResultEdit = yield* executionSnapshot(program('1 + 0'))
    const runnerOf = Effect.fnUntraced(function* (snapshot: typeof before) {
      const catalog = snapshot.analysis.testCatalog
      if (catalog === undefined) return unreachable('expected test catalog')
      return yield* TestExecution.runnerIdentity(
        Analysis.instancesOf(snapshot.analysis),
        snapshot.analysis.results,
        catalog,
      )
    })
    const beforeRunner = yield* runnerOf(before)
    const changedRunner = yield* runnerOf(changed)
    const sameResultRunner = yield* runnerOf(sameResultEdit)
    assert.isTrue(beforeRunner.complete)
    assert.isTrue(changedRunner.complete)
    assert.isTrue(sameResultRunner.complete)
    assert.notStrictEqual(changedRunner.identity, beforeRunner.identity)
    assert.notStrictEqual(sameResultRunner.identity, beforeRunner.identity)
    assert.deepEqual(eligibleIdentities(changed.manifest), eligibleIdentities(before.manifest))
    assert.deepEqual(
      eligibleIdentities(sameResultEdit.manifest),
      eligibleIdentities(before.manifest),
    )

    const runnerDependency = Analysis.instancesOf(before.analysis)
      .residualBodies.find(
        (body) => body.declaration.module === 'Cases' && body.declaration.name === 'main',
      )
      ?.dependencies.find((dependency) => dependency.declaration.name === 'leaf')
    assert.isDefined(runnerDependency)
    assert.deepEqual(runnerDependency?.resolvedConstants, [
      { _tag: 'CanonicalDeclarationId', module: 'Cases', name: 'ANSWER' },
    ])
  }),
)

it.effect('propagates custom runner resolved types into effective test identities', () =>
  Effect.gen(function* () {
    const program = (number: 'f32' | 'f64') => `type Number = ${number}
static fn leaf() -> bool {
  let value: Number = 16777216.0
  return value + 1.0 == value
}
test fn alpha() -> () {}
test fn beta() -> () {}
pub fn main() -> () {
  if leaf() { let crash = 1 / 0 drop crash }
  static for descriptor in Intrinsic.tests() {
    let body = Intrinsic.testFunction(descriptor)
    body()
  }
}`
    const before = yield* executionSnapshot(program('f64'))
    const changed = yield* executionSnapshot(program('f32'))
    const runnerOf = Effect.fnUntraced(function* (snapshot_: typeof before) {
      const catalog = snapshot_.analysis.testCatalog
      if (catalog === undefined) return unreachable('expected test catalog')
      return yield* TestExecution.runnerIdentity(
        Analysis.instancesOf(snapshot_.analysis),
        snapshot_.analysis.results,
        catalog,
      )
    })
    const effectiveManifest = Effect.fnUntraced(function* (
      snapshot_: typeof before,
      runner: { readonly identity: string; readonly complete: boolean },
    ) {
      const catalog = snapshot_.analysis.testCatalog
      if (catalog === undefined) return unreachable('expected test catalog')
      return TestExecution.make(
        yield* TestExecution.closures(
          catalog,
          Analysis.instancesOf(snapshot_.analysis),
          snapshot_.analysis.results,
        ),
        {
          ...defaultEnvironment,
          runnerIdentity: runner.identity,
          complete: runner.complete,
        },
      )
    })
    const beforeRunner = yield* runnerOf(before)
    const changedRunner = yield* runnerOf(changed)
    const beforeEffective = yield* effectiveManifest(before, beforeRunner)
    const changedEffective = yield* effectiveManifest(changed, changedRunner)

    assert.isTrue(beforeRunner.complete)
    assert.isTrue(changedRunner.complete)
    assert.notStrictEqual(changedRunner.identity, beforeRunner.identity)
    assert.deepEqual(
      beforeEffective.entries.map((entry) => entry.eligibility._tag),
      ['Eligible', 'Eligible'],
    )
    assert.deepEqual(
      changedEffective.entries.map((entry) => entry.eligibility._tag),
      ['Eligible', 'Eligible'],
    )
    for (const [name, identity] of eligibleIdentities(beforeEffective))
      assert.notStrictEqual(eligibleIdentities(changedEffective).get(name), identity)

    const beforeDependency = Analysis.instancesOf(before.analysis)
      .residualBodies.find(
        (body) => body.declaration.module === 'Cases' && body.declaration.name === 'main',
      )
      ?.dependencies.find((dependency) => dependency.declaration.name === 'leaf')
    const changedDependency = Analysis.instancesOf(changed.analysis)
      .residualBodies.find(
        (body) => body.declaration.module === 'Cases' && body.declaration.name === 'main',
      )
      ?.dependencies.find((dependency) => dependency.declaration.name === 'leaf')
    assert.include(beforeDependency?.resolvedTypes.map(Type.key) ?? [], 'builtin:f64')
    assert.include(changedDependency?.resolvedTypes.map(Type.key) ?? [], 'builtin:f32')
  }),
)

it.effect('keeps runner policy independent from tests while tracking custom runner work', () =>
  Effect.gen(function* () {
    const program = (alpha: number, runnerHelper: number, runnerBody: string) => `
test fn alpha() -> () { let value = ${alpha} drop value }
test fn beta() -> () {}
fn runnerHelper() -> i32 { return ${runnerHelper} }
pub fn main() -> () {
  let marker = runnerHelper() ${runnerBody}
  drop marker
  static for descriptor in Intrinsic.tests() {
    let body = Intrinsic.testFunction(descriptor)
    body()
  }
}`
    const before = yield* runnerExecutionIdentity(program(1, 2, ''))
    const alphaChanged = yield* runnerExecutionIdentity(program(3, 2, ''))
    const helperChanged = yield* runnerExecutionIdentity(program(1, 4, ''))
    const runnerChanged = yield* runnerExecutionIdentity(program(1, 2, '+ 1'))
    assert.isTrue(before.complete)
    assert.strictEqual(alphaChanged.identity, before.identity)
    assert.notStrictEqual(helperChanged.identity, before.identity)
    assert.notStrictEqual(runnerChanged.identity, before.identity)
  }),
)

it.effect('keeps the bundled runner environment complete for ordinary tests', () =>
  Effect.gen(function* () {
    const analysis = yield* Analysis.makeRealized({
      root: 'silk/test_runner',
      target: 'x86_64-unknown-linux-gnu',
      discovery: { root: 'Cases' },
    }).pipe(
      Effect.provide(
        SourceResolver.overlay([source('Cases', 'test fn cacheablePass() -> () {}')]).pipe(
          Layer.provideMerge(SourceResolver.empty),
        ),
      ),
    )
    assert.deepEqual(Analysis.diagnostics(analysis), [])
    const catalog = analysis.testCatalog
    if (catalog === undefined) return unreachable('expected test catalog')
    const runner = yield* TestExecution.runnerIdentity(
      Analysis.instancesOf(analysis),
      analysis.results,
      catalog,
    )
    assert.isTrue(runner.complete)
    const manifest = TestExecution.make(
      yield* TestExecution.closures(catalog, Analysis.instancesOf(analysis), analysis.results),
      {
        profileIdentity: 'profile-a',
        bootstrapIdentity: 'bootstrap-a',
        runnerIdentity: runner.identity,
        compilerIdentity: 'compiler-a',
        runtimeIdentity: 'runtime-a',
        nativeIdentity: 'native-a',
        complete: runner.complete,
      },
    )
    assert.deepEqual(
      manifest.entries.map((entry) => entry.test.name),
      ['cacheablePass'],
    )
    assert.deepEqual(
      manifest.entries.map((entry) => entry.eligibility._tag),
      ['Eligible'],
    )
  }),
)

it.effect('isolates exclusive helper edits and invalidates shared transitive dependents', () =>
  Effect.gen(function* () {
    const program = (shared: number, alphaOffset: number) =>
      `fn sharedHelper() -> i32 { return ${shared} }
fn alphaHelper() -> i32 { return sharedHelper() + ${alphaOffset} }
fn betaHelper() -> i32 { return sharedHelper() + 2 }
test fn alpha() -> () { let observed = alphaHelper() drop observed }
test fn beta() -> () { let observed = betaHelper() drop observed }
test fn independent() -> () {}
pub fn main() -> () {
  static for descriptor in Intrinsic.tests() {
    let body = Intrinsic.testFunction(descriptor)
    body()
  }
}`
    const before = yield* executionManifest(program(40, 1))
    const alphaChanged = yield* executionManifest(program(40, 7))
    const sharedChanged = yield* executionManifest(program(41, 1))

    for (const manifest of [before, alphaChanged, sharedChanged]) {
      assert.deepEqual(
        manifest.entries.map((entry) => entry.test.name),
        ['alpha', 'beta', 'independent'],
      )
      assert.deepEqual(
        manifest.entries.map((entry) => entry.eligibility._tag),
        ['Eligible', 'Eligible', 'Eligible'],
      )
    }
    const beforeIdentities = eligibleIdentities(before)
    const alphaIdentities = eligibleIdentities(alphaChanged)
    const sharedIdentities = eligibleIdentities(sharedChanged)

    assert.notStrictEqual(alphaIdentities.get('alpha'), beforeIdentities.get('alpha'))
    assert.strictEqual(alphaIdentities.get('beta'), beforeIdentities.get('beta'))
    assert.strictEqual(alphaIdentities.get('independent'), beforeIdentities.get('independent'))
    assert.notStrictEqual(sharedIdentities.get('alpha'), beforeIdentities.get('alpha'))
    assert.notStrictEqual(sharedIdentities.get('beta'), beforeIdentities.get('beta'))
    assert.strictEqual(sharedIdentities.get('independent'), beforeIdentities.get('independent'))
  }),
)

it.effect('includes normalized execution configuration in every eligible identity', () =>
  Effect.gen(function* () {
    const source = `test fn alpha() -> () {}
test fn beta() -> () {}
pub fn main() -> () {
  static for descriptor in Intrinsic.tests() {
    let body = Intrinsic.testFunction(descriptor)
    body()
  }
}`
    const normalized = yield* CompilationProfile.normalize({
      target: 'x86_64-unknown-linux-gnu',
      cpu: { features: ['sse2'] },
      optimization: 'none',
      safety: 'checked',
    })
    const published = yield* CompilationProfile.publish(normalized, [
      {
        package: 'suite@1.0.0',
        module: 'Cases',
        parameter: 'enabled',
        type: 'bool',
        value: { kind: 'boolean', value: true },
        origin: ConfigurationOrigin.literal('test configuration'),
      },
    ])
    const changedProfile = yield* CompilationProfile.normalize({
      target: 'x86_64-unknown-linux-gnu',
      cpu: { features: ['sse2'] },
      optimization: 'speed',
      safety: 'checked',
    })
    const { analysis, manifest: before } = yield* executionSnapshot(source, {
      ...defaultEnvironment,
      profileIdentity: published.identity,
    })
    const changed = yield* manifestOf(analysis, {
      ...defaultEnvironment,
      profileIdentity: changedProfile.identity,
    })
    const incomplete = yield* manifestOf(analysis, {
      ...defaultEnvironment,
      complete: false,
    })
    assert.notStrictEqual(changed.environmentIdentity, before.environmentIdentity)
    for (const [name, identity] of eligibleIdentities(before)) {
      assert.notStrictEqual(eligibleIdentities(changed).get(name), identity)
    }
    assert.deepEqual(
      incomplete.entries.map((entry) => entry.eligibility),
      [
        { _tag: 'Ineligible', reason: { _tag: 'IncompleteEnvironment', component: 'Runner' } },
        { _tag: 'Ineligible', reason: { _tag: 'IncompleteEnvironment', component: 'Runner' } },
      ],
    )
  }),
)

it.effect('requires the explicit discovery root', () =>
  Effect.gen(function* () {
    const attempted = yield* Effect.result(
      Analysis.make({
        root: 'runner/Main',
        discovery: { root: 'suite/Missing' },
      }).pipe(
        Effect.provide(
          SourceResolver.overlay([source('runner/Main', 'pub fn main() -> () {}')]).pipe(
            Layer.provideMerge(SourceResolver.empty),
          ),
        ),
      ),
    )
    assert.isTrue(Result.isFailure(attempted))
    if (Result.isFailure(attempted))
      assert.strictEqual(attempted.failure.reason._tag, 'MissingRoot')
  }),
)

it.effect('requires ownership and logical-path facts for reachable in-memory sources', () =>
  Effect.gen(function* () {
    const attempted = yield* Effect.result(
      Analysis.make({
        root: 'Runner',
        discovery: { root: 'MemoryTests' },
      }).pipe(
        Effect.provide(
          SourceResolver.overlay([
            source('Runner', 'pub fn main() -> () {}'),
            SourceFile.make(
              'MemoryTests',
              encoder.encode('test fn omitted() {}'),
              SourceOrigin.memory('memory://tests'),
            ),
          ]).pipe(Layer.provideMerge(SourceResolver.empty)),
        ),
      ),
    )

    assert.isTrue(Result.isFailure(attempted))
    if (Result.isFailure(attempted)) {
      assert.strictEqual(attempted.failure._tag, 'ModuleClosureError')
      assert.deepEqual(attempted.failure.reason, {
        _tag: 'MissingDiscoverySource',
        module: 'MemoryTests',
      })
    }
  }),
)

it.effect('requires ownership facts for in-memory sources reached by selected imports', () =>
  Effect.gen(function* () {
    const attempted = yield* Effect.result(
      Analysis.make({
        root: 'Runner',
        target: 'x86_64-unknown-linux-gnu',
        discovery: {
          root: 'MemoryTests',
          sources: new Map([
            [
              'MemoryTests',
              { ownership: 'Project' as const, logicalPath: 'tests/MemoryTests.silk' },
            ],
          ]),
        },
      }).pipe(
        Effect.provide(
          SourceResolver.overlay([
            source('Runner', 'pub fn main() -> () {}'),
            SourceFile.make(
              'MemoryTests',
              encoder.encode('static if true { import SelectedTests }'),
              SourceOrigin.memory('memory://tests'),
            ),
            SourceFile.make(
              'SelectedTests',
              encoder.encode('test fn omitted() {}'),
              SourceOrigin.memory('memory://selected-tests'),
            ),
          ]).pipe(Layer.provideMerge(SourceResolver.empty)),
        ),
      ),
    )

    assert.isTrue(Result.isFailure(attempted))
    if (Result.isFailure(attempted)) {
      assert.strictEqual(attempted.failure._tag, 'ModuleClosureError')
      assert.deepEqual(attempted.failure.reason, {
        _tag: 'MissingDiscoverySource',
        module: 'SelectedTests',
      })
    }
  }),
)

it.effect('does not retain an uncalled test in an ordinary executable', () =>
  Effect.gen(function* () {
    const analysis = yield* Analysis.makeRealized({
      root: 'Main',
      target: 'wasm32-unknown-unknown',
    }).pipe(
      Effect.provide(
        SourceResolver.overlay([
          source('Main', 'test fn unused() {}\npub fn main() -> i32 { return 0 }'),
        ]).pipe(Layer.provideMerge(SourceResolver.empty)),
      ),
    )

    assert.deepEqual(Analysis.diagnostics(analysis), [])
    assert.notInclude(
      Analysis.loweredMir(analysis).functions.map((function_) => function_.id.name),
      'unused',
    )
  }),
)

it.effect('rejects catalog iteration when realization has no discovery context', () =>
  Effect.gen(function* () {
    const analysis = yield* Analysis.makeRealized({
      root: 'Main',
      target: 'wasm32-unknown-unknown',
    }).pipe(
      Effect.provide(
        SourceResolver.overlay([
          source(
            'Main',
            `pub fn main() -> () {
  static for descriptor in Intrinsic.tests() { drop descriptor }
}`,
          ),
        ]).pipe(Layer.provideMerge(SourceResolver.empty)),
      ),
    )

    assert.include(
      Analysis.diagnostics(analysis).map((diagnostic) => diagnostic.code),
      'SEM0176',
    )
  }),
)

it.effect('specializes a private test callable without retaining discovery values', () =>
  Effect.gen(function* () {
    const analysis = yield* Analysis.makeRealized({
      root: 'Runner',
      target: 'wasm32-unknown-unknown',
      discovery: { root: 'Runner' },
    }).pipe(
      Effect.provide(
        SourceResolver.overlay([
          source(
            'Runner',
            `test fn privateTest() {}
pub fn main() -> () {
  static for descriptor in Intrinsic.tests() {
    let body = Intrinsic.testFunction(descriptor)
    body()
  }
}`,
          ),
        ]).pipe(Layer.provideMerge(SourceResolver.empty)),
      ),
    )

    assert.deepEqual(Analysis.diagnostics(analysis), [])
    const tir = Tir.encode(Analysis.rootAnalysis(analysis).tir)
    const mirStrings: string[] = []
    const pending: unknown[] = [Analysis.loweredMir(analysis)]
    while (pending.length > 0) {
      const value = pending.pop()
      if (typeof value === 'string') mirStrings.push(value)
      else if (typeof value === 'object' && value !== null)
        for (const child of Object.values(value)) pending.push(child)
    }
    const mir = mirStrings.join('\n')
    assert.include(tir, 'privateTest')
    assert.include(mir, 'privateTest')
    for (const phaseOnly of ['Intrinsic.tests', 'Intrinsic.testFunction', 'TestDescriptorValue']) {
      assert.isFalse(tir.includes(phaseOnly), tir)
      assert.isFalse(mir.includes(phaseOnly), mir)
    }
  }),
)
