import * as CompilerTrace from './CompilerTrace.js'
import type * as ForeignContract from './ForeignContract.js'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import type * as DeclarationFacts from './DeclarationFacts.js'
import type * as Diagnostic from './Diagnostic.js'
import * as Instances from './Instances.js'
import * as ForeignAvailability from './ForeignAvailability.js'
import * as ForeignPlanning from './ForeignPlanning.js'
import * as IntrinsicAvailability from './IntrinsicAvailability.js'
import * as Mir from './Mir.js'
import type * as SourceSpan from './SourceSpan.js'
import * as StaticValue from './StaticValue.js'
import type * as Target from './Target.js'
import * as Type from './Type.js'
import type * as CAbi from './CAbi.js'

export interface CodegenRequest {
  readonly mode: 'debug' | 'release'
  /** Restricted, runtime-free object compilation; only C exports remain externally visible. */
  readonly support?: boolean
  readonly sources?: ReadonlyMap<string, Uint8Array>
  readonly privateExecutionStackPages?: number
}

export interface SymbolEntry {
  readonly declaration: DeclarationFacts.CanonicalId
  readonly instance: Mir.MirFunction['instance']
  readonly symbol: string
}

export interface ControlProvenance {
  readonly _tag: 'BackendControlProvenance'
  readonly backend: 'LLVM'
  readonly function: DeclarationFacts.CanonicalId
  readonly instance: Mir.MirFunction['instance']
  readonly region: Mir.RegionId
  readonly construct: 'LlvmJump' | 'LlvmBranch' | 'LlvmReturn' | 'LlvmTrap'
  readonly targets: ReadonlyArray<Mir.RegionId>
  readonly loop?: Mir.LoopId
  readonly span: SourceSpan.SourceSpan
}

export type Id = 'llvm'

/** Canonical target-runtime capabilities that the backend actually emitted. */
export type RuntimeFeature =
  | 'DormantContinuation'
  | 'ExecutionDrive'
  | 'ExecutionPackage'
  | 'ExternalWakeCell'
  | 'NestedSuspensionRuntime'
  | 'ReadinessNotification'

/**
 * One reachable foreign (`extern "C"`) symbol the artifact expects the link step to resolve, with
 * its classified C signature spelled as C class names (`i32`, `u64`, `f64`, `void`, ...).
 */
export interface ForeignImport {
  readonly variadic: boolean
  readonly contract: ForeignContract.ForeignContract
  readonly symbol: string
  readonly parameters: ReadonlyArray<CAbi.TypeText>
  readonly result: CAbi.TypeText
}

/** One exported C-callable symbol and the C class spellings of its thunk signature. */
export interface ForeignExport {
  readonly variadic: boolean
  readonly contract: ForeignContract.ForeignContract
  readonly symbol: string
  readonly parameters: ReadonlyArray<CAbi.TypeText>
  readonly result: CAbi.TypeText
}

/** One native C data symbol retained by an artifact, with its scalar C class. */
export interface ForeignStatic {
  readonly symbol: string
  readonly type: CAbi.TypeText
  readonly direction: 'Import' | 'Export'
}

interface ArtifactBase {
  readonly module: string
  readonly backend: Id
  readonly target: Target.Target
  readonly symbols: ReadonlyArray<SymbolEntry>
  readonly nativeRuntimeSymbols: ReadonlyArray<string>
  readonly runtimeFeatures: ReadonlyArray<RuntimeFeature>
  /** Reachable foreign symbols sorted by symbol. */
  readonly foreignImports: ReadonlyArray<ForeignImport>
  /** Exported C-callable symbols with their classified signatures, sorted by symbol. */
  readonly foreignExports: ReadonlyArray<ForeignExport>
  /** Imported and exported C data symbols, sorted by symbol and direction. */
  readonly foreignStatics: ReadonlyArray<ForeignStatic>
  readonly control: ReadonlyArray<ControlProvenance>
}

export interface LlvmBitcodeArtifact extends ArtifactBase {
  readonly _tag: 'LlvmBitcodeArtifact'
  readonly support?: boolean
  readonly backend: 'llvm'
  readonly bitcode: Uint8Array
  readonly ir: string
}

export type Artifact = LlvmBitcodeArtifact

export interface ModuleViolation {
  readonly function: string
  readonly message: string
  readonly detail: ReadonlyArray<string>
}

export const formatModuleViolations = (
  violations: ReadonlyArray<ModuleViolation>,
  limit = 5,
): string => {
  const shown = violations
    .slice(0, limit)
    .map((violation) =>
      [`${violation.message} (in ${violation.function})`, ...violation.detail].join('\n'),
    )
  const remaining = violations.length - shown.length
  return [...shown, ...(remaining > 0 ? [`... and ${remaining} more violation(s)`] : [])].join('\n')
}

export class BackendError extends Data.TaggedError('BackendError')<{
  readonly operation: 'Backend.emit'
  readonly backend: string
  readonly message: string
  readonly reason:
    | { readonly _tag: 'InvalidModule'; readonly violations: ReadonlyArray<ModuleViolation> }
    | { readonly _tag: 'UnsupportedMir'; readonly detail: string }
    | { readonly _tag: 'UnsupportedTarget'; readonly target: Target.Id }
    | {
        readonly _tag: 'UnsupportedIntrinsic'
        readonly diagnostics: ReadonlyArray<Diagnostic.Diagnostic>
      }
    | {
        readonly _tag: 'UnsupportedForeignFunction'
        readonly diagnostics: ReadonlyArray<Diagnostic.Diagnostic>
      }
    | { readonly _tag: 'ForeignSymbolConflict'; readonly symbol: string }
    | { readonly _tag: 'WrappedFailure'; readonly cause: unknown }
}> {}

