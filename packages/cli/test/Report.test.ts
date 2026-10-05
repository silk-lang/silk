import * as MirVerification from '@silklang/compiler/MirVerification'
import { assert, it } from '@effect/vitest'
import * as Backend from '@silklang/compiler/Backend'
import type * as Diagnostic from '@silklang/compiler/Diagnostic'
import type * as Driver from '@silklang/compiler/Driver'
import * as NativeToolchain from '@silklang/compiler/NativeToolchain'
import * as Target from '@silklang/compiler/Target'
import * as ToolchainIntegrity from '@silklang/compiler/ToolchainIntegrity'
import * as Report from '../src/Report.js'

const ascii = (text: string): Uint8Array =>
  Uint8Array.from(text.split('').map((character) => character.charCodeAt(0)))

const source = (text: string): Report.SourceCatalog =>
  new Map([['main', { path: 'main.silk', bytes: ascii(text) }]])

// Spans are nominal, so tests build them structurally rather than through the private constructor.
const span = (start: number, end: number, sourceId = 'main'): Diagnostic.Diagnostic['span'] =>
  ({ sourceId, start, end }) as unknown as Diagnostic.Diagnostic['span']

const diagnostic = (
  overrides: Partial<Diagnostic.Diagnostic> & { readonly span: Diagnostic.Diagnostic['span'] },
): Diagnostic.Diagnostic =>
  ({
    _tag: 'Diagnostic',
    phase: 'semantic',
    code: 'SEM0001',
    severity: 'error',
    message: 'Unknown type Nope',
    reason: { _tag: 'UnknownType' },
    ...overrides,
  }) as Diagnostic.Diagnostic

it('reports the first byte as line 1, column 1', () => {
  assert.deepStrictEqual(Report.positionAt(ascii('abc'), 0), { line: 1, column: 1 })
})

it('counts lines and restarts columns after each newline', () => {
  const bytes = ascii('one\ntwo\nthree')
  assert.deepStrictEqual(Report.positionAt(bytes, 4), { line: 2, column: 1 })
  assert.deepStrictEqual(Report.positionAt(bytes, 6), { line: 2, column: 3 })
  assert.deepStrictEqual(Report.positionAt(bytes, 8), { line: 3, column: 1 })
})

it('clamps an offset past the end to the final position', () => {
  const bytes = ascii('ab')
  assert.deepStrictEqual(Report.positionAt(bytes, 99), { line: 1, column: 3 })
})

it('renders a diagnostic with a clickable path, position, code, and message', () => {
  const rendered = Report.diagnostic(
    diagnostic({ span: span(17, 21) }),
    source('pub fn main() -> Nope { return 42 }'),
  )
  assert.strictEqual(rendered, 'main.silk:1:18: error[SEM0001] Unknown type Nope')
})

it('indents diagnostic notes beneath their diagnostic', () => {
  const rendered = Report.diagnostic(
    diagnostic({ span: span(0, 1), notes: ['try i32'] }),
    source('pub fn main() -> Nope { return 42 }'),
  )
  assert.strictEqual(rendered, 'main.silk:1:1: error[SEM0001] Unknown type Nope\n  note: try i32')
})

it('renders each diagnostic against the physical file for its source identity', () => {
  const catalog: Report.SourceCatalog = new Map([
    ['app.Main', { path: '/project/app/Main.silk', bytes: ascii('pub fn main() -> Nope') }],
    ['compiler.Syntax', { path: '/project/compiler/Syntax.silk', bytes: ascii('\npub type Nope') }],
  ])
  const rendered = Report.diagnostics(
    [
      diagnostic({ span: span(17, 21, 'app.Main') }),
      diagnostic({ span: span(1, 4, 'compiler.Syntax'), message: 'Imported declaration failed' }),
    ],
    catalog,
  )

  assert.strictEqual(
    rendered,
    [
      '/project/app/Main.silk:1:18: error[SEM0001] Unknown type Nope',
      '/project/compiler/Syntax.silk:2:1: error[SEM0001] Imported declaration failed',
    ].join('\n'),
  )
})

it('names the executable, target, and symbol count on success', () => {
  const outcome: Driver.Outcome = {
    _tag: 'Compiled',
    backend: 'llvm',
    artifactKind: 'NativeExecutable',
    path: '/tmp/a.out',
    target: { id: 'aarch64-apple-darwin' } as Driver.Compiled['target'],
    symbols: [
      {
        declaration: { _tag: 'CanonicalDeclarationId', module: 'main', name: 'main' },
        symbol: 'silk_main_main__4_6d61696e_4_6d61696e',
      },
    ],
    foreignImports: [],
    foreignExports: [],
    foreignStatics: [],
    diagnostics: [],
    report: [],
    toolchainIdentity: 'fixture-toolchain',
  }
  assert.strictEqual(
    Report.outcome(outcome, source('pub fn main() -> i32 { return 42 }'), 'main.silk'),
    'Compiled main.silk -> /tmp/a.out (llvm, aarch64-apple-darwin, 1 symbols)',
  )
  assert.strictEqual(
    Report.outcome(
      { ...outcome, path: '/tmp/project/build/a.out' },
      source('pub fn main() -> i32 { return 42 }'),
      '/tmp/project/src/main.silk',
      (value) => value.replace('/tmp/project/', ''),
    ),
    'Compiled src/main.silk -> build/a.out (llvm, aarch64-apple-darwin, 1 symbols)',
  )
})

