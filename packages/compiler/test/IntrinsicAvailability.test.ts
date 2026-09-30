import * as Layer from 'effect/Layer'
import * as AnalysisFixture from './support/AnalysisFixture.js'
import * as MirVerification from '../src/MirVerification.js'
import * as NativeAssembly from '../src/NativeAssembly.js'
import * as Exit from 'effect/Exit'
import * as ForeignContract from '../src/ForeignContract.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as CAbi from '../src/CAbi.js'
import type * as Diagnostic from '../src/Diagnostic.js'
import * as ForeignAvailability from '../src/ForeignAvailability.js'
import * as ForeignPlanning from '../src/ForeignPlanning.js'
import * as Instances from '../src/Instances.js'
import * as Mir from '../src/Mir.js'
import * as Intrinsic from '../src/Intrinsic.js'
import * as IntrinsicAvailability from '../src/IntrinsicAvailability.js'
import * as SourceFile from '../src/SourceFile.js'
import * as SourceResolver from '../src/SourceResolver.js'
import * as SourceSpan from '../src/SourceSpan.js'
import * as Stdlib from '../src/Stdlib.js'
import * as Target from '../src/Target.js'
import * as ToolchainIntegrity from '../src/ToolchainIntegrity.js'
import * as Type from '../src/Type.js'
import * as MirSamples from './support/mirSamples.js'
import { unreachable } from './support/raise.js'

const encoder = new TextEncoder()
const source = `fn nativeWrapper() -> i32 { return Intrinsic.i32Add(20, 22) }
pub fn main() -> i32 { return 0 }`

const snapshot = (text: string, target = 'aarch64-apple-darwin') =>
  AnalysisFixture.retainingMain('availability/main', encoder.encode(text), target)

it.effect('retains exact canonical identities and call provenance only when reachable', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(source.replace('return 0', 'return nativeWrapper()'))
    assert.deepEqual(Analysis.diagnostics(self), [])
    assert.deepEqual(
      self.instances.intrinsics.map((call) => ({
        operation: Intrinsic.operationText(call.operation),
        sourceId: call.span.sourceId,
      })),
      [{ operation: 'Intrinsic.i32Add', sourceId: 'availability/main' }],
    )
  }),
)

it.effect('does not grant compiler availability privilege to an ordinary declaration name', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`fn i32Add(left: i32, right: i32) -> i32 {
  return left
}
pub fn main() -> i32 { return i32Add(20, 22) }`)
    assert.deepEqual(Analysis.diagnostics(self), [])
    assert.isFalse(
      self.instances.intrinsics.some(
        (call) => Intrinsic.operationText(call.operation) === 'Intrinsic.i32Add',
      ),
    )
  }),
)

it.effect('does not grant enum projection privilege to an ordinary value declaration', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`fn value(input: i32) -> i32 { return input }
pub fn main() -> i32 { return value(42) }`)
    assert.deepEqual(Analysis.diagnostics(self), [])
    assert.isFalse(
      self.instances.intrinsics.some(
        (call) => Intrinsic.operationText(call.operation) === 'Intrinsic.enumValue',
      ),
    )
  }),
)

it('requires normalized target metadata in every sealed inventory entry', () => {
  assert.deepEqual(
    Intrinsic.runtimeTargets,
    Target.all.map((target) => target.id),
  )
  assert.isTrue(
    Intrinsic.inventory().every((entry) => {
      const expected =
        entry.phase !== 'StaticOnly' ? Intrinsic.normalizeRuntimeTargets(entry.targets) : []
      return (
        JSON.stringify(entry.targets) === JSON.stringify(expected) &&
        (entry.phase !== 'Runtime' || entry.targets.length > 0)
      )
    }),
  )
})

it('rejects static-only intrinsic leakage at runtime availability and integrity seams', () => {
  const operation = Intrinsic.findOperation('Intrinsic', 'targetPointerBits')
  const span = SourceSpan.fromOffsets('availability/static-only', 0, 0)
  assert.isDefined(operation)
  assert.isDefined(span)
  if (operation === undefined || span === undefined) return
  const calls = [{ _tag: 'ReachableIntrinsicCall' as const, operation: operation.id, span }]
  for (const target of Target.all) {
    const availability = IntrinsicAvailability.select(calls, target)
    assert.strictEqual(availability._tag, 'Unavailable')
    if (availability._tag === 'Unavailable')
      assert.deepEqual(availability.operations, ['Intrinsic.targetPointerBits'])
    const integrity = ToolchainIntegrity.validateTarget(
      ToolchainIntegrity.installed(),
      target,
      calls,
    )
    assert.strictEqual(integrity._tag, 'UnsupportedTarget')
    if (integrity._tag === 'UnsupportedTarget')
      assert.deepEqual(integrity.operations, ['Intrinsic.targetPointerBits'])
  }
  assert.isFalse(
    ToolchainIntegrity.installed().components.some(
      (component) =>
        component.kind === 'RuntimeSupport' &&
        component.id.endsWith('/Intrinsic.targetPointerBits'),
    ),
  )
})

it.effect('does not admit targetPointerBits into runtime TIR', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(
      'pub fn main() -> u32 { return Intrinsic.targetPointerBits() }',
      'wasm32-unknown-unknown',
    )
    assert.isAbove(Analysis.diagnostics(self).length, 0)
    assert.isFalse(
      self.instances.intrinsics.some(
        (call) => Intrinsic.operationText(call.operation) === 'Intrinsic.targetPointerBits',
      ),
    )
  }),
)

