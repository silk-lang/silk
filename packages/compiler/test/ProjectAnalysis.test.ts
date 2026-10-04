import { records } from './support/records.js'
import * as Layer from 'effect/Layer'
import { assert, it } from '@effect/vitest'
import * as Arr from 'effect/Array'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Option from 'effect/Option'
import * as Tracer from 'effect/Tracer'
import * as Analysis from '../src/Analysis.js'
import * as FrontendTooling from '../src/FrontendTooling.js'
import * as Tir from '../src/Tir.js'
import * as ProjectAnalysis from '../src/ProjectAnalysis.js'
import * as SourceCatalog from '../src/SourceCatalog.js'
import * as NameResolution from '../src/NameResolution.js'
import * as Ownership from '../src/Ownership.js'
import * as ResidualOwnership from '../src/ResidualOwnership.js'
import * as SourceFile from '../src/SourceFile.js'
import * as SourceOrigin from '../src/SourceOrigin.js'
import * as SourceResolver from '../src/SourceResolver.js'
import * as DeclarationFacts from '../src/DeclarationFacts.js'
import { raise } from './support/raise.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

const roots: Arr.NonEmptyReadonlyArray<SourceFile.SourceFile> = Object.freeze([
  SourceFile.make('app/A', ascii('import shared.Core\npub fn a() -> i32 { return Core.answer() }')),
  SourceFile.make('app/B', ascii('import shared.Core\npub fn b() -> i32 { return Core.answer() }')),
])

const sources = new Map([['shared/Core', ascii('pub fn answer() -> i32 { return 42 }')]])

const make = (requestedRoots: Arr.NonEmptyReadonlyArray<SourceFile.SourceFile> = roots) =>
  ProjectAnalysis.make(Arr.map(requestedRoots, (source) => source.id)).pipe(
    Effect.provide(
      SourceResolver.overlay(requestedRoots).pipe(
        Layer.provideMerge(SourceResolver.memory(sources)),
      ),
    ),
  )

it.effect(
  'isolates selected surfaces by profile while reusing parsed syntax and ignoring unloaded edits',
  () =>
    Effect.gen(function* () {
      const root = SourceFile.make(
        'selected',
        ascii(`
static if Intrinsic.targetOperatingSystem() == "darwin" {
  pub import darwin { value as selected }
} else {
  pub import linux { value as selected }
}`),
      )
      const supply = (unused: string) =>
        SourceResolver.memory(
          new Map([
            ['darwin', ascii('pub fn value() -> i32 { return 1 }')],
            ['linux', ascii('pub fn value() -> i32 { return 2 }')],
            ['unloaded', ascii(unused)],
          ]),
        )
      const darwinOptions: ProjectAnalysis.Options = {
        configuration: {
          profile: {
            target: 'aarch64-apple-darwin',
            artifact: 'object',
            runtime: { kind: 'none' },
          },
        },
      }
      const linuxOptions: ProjectAnalysis.Options = {
        configuration: {
          profile: {
            target: 'x86_64-unknown-linux-gnu',
            artifact: 'object',
            runtime: { kind: 'none' },
          },
        },
      }
      const darwin = yield* ProjectAnalysis.make([root.id], darwinOptions).pipe(
        Effect.provide(SourceResolver.overlay([root]).pipe(Layer.provideMerge(supply('')))),
      )
      const linux = yield* ProjectAnalysis.revise(darwin, [root.id], linuxOptions).pipe(
        Effect.provide(SourceResolver.overlay([root]).pipe(Layer.provideMerge(supply('')))),
      )
      const same = yield* ProjectAnalysis.revise(darwin, [root.id], darwinOptions).pipe(
        Effect.provide(
          SourceResolver.overlay([root]).pipe(
            Layer.provideMerge(supply('invalid unloaded source')),
          ),
        ),
      )
      for (const [project, expected] of [
        [darwin, 'darwin'],
        [linux, 'linux'],
        [same, 'darwin'],
      ] as const) {
        const view = ProjectAnalysis.view(project, 'selected') ?? raise('selected view')
        assert.deepEqual(view.diagnostics, [])
        const member = DeclarationFacts.publishedMember(view.index, 'selected', 'selected')
        assert.strictEqual(member._tag, 'Resolved')
        if (member._tag === 'Resolved' && member.declaration.canonical._tag === 'Canonical')
          assert.strictEqual(member.declaration.canonical.id.module, expected)
        assert.deepEqual([...view.closure.sources.keys()], [expected, 'selected'])
        const catalog = SourceCatalog.fromProject(project) ?? raise('selected catalog')
        const published =
          catalog.modules
            .get('selected')
            ?.publicDeclarations.find((declaration) => declaration.spelling === 'selected') ??
          raise('published catalog entry')
        assert.strictEqual(published.selectionSpan.sourceId, expected)
      }
      assert.strictEqual(linux.syntaxRevisions.get('selected')?._tag, 'Reused')
      assert.notStrictEqual(linux.semantics.get('selected'), darwin.semantics.get('selected'))
      assert.strictEqual(same.semantics.get('selected'), darwin.semantics.get('selected'))
      assert.strictEqual(same.profile?.identity, darwin.profile?.identity)
      assert.strictEqual(
        SourceCatalog.fromProject(same)?.identity,
        SourceCatalog.fromProject(darwin)?.identity,
      )
      assert.notStrictEqual(
        SourceCatalog.fromProject(linux)?.identity,
        SourceCatalog.fromProject(darwin)?.identity,
      )
    }),
)

it.effect('invalidates selection when an imported condition helper body changes', () =>
  Effect.gen(function* () {
    const root = SourceFile.make(
      'selected',
      ascii(`import policy { enabled }
static if enabled() { pub const first: i32 = 1 } else { pub const second: i32 = 2 }`),
    )
    const options: ProjectAnalysis.Options = {
      configuration: {
        profile: { target: 'aarch64-apple-darwin', artifact: 'object', runtime: { kind: 'none' } },
      },
    }
    const resolver = (value: boolean) =>
      SourceResolver.memory(
        new Map([['policy', ascii(`pub static fn enabled() -> bool { return ${value} }`)]]),
      )
    const before = yield* ProjectAnalysis.make([root.id], options).pipe(
      Effect.provide(SourceResolver.overlay([root]).pipe(Layer.provideMerge(resolver(true)))),
    )
    const after = yield* ProjectAnalysis.revise(before, [root.id], options).pipe(
      Effect.provide(SourceResolver.overlay([root]).pipe(Layer.provideMerge(resolver(false)))),
    )
    const beforeView = ProjectAnalysis.view(before, 'selected') ?? raise('before view')
    const afterView = ProjectAnalysis.view(after, 'selected') ?? raise('after view')
    assert.deepEqual(beforeView.diagnostics, [])
    assert.deepEqual(afterView.diagnostics, [])
    assert.strictEqual(Analysis.memberByName(beforeView, 'selected', 'first')._tag, 'Resolved')
    assert.strictEqual(Analysis.memberByName(afterView, 'selected', 'first')._tag, 'Missing')
    assert.strictEqual(Analysis.memberByName(afterView, 'selected', 'second')._tag, 'Resolved')
    assert.notStrictEqual(before.semantics.get('selected'), after.semantics.get('selected'))
    assert.strictEqual(after.syntaxRevisions.get('selected')?._tag, 'Reused')
  }),
)