it('reports every durable native-library path on success', () => {
  const outcome: Driver.Outcome = {
    _tag: 'Compiled',
    backend: 'llvm',
    artifactKind: 'NativeStaticLibrary',
    path: '/tmp/libanswer.a',
    target: { id: 'aarch64-apple-darwin' } as Driver.Compiled['target'],
    symbols: [],
    foreignImports: [],
    foreignExports: [],
    foreignStatics: [],
    libraryInterface: {
      _tag: 'LibraryInterfaceArtifacts',
      cHeader: '/tmp/answer.h',
      abiManifest: '/tmp/answer.abi.json',
    },
    diagnostics: [],
    report: [],
    toolchainIdentity: 'fixture-toolchain',
  }
  assert.strictEqual(
    Report.outcome(outcome, source('export "C" fn answer() -> i32 { return 42 }'), 'main.silk'),
    [
      'Compiled main.silk -> /tmp/libanswer.a (llvm, aarch64-apple-darwin, 0 symbols)',
      'C header: /tmp/answer.h',
      'ABI manifest: /tmp/answer.abi.json',
    ].join('\n'),
  )
})

it('lists each MIR violation with its rule, location, and owning function', () => {
  const outcome: Driver.Outcome = {
    _tag: 'VerificationFailed',
    error: new MirVerification.MirVerificationError({
      operation: 'MirVerification.check',
      message: 'MIR verification failed',
      violations: [
        {
          _tag: 'Violation',
          rule: 'InvalidLoan',
          function: { _tag: 'CanonicalDeclarationId', module: 'main', name: 'useCounter' },
          provenance: { span: span(4, 8), generated: false },
          detail: 'loan escapes its region',
        },
        { _tag: 'Violation', rule: 'InvalidArtifactRoot', detail: 'retained root missing' },
      ],
    }),
    diagnostics: [],
    report: [],
  }
  assert.strictEqual(
    Report.outcome(outcome, source('one\ntwo\nthree'), 'main.silk'),
    [
      'Verification error: MIR verification failed',
      '  main.silk:2:1: error[InvalidLoan] loan escapes its region (in main.useCounter)',
      '  error[InvalidArtifactRoot] retained root missing',
    ].join('\n'),
  )
})

it('renders unsupported intrinsic diagnostics beneath the backend error', () => {
  const outcome: Driver.Outcome = {
    _tag: 'BackendFailed',
    error: new Backend.BackendError({
      operation: 'Backend.emit',
      backend: 'LLVM',
      message: 'LLVM cannot emit a program with unavailable intrinsics',
      reason: {
        _tag: 'UnsupportedIntrinsic',
        diagnostics: [diagnostic({ span: span(0, 1), message: 'intrinsic unavailable on llvm' })],
      },
    }),
    diagnostics: [],
    report: [],
  }
  assert.strictEqual(
    Report.outcome(outcome, source('one\ntwo\nthree'), 'main.silk'),
    [
      'Backend error: LLVM cannot emit a program with unavailable intrinsics',
      'main.silk:1:1: error[SEM0001] intrinsic unavailable on llvm',
    ].join('\n'),
  )
})

it('keeps the failing command so a toolchain failure is reproducible by hand', () => {
  const failure = new NativeToolchain.ToolchainError({
    operation: 'NativeToolchain.NativeFinalizer.finalize',
    stage: 'link',
    message: 'link failed',
    reason: {
      _tag: 'LinkFailed',
      planned: {
        _tag: 'PlannedCommand',
        target: Target.aarch64AppleDarwin,
        command: 'clang',
        arguments: ['-o', 'a.out'],
      },
      status: 1,
      output: 'ld: symbol not found',
    },
  })
  const rendered = Report.toolchainError(failure)
  assert.strictEqual(
    rendered,
    [
      'link stage failed: process exited with status 1',
      '  command: clang -o a.out',
      '  | ld: symbol not found',
    ].join('\n'),
  )
})

it('reports broken distribution identity separately from backend and source failures', () => {
  const installed = ToolchainIntegrity.installed()
  const stale = ToolchainIntegrity.make(
    installed.components.map((component) =>
      component.kind === 'IntrinsicInventory'
        ? { ...component, digest: '0'.repeat(64) }
        : component,
    ),
  )
  const validation = ToolchainIntegrity.validateFrontend(stale)
  assert.strictEqual(validation._tag, 'Invalid')
  if (validation._tag !== 'Invalid') return
  const rendered = Report.outcome(
    {
      _tag: 'ToolchainFailed',
      expectedIdentity: installed.digest,
      observedIdentity: stale.digest,
      failures: validation.failures,
      report: [],
    },
    source(''),
    'main.silk',
  )
  assert.include(rendered, 'Broken toolchain:')
  assert.include(rendered, 'IntrinsicInventory silk/intrinsic/inventory digest mismatch')
})

it('treats only a Compiled outcome as success', () => {
  assert.strictEqual(
    Report.succeeded({ _tag: 'Rejected', sources: new Map(), diagnostics: [], report: [] }),
    false,
  )
})