it.effect('rejects selected native providers and preserves portable LLVM-to-Wasm imports', () =>
  Effect.gen(function* () {
    const unused = yield* snapshot(
      `import silk.os_monotonic_clock { OsMonotonicClock }
pub fn main() -> i32 { return 42 }`,
      'wasm32-unknown-unknown',
    )
    assert.deepEqual(Analysis.diagnostics(unused), [])
    assert.strictEqual(
      ToolchainIntegrity.validateTarget(
        ToolchainIntegrity.installed(),
        Target.wasm32UnknownUnknown,
        unused.instances.intrinsics,
      )._tag,
      'Matched',
    )
    const portable = yield* Analysis.codegen(unused, { mode: 'release' })
    assert.deepEqual(portable.nativeRuntimeSymbols, [])

    const reachable = yield* snapshot(
      `import silk.os_monotonic_clock { OsMonotonicClock }
pub fn main() -> i32 { let provider = OsMonotonicClock.make() return 42 }`,
      'wasm32-unknown-unknown',
    )
    const module = Stdlib.find('silk/os_monotonic_clock') ?? unreachable('expected clock source')
    const text = new TextDecoder().decode(module.bytes)
    const start = text.indexOf('compileError("') + 'compileError("'.length
    const end = text.indexOf('"', start)
    assert.deepEqual(
      Analysis.diagnostics(reachable).map((diagnostic) => [
        diagnostic.code,
        diagnostic.span.sourceId,
        diagnostic.span.start,
        diagnostic.span.end,
      ]),
      [['SEM0177', module.module, start, end]],
    )

    const standardOutput = yield* snapshot(
      `import silk.os_writer { StdoutWriter }
import silk.effect { Effect }
import silk.writer { Writer, WriterError }
effect fn writeMessage() -> () ! WriterError {
  let mut writer = StdoutWriter.make()
  return run Writer.writeAll(b"Silk") |> Effect.provideMut<Writer>(&mut writer)
}
effect fn ignoreWriteFailure(error: WriterError) -> () { return () }
pub fn main() -> i32 {
  let completed = run Effect.catchAll(writeMessage(), ignoreWriteFailure)
  return 42
}`,
      'wasm32-unknown-unknown',
    )
    assert.isTrue(
      Analysis.diagnostics(standardOutput).some((diagnostic) => diagnostic.code === 'SEM0014'),
    )
  }),
)

it.effect('validates only reachable runtime implementation identities', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(source.replace('return 0', 'return nativeWrapper()'))
    const installed = ToolchainIntegrity.installed()
    const withoutUnrelatedRuntime = ToolchainIntegrity.make(
      installed.components.filter(
        (component) => component.id !== 'runtime/aarch64-apple-darwin/Intrinsic.boolEquals',
      ),
    )
    assert.strictEqual(
      ToolchainIntegrity.validateTarget(
        withoutUnrelatedRuntime,
        Target.aarch64AppleDarwin,
        self.instances.intrinsics,
      )._tag,
      'Matched',
    )

    const withoutRequiredRuntime = ToolchainIntegrity.make(
      installed.components.filter(
        (component) => component.id !== 'runtime/aarch64-apple-darwin/Intrinsic.i32Add',
      ),
    )
    const missingRuntime = ToolchainIntegrity.validateTarget(
      withoutRequiredRuntime,
      Target.aarch64AppleDarwin,
      self.instances.intrinsics,
    )
    assert.strictEqual(missingRuntime._tag, 'Invalid')
    if (missingRuntime._tag === 'Invalid')
      assert.isTrue(
        missingRuntime.failures.some(
          (failure) =>
            failure.reason._tag === 'MissingComponent' &&
            failure.reason.id === 'runtime/aarch64-apple-darwin/Intrinsic.i32Add',
        ),
      )
  }),
)

const foreignEntry = (
  symbol: string,
  parameters: ReadonlyArray<CAbi.CAbiType>,
  sourceId: string,
  start: number,
): Instances.ForeignCall => {
  const span = SourceSpan.fromOffsets(sourceId, start, start + 3)
  if (span === undefined) throw new Error('expected a span')
  return Object.freeze({
    _tag: 'ReachableForeignCall',
    symbol,
    signature: Object.freeze({
      variadic: false,
      contract: ForeignContract.conservative,
      parameters,
      result: Object.freeze({ _tag: 'Void' }),
    }),
    declaration: Object.freeze({ _tag: 'CanonicalDeclarationId', module: sourceId, name: symbol }),
    declarationSpan: span,
    callSpan: span,
  })
}

it('admits the Wasm direct C subset and rejects conflicting signatures per pair', () => {
  const i32 = Object.freeze({
    _tag: 'Integer' as const,
    bits: 32 as const,
    signed: true,
    extension: 'None' as const,
  })
  const i64 = Object.freeze({
    _tag: 'Integer' as const,
    bits: 64 as const,
    signed: true,
    extension: 'None' as const,
  })
  const exit = foreignEntry('exit', [i32], 'availability/a', 40)
  const calls = [
    foreignEntry('abs', [i32], 'availability/a', 0),
    foreignEntry('abs', [i64], 'availability/b', 10),
    exit,
  ]
  const codes = (selected: Target.Target) =>
    ForeignAvailability.select(calls, selected).map((diagnostic) => [
      diagnostic.code,
      diagnostic.reason._tag === 'ForeignFunctionTargetUnavailable'
        ? `${diagnostic.reason.symbol}@${diagnostic.reason.surface}`
        : diagnostic.relatedSpans?.map((related) => related.span.sourceId).join(','),
    ])
  assert.deepEqual(codes(Target.aarch64AppleDarwin), [['SEM0192', 'availability/a']])
  assert.deepEqual(codes(Target.wasm32UnknownUnknown), [
    ['SEM0192', 'availability/a'],
    ['SEM0193', 'abs@wasm32-unknown-unknown'],
  ])
  assert.deepEqual(ForeignAvailability.select([exit], Target.x8664UnknownLinuxGnu), [])
  const fixed = foreignEntry('receive', [i32], 'availability/fixed', 0)
  const marked = foreignEntry('receive', [i32], 'availability/variadic', 10)
  const variadic = { ...marked, signature: { ...marked.signature, variadic: true } }
  assert.deepEqual(
    ForeignAvailability.select([fixed, variadic], Target.aarch64AppleDarwin).map((diagnostic) => [
      diagnostic.code,
      diagnostic.span.sourceId,
      diagnostic.relatedSpans?.at(0)?.span.sourceId,
    ]),
    [['SEM0192', 'availability/variadic', 'availability/fixed']],
  )
})