const deterministicReport = (self: ProjectAnalysis.ProjectAnalysis) =>
  ProjectAnalysis.phases(self).map(({ phase, inputs, outputs, diagnostics }) => ({
    phase,
    inputs,
    outputs,
    diagnostics,
  }))

const projectViewIsNotSingleRoot: ProjectAnalysis.View extends Analysis.SingleRootFrontendSnapshot
  ? false
  : true = true

it.effect('reuses borrowed Effect contracts and invalidates changed environment bounds', () =>
  Effect.gen(function* () {
    const source = `import shared.Core
pub fn main() -> i32 { let value = 42 let result = run Core.borrow(&value) return result.* }`
    const root = SourceFile.make('query/Effect', ascii(source))
    const library = `pub effect<'env> fn borrow<'data: 'env, 'env>(value: &'data i32) -> &'data i32 { return value }
fn privateValue() -> i32 { return 1 }`
    const resolve = (source: string) =>
      SourceResolver.memory(new Map([['shared/Core', ascii(source)]]))
    const initial = yield* ProjectAnalysis.make([root.id]).pipe(
      Effect.provide(SourceResolver.overlay([root]).pipe(Layer.provideMerge(resolve(library)))),
    )
    const edited = yield* ProjectAnalysis.revise(initial, [root.id]).pipe(
      Effect.provide(
        SourceResolver.overlay([root]).pipe(
          Layer.provideMerge(resolve(library.replace('return 1', 'return 2'))),
        ),
      ),
    )
    const renamed = yield* ProjectAnalysis.revise(edited, [root.id]).pipe(
      Effect.provide(
        SourceResolver.overlay([root]).pipe(
          Layer.provideMerge(
            resolve(
              library
                .replaceAll("'data", "'backing")
                .replaceAll("'env", "'capture")
                .replace('return 1', 'return 2'),
            ),
          ),
        ),
      ),
    )
    const extra = SourceFile.make(
      'query/Effect',
      ascii(
        source +
          '\nfn another() -> i32 { let value = 21 let result = run Core.borrow(&value) return result.* }',
      ),
    )
    const additional = yield* ProjectAnalysis.revise(initial, [extra.id]).pipe(
      Effect.provide(SourceResolver.overlay([extra]).pipe(Layer.provideMerge(resolve(library)))),
    )
    for (const project of [initial, edited, renamed, additional]) {
      const view = ProjectAnalysis.view(project, 'query/Effect') ?? raise('Effect consumer')
      assert.deepEqual(Analysis.diagnostics(view), [])
    }
    const counts = (project: ProjectAnalysis.ProjectAnalysis) => {
      const counters = project.report.find(
        (phase) => phase.phase === 'Semantic.checkBody',
      )?.counters
      if (counters?._tag !== 'BodyQueryCounters') return raise('body counters')
      return counters
    }
    assert.strictEqual(counts(edited).checked, 1)
    assert.strictEqual(counts(renamed).checked, 0)
    assert.strictEqual(counts(additional).checked, 1)
    const constrained = yield* ProjectAnalysis.revise(initial, [root.id]).pipe(
      Effect.provide(
        SourceResolver.overlay([root]).pipe(
          Layer.provideMerge(resolve(library.replace("'data: 'env", "'data: 'static"))),
        ),
      ),
    )
    assert.isAbove(counts(constrained).checked, 1)
    const invalid =
      ProjectAnalysis.view(constrained, 'query/Effect') ?? raise('changed Effect bound')
    assert.include(
      Analysis.diagnostics(invalid).map((diagnostic) => diagnostic.code),
      'SEM0212',
    )
  }),
)

it.effect('reuses variance-only edits and invalidates cleanup changes', () =>
  Effect.gen(function* () {
    const root = SourceFile.make(
      'query/Dependent',
      ascii(`import shared.Core
fn consume<'a>(value: Core.Guard<'a>) { drop value }
fn unrelated() -> i32 { return 7 }`),
    )
    const library = `pub struct Guard<'a> { value: &'a i32 }
fn privateValue() -> i32 { return 1 }`
    const resolve = (source: string) =>
      SourceResolver.memory(new Map([['shared/Core', ascii(source)]]))
    const initial = yield* ProjectAnalysis.make([root.id]).pipe(
      Effect.provide(SourceResolver.overlay([root]).pipe(Layer.provideMerge(resolve(library)))),
    )
    const editedSource = library.replace('return 1', 'return 2')
    const edited = yield* ProjectAnalysis.revise(initial, [root.id]).pipe(
      Effect.provide(
        SourceResolver.overlay([root]).pipe(Layer.provideMerge(resolve(editedSource))),
      ),
    )
    const privateQueries = edited.report.find(
      (phase) => phase.phase === 'Semantic.checkBody',
    )?.counters
    assert.strictEqual(privateQueries?._tag, 'BodyQueryCounters')
    if (privateQueries?._tag !== 'BodyQueryCounters') return
    assert.strictEqual(privateQueries.checked, 1)
    assert.strictEqual(privateQueries.ownershipReused, 2)
    const exclusiveSource = editedSource.replace("&'a i32", "&'a mut i32")
    const exclusive = yield* ProjectAnalysis.revise(edited, [root.id]).pipe(
      Effect.provide(
        SourceResolver.overlay([root]).pipe(Layer.provideMerge(resolve(exclusiveSource))),
      ),
    )
    const varianceQueries = exclusive.report.find(
      (phase) => phase.phase === 'Semantic.checkBody',
    )?.counters
    assert.strictEqual(varianceQueries?._tag, 'BodyQueryCounters')
    if (varianceQueries?._tag !== 'BodyQueryCounters') return
    assert.strictEqual(varianceQueries.checked, 0)
    assert.strictEqual(varianceQueries.reused, 3)
    const cleanupSource =
      exclusiveSource +
      `
impl<'a> Drop for Guard<'a> { fn drop(self: &mut Guard<'a>) -> () { return () } }`
    const cleanup = yield* ProjectAnalysis.revise(exclusive, [root.id]).pipe(
      Effect.provide(
        SourceResolver.overlay([root]).pipe(Layer.provideMerge(resolve(cleanupSource))),
      ),
    )
    const cleanupQueries = cleanup.report.find(
      (phase) => phase.phase === 'Semantic.checkBody',
    )?.counters
    assert.strictEqual(cleanupQueries?._tag, 'BodyQueryCounters')
    if (cleanupQueries?._tag !== 'BodyQueryCounters') return
    // Adding a conformance changes the resolution catalog; implementation-only hook edits do not.
    assert.strictEqual(cleanupQueries.ownershipChecked, 4)
    assert.strictEqual(cleanupQueries.ownershipReused, 0)
    const hookEdited = yield* ProjectAnalysis.revise(cleanup, [root.id]).pipe(
      Effect.provide(
        SourceResolver.overlay([root]).pipe(
          Layer.provideMerge(
            resolve(cleanupSource.replace('return ()', 'self.value.* = 0 return ()')),
          ),
        ),
      ),
    )
    const hookQueries = hookEdited.report.find(
      (phase) => phase.phase === 'Semantic.checkBody',
    )?.counters
    assert.strictEqual(hookQueries?._tag, 'BodyQueryCounters')
    if (hookQueries?._tag !== 'BodyQueryCounters') return
    assert.strictEqual(hookQueries.checked, 1)
    assert.strictEqual(hookQueries.ownershipReused, 3)
    for (const project of [initial, edited, exclusive, cleanup, hookEdited]) {
      const view = ProjectAnalysis.view(project, 'query/Dependent') ?? raise('dependent view')
      assert.deepEqual(Analysis.diagnostics(view), [])
    }
  }),
)

