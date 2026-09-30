import * as Layer from 'effect/Layer'
import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as CleanupPlan from '../src/CleanupPlan.js'
import * as Intrinsic from '../src/Intrinsic.js'
import * as Lexer from '../src/Lexer.js'
import * as Parser from '../src/Parser.js'
import * as SyntaxTree from '../src/SyntaxTree.js'
import * as MirVerification from '../src/MirVerification.js'
import * as SourceFile from '../src/SourceFile.js'
import * as SourceResolver from '../src/SourceResolver.js'
import * as Stdlib from '../src/Stdlib.js'
import * as Projections from './support/projections.js'
import { unreachable } from './support/raise.js'
import { httpValuesAcceptanceSource } from './support/httpValuesAcceptance.js'
import {
  httpRedirectAffineDiagnosticSource,
  httpProxyRedirectPolicyAcceptanceSource,
} from './support/httpRedirectAcceptance.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

const diagnosticSummary = (snapshot: Analysis.Snapshot) =>
  Analysis.diagnostics(snapshot).map((diagnostic) => ({
    code: diagnostic.code,
    message: diagnostic.message,
    sourceId: diagnostic.span.sourceId,
    start: diagnostic.span.start,
  }))

const sourceSection = (source: string, start: string, end: string): string => {
  const startOffset = source.indexOf(start)
  assert.notStrictEqual(startOffset, -1, `missing section start: ${start}`)
  const endOffset = source.indexOf(end, startOffset + start.length)
  assert.notStrictEqual(endOffset, -1, `missing section end: ${end}`)
  return source.slice(startOffset, endOffset)
}