it.effect('classifies a reachable foreign call for the selected target', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`unsafe extern "C" fn count(value: usize) -> usize
fn size() -> usize { return unsafe count(1) }
pub fn main() -> i32 { let n = size()
  drop n
  return 0 }`)
    assert.deepEqual(Analysis.diagnostics(self), [])
    assert.deepEqual(
      self.instances.foreignCalls.map((call) => ({
        symbol: call.symbol,
        signature: CAbi.signatureKey(call.signature),
        declaration: call.declaration.name,
        callSource: call.callSpan.sourceId,
      })),
      [
        {
          symbol: 'count',
          signature:
            '(u64)->u64!readwrite/external/capture:/borrow:/callbacks:/returned:-/noreturn:false/unwind:forbidden',
          declaration: 'count',
          callSource: 'availability/main',
        },
      ],
    )
    const program = Analysis.loweredMir(self)
    assert.deepEqual(program.foreignCalls, self.instances.foreignCalls)
  }),
)

it.effect('keeps unreachable foreign declarations out of LLVM-to-Wasm planning', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(
      `unsafe extern "C" fn abs(value: i32) -> i32
unsafe extern "C" fn install(callback: extern "C" fn(i32) -> i32) -> () with Intrinsic.foreign(callbacks: ("callback",))
unsafe extern "C" static environment: *mut *mut u8 as "environ"
pub fn main() -> i32 { return 42 }`,
      'wasm32-unknown-unknown',
    )
    assert.deepEqual(Analysis.diagnostics(self), [])
    assert.deepEqual(self.instances.foreignCalls, [])
    const program = Analysis.loweredMir(self)
    assert.deepEqual(program.foreignCalls, [])
    assert.deepEqual(program.foreignStatics, [])
    const artifact = yield* Analysis.codegen(self, { mode: 'release' })
    assert.deepEqual(artifact.foreignImports, [])
    assert.notInclude(artifact.ir, '@abs')
    assert.notInclude(artifact.ir, '@install')
    assert.notInclude(artifact.ir, '@environ')
  }),
)

const twoModules = (dependencyAbs: string) =>
  Analysis.makeRealized({
    configuration: AnalysisFixture.configuration('availability/foreign-root'),
    root: 'availability/foreign-root',
  }).pipe(
    Effect.provide(
      SourceResolver.overlay([
        SourceFile.make(
          'availability/foreign-root',
          encoder.encode(`import foreign_dep
unsafe extern "C" fn abs(value: i32) -> i32
pub fn main() -> i32 { return unsafe abs(-2) + foreign_dep.viaDep() }`),
        ),
      ]).pipe(
        Layer.provideMerge(
          SourceResolver.memory(
            new Map([
              [
                'foreign_dep',
                encoder.encode(`${dependencyAbs}
pub fn viaDep() -> i32 { let wide = unsafe abs(-1)
  drop wide
  return 0 }`),
              ] as const,
            ]),
          ),
        ),
      ),
    ),
  )

it.effect('accepts agreeing redeclarations of one symbol across two modules', () =>
  Effect.gen(function* () {
    const self = yield* twoModules('unsafe extern "C" fn abs(value: i32) -> i32')
    assert.deepEqual(Analysis.diagnostics(self), [])
    assert.deepEqual(
      self.instances.foreignCalls.map((call) => [
        call.declaration.module,
        CAbi.signatureKey(call.signature),
      ]),
      [
        [
          'availability/foreign-root',
          '(i32)->i32!readwrite/external/capture:/borrow:/callbacks:/returned:-/noreturn:false/unwind:forbidden',
        ],
        [
          'foreign_dep',
          '(i32)->i32!readwrite/external/capture:/borrow:/callbacks:/returned:-/noreturn:false/unwind:forbidden',
        ],
      ],
    )
    if (self.target._tag !== 'Resolved') return assert.fail('expected a resolved target')
    assert.deepEqual(
      ForeignAvailability.select(self.instances.foreignCalls, self.target.target),
      [],
    )
    const artifact = yield* Analysis.codegen(self, { mode: 'release' })
    assert.deepEqual(artifact.foreignImports, [
      {
        variadic: false,
        symbol: 'abs',
        parameters: ['i32'],
        result: 'i32',
        contract: ForeignContract.conservative,
      },
    ])
  }),
)

it.effect('rejects a conflicting redeclaration relating both declarations', () =>
  Effect.gen(function* () {
    const self = yield* twoModules('unsafe extern "C" fn abs(value: i64) -> i64 as "abs"')
    assert.deepEqual(Analysis.diagnostics(self), [])
    const failure = yield* Effect.flip(Analysis.codegen(self, { mode: 'release' }))
    assert.strictEqual(failure._tag, 'CodegenUnavailable')
    if (failure._tag !== 'CodegenUnavailable') return
    assert.deepEqual(
      failure.diagnostics.map((diagnostic) => [
        diagnostic.code,
        diagnostic.span.sourceId,
        diagnostic.relatedSpans?.map((related) => related.span.sourceId),
      ]),
      [['SEM0192', 'foreign_dep', ['availability/foreign-root']]],
    )
  }),
)