it.effect(
  'checks only edited bodies and rebinds alpha-renamed lifetime declarations in cached consumers',
  () =>
    Effect.gen(function* () {
      const root = SourceFile.make(
        'query/Main',
        ascii(`import shared.Core
pub fn main() -> i32 { let value = 5 return Core.identity(&value).* }
fn sibling() -> i32 { return 8 }`),
      )
      const library = `pub fn identity<'a>(value: &'a i32) -> &'a i32 { return value }
fn privateValue() -> i32 { return 1 }
pub fn value() -> i32 { return privateValue() }`
      const initial = yield* ProjectAnalysis.make([root.id]).pipe(
        Effect.provide(
          SourceResolver.overlay([root]).pipe(
            Layer.provideMerge(SourceResolver.memory(new Map([['shared/Core', ascii(library)]]))),
          ),
        ),
      )
      const edited = library.replace('return 1', 'return 23')
      const revised = yield* ProjectAnalysis.revise(initial, [root.id]).pipe(
        Effect.provide(
          SourceResolver.overlay([root]).pipe(
            Layer.provideMerge(SourceResolver.memory(new Map([['shared/Core', ascii(edited)]]))),
          ),
        ),
      )
      const queries = revised.report.find((phase) => phase.phase === 'Semantic.checkBody')?.counters
      assert.strictEqual(queries?._tag, 'BodyQueryCounters')
      if (queries?._tag !== 'BodyQueryCounters') return
      assert.strictEqual(queries.checked, 1)
      assert.strictEqual(queries.reused, 4)
      assert.strictEqual(queries.ownershipChecked, 1)
      assert.strictEqual(queries.ownershipReused, 4)
      const alpha = edited.replaceAll("'a", "'long")
      const renamed = yield* ProjectAnalysis.revise(revised, [root.id]).pipe(
        Effect.provide(
          SourceResolver.overlay([root]).pipe(
            Layer.provideMerge(SourceResolver.memory(new Map([['shared/Core', ascii(alpha)]]))),
          ),
        ),
      )
      const renamedQueries = renamed.report.find(
        (phase) => phase.phase === 'Semantic.checkBody',
      )?.counters
      assert.strictEqual(renamedQueries?._tag, 'BodyQueryCounters')
      if (renamedQueries?._tag !== 'BodyQueryCounters') return
      assert.strictEqual(renamedQueries.checked, 0)
      assert.strictEqual(renamedQueries.reused, 5)
      assert.strictEqual(renamedQueries.ownershipChecked, 0)
      assert.strictEqual(renamedQueries.ownershipReused, 5)
      const view = ProjectAnalysis.view(renamed, 'query/Main') ?? raise('renamed query view')
      assert.deepEqual(Analysis.diagnostics(view), [])
      const consumers = view.results.get('query/Main') ?? raise('consumer facts')
      // A reused consumer names its callee by id, so it reads the renamed header of this revision.
      const selectedNames: Array<string> = []
      const visit = (expression: Tir.Expression): void => {
        if (expression._tag === 'Call')
          for (const module of view.index.modules)
            for (const declaration of module.declarations)
              if (
                declaration.canonical._tag === 'Canonical' &&
                declaration.canonical.id.module === expression.target.module &&
                declaration.canonical.id.name === expression.target.name
              )
                for (const parameter of declaration.typeParameters)
                  if (parameter.name._tag === 'Present') selectedNames.push(parameter.name.spelling)
        Tir.expressionChildren(expression).forEach(visit)
      }
      for (const fn of consumers.tir.functions)
        fn.statements.flatMap(Tir.statementExpressions).forEach(visit)
      assert.deepEqual(selectedNames, ["'long"])
      const functions =
        records(view.results.get('shared/Core'))?.functions ?? raise('library facts')
      const value = functions.at(-1) ?? raise('last library function')
      // The presented header span is trivia-free, so it slices the declaration exactly.
      const valueSpan = view.resolution.contexts.spanOf(value.declaration.anchor)
      assert.strictEqual(
        alpha.slice(valueSpan.start, valueSpan.end),
        'pub fn value() -> i32 { return privateValue() }',
      )
      const additionalRoot = SourceFile.make(
        'query/Main',
        ascii(`import shared.Core
pub fn main() -> i32 { let value = 5 return Core.identity(&value).* }
fn sibling() -> i32 { return 8 }
fn additional() -> i32 { let value = 6 return Core.identity(&value).* }`),
      )
      const additional = yield* ProjectAnalysis.revise(renamed, [additionalRoot.id]).pipe(
        Effect.provide(
          SourceResolver.overlay([additionalRoot]).pipe(
            Layer.provideMerge(SourceResolver.memory(new Map([['shared/Core', ascii(alpha)]]))),
          ),
        ),
      )
      const additionalQueries = additional.report.find(
        (phase) => phase.phase === 'Semantic.checkBody',
      )?.counters
      assert.strictEqual(additionalQueries?._tag, 'BodyQueryCounters')
      if (additionalQueries?._tag !== 'BodyQueryCounters') return
      assert.strictEqual(additionalQueries.checked, 1)
      assert.strictEqual(additionalQueries.reused, 5)
      const constrained = alpha.replace("identity<'long>", "identity<'long: 'static>")
      const changedBound = yield* ProjectAnalysis.revise(renamed, [root.id]).pipe(
        Effect.provide(
          SourceResolver.overlay([root]).pipe(
            Layer.provideMerge(
              SourceResolver.memory(new Map([['shared/Core', ascii(constrained)]])),
            ),
          ),
        ),
      )
      const boundQueries = changedBound.report.find(
        (phase) => phase.phase === 'Semantic.checkBody',
      )?.counters
      assert.strictEqual(boundQueries?._tag, 'BodyQueryCounters')
      if (boundQueries?._tag !== 'BodyQueryCounters') return
      assert.strictEqual(boundQueries.checked, 2)
      assert.strictEqual(boundQueries.reused, 3)
    }),
)