export interface Backend<A extends Artifact = Artifact> {
  readonly _tag: 'Backend'
  readonly id: Id
  readonly name: string
  readonly targets: ReadonlyArray<Target.Id>
  readonly emit: (program: Mir.Module, request: CodegenRequest) => Effect.Effect<A, BackendError>
}

/** Emits internally consistent MIR after checking backend capabilities. Run MirVerification.check explicitly to audit compiler invariants. */
export const emit = Effect.fn('Backend.emit')(function* <A extends Artifact>(
  self: Backend<A>,
  program: Mir.Module,
  request: CodegenRequest,
): Effect.fn.Return<A, BackendError> {
  yield* Effect.annotateCurrentSpan({
    'backend.name': self.name,
    'module.name': program.module,
    'functions.count': program.functions.length,
    'target.id': program.layout.target.id,
  })
  const availability = yield* selectIntrinsics(program)
  if (availability._tag === 'Unavailable') {
    return yield* new BackendError({
      operation: 'Backend.emit',
      backend: self.name,
      message: `${self.name} cannot emit a program with unavailable intrinsics`,
      reason: { _tag: 'UnsupportedIntrinsic', diagnostics: availability.diagnostics },
    })
  }
  const foreign = yield* selectForeign(program)
  const planning = yield* checkForeignPlanning(program)
  if (foreign.length > 0 || planning.length > 0) {
    return yield* new BackendError({
      operation: 'Backend.emit',
      backend: self.name,
      message: `${self.name} cannot emit a program with unavailable foreign functions`,
      reason: { _tag: 'UnsupportedForeignFunction', diagnostics: [...foreign, ...planning] },
    })
  }
  if (!self.targets.includes(program.layout.target.id)) {
    return yield* new BackendError({
      operation: 'Backend.emit',
      backend: self.name,
      message: `${self.name} does not support target ${program.layout.target.id}`,
      reason: { _tag: 'UnsupportedTarget', target: program.layout.target.id },
    })
  }
  return yield* self.emit(program, request)
})

const selectIntrinsics = Effect.fn('Backend.selectIntrinsics')((program: Mir.Module) =>
  Effect.sync(() => IntrinsicAvailability.select(program.intrinsics, program.layout.target)),
)
const selectForeign = Effect.fn('Backend.selectForeign')(function* (program: Mir.Module) {
  const trace = yield* CompilerTrace.capture()
  const callbacks = trace('ForeignAvailability.callbackAddresses', () =>
    ForeignAvailability.callbackAddresses(program),
  )
  const statics = trace('ForeignAvailability.staticLoads', () =>
    ForeignAvailability.staticLoads(program),
  )
  return trace('ForeignAvailability.select', () =>
    ForeignAvailability.select(
      program.foreignCalls,
      program.layout.target,
      program.foreignStatics,
      callbacks,
      statics,
    ),
  )
})
const checkForeignPlanning = Effect.fn('Backend.checkForeignPlanning')((program: Mir.Module) =>
  Effect.sync(() => ForeignPlanning.check(program, program.layout.target)),
)

export const sanitize = (name: string): string => name.replace(/[^A-Za-z0-9_]/g, '_')

const textEncoder = new TextEncoder()
const hexadecimalBytes = Array.from({ length: 256 }, (_, byte) =>
  byte.toString(16).padStart(2, '0'),
)

const injectivePart = (value: string): string => {
  const bytes = textEncoder.encode(value)
  let hexadecimal = ''
  for (const byte of bytes) hexadecimal += hexadecimalBytes[byte]
  return `${bytes.length}_${hexadecimal}`
}

// Checked propagation names every frame literal after its function's symbol, so emission asks
// for the same function's symbol once per propagation site.
const symbols = new WeakMap<Mir.MirFunction, string>()

export const symbolFor = (fn: Mir.MirFunction): string => {
  const cached = symbols.get(fn)
  if (cached !== undefined) return cached
  const symbol = `silk_${sanitize(fn.id.module)}_${sanitize(fn.id.name)}__${[
    fn.instance.declaration.module,
    fn.instance.declaration.name,
    ...Type.runtimeArgumentKeys(fn.instance.typeArguments),
    ...fn.instance.staticArguments.map(StaticValue.key),
    ...fn.instance.contractRow,
  ]
    .map(injectivePart)
    .join('_')}`
  symbols.set(fn, symbol)
  return symbol
}

export const suspensionPointKey = (point: Mir.SuspensionPointId): string =>
  `${Instances.keyText(point.owner)}\u0000${point.sourceId}\u0000${point.spanStart}\u0000${point.spanEnd}\u0000${point.ordinal}`

export interface LineTable {
  readonly lineStarts: ReadonlyArray<number>
}

export const lineTable = (bytes: Uint8Array | undefined): LineTable => {
  const lineStarts = [0]
  if (bytes !== undefined) {
    for (let index = 0; index < bytes.length; index += 1) {
      if (bytes[index] === 0x0a) lineStarts.push(index + 1)
    }
  }
  return { lineStarts }
}

export const positionOf = (
  table: LineTable,
  offset: number,
): { readonly line: number; readonly column: number } => {
  let line = 0
  while (line + 1 < table.lineStarts.length && (table.lineStarts[line + 1] ?? 0) <= offset) {
    line += 1
  }
  return { line: line + 1, column: offset - (table.lineStarts[line] ?? 0) + 1 }
}