const exportSource = `export "C" fn silk_test_double_v1(value: i32) -> i32 { return value * 2 }
pub fn main() -> i32 { return 0 }`

const exportInventory = (self: Analysis.Snapshot) =>
  self.instances.foreignExports.map((record) => ({
    symbol: record.symbol,
    signature: CAbi.signatureKey(record.signature),
    key: Instances.keyText(record.key),
    declaration: record.declaration.name,
    declarationSource: record.declarationSpan.sourceId,
  }))

it.effect('seeds native discovery with an uncalled export and records it on MIR', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(exportSource)
    assert.deepEqual(Analysis.diagnostics(self), [])
    assert.deepEqual(
      self.instances.instances.map((instance) => instance.key.declaration.name),
      ['main', 'silk_test_double_v1'],
    )
    assert.deepEqual(exportInventory(self), [
      {
        symbol: 'silk_test_double_v1',
        signature:
          '(i32)->i32!readwrite/external/capture:/borrow:/callbacks:/returned:-/noreturn:false/unwind:forbidden',
        key: Instances.keyText(
          self.instances.instances.at(1)?.key ?? unreachable('expected the export instance'),
        ),
        declaration: 'silk_test_double_v1',
        declarationSource: 'availability/main',
      },
    ])
    assert.deepEqual(Analysis.loweredMir(self).foreignExports, self.instances.foreignExports)
    const again = yield* snapshot(exportSource)
    assert.deepEqual(
      again.instances.instances.map((instance) => Instances.keyText(instance.key)),
      self.instances.instances.map((instance) => Instances.keyText(instance.key)),
    )
    assert.deepEqual(exportInventory(again), exportInventory(self))
  }),
)

const exportModules = (root: string, dependency: string, main = 'export_dep.viaDep()') =>
  Analysis.makeRealized({
    configuration: AnalysisFixture.configuration('availability/export-root'),
    root: 'availability/export-root',
  }).pipe(
    Effect.provide(
      SourceResolver.overlay([
        SourceFile.make(
          'availability/export-root',
          encoder.encode(`import export_dep
${root}
pub fn main() -> i32 { return ${main} }`),
        ),
      ]).pipe(
        Layer.provideMerge(
          SourceResolver.memory(
            new Map([
              [
                'export_dep',
                encoder.encode(`${dependency}
pub fn viaDep() -> i32 { return 0 }`),
              ] as const,
            ]),
          ),
        ),
      ),
    ),
  )

const planningFailure = (self: Analysis.Snapshot) =>
  Effect.map(Effect.flip(Analysis.codegen(self, { mode: 'release' })), (failure) => {
    assert.strictEqual(failure._tag, 'CodegenUnavailable')
    return failure._tag === 'CodegenUnavailable'
      ? failure.diagnostics.map((diagnostic) => [
          diagnostic.code,
          diagnostic.span.sourceId,
          diagnostic.relatedSpans?.map((related) => related.span.sourceId),
        ])
      : []
  })

it.effect('rejects two exports of one symbol relating both declarations', () =>
  Effect.gen(function* () {
    const self = yield* exportModules(
      'export "C" fn one(value: i32) -> i32 as "silk_test_v1" { return value }',
      'export "C" fn two(value: i32) -> i32 as "silk_test_v1" { return value }',
    )
    assert.deepEqual(Analysis.diagnostics(self), [])
    assert.deepEqual(yield* planningFailure(self), [
      ['SEM0192', 'export_dep', ['availability/export-root']],
    ])
  }),
)

it.effect('rejects an export whose symbol a reachable import claims', () =>
  Effect.gen(function* () {
    const self = yield* exportModules(
      'unsafe extern "C" fn abs(value: i32) -> i32',
      'export "C" fn abs(value: i32) -> i32 { return value }',
      'unsafe abs(-1) + export_dep.viaDep()',
    )
    assert.deepEqual(Analysis.diagnostics(self), [])
    assert.deepEqual(yield* planningFailure(self), [
      ['SEM0192', 'export_dep', ['availability/export-root']],
    ])
  }),
)

it.effect('accepts distinct export symbols across modules in canonical order', () =>
  Effect.gen(function* () {
    const self = yield* exportModules(
      'export "C" fn silk_test_double_v1(value: i32) -> i32 { return value * 2 }',
      'export "C" fn silk_test_add_v1(left: i32, right: i32) -> i32 { return left + right }',
    )
    assert.deepEqual(Analysis.diagnostics(self), [])
    assert.deepEqual(
      exportInventory(self).map((record) => [record.symbol, record.signature]),
      [
        [
          'silk_test_double_v1',
          '(i32)->i32!readwrite/external/capture:/borrow:/callbacks:/returned:-/noreturn:false/unwind:forbidden',
        ],
        [
          'silk_test_add_v1',
          '(i32,i32)->i32!readwrite/external/capture:/borrow:/callbacks:/returned:-/noreturn:false/unwind:forbidden',
        ],
      ],
    )
    if (self.target._tag !== 'Resolved') return assert.fail('expected a resolved target')
    assert.deepEqual(ForeignPlanning.check(Analysis.loweredMir(self), self.target.target), [])
    const artifact = yield* Analysis.codegen(self, { mode: 'release' })
    assert.deepEqual(artifact.foreignExports, [
      {
        variadic: false,
        symbol: 'silk_test_add_v1',
        parameters: ['i32', 'i32'],
        result: 'i32',
        contract: ForeignContract.conservative,
      },
      {
        variadic: false,
        symbol: 'silk_test_double_v1',
        parameters: ['i32'],
        result: 'i32',
        contract: ForeignContract.conservative,
      },
    ])
  }),
)