const assertProjectViewNotRealizable = (view: ProjectAnalysis.View): void => {
  assert.strictEqual(view.realization, 'ProjectView')
  assert.isTrue(projectViewIsNotSingleRoot)
}

it.effect('invalidates a cached missing imported member only when that member appears', () =>
  Effect.gen(function* () {
    const source = `import shared.Core
pub fn main() -> i32 { return Core.answer() }
fn sibling() -> i32 { return 0 }`
    const root = SourceFile.make('query/Missing', ascii(source))
    const initialLibrary = 'pub fn other() -> i32 { return 1 }'
    const initial = yield* ProjectAnalysis.make([root.id]).pipe(
      Effect.provide(
        SourceResolver.overlay([root]).pipe(
          Layer.provideMerge(
            SourceResolver.memory(new Map([['shared/Core', ascii(initialLibrary)]])),
          ),
        ),
      ),
    )
    const initialView = ProjectAnalysis.view(initial, root.id) ?? raise('missing initial view')
    const missing = Analysis.diagnostics(initialView)
    assert.deepEqual(
      missing.map((diagnostic) => ({
        code: diagnostic.code,
        start: diagnostic.span.start,
        end: diagnostic.span.end,
      })),
      [
        {
          code: 'SEM0014',
          start: source.indexOf('answer'),
          end: source.indexOf('answer') + 'answer'.length,
        },
      ],
    )
    const unrelatedLibrary = `${initialLibrary}\nfn unrelated() -> i32 { return 2 }`
    const unrelated = yield* ProjectAnalysis.revise(initial, [root.id]).pipe(
      Effect.provide(
        SourceResolver.overlay([root]).pipe(
          Layer.provideMerge(
            SourceResolver.memory(new Map([['shared/Core', ascii(unrelatedLibrary)]])),
          ),
        ),
      ),
    )
    const unrelatedWork = unrelated.report.find(
      (phase) => phase.phase === 'Semantic.checkBody',
    )?.counters
    assert.strictEqual(unrelatedWork?._tag, 'BodyQueryCounters')
    if (unrelatedWork?._tag !== 'BodyQueryCounters') return
    assert.strictEqual(unrelatedWork.checked, 1)
    assert.strictEqual(unrelatedWork.reused, 3)
    const unrelatedView =
      ProjectAnalysis.view(unrelated, root.id) ?? raise('missing unrelated view')
    assert.deepEqual(
      Analysis.diagnostics(unrelatedView).map((diagnostic) => diagnostic.code),
      ['SEM0014'],
    )
    const repairedLibrary = `${unrelatedLibrary}\npub fn answer() -> i32 { return 42 }`
    const repaired = yield* ProjectAnalysis.revise(unrelated, [root.id]).pipe(
      Effect.provide(
        SourceResolver.overlay([root]).pipe(
          Layer.provideMerge(
            SourceResolver.memory(new Map([['shared/Core', ascii(repairedLibrary)]])),
          ),
        ),
      ),
    )
    const repairedWork = repaired.report.find(
      (phase) => phase.phase === 'Semantic.checkBody',
    )?.counters
    assert.strictEqual(repairedWork?._tag, 'BodyQueryCounters')
    if (repairedWork?._tag !== 'BodyQueryCounters') return
    assert.strictEqual(repairedWork.checked, 2)
    assert.strictEqual(repairedWork.reused, 3)
    const repairedView = ProjectAnalysis.view(repaired, root.id) ?? raise('missing repaired view')
    assert.deepEqual(Analysis.diagnostics(repairedView), [])
  }),
)

it.effect('reuses checked bodies across transitive static implementation edits', () =>
  Effect.gen(function* () {
    const source = `static fn base() -> i32 { return 1 }
static fn indirect() -> i32 { return base() }
pub fn main() -> i32 { return indirect() }
fn spare() -> i32 { return 0 }
fn recursiveLeft() -> i32 { return recursiveRight() }
fn recursiveRight() -> i32 { return recursiveLeft() }`
    const initial = yield* make([SourceFile.make('query/Static', ascii(source))])
    const changed = yield* ProjectAnalysis.revise(initial, ['query/Static']).pipe(
      Effect.provide(
        SourceResolver.overlay([
          SourceFile.make('query/Static', ascii(source.replace('return 1', 'return 2'))),
        ]).pipe(Layer.provideMerge(SourceResolver.memory(sources))),
      ),
    )
    const queries = changed.report.find((phase) => phase.phase === 'Semantic.checkBody')?.counters
    assert.strictEqual(queries?._tag, 'BodyQueryCounters')
    if (queries?._tag !== 'BodyQueryCounters') return
    assert.strictEqual(queries.checked, 1)
    assert.strictEqual(queries.reused, 5)
    assert.strictEqual(queries.recursiveComponents, 1)
    const view = ProjectAnalysis.view(changed, 'query/Static') ?? raise('static query view')
    assert.deepEqual(Analysis.diagnostics(view), [])
  }),
)

it.effect(
  'rebinds cached diagnostics, anonymous declaration identities and match bindings after insertion',
  () =>
    Effect.gen(function* () {
      const source = `struct Box { value: i32 }
fn callback(input: Box) -> i32 {
  let transform = fn(value: i32) -> i32 { return value }
  return match input { Box { value } => transform(value) }
}
fn broken() -> i32 { return missing() }`
      const initial = yield* make([SourceFile.make('query/Rebind', ascii(source))])
      const prefix = 'fn prefix() -> i32 { return 0 }\n'
      const currentSource = prefix + source
      const current = yield* ProjectAnalysis.revise(initial, ['query/Rebind']).pipe(
        Effect.provide(
          SourceResolver.overlay([SourceFile.make('query/Rebind', ascii(currentSource))]).pipe(
            Layer.provideMerge(SourceResolver.memory(sources)),
          ),
        ),
      )
      const queries = current.report.find((phase) => phase.phase === 'Semantic.checkBody')?.counters
      assert.strictEqual(queries?._tag, 'BodyQueryCounters')
      if (queries?._tag !== 'BodyQueryCounters') return
      assert.strictEqual(queries.checked, 1)
      assert.strictEqual(queries.reused, 2)
      const oldView =
        ProjectAnalysis.view(initial, 'query/Rebind') ?? raise('original rebound view')
      const view = ProjectAnalysis.view(current, 'query/Rebind') ?? raise('current rebound view')
      const oldDiagnostic = Analysis.diagnostics(oldView).at(0) ?? raise('original unresolved call')
      const diagnostic = Analysis.diagnostics(view).at(0) ?? raise('rebound unresolved call')
      assert.strictEqual(diagnostic.code, oldDiagnostic.code)
      assert.strictEqual(diagnostic.span.start, oldDiagnostic.span.start + prefix.length)
      assert.strictEqual(diagnostic.span.end, oldDiagnostic.span.end + prefix.length)
      const result = view.results.get('query/Rebind') ?? raise('rebound module')
      const hidden = result.bodies.find((body) => body.hidden) ?? raise('rebound anonymous body')
      const callback =
        result.bodies.find(
          (body) =>
            body.declaration.name._tag === 'Present' &&
            body.declaration.name.spelling === 'callback',
        ) ?? raise('rebound callback')
      // The hidden identity follows its enclosing declaration and callable site, not byte offsets.
      assert.strictEqual(
        hidden.declaration.id.ordinal,
        Tir.hiddenDeclarationOrdinal(callback.declaration.id.ordinal, 0),
      )
      assert.deepEqual(hidden.function?.declaration.id, hidden.declaration.id)
      const oldResult = oldView.results.get('query/Rebind') ?? raise('original module')
      const oldHidden =
        oldResult.bodies.find((body) => body.hidden) ?? raise('original anonymous body')
      assert.strictEqual(hidden.declaration.id.ordinal - oldHidden.declaration.id.ordinal, 65536)
      // The reused body names its pattern binding where the binding now stands.
      const bound = (callback.results.tooling?.occurrences ?? []).filter(
        (occurrence) =>
          occurrence.resolution._tag === 'Available' &&
          occurrence.resolution.identity._tag === 'PatternBindingIdentity',
      )
      assert.isAbove(bound.length, 0)
      for (const occurrence of bound) {
        const span = view.resolution.contexts.spanOf(occurrence.at)
        assert.strictEqual(currentSource.slice(span.start, span.end), 'value')
      }
    }),
)