it.effect(
  'ships HTTP values as navigable ordinary source',
  () =>
    Effect.gen(function* () {
      const source = `import silk.http { Header, Method, RequestHead, ResponseHead, Status, Version }
import silk.http_headers { Headers, Limits, OwnedHeaders }
import silk.http_target { HttpAuthority, RequestTarget, TargetForm }
pub fn main() -> i32 { return 42 }`
      const snapshot = yield* AnalysisFixture.retainingMain('http-values/navigation', ascii(source))
      const diagnostics = diagnosticSummary(snapshot)
      assert.deepEqual(diagnostics.slice(0, 20), [])
      assert.strictEqual(diagnostics.length, 0)

      for (const module of ['silk/http', 'silk/http_headers', 'silk/http_target']) {
        const canonical = Projections.syntaxOf(snapshot, module)?.source
        assert.isDefined(canonical)
        const archived = Stdlib.find(module)
        assert.deepEqual(
          archived?.bytes,
          canonical === undefined ? undefined : SourceFile.toUint8Array(canonical),
        )
      }

      // Safe Silk cannot construct an addressable slice large enough to overflow usize, so retain
      // structural evidence that every aggregate-size path uses checked arithmetic and maps its
      // unrepresentable branch to the public SizeOverflow reason.
      const headersSource = Projections.syntaxOf(snapshot, 'silk/http_headers')?.source
      const headSource = Projections.syntaxOf(snapshot, 'silk/http')?.source
      const targetSource = Projections.syntaxOf(snapshot, 'silk/http_target')?.source
      assert.isDefined(headersSource)
      assert.isDefined(headSource)
      assert.isDefined(targetSource)
      const decode = (file: SourceFile.SourceFile | undefined): string =>
        file === undefined ? '' : new TextDecoder().decode(SourceFile.toUint8Array(file))
      const headersText = decode(headersSource)
      const headText = decode(headSource)
      const targetText = decode(targetSource)
      const checkedAdd = sourceSection(headersText, 'fn checkedAdd(', '\nfn copyBytes')
      assert.include(checkedAdd, 'usize.checkedAdd')
      assert.include(checkedAdd, 'sizeFailure(component)')
      assert.include(headersText, 'ValueReason.SizeOverflow')

      const headersMake = sourceSection(
        headersText,
        '  pub fn make(',
        '\n  /// Returns the number of fields',
      )
      assert.lengthOf(headersMake.match(/checkedAdd/g) ?? [], 2)
      const headersCopy = sourceSection(
        headersText,
        '  pub effect fn copy(',
        '\n  /// Computes the payload-plus-index bytes',
      )
      assert.include(headersCopy, 'usize.checkedMultiply')
      assert.include(headersCopy, 'checkedAdd(')
      assert.include(headersCopy, 'sizeFailure(ValueComponent.Headers)')
      const requiredOwnedBytes = sourceSection(
        headersText,
        '  pub fn requiredOwnedBytes(',
        '\n  /// Formats only ordered field lines',
      )
      assert.include(requiredOwnedBytes, 'usize.checkedMultiply')
      assert.include(requiredOwnedBytes, 'checkedAdd(')
      assert.include(requiredOwnedBytes, 'sizeFailure(ValueComponent.Headers)')
      const formatInto = sourceSection(
        headersText,
        '  pub fn formatInto(',
        '\n  /// Iterates Connection field tokens',
      )
      assert.lengthOf(formatInto.match(/checkedAdd/g) ?? [], 3)

      const headOwnedBytes = sourceSection(headText, 'fn headOwnedBytes(', '\nfn absurd')
      assert.lengthOf(headOwnedBytes.match(/usize\.checkedAdd/g) ?? [], 3)
      assert.lengthOf(headOwnedBytes.match(/sizeFailure\(/g) ?? [], 3)
      const fromUri = sourceSection(
        targetText,
        '  pub fn fromUri(',
        '\n/// Validates Host cardinality',
      )
      assert.lengthOf(fromUri.match(/usize\.checkedAdd/g) ?? [], 3)
      assert.lengthOf(fromUri.match(/sizeFailure\(/g) ?? [], 3)
      assert.include(
        fromUri,
        'if path.length == usize.ZERO {\n        required = match move usize.checkedAdd(required, usize.ONE)',
      )

      assert.isFalse(
        Intrinsic.all().some((actor) =>
          [
            'Header',
            'Headers',
            'Method',
            'RequestHead',
            'RequestTarget',
            'ResponseHead',
            'Status',
          ].includes(actor.spelling),
        ),
      )

      const forgedSource = `import silk.http_target { RequestTarget }
pub fn main() -> i32 {
  let target = RequestTarget.Origin { text: "bad target" }
  return 0
}`
      const forged = yield* AnalysisFixture.retainingMain(
        'http-values/forged-target',
        ascii(forgedSource),
      )
      assert.deepEqual(
        Analysis.diagnostics(forged)
          .filter((diagnostic) => diagnostic.span.sourceId === 'http-values/forged-target')
          .map((diagnostic) => ({
            code: diagnostic.code,
            sourceId: diagnostic.span.sourceId,
            start: diagnostic.span.start,
          })),
        [{ code: 'SEM0021', sourceId: 'http-values/forged-target', start: 80 }],
      )
    }),
  60_000,
)

it.effect(
  'analyzes the shared HTTP value acceptance program without diagnostics',
  () =>
    Effect.gen(function* () {
      const snapshot = yield* AnalysisFixture.retainingMain(
        'http-values/acceptance',
        ascii(httpValuesAcceptanceSource),
      )
      const diagnostics = diagnosticSummary(snapshot)
      assert.deepEqual(diagnostics.slice(0, 20), [])
      assert.strictEqual(diagnostics.length, 0)
    }),
  60_000,
)

it.effect(
  'rejects HTTP owner-derived views, iterators, and yielded fields that escape',
  () =>
    Effect.gen(function* () {
      const source = `import silk.http { Header, OwnedRequestHead, OwnedResponseHead, RequestHead, ResponseHead }
import silk.http_headers { HeaderIterator, Headers, OwnedHeaders }
import silk.option { Option }
fn headersView(owner: OwnedHeaders) -> Headers<'static> {
  return OwnedHeaders.view(&owner)
}
fn headerIterator(owner: OwnedHeaders) -> HeaderIterator<'static> {
  let view = OwnedHeaders.view(&owner)
  return Headers.iter(&view)
}
fn yieldedHeader(owner: OwnedHeaders) -> Option<Header<'static>> {
  let view = OwnedHeaders.view(&owner)
  let mut iterator = Headers.iter(&view)
  return HeaderIterator.next(&mut iterator)
}
fn requestView(owner: OwnedRequestHead) -> RequestHead<'static> {
  return OwnedRequestHead.view(&owner)
}
fn responseView(owner: OwnedResponseHead) -> ResponseHead<'static> {
  return OwnedResponseHead.view(&owner)
}
pub fn main() -> i32 { return 0 }`
      const snapshot = yield* AnalysisFixture.retainingMain(
        'http-values/ownership-escapes',
        ascii(source),
      )
      const diagnostics = Analysis.diagnostics(snapshot)
      assert.isAtLeast(diagnostics.length, 5)
      assert.isTrue(
        diagnostics.every((diagnostic) => ['OWN0019', 'SEM0212'].includes(diagnostic.code)),
      )
      assert.includeMembers(
        diagnostics.map((diagnostic) => diagnostic.code),
        ['OWN0019', 'SEM0212'],
      )
    }),
  60_000,
)

it.effect(
  'plans cleanup for partially constructed owned HTTP storage',
  () =>
    Effect.gen(function* () {
      const source = `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.http { Header, ValueError }
import silk.http_headers { Headers, Limits, OwnedHeaders }
import silk.result { Result }
fn limits() -> Limits {
  return Limits { maxMethodBytes: 8, maxTargetBytes: 32, maxNameBytes: 16, maxValueBytes: 16, maxFields: 2, maxFieldBytes: 32, maxOwnedBytes: 256 }
}
effect fn copyMade<'value>(made: Result<Headers<'value>, ValueError>) -> ()
! OutOfMemoryError ? &mut Allocator {
  let headers = match move made {
    Result<Headers<'value>, ValueError>.Failure {error} => { return () }
    Result<Headers<'value>, ValueError>.Success {value} => value
  }
  let copied = run Headers.copy(&headers, limits())
  drop copied
  return ()
}
effect fn build() -> i32 ! OutOfMemoryError {
  let header = match move Header.make("X-Test", b"value", limits()) {
    Result<Header<'static>, ValueError>.Failure {error} => { return 0 }
    Result<Header<'static>, ValueError>.Success {value} => value
  }
  let entries = [header]
  let mut allocator = Allocator.systemAllocatorProvider()
  run copyMade(Headers.make(&entries, limits())) |> Effect.provideMut<Allocator>(&mut allocator)
  return 42
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(build(), recover) }`
      const snapshot = yield* AnalysisFixture.retainingMain(
        'http-values/owned-cleanup',
        ascii(source),
      )
      assert.deepEqual(diagnosticSummary(snapshot), [])
      for (const { module, name, bindings } of [
        { module: 'silk/http_headers', name: 'Headers.copy', bindings: ['payload', 'records'] },
        { module: 'silk/http', name: 'RequestHead.copy', bindings: ['value', 'methodOwned'] },
        { module: 'silk/http', name: 'ResponseHead.copy', bindings: ['headers'] },
      ] as const) {
        const facts = Analysis.ownershipOf(snapshot, module)?.functions.find(
          (candidate) =>
            candidate.declaration.canonical._tag === 'Canonical' &&
            candidate.declaration.canonical.id.name === name,
        )
        const propagations = facts?.exits.filter((exit) => exit.kind === 'Propagation') ?? []
        assert.isNotEmpty(propagations, name)
        for (const exit of propagations) {
          const names = exit.releases.map((release) => release.binding.name)
          assert.strictEqual(new Set(names).size, names.length, `${name}: releases exactly once`)
        }
        for (const binding of bindings) {
          const releases = propagations.flatMap((exit) =>
            exit.releases.filter((release) => release.binding.name === binding),
          )
          assert.isNotEmpty(releases, `${name}: ${binding}`)
          assert.isTrue(
            releases.every((release) => CleanupPlan.reclaims(release.cleanup)),
            `${name}: ${binding}`,
          )
        }
      }
      const copy = Analysis.loweredMir(snapshot).functions.find(
        (fn) =>
          fn.id.module === 'silk/http_headers' && fn.id.name.startsWith('Headers.copy$effect$'),
      )
      assert.isDefined(copy)
      assert.isTrue(
        (copy === undefined ? [] : MirVerification.operations(copy)).some(
          (operation) => operation._tag === 'Drop' && CleanupPlan.reclaims(operation.cleanup),
        ),
      )
    }),
  60_000,
)

it.effect(
  'compiles HTTP pool, proxy, and redirect policy witnesses and verifies their lowered MIR once',
  () =>
    Effect.gen(function* () {
      // Keep the positive composite free of diagnostics so its one retained program can lower.
      // The focused frontend-only assertion below owns the intentional affine failures.
      const module = 'http-proxy-redirect/policy'
      // The native copy witness has a borrowed input, so retain its closed definition explicitly
      // instead of expecting an uncalled declaration to become reachable from main.
      const snapshot = yield* Analysis.makeRealized({
        root: module,
        configuration: AnalysisFixture.configuration(module, 'x86_64-unknown-linux-gnu', [
          'main',
          'nativePoolCopyWitness',
        ]),
      }).pipe(
        Effect.provide(
          SourceResolver.overlay([
            SourceFile.make(module, ascii(httpProxyRedirectPolicyAcceptanceSource)),
          ]).pipe(Layer.provideMerge(SourceResolver.empty)),
        ),
      )
      assert.deepEqual(diagnosticSummary(snapshot), [])
      const mir = Analysis.loweredMir(snapshot)
      assert.deepEqual(yield* MirVerification.verify(mir), [])
      for (const operation of ['Config.defaults', 'ConnectionKey.direct', 'ConnectionKey.origin']) {
        assert.isTrue(
          mir.functions.some(
            (fn) =>
              fn.id.module === 'silk/http_connection_pool' && fn.id.name.startsWith(operation),
          ),
          `missing lowered pool declaration: ${operation}`,
        )
      }
      for (const witness of ['poolDeclarationsWitness', 'poolCountsShape']) {
        assert.isTrue(
          mir.functions.some((fn) => fn.id.name.startsWith(witness)),
          `missing lowered pool declaration witness: ${witness}`,
        )
      }
      assert.isTrue(
        mir.functions.some(
          (fn) =>
            fn.id.module === 'silk/http_connection_pool_native' &&
            fn.id.name.startsWith('copyHandle$effect$'),
        ),
        'missing lowered native pool context copy witness',
      )
      for (const operation of [
        'withEmptyResponse',
        'withBytesResponse',
        'withOneShotResponse',
        'withReplayResponse',
      ]) {
        assert.isTrue(
          mir.functions.some(
            (fn) =>
              fn.id.module === 'silk/http_redirect' &&
              fn.id.name.startsWith(`${operation}$effect$`),
          ),
          `missing lowered redirect operation: ${operation}`,
        )
      }
      for (const witness of [
        'redirectEmptyContractWitness',
        'redirectBytesContractWitness',
        'redirectOneShotContractWitness',
        'redirectReplayContractWitness',
      ]) {
        assert.isTrue(
          mir.functions.some((fn) => fn.id.name.startsWith(`${witness}$effect$`)),
          `missing lowered exact-row witness: ${witness}`,
        )
      }
      assert.isTrue(
        mir.functions.some((fn) => fn.id.name === 'redirectPolicyCompileWitness'),
        'missing lowered redirect policy behavior sentinel',
      )
      assert.isTrue(
        mir.functions.some((fn) => fn.id.name.startsWith('verifyRedirectPolicy$effect$')),
        'missing lowered allocation-backed redirect behavior sentinel',
      )
    }),
  // This single full-program witness took 455 seconds on the contended compiler shard.
  600000,
)

it.effect(
  'rejects escaping response loans and escaping or duplicating scoped redirect producers',
  () =>
    Effect.gen(function* () {
      const snapshot = yield* AnalysisFixture.frontend(
        'http-redirect/affine-diagnostics',
        ascii(httpRedirectAffineDiagnosticSource),
      )
      const diagnostics = Analysis.diagnostics(snapshot).map((diagnostic) => ({
        code: diagnostic.code,
        span: httpRedirectAffineDiagnosticSource
          .slice(diagnostic.span.start, diagnostic.span.end)
          .trim(),
      }))
      assert.deepEqual(diagnostics, [
        { code: 'SEM0025', span: 'move uri' },
        { code: 'SEM0025', span: 'move exchange' },
        { code: 'SEM0129', span: 'move producer' },
        { code: 'OWN0001', span: 'move producer' },
      ])
    }),
  120_000,
)

it('declares native HTTP providers unconditionally and rejects unsupported use inside bodies', () => {
  const module =
    Stdlib.find('silk/http_client_native') ?? unreachable('expected HTTP native source')
  const syntax = Parser.parse(Lexer.lex(SourceFile.make(module.module, module.bytes)))
  assert.deepEqual(syntax.lexicalDiagnostics, [])
  assert.deepEqual(syntax.parserDiagnostics, [])
  const declarations = syntax.root.children.filter(SyntaxTree.isNode)
  assert.isFalse(declarations.some((node) => node.kind === 'StaticConditionalDeclaration'))
  const decode = new TextDecoder()
  const named = (name: string): SyntaxTree.Node =>
    declarations.find((node) => {
      const token = SyntaxTree.tokens(node).find((token) => token.kind === 'Identifier')
      return (
        token !== undefined &&
        decode.decode(module.bytes.subarray(token.span.start, token.span.end)) === name
      )
    }) ?? unreachable(`expected declaration ${name}`)
  for (const [name, kind] of [
    ['NativeTransport', 'StructDeclaration'],
    ['NativeRouteProvider', 'StructDeclaration'],
    ['acquireOwned', 'FunctionDeclaration'],
  ] as const) {
    const declaration = named(name)
    assert.strictEqual(declaration.kind, kind)
    assert.isTrue(
      declaration.children.some(
        (child) => SyntaxTree.isToken(child) && child.kind === 'PubKeyword',
      ),
    )
  }
  const preflight = named('preflight')
  const body =
    preflight.children.filter(SyntaxTree.isNode).find((node) => node.kind === 'Block') ??
    unreachable('expected preflight body')
  const guard =
    body.children
      .filter(SyntaxTree.isNode)
      .find((node) => node.kind === 'StaticConditionalStatement') ??
    unreachable('expected body-level platform guard')
  const branches = guard.children.filter(SyntaxTree.isNode).filter((node) => node.kind === 'Block')
  assert.strictEqual(branches.length, 2)
  const rejected = branches.at(-1) ?? unreachable('expected unsupported branch')
  const descendants = (node: SyntaxTree.Node): ReadonlyArray<SyntaxTree.Node> => [
    node,
    ...node.children.filter(SyntaxTree.isNode).flatMap(descendants),
  ]
  assert.strictEqual(
    descendants(rejected).filter((node) => node.kind === 'CompileErrorExpression').length,
    1,
  )
})