it.effect('rejects an export whose body suspends and accepts a synchronous one', () =>
  Effect.gen(function* () {
    const suspending = yield* snapshot(`import silk.effect { Effect }
export "C" fn silk_test_wait_v1() -> i32 { return run Effect.suspend(effect { return 2 }) }
pub fn main() -> i32 { return 0 }`)
    assert.deepEqual(Analysis.diagnostics(suspending), [])
    const failure = yield* Effect.flip(Analysis.codegen(suspending, { mode: 'release' }))
    assert.strictEqual(failure._tag, 'CodegenUnavailable')
    if (failure._tag === 'CodegenUnavailable')
      assert.deepEqual(
        failure.diagnostics.map((diagnostic) => [
          diagnostic.code,
          diagnostic.reason._tag,
          diagnostic.relatedSpans?.map((related) => related.label),
        ]),
        [['SEM0201', 'ExportSuspends', ['suspending call']]],
      )
    const synchronous = yield* snapshot(exportSource)
    if (synchronous.target._tag !== 'Resolved') return assert.fail('expected a resolved target')
    assert.deepEqual(
      ForeignPlanning.check(Analysis.loweredMir(synchronous), synchronous.target.target),
      [],
    )
  }),
)

it.effect('rejects a suspending export at its C callback conversion site', () =>
  Effect.gen(function* () {
    const callbackSource = `import silk.effect { Effect }
unsafe extern "C" fn install(callback: extern "C" fn() -> i32) -> () with Intrinsic.foreign(callbacks: ("callback",))
export "C" fn silk_test_wait_v1() -> i32 { return run Effect.suspend(effect { return 2 }) }
pub fn main() -> i32 { unsafe install(silk_test_wait_v1) return 0 }`
    const self = yield* snapshot(callbackSource)
    assert.deepEqual(Analysis.diagnostics(self), [])
    const failure = yield* Effect.flip(Analysis.codegen(self, { mode: 'release' }))
    assert.strictEqual(failure._tag, 'CodegenUnavailable')
    if (failure._tag !== 'CodegenUnavailable') return
    assert.deepEqual(
      failure.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.reason._tag]),
      [
        ['SEM0201', 'ExportSuspends'],
        ['SEM0207', 'InvalidForeignCallback'],
      ],
    )
    const callback = failure.diagnostics.find((diagnostic) => diagnostic.code === 'SEM0207')
    assert.strictEqual(
      callback === undefined
        ? undefined
        : callbackSource.slice(callback.span.start, callback.span.end),
      'silk_test_wait_v1',
    )
  }),
)
it.effect(
  'plans exports over MIR: symbol map, non-native rejection, and suspension',
  Effect.fnUntraced(function* () {
    const sample = yield* MirSamples.foreignCallSample(Target.aarch64AppleDarwin)
    const key = sample.functions.at(0)?.instance ?? unreachable('expected a fixture function')
    const i32 = Object.freeze({
      _tag: 'Integer' as const,
      bits: 32 as const,
      signed: true,
      extension: 'None' as const,
    })
    const record = (symbol: string, sourceId: string, start: number): Instances.ForeignExport =>
      Object.freeze({
        _tag: 'ForeignExport',
        symbol,
        type: Type.foreignFunction(['i32'], 'i32'),
        signature: Object.freeze({
          variadic: false,
          contract: ForeignContract.conservative,
          parameters: Object.freeze([i32]),
          result: i32,
        }),
        key,
        declaration: Object.freeze({
          _tag: 'CanonicalDeclarationId',
          module: sourceId,
          name: symbol,
        }),
        declarationSpan: foreignEntry(symbol, [], sourceId, start).declarationSpan,
      })
    const program: Mir.Module = Object.freeze({
      ...sample,
      foreignCalls: Object.freeze([foreignEntry('abs', [i32], 'planning/import', 0)]),
      foreignExports: Object.freeze([
        record('silk_test_v1', 'planning/a', 0),
        record('abs', 'planning/b', 0),
        record('silk_test_v1', 'planning/c', 0),
        record('silk_test_ok', 'planning/d', 0),
      ]),
    })
    const summarize = (diagnostics: ReadonlyArray<Diagnostic.Diagnostic>) =>
      diagnostics.map((diagnostic) => [
        diagnostic.code,
        diagnostic.span.sourceId,
        diagnostic.reason._tag === 'ForeignFunctionTargetUnavailable'
          ? diagnostic.reason.surface
          : diagnostic.relatedSpans?.map((related) => related.span.sourceId).join(','),
      ])
    assert.deepEqual(summarize(ForeignPlanning.check(program, Target.aarch64AppleDarwin)), [
      ['SEM0192', 'planning/b', 'planning/import'],
      ['SEM0192', 'planning/c', 'planning/a'],
    ])
    assert.deepEqual(
      summarize(
        ForeignPlanning.check(
          { ...program, foreignExports: program.foreignExports.slice(3) },
          Target.wasm32UnknownUnknown,
        ),
      ),
      [],
    )
    const suspending: Mir.Module = {
      ...program,
      foreignExports: program.foreignExports.slice(3),
      functions: program.functions.map((fn) => ({
        ...fn,
        suspension: { classification: 'Suspendable' as const, regions: Object.freeze([]) },
      })),
    }
    assert.deepEqual(summarize(ForeignPlanning.check(suspending, Target.aarch64AppleDarwin)), [
      ['SEM0201', 'planning/d', undefined],
    ])
  }),
)