class TrackingMap<K, V> extends Map<K, V> {
  readonly reads: Array<K> = []

  override get(key: K): V | undefined {
    this.reads.push(key)
    return super.get(key)
  }
}

it.effect('analyzes a shared dependency once and derives structurally shared root views', () =>
  Effect.gen(function* () {
    const project = yield* make()
    const left = ProjectAnalysis.view(project, 'app/A')
    const right = ProjectAnalysis.view(project, 'app/B')
    const predictableCatalogSymbol = Symbol.for('@silklang/compiler/OpaqueRealizationCatalog')
    assert.strictEqual(predictableCatalogSymbol in project, false)
    assert.notInclude(Object.getOwnPropertySymbols(project), predictableCatalogSymbol)
    assert.strictEqual(left === undefined ? false : predictableCatalogSymbol in left, false)

    assert.isDefined(left)
    assert.isDefined(right)
    if (left === undefined || right === undefined) return
    assertProjectViewNotRealizable(left)
    assert.deepEqual(project.roots, ['app/A', 'app/B'])
    assert.strictEqual(project.primary, left)
    // Zero roots are unrepresentable; the test typecheck fails once either call accepts them.
    // @ts-expect-error a project analysis needs at least one root
    void ProjectAnalysis.make([])
    // @ts-expect-error a revised project analysis needs at least one root
    void ProjectAnalysis.revise(project, [])
    assert.strictEqual(project.semanticInvalidation.totals.modules, 3)
    assert.strictEqual(project.semanticInvalidation.totals.recomputed, 3)
    assert.strictEqual(project.semanticInvalidation.totals.reasons.Fresh, 3)
    assert.strictEqual(left.closure.rootModule, 'app/A')
    assert.strictEqual(right.closure.rootModule, 'app/B')
    assert.strictEqual(left.closure.modules, right.closure.modules)
    assert.strictEqual(left.closure.sources, right.closure.sources)
    assert.strictEqual(left.index, right.index)
    assert.strictEqual(left.resolution, right.resolution)
    assert.strictEqual(left.surfaces, right.surfaces)
    assert.strictEqual(left.surfaces, project.surfaces)
    assert.strictEqual(left.semantics, right.semantics)
    assert.strictEqual(left.semantics, project.semantics)
    assert.strictEqual(left.toolingModules, right.toolingModules)
    assert.strictEqual(left.toolingModules, project.toolingModules)
    assert.strictEqual(left.results, right.results)
    assert.strictEqual(left.ownership, right.ownership)
    assert.strictEqual(left.semanticOccurrences, right.semanticOccurrences)
    assert.strictEqual(left.anonymousExpressions, right.anonymousExpressions)
    assert.strictEqual(Analysis.phases(left), Analysis.phases(right))
    assert.strictEqual(left.semanticInvalidation, project.semanticInvalidation)
    assert.deepEqual(
      Analysis.modules(left).map(({ name }) => name),
      ['app/A', 'app/B', 'shared/Core'],
    )
    assert.strictEqual(Analysis.declarationByName(left, 'app/A', 'a')._tag, 'Resolved')
    assert.strictEqual(Analysis.declarationByName(right, 'app/B', 'b')._tag, 'Resolved')
    assert.deepEqual(Analysis.diagnostics(left), [])
    assert.deepEqual(
      deterministicReport(project).map(({ phase }) => phase),
      [
        'closure',
        'declaration-collection',
        'declaration-index',
        'name-resolution',
        'module-surface',
        'Semantic.checkBody',
        'semantic-invalidation',
        'elaboration',
        'ownership',
        'semantic-occurrences',
        'anonymous-expressions',
      ],
    )
    assert.deepEqual(deterministicReport(project).at(0), {
      phase: 'closure',
      inputs: 2,
      outputs: 3,
      diagnostics: 0,
    })
    assert.deepEqual(
      project.report.find(({ phase }) => phase === 'semantic-occurrences')?.counters,
      {
        _tag: 'ModuleReuseCounters',
        reused: 0,
        recomputed: 3,
      },
    )
    assert.deepEqual(
      project.report.find(({ phase }) => phase === 'anonymous-expressions')?.counters,
      {
        _tag: 'ModuleReuseCounters',
        reused: 0,
        recomputed: 3,
      },
    )
  }),
)

it.effect('keeps project facts deterministic when root supply order changes', () =>
  Effect.gen(function* () {
    const first = yield* make()
    const second = yield* make(Arr.reverse(roots))

    assert.deepEqual(first.roots, second.roots)
    assert.deepEqual(
      first.closure.modules.map(({ name }) => name),
      second.closure.modules.map(({ name }) => name),
    )
    assert.deepEqual(deterministicReport(first), deterministicReport(second))
    assert.deepEqual(
      first.report
        .filter(
          ({ phase }) => phase === 'semantic-occurrences' || phase === 'anonymous-expressions',
        )
        .map(({ phase, counters }) => ({ phase, counters })),
      second.report
        .filter(
          ({ phase }) => phase === 'semantic-occurrences' || phase === 'anonymous-expressions',
        )
        .map(({ phase, counters }) => ({ phase, counters })),
    )
    assert.deepEqual(
      Analysis.diagnostics(ProjectAnalysis.view(first, 'app/A') ?? raise('missing app/A')),
      Analysis.diagnostics(ProjectAnalysis.view(second, 'app/A') ?? raise('missing app/A')),
    )
  }),
)

it.effect('interrupts cooperative tooling batches before processing remaining modules', () =>
  Effect.gen(function* () {
    const batchRoots = Object.freeze(
      Arr.makeBy(9, (ordinal) =>
        SourceFile.make(
          `batch/M${ordinal.toString().padStart(2, '0')}`,
          ascii(`pub fn value${ordinal}() -> i32 { return ${ordinal} }`),
        ),
      ),
    )
    const project = yield* ProjectAnalysis.make(Arr.map(batchRoots, (source) => source.id)).pipe(
      Effect.provide(
        SourceResolver.overlay(batchRoots).pipe(Layer.provideMerge(SourceResolver.empty)),
      ),
    )
    const firstRoot = batchRoots.at(0) ?? raise('missing first batch root')
    const view = ProjectAnalysis.view(project, firstRoot.id) ?? raise('missing first batch view')
    const interruptedReads = new TrackingMap(project.toolingModules)
    const fiber = yield* Effect.forkChild(FrontendTooling.make(view, interruptedReads), {
      startImmediately: true,
    })
    yield* Fiber.interrupt(fiber)
    const interrupted = yield* Fiber.await(fiber)

    assert.isTrue(Exit.isFailure(interrupted))
    assert.strictEqual(interruptedReads.reads.length, 8)

    const completedReads = new TrackingMap(project.toolingModules)
    const rebuilt = yield* FrontendTooling.make(view, completedReads)
    assert.strictEqual(completedReads.reads.length, 9)
    assert.deepEqual([...rebuilt.toolingModules.keys()], [...project.toolingModules.keys()])
    assert.deepEqual(rebuilt.semanticOccurrences, view.semanticOccurrences)
    assert.deepEqual(rebuilt.anonymousExpressions, view.anonymousExpressions)
  }),
)

it.effect('deduplicates repeated root identities through one resolver supply', () =>
  Effect.gen(function* () {
    const source = SourceFile.make('app/Main', ascii('pub fn main() -> i32 { return 1 }'))
    const project = yield* make([source, source])
    assert.deepEqual(project.roots, ['app/Main'])
    assert.strictEqual(project.views.size, 1)
  }),
)

it.effect('reuses exact unchanged syntax and module semantics inside one coherent frontend', () =>
  Effect.gen(function* () {
    const spans: Array<Tracer.Span> = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      },
    })
    const previous = yield* make().pipe(Effect.withTracer(tracer))
    const revisedRoots: Arr.NonEmptyReadonlyArray<SourceFile.SourceFile> = Object.freeze([
      SourceFile.make(
        'app/A',
        ascii(
          'import shared.Core\npub fn inserted() -> i32 { return 0 }\npub fn a() -> i32 { return Core.answer() }',
        ),
      ),
      roots.at(1) ?? raise('missing app/B root'),
    ])
    const current = yield* ProjectAnalysis.revise(
      previous,
      Arr.map(revisedRoots, (source) => source.id),
    ).pipe(
      Effect.provide(
        SourceResolver.overlay(revisedRoots).pipe(
          Layer.provideMerge(SourceResolver.memory(sources)),
        ),
      ),
      Effect.withTracer(tracer),
    )
    const previousModules = new Map(
      previous.closure.modules.map((module) => [module.name, module.syntax]),
    )
    const currentModules = new Map(
      current.closure.modules.map((module) => [module.name, module.syntax]),
    )

    assert.notStrictEqual(currentModules.get('app/A'), previousModules.get('app/A'))
    assert.strictEqual(currentModules.get('app/B'), previousModules.get('app/B'))
    assert.strictEqual(currentModules.get('shared/Core'), previousModules.get('shared/Core'))
    assert.strictEqual(current.syntaxRevisions.get('app/A')?._tag, 'Changed')
    assert.strictEqual(current.syntaxRevisions.get('app/B')?._tag, 'Reused')
    assert.strictEqual(current.syntaxRevisions.get('shared/Core')?._tag, 'Reused')
    const changed = current.syntaxRevisions.get('app/A')
    assert.strictEqual(changed?._tag, 'Changed')
    if (changed?._tag === 'Changed') assert.notStrictEqual(changed.previous, changed.current)

    const previousView = ProjectAnalysis.view(previous, 'app/A')
    const currentView = ProjectAnalysis.view(current, 'app/A')
    assert.isDefined(previousView)
    assert.isDefined(currentView)
    if (previousView === undefined || currentView === undefined) return
    assert.notStrictEqual(currentView.index, previousView.index)
    assert.notStrictEqual(currentView.resolution, previousView.resolution)
    assert.notStrictEqual(currentView.results, previousView.results)
    assert.notStrictEqual(currentView.ownership, previousView.ownership)
    assert.notStrictEqual(currentView.semantics, previousView.semantics)
    assert.notStrictEqual(currentView.semanticOccurrences, previousView.semanticOccurrences)
    assert.notStrictEqual(currentView.surfaces, previousView.surfaces)
    assert.strictEqual(currentView.semanticInvalidation, current.semanticInvalidation)
    assert.strictEqual(Analysis.phases(currentView), current.report)
    assert.deepEqual(current.semanticInvalidation.observations, [
      {
        _tag: 'Recomputed',
        module: 'app/A',
        reasons: ['LocalChange'],
        surfaceChanged: true,
      },
      { _tag: 'Reusable', module: 'app/B', surfaceChanged: false },
      { _tag: 'Reusable', module: 'shared/Core', surfaceChanged: false },
    ])
    assert.deepEqual(
      current.report.find(({ phase }) => phase === 'semantic-invalidation')?.counters,
      {
        _tag: 'SemanticInvalidationCounters',
        reusable: 2,
        recomputed: 1,
        fresh: 0,
        localChange: 1,
        opaqueBodyChange: 0,
        opaqueTargetChange: 0,
        opaqueLayoutChange: 0,
        dependencySurfaceChange: 0,
        cyclicPeerChange: 0,
        environmentChange: 0,
        surfaceChange: 0,
      },
    )
    assert.notStrictEqual(currentView.semantics.get('app/A'), previousView.semantics.get('app/A'))
    assert.strictEqual(currentView.semantics.get('app/B'), previousView.semantics.get('app/B'))
    assert.strictEqual(
      currentView.semantics.get('shared/Core'),
      previousView.semantics.get('shared/Core'),
    )
    assert.strictEqual(currentView.results.get('app/B'), previousView.results.get('app/B'))
    assert.strictEqual(currentView.ownership.get('app/B'), previousView.ownership.get('app/B'))
    const retainedResult = currentView.results.get('shared/Core') ?? raise('retained library')
    const retainedFunction = retainedResult.tir.functions.at(0) ?? raise('retained TIR function')
    const retainedBody = retainedResult.bodies.at(0) ?? raise('retained checked body')
    const ownershipInput = Ownership.input(
      retainedFunction,
      Tir.functionArtifact(retainedFunction),
      retainedBody.results.lifetimes,
      currentView.index,
      Ownership.localSharedAccessBoundaryPlan(currentView.results),
      NameResolution.scopeOf(currentView.resolution, 'shared/Core')?.context ??
        raise('retained library context'),
      retainedBody.results.causes,
    )
    const sourceProof = Ownership.sourceProof(ownershipInput) ?? raise('current-index source proof')
    const residual = ResidualOwnership.make()
    assert.strictEqual(
      ResidualOwnership.check(residual, ownershipInput, 'UnchangedBody'),
      sourceProof,
    )
    assert.strictEqual(ResidualOwnership.counters(residual).sourceReused, 1)
    assert.strictEqual(ResidualOwnership.counters(residual).checked, 0)

    assert.deepEqual(current.report.find(({ phase }) => phase === 'elaboration')?.counters, {
      _tag: 'ModuleReuseCounters',
      reused: 2,
      recomputed: 1,
    })
    assert.deepEqual(current.report.find(({ phase }) => phase === 'ownership')?.counters, {
      _tag: 'ModuleReuseCounters',
      reused: 2,
      recomputed: 1,
    })
    assert.strictEqual(
      currentView.semanticOccurrences.modules.get('app/B'),
      previousView.semanticOccurrences.modules.get('app/B'),
    )
    assert.strictEqual(
      currentView.anonymousExpressions.get('app/B'),
      previousView.anonymousExpressions.get('app/B'),
    )
    assert.notStrictEqual(current.toolingModules.get('app/A'), previous.toolingModules.get('app/A'))
    assert.strictEqual(current.toolingModules.get('app/B'), previous.toolingModules.get('app/B'))
    assert.strictEqual(
      current.toolingModules.get('shared/Core'),
      previous.toolingModules.get('shared/Core'),
    )
    assert.deepEqual(
      current.report.find(({ phase }) => phase === 'semantic-occurrences')?.counters,
      { _tag: 'ModuleReuseCounters', reused: 2, recomputed: 1 },
    )
    assert.deepEqual(
      current.report.find(({ phase }) => phase === 'anonymous-expressions')?.counters,
      { _tag: 'ModuleReuseCounters', reused: 2, recomputed: 1 },
    )
    assert.deepEqual(Analysis.diagnostics(currentView), [])
    const moduleSpans = new Set(
      spans
        .filter((span) => span.name === 'Frontend.elaborateModules:module')
        .map((span) => span.spanId),
    )
    const bodySpans = spans.filter((span) => span.name === 'Semantic.checkBody')
    assert.isAbove(bodySpans.length, 0)
    for (const span of bodySpans)
      assert.isTrue(moduleSpans.has(Option.getOrUndefined(span.parent)?.spanId ?? ''))
    assert.isTrue(spans.some((span) => span.name === 'Semantic.checkBody.execute'))
    assert.isTrue(spans.some((span) => span.name === 'Semantic.checkBody.reuse'))
    assert.isFalse(spans.some((span) => span.name.startsWith('PhaseReport.measure')))
  }),
)