it.effect('shares matching C data imports and rejects incompatible symbol claims', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`
unsafe extern "C" static first: i32 as "shared_data"
unsafe extern "C" static second: i32 as "shared_data"
pub fn main() -> i32 { unsafe { return first + second } }`)
    assert.deepEqual(Analysis.diagnostics(self), [])
    const program = Analysis.loweredMir(self)
    assert.strictEqual(program.foreignStatics.length, 2)
    assert.deepEqual(ForeignPlanning.check(program, program.layout.target), [])
    const artifact = yield* Analysis.codegen(self, { mode: 'release' })
    assert.deepEqual(artifact.foreignStatics, [
      { symbol: 'shared_data', type: 'i32', direction: 'Import' },
    ])
    assert.strictEqual(artifact.ir.split('@shared_data =').length, 2)
    const first = program.foreignStatics[0] ?? unreachable('first data import')
    const second = program.foreignStatics[1] ?? unreachable('second data import')
    const variants: ReadonlyArray<Mir.Module['foreignStatics']> = [
      [first, { ...second, type: 'i64' }],
      [first, { ...second, direction: 'Export' }],
      [{ ...first, direction: 'Export' }, second],
      [
        { ...first, direction: 'Export' },
        { ...second, direction: 'Export' },
      ],
    ]
    for (const foreignStatics of variants) {
      const diagnostics = ForeignPlanning.check(
        { ...program, foreignStatics },
        program.layout.target,
      )
      assert.deepEqual(
        diagnostics.map((entry) => entry.code),
        ['SEM0192'],
      )
      assert.deepEqual(diagnostics[0]?.span, second.declarationSpan)
      assert.deepEqual(diagnostics[0]?.relatedSpans?.[0]?.span, first.declarationSpan)
    }
    const call = foreignEntry('shared_data', [], 'planning/function', 0)
    const collision = ForeignPlanning.check(
      { ...program, foreignCalls: [call], foreignStatics: [first] },
      program.layout.target,
    )
    assert.deepEqual(
      collision.map((entry) => entry.code),
      ['SEM0192'],
    )
    assert.deepEqual(collision[0]?.span, first.declarationSpan)
    assert.deepEqual(collision[0]?.relatedSpans?.[0]?.span, call.declarationSpan)
  }),
)

it.effect('lowers literal typed assembly through fixed and tied native registers', () =>
  Effect.gen(function* () {
    const analysis = yield* Analysis.makeRealized({
      root: 'assembly',
      configuration: {
        profile: {
          target: 'x86_64-unknown-linux-gnu',
          artifact: 'object',
          runtime: { kind: 'none' },
        },
      },
    }).pipe(
      Effect.provide(
        SourceResolver.overlay([
          SourceFile.make(
            'assembly',
            encoder.encode(`
unsafe fn add(left: u64, right: u64) -> u64 {
  return unsafe Intrinsic.assembly<u64>("addq $2, $0", "={rax},0,{rdi}", "flags", "none", false, false, (left, right))
}
export "C" fn sum(left: u64, right: u64) -> u64 { return unsafe add(left, right) }
`),
          ),
        ]).pipe(Layer.provideMerge(SourceResolver.empty)),
      ),
    )
    assert.deepEqual(Analysis.diagnostics(analysis), [])
    const artifact = yield* Analysis.codegen(analysis, { mode: 'release' })
    assert.match(artifact.ir, /asm "addq \$2, \$0", "=\{rax\},0,\{rdi\},~\{flags\}"/)
    assert.notMatch(artifact.ir, /@silk\.static\./)
    const program =
      analysis.mir._tag === 'Available' ? analysis.mir.value : unreachable('expected assembly MIR')
    const corrupted = {
      ...program,
      functions: program.functions.map((fn) => ({
        ...fn,
        regions: fn.regions.map((region) =>
          region._tag === 'OperationRegion'
            ? {
                ...region,
                operations: region.operations.map((operation) =>
                  operation._tag === 'NativeAssembly'
                    ? { ...operation, type: { _tag: 'bool' as const } }
                    : operation,
                ),
              }
            : region,
        ),
      })),
    }
    assert.include(
      (yield* MirVerification.verify(corrupted)).map((violation) => violation.rule),
      'InvalidNativeAssembly',
    )
  }),
)