it.effect('reports fresh and removed modules and refuses reuse across source origins', () =>
  Effect.gen(function* () {
    const previousRoot = SourceFile.make(
      'app/Main',
      ascii('pub fn main() -> i32 { return 1 }'),
      SourceOrigin.memory('file:///old/Main.silk'),
    )
    const previous = yield* ProjectAnalysis.make([previousRoot.id]).pipe(
      Effect.provide(
        SourceResolver.overlay([previousRoot]).pipe(Layer.provideMerge(SourceResolver.empty)),
      ),
    )
    const current = yield* ProjectAnalysis.revise(previous, ['app/Next']).pipe(
      Effect.provide(
        SourceResolver.overlay([
          SourceFile.make(
            'app/Next',
            ascii('pub fn next() -> i32 { return 2 }'),
            SourceOrigin.memory('file:///new/Next.silk'),
          ),
        ]).pipe(Layer.provideMerge(SourceResolver.empty)),
      ),
    )
    assert.strictEqual(current.syntaxRevisions.has('app/Main'), false)
    assert.strictEqual(current.syntaxRevisions.get('app/Next')?._tag, 'Fresh')

    const changedOrigin = yield* ProjectAnalysis.revise(previous, ['app/Main']).pipe(
      Effect.provide(
        SourceResolver.overlay([
          SourceFile.make(
            'app/Main',
            ascii('pub fn main() -> i32 { return 1 }'),
            SourceOrigin.memory('file:///new/Main.silk'),
          ),
        ]).pipe(Layer.provideMerge(SourceResolver.empty)),
      ),
    )
    assert.strictEqual(changedOrigin.syntaxRevisions.get('app/Main')?._tag, 'Changed')
    assert.notStrictEqual(
      changedOrigin.closure.modules.at(0)?.syntax,
      previous.closure.modules.at(0)?.syntax,
    )
  }),
)

it.effect('recomputes conservatively when a reusable prior artifact is missing', () =>
  Effect.gen(function* () {
    const previous = yield* make()
    const incomplete = Object.freeze({
      ...previous,
      semantics: new Map([...previous.semantics].filter(([module]) => module !== 'app/B')),
    })
    const current = yield* ProjectAnalysis.revise(
      incomplete,
      Arr.map(roots, (source) => source.id),
    ).pipe(
      Effect.provide(
        SourceResolver.overlay(roots).pipe(Layer.provideMerge(SourceResolver.memory(sources))),
      ),
    )

    assert.strictEqual(current.semanticInvalidation.totals.reusable, 3)
    assert.strictEqual(current.semantics.get('app/A'), previous.semantics.get('app/A'))
    assert.notStrictEqual(current.semantics.get('app/B'), previous.semantics.get('app/B'))
    assert.strictEqual(current.semantics.get('shared/Core'), previous.semantics.get('shared/Core'))
    assert.deepEqual(current.report.find(({ phase }) => phase === 'elaboration')?.counters, {
      _tag: 'ModuleReuseCounters',
      reused: 2,
      recomputed: 1,
    })
  }),
)

it.effect('recomputes tooling conservatively when prior module tooling is missing', () =>
  Effect.gen(function* () {
    const previous = yield* make()
    const incomplete = Object.freeze({
      ...previous,
      toolingModules: new Map(
        [...previous.toolingModules].filter(([module]) => module !== 'app/B'),
      ),
    })
    const current = yield* ProjectAnalysis.revise(
      incomplete,
      Arr.map(roots, (source) => source.id),
    ).pipe(
      Effect.provide(
        SourceResolver.overlay(roots).pipe(Layer.provideMerge(SourceResolver.memory(sources))),
      ),
    )

    assert.strictEqual(current.semantics.get('app/B'), previous.semantics.get('app/B'))
    assert.notStrictEqual(current.toolingModules.get('app/B'), previous.toolingModules.get('app/B'))
    assert.strictEqual(current.toolingModules.get('app/A'), previous.toolingModules.get('app/A'))
    assert.deepEqual(
      current.report.find(({ phase }) => phase === 'semantic-occurrences')?.counters,
      { _tag: 'ModuleReuseCounters', reused: 2, recomputed: 1 },
    )
    assert.deepEqual(
      current.report.find(({ phase }) => phase === 'anonymous-expressions')?.counters,
      { _tag: 'ModuleReuseCounters', reused: 2, recomputed: 1 },
    )
  }),
)