it.effect('emits a naked entry directly at its C symbol', () =>
  Effect.gen(function* () {
    const analysis = yield* Analysis.makeRealized({
      root: 'entry',
      configuration: {
        profile: {
          target: 'x86_64-unknown-linux-gnu',
          artifact: 'object',
          runtime: { kind: 'none' },
        },
      },
    }).pipe(
      Effect.provide(
        SourceResolver.overlay([
          SourceFile.make(
            'entry',
            encoder.encode(`
unsafe export "C" fn entry() -> () as "native_entry" with Intrinsic.machine(naked: true, noReturn: true) {
  return unsafe Intrinsic.assembly<()>("movq %rsp, %rdi\\njmp native_entry_probe", "", "", "readwrite", true, true, ())
}
`),
          ),
        ]).pipe(Layer.provideMerge(SourceResolver.empty)),
      ),
    )
    assert.deepEqual(Analysis.diagnostics(analysis), [])
    const artifact = yield* Analysis.codegen(analysis, { mode: 'release' })
    assert.match(artifact.ir, /define void @native_entry\(/)
    assert.match(artifact.ir, /naked/)
    assert.match(artifact.ir, /asm sideeffect/)
  }),
)

it.effect('rejects malformed native register, memory, lane and template contracts', () =>
  Effect.gen(function* () {
    const base = {
      template: 'addq $1, $0',
      constraints: '={rax},0',
      clobbers: 'flags',
      memory: 'none',
      sideEffects: false,
      noReturn: false,
    }
    for (const patch of [
      { constraints: '={rsp},0' },
      { constraints: '={rax},{rax}' },
      { clobbers: 'rax' },
      { clobbers: 'flags,flags' },
      { memory: 'arbitrary' },
      { memory: 'write' },
      { noReturn: true },
      { template: '.globl injected' },
      { template: 'mov $2, $0' },
      { template: 'mov $, $0' },
      { constraints: '={rax},r' },
    ])
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            NativeAssembly.decode(
              { ...base, ...patch },
              'u64',
              ['u64'],
              Target.x8664UnknownLinuxGnu,
            ),
          ),
        ),
      )
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(
          NativeAssembly.decode(base, 'i32', ['i32'], Target.x8664UnknownLinuxGnu),
        ),
      ),
    )
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(NativeAssembly.decode(base, 'u64', ['u64'], Target.aarch64AppleDarwin)),
      ),
    )
    const arm = yield* NativeAssembly.decode(
      { ...base, template: 'add $0, $0, $1', constraints: '={x0},0' },
      'u64',
      ['u64'],
      Target.aarch64UnknownLinuxGnu,
    )
    assert.equal(
      NativeAssembly.llvmConstraints(arm, Target.aarch64UnknownLinuxGnu),
      '={x0},0,~{cc}',
    )
    assert.include(
      NativeAssembly.violations(
        { ...arm, inputs: [] },
        'u64',
        ['u64'],
        Target.aarch64UnknownLinuxGnu,
      ),
      'assembly metadata normalization',
    )
  }),
)

it.effect('rejects compiler work in naked bodies and nonliteral machine properties', () =>
  Effect.gen(function* () {
    for (const [properties, body] of [
      ['naked: true, noReturn: true', 'return ()'],
      ['naked: true, noReturn: true', 'let value = 1; return ()'],
      ['naked: true && false, noReturn: true', 'return ()'],
      ['naked: true', 'return ()'],
    ]) {
      const analysis = yield* Analysis.makeRealized({
        root: 'invalid-entry',
        configuration: {
          profile: {
            target: 'x86_64-unknown-linux-gnu',
            artifact: 'object',
            runtime: { kind: 'none' },
          },
        },
      }).pipe(
        Effect.provide(
          SourceResolver.overlay([
            SourceFile.make(
              'invalid-entry',
              encoder.encode(
                `unsafe export "C" fn entry() -> () with Intrinsic.machine(${properties}) { ${body} }`,
              ),
            ),
          ]).pipe(Layer.provideMerge(SourceResolver.empty)),
        ),
      )
      const diagnostic =
        Analysis.diagnostics(analysis).find((entry) => entry.code === 'SEM0214') ??
        unreachable('expected machine contract rejection')
      assert.equal(diagnostic.span.sourceId, 'invalid-entry')
      assert.isAbove(diagnostic.span.end, diagnostic.span.start)
    }
  }),
)

it.effect('rejects naked instrumentation and unwind profiles before emission', () =>
  Effect.gen(function* () {
    for (const extra of [{ unwind: 'native' as const }, { sanitizers: ['address' as const] }]) {
      const analysis = yield* Analysis.makeRealized({
        root: 'profile-entry',
        configuration: {
          profile: {
            target: 'x86_64-unknown-linux-gnu',
            artifact: 'object',
            runtime: { kind: 'none' },
            ...extra,
          },
        },
      }).pipe(
        Effect.provide(
          SourceResolver.overlay([
            SourceFile.make(
              'profile-entry',
              encoder.encode(
                `unsafe export "C" fn entry() -> () with Intrinsic.machine(naked: true, noReturn: true) { return unsafe Intrinsic.assembly<()>("ud2", "", "", "none", true, true, ()) }`,
              ),
            ),
          ]).pipe(Layer.provideMerge(SourceResolver.empty)),
        ),
      )
      assert.include(
        Analysis.diagnostics(analysis).map((entry) => entry.code),
        'SEM0214',
      )
    }
  }),
)

it.effect('rejects assembly in static functions at the source boundary', () =>
  Effect.gen(function* () {
    const analysis = yield* Analysis.makeRealized({
      root: 'static-assembly',
      configuration: {
        profile: {
          target: 'x86_64-unknown-linux-gnu',
          artifact: 'object',
          runtime: { kind: 'none' },
        },
      },
    }).pipe(
      Effect.provide(
        SourceResolver.overlay([
          SourceFile.make(
            'static-assembly',
            encoder.encode(
              `static fn machine() -> u64 { return unsafe Intrinsic.assembly<u64>("movq $$1, $0", "={rax}", "", "none", false, false, ()) }`,
            ),
          ),
        ]).pipe(Layer.provideMerge(SourceResolver.empty)),
      ),
    )
    assert.include(
      Analysis.diagnostics(analysis).map((entry) => entry.code),
      'SEM0176',
    )
  }),
)

it.effect('reports source assembly constraints and target admission with call spans', () =>
  Effect.gen(function* () {
    for (const [target, constraint, operand, expected] of [
      ['x86_64-unknown-linux-gnu', '={rax},{rax}', 'value', 'SEM0214'],
      ['x86_64-unknown-linux-gnu', '={rax},0', 'true', 'SEM0214'],
      ['aarch64-apple-darwin', '={rax},0', 'value', 'SEM0093'],
      ['wasm32-unknown-unknown', '={rax},0', 'value', 'SEM0093'],
    ] as const) {
      const analysis = yield* Analysis.makeRealized({
        root: 'bad-assembly',
        configuration: {
          profile: { target, artifact: 'object', runtime: { kind: 'none' } },
          composition: {
            runtimes: [],
            defaults: [],
            requirements: [],
            retention: [{ module: 'bad-assembly', declaration: 'machine' }],
          },
        },
      }).pipe(
        Effect.provide(
          SourceResolver.overlay([
            SourceFile.make(
              'bad-assembly',
              encoder.encode(
                `pub fn machine(value: u64) -> u64 { return unsafe Intrinsic.assembly<u64>("", "${constraint}", "", "none", false, false, (${operand},)) }`,
              ),
            ),
          ]).pipe(Layer.provideMerge(SourceResolver.empty)),
        ),
      )
      assert.include(
        Analysis.diagnostics(analysis).map((entry) => entry.code),
        expected,
        target + ':' + operand,
      )
      const diagnostic =
        Analysis.diagnostics(analysis).find((entry) => entry.code === expected) ??
        unreachable('expected assembly rejection')
      assert.equal(diagnostic.span.sourceId, 'bad-assembly')
      assert.isAbove(diagnostic.span.end, diagnostic.span.start)
    }
  }),
)

it.effect('keeps native stream providers absent from no-libc selections', () =>
  Effect.gen(function* () {
    const source = `import silk.os_writer { StdoutWriter }
import silk.os_logger { StdoutLogger }
import silk.os_standard_input { OsStandardInput }
pub fn main() -> i32 { return 42 }`
    for (const target of Target.native) {
      const self = yield* Analysis.makeRealized({
        root: 'stream-selection/main',
        configuration: {
          profile: { target: target.id, artifact: 'object', libc: 'none', entry: { kind: 'none' } },
        },
      }).pipe(
        Effect.provide(
          SourceResolver.overlay([
            SourceFile.make('stream-selection/main', encoder.encode(source)),
          ]).pipe(Layer.provideMerge(SourceResolver.empty)),
        ),
      )
      assert.deepEqual(
        Analysis.diagnostics(self).map((value) => [value.code, value.span.start, value.span.end]),
        ['StdoutWriter', 'StdoutLogger', 'OsStandardInput'].map((name) => [
          'SEM0014',
          source.indexOf(name),
          source.indexOf(name) + name.length,
        ]),
      )
      assert.deepEqual(self.instances.foreignCalls, [])
    }
  }),
)

it.effect('compiles portable stream replacements on Wasm without foreign stream imports', () =>
  Effect.gen(function* () {
    const self = yield* AnalysisFixture.retainingMain(
      'stream-portable/main',
      encoder.encode(`import silk.writer { Writer, WriterError }
import silk.standard_input { StandardInput, StreamReadError, ReadOutcome }
import silk.effect { Effect }
import silk.u8
struct Sink {}
impl Writer for Sink {
  effect fn writeAll(self: &mut Self, bytes: &[u8]) -> () ! WriterError ? &mut Writer { return () }
  effect fn flush(self: &mut Self) -> () ! WriterError ? &mut Writer { return () }
}
struct Ended {}
impl StandardInput for Ended {
  effect fn read(self: &mut Self, buffer: &mut [u8]) -> ReadOutcome ! StreamReadError ? &mut StandardInput {
    if buffer.length == 0 { return StandardInput.filled(0) }
    return StandardInput.endOfInput()
  }
}
effect fn program() -> i32 ! WriterError | StreamReadError {
  let mut sink = Sink {}
  run Writer.writeAll(b"portable") |> Effect.provideMut<Writer>(&mut sink)
  let mut input = Ended {}
  let mut buffer = [u8.toU8(9)]
  let outcome = run StandardInput.receive(&mut buffer) |> Effect.provideMut<StandardInput>(&mut input)
  if StandardInput.isEndOfInput(&outcome) { return 42 }
  return 1
}
effect fn recover(error: WriterError | StreamReadError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(program(), recover) }`),
      'wasm32-unknown-unknown',
    )
    assert.deepEqual(Analysis.diagnostics(self), [])
    const artifact = yield* Analysis.codegen(self, { mode: 'release' })
    assert.deepEqual(artifact.foreignImports, [])
    assert.deepEqual(artifact.nativeRuntimeSymbols, [])
  }),
)

it.effect('binds unused migrated clock providers while the system provider remains selected', () =>
  Effect.gen(function* () {
    const source = `import silk.os_system_clock { OsSystemClock }
import silk.os_monotonic_clock { OsMonotonicClock }
import silk.native_clock { NativeClock }
pub fn main() -> i32 { return 42 }`
    for (const target of Target.native) {
      const self = yield* Analysis.makeRealized({
        root: 'clock-selection/main',
        configuration: {
          profile: { target: target.id, artifact: 'object', libc: 'none', entry: { kind: 'none' } },
        },
      }).pipe(
        Effect.provide(
          SourceResolver.overlay([
            SourceFile.make('clock-selection/main', encoder.encode(source)),
          ]).pipe(Layer.provideMerge(SourceResolver.empty)),
        ),
      )
      assert.deepEqual(
        Analysis.diagnostics(self).map((value) => [value.code, value.span.start, value.span.end]),
        ['OsSystemClock'].map((name) => [
          'SEM0014',
          source.indexOf(name),
          source.indexOf(name) + name.length,
        ]),
      )
      assert.deepEqual(self.instances.foreignCalls, [])
    }
  }),
)