it.effect(
  'rechecks retained callback ownership when an incoming caller adds an access boundary',
  () =>
    Effect.gen(function* () {
      const callbackSource = ascii('pub fn use(value: &mut i32) -> i32 { return value.* }')
      const caller = `import shared.Callbacks
fn conflict() -> i32 { return 0 }
unsafe fn probe(core: &Intrinsic.SharedCore<i32>) -> i32 { return 1 }`
      const initial = yield* ProjectAnalysis.make(['boundary/Main']).pipe(
        Effect.provide(
          SourceResolver.overlay([SourceFile.make('boundary/Main', ascii(caller))]).pipe(
            Layer.provideMerge(
              SourceResolver.memory(new Map([['shared/Callbacks', callbackSource]])),
            ),
          ),
        ),
      )
      const edited = caller.replace(
        'return 1',
        'return Intrinsic.sharedWithMut<i32, i32>(core, Callbacks.use, conflict)',
      )
      const revised = yield* ProjectAnalysis.revise(initial, ['boundary/Main']).pipe(
        Effect.provide(
          SourceResolver.overlay([SourceFile.make('boundary/Main', ascii(edited))]).pipe(
            Layer.provideMerge(
              SourceResolver.memory(new Map([['shared/Callbacks', callbackSource]])),
            ),
          ),
        ),
      )
      const before = ProjectAnalysis.view(initial, 'boundary/Main') ?? raise('initial view')
      const after = ProjectAnalysis.view(revised, 'boundary/Main') ?? raise('revised view')
      assert.deepEqual(Analysis.diagnostics(before), [])
      assert.deepEqual(Analysis.diagnostics(after), [])
      const beforeResult = before.results.get('shared/Callbacks') ?? raise('initial callbacks')
      const afterResult = after.results.get('shared/Callbacks') ?? raise('revised callbacks')
      assert.strictEqual(afterResult, beforeResult)
      const fn = afterResult.tir.functions.at(0) ?? raise('callback TIR')
      const body = afterResult.bodies.at(0) ?? raise('callback body')
      const previousInput = Ownership.input(
        fn,
        Tir.functionArtifact(fn),
        body.results.lifetimes,
        before.index,
        Ownership.localSharedAccessBoundaryPlan(before.results),
        NameResolution.scopeOf(before.resolution, 'shared/Callbacks')?.context ??
          raise('previous callbacks context'),
        body.results.causes,
      )
      const currentInput = Ownership.input(
        fn,
        Tir.functionArtifact(fn),
        body.results.lifetimes,
        after.index,
        Ownership.localSharedAccessBoundaryPlan(after.results),
        NameResolution.scopeOf(after.resolution, 'shared/Callbacks')?.context ??
          raise('current callbacks context'),
        body.results.causes,
      )
      assert.lengthOf(previousInput.boundaries, 0)
      assert.lengthOf(currentInput.boundaries, 1)
      const previousProof = Ownership.sourceProof(previousInput) ?? raise('previous callback proof')
      const currentProof = Ownership.sourceProof(currentInput) ?? raise('current callback proof')
      assert.notStrictEqual(currentProof.ownership, previousProof.ownership)
      assert.notStrictEqual(
        after.ownership.get('shared/Callbacks'),
        before.ownership.get('shared/Callbacks'),
      )
      assert.strictEqual(
        after.semantics.get('shared/Callbacks')?.ownership,
        after.ownership.get('shared/Callbacks'),
      )
      const counters = revised.report.find(
        (phase) => phase.phase === 'Semantic.checkBody',
      )?.counters
      assert.strictEqual(counters?._tag, 'BodyQueryCounters')
      if (counters?._tag !== 'BodyQueryCounters') return
      assert.strictEqual(counters.checked, 1)
      assert.strictEqual(counters.ownershipChecked, 2)
    }),
)

it.effect('loads a configured application independently of open document roots', () =>
  Effect.gen(function* () {
    const project = yield* ProjectAnalysis.make(['Main'], {
      application: 'Entry',
      configuration: {
        profile: {
          target: 'aarch64-apple-darwin',
          artifact: 'object',
          runtime: { kind: 'none' },
        },
      },
    }).pipe(
      Effect.provide(
        SourceResolver.overlay([
          SourceFile.make(
            'Main',
            ascii('import Util\npub fn main() -> i32 { return Util.answer() }'),
          ),
        ]).pipe(
          Layer.provideMerge(
            SourceResolver.memory(
              new Map([
                ['Entry', ascii('pub fn entry() -> i32 { return 0 }')],
                ['Util', ascii('pub fn other() -> i32 { return 11 }')],
              ]),
            ),
          ),
        ),
      ),
    )
    const view = ProjectAnalysis.view(project, 'Main') ?? raise('open document view')
    assert.include(
      Analysis.diagnostics(view).map((entry) => entry.code),
      'SEM0014',
    )
    assert.isTrue(project.closure.sources.has('Entry'))
  }),
)

for (const [target, startup, explicitApplication] of [
  ['aarch64-apple-darwin', 'silk/native_start', false],
  ['wasm32-unknown-unknown', 'silk/wasm_start', true],
] as const) {
  it.effect(`loads default ${startup} before selecting project declarations`, () =>
    Effect.gen(function* () {
      const application = SourceFile.make('Main', ascii('pub fn main() -> i32 { return 42 }'))
      const helper = SourceFile.make('Helper', ascii('pub fn value() -> i32 { return 7 }'))
      const project = yield* ProjectAnalysis.make(
        explicitApplication ? [helper.id, application.id] : [application.id, helper.id],
        {
          ...(explicitApplication ? { application: 'Main' } : {}),
          configuration: { profile: { target } },
        },
      ).pipe(
        Effect.provide(
          SourceResolver.overlay(
            explicitApplication ? [helper, application] : [application, helper],
          ).pipe(Layer.provideMerge(SourceResolver.memory(new Map()))),
        ),
      )
      const view = ProjectAnalysis.view(project, 'Main') ?? raise('application view')
      assert.deepEqual(Analysis.diagnostics(view), [])
      assert.deepEqual(project.closure.resolutionFailures, [])
      assert.isTrue(project.closure.sources.has(startup))
      assert.deepEqual(view.configuration?.profile, { target })
      assert.strictEqual(view.closure.rootModule, 'Main')
    }),
  )
}
