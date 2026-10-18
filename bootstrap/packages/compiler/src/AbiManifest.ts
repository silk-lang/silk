import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as Option from 'effect/Option'
import * as Diagnostic from './Diagnostic.js'
import * as ForeignSymbol from './ForeignSymbol.js'
import * as SourceFile from './SourceFile.js'
import * as SourceSpan from './SourceSpan.js'
import type * as Mir from './Mir.js'
import * as ForeignContract from './ForeignContract.js'
import type * as Backend from './Backend.js'
import * as CAbi from './CAbi.js'
import * as Target from './Target.js'

export interface FunctionEntry {
  readonly variadic: boolean
  readonly contract: ForeignContract.ForeignContract
  readonly kind: 'function'
  readonly symbol: string
  readonly abi: 'C'
  readonly direction: 'export' | 'import'
  readonly parameters: ReadonlyArray<CAbi.TypeText>
  readonly result: CAbi.TypeText
}

export interface DataEntry {
  readonly kind: 'data'
  readonly symbol: string
  readonly abi: 'C'
  readonly direction: 'export' | 'import'
  readonly type: CAbi.TypeText
}

export type Entry = FunctionEntry | DataEntry

/** The stable behavioral machine-readable ABI surface of one native library. */
export interface AbiManifest {
  readonly silkForeignAbi: 4
  readonly target: Target.Id
  readonly exports: ReadonlyArray<Entry>
  readonly imports: ReadonlyArray<Entry>
}

const compareText = (left: string, right: string): number => {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

const compareEntries = (left: Entry, right: Entry): number =>
  compareText(left.symbol, right.symbol) || compareText(left.kind, right.kind)

const functionEntry = (
  direction: 'export' | 'import',
  fn: Backend.ForeignExport | Backend.ForeignImport,
): FunctionEntry => ({
  kind: 'function',
  symbol: fn.symbol,
  abi: 'C',
  direction,
  parameters: [...fn.parameters],
  result: fn.result,
  contract: fn.contract,
  variadic: fn.variadic,
})

const dataEntry = (data: Backend.ForeignStatic): DataEntry => ({
  kind: 'data',
  symbol: data.symbol,
  abi: 'C',
  direction: data.direction === 'Export' ? 'export' : 'import',
  type: data.type,
})

/** Creates a versioned manifest from one target-qualified verified ABI inventory. */
export const make = (
  target: Target.Target,
  functionImports: ReadonlyArray<Backend.ForeignImport>,
  functionExports: ReadonlyArray<Backend.ForeignExport>,
  data: ReadonlyArray<Backend.ForeignStatic>,
): AbiManifest => {
  const exports: Array<Entry> = [
    ...functionExports.map((fn) => functionEntry('export', fn)),
    ...data.filter((entry) => entry.direction === 'Export').map(dataEntry),
  ]
  const imports: Array<Entry> = [
    ...functionImports.map((fn) => functionEntry('import', fn)),
    ...data.filter((entry) => entry.direction === 'Import').map(dataEntry),
  ]
  exports.sort(compareEntries)
  imports.sort(compareEntries)
  return {
    silkForeignAbi: 4,
    target: target.id,
    exports: exports,
    imports: imports,
  }
}

/** Renders stable two-space JSON with one trailing newline. */
export const render = (self: AbiManifest): string => `${JSON.stringify(self, null, 2)}\n`

/** Encodes one canonical manifest as UTF-8 bytes. */
export const encode = (self: AbiManifest): Uint8Array => new TextEncoder().encode(render(self))

/** A validated interface paired with its current supplied-file origin. */
export interface Imported {
  readonly manifest: AbiManifest
  readonly span: SourceSpan.SourceSpan
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const exact = (value: Record<string, unknown>, keys: ReadonlyArray<string>): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))

const inspectEntry = (input: unknown, direction: 'import' | 'export'): Entry | undefined => {
  if (
    !record(input) ||
    input.abi !== 'C' ||
    input.direction !== direction ||
    typeof input.symbol !== 'string' ||
    !ForeignSymbol.isValidSpelling(input.symbol)
  )
    return undefined
  const common = { symbol: input.symbol, abi: 'C' as const, direction }
  if (
    input.kind === 'data' &&
    exact(input, ['kind', 'symbol', 'abi', 'direction', 'type']) &&
    CAbi.isTypeText(input.type) &&
    input.type !== 'void'
  )
    return { ...common, kind: 'data', type: input.type }
  if (
    input.kind !== 'function' ||
    !exact(input, [
      'kind',
      'symbol',
      'abi',
      'direction',
      'parameters',
      'result',
      'contract',
      'variadic',
    ]) ||
    typeof input.variadic !== 'boolean' ||
    !Array.isArray(input.parameters) ||
    (input.variadic && (input.parameters.length === 0 || direction === 'export')) ||
    !CAbi.isTypeText(input.result)
  )
    return undefined
  const parameters: Array<CAbi.TypeText> = []
  for (const parameter of input.parameters) {
    if (!CAbi.isTypeText(parameter) || parameter === 'void') return undefined
    parameters.push(parameter)
  }
  const contract = ForeignContract.inspect(input.contract, parameters, input.result)
  if (
    contract !== undefined &&
    parameters.some((text) => {
      const shape = CAbi.inspectText(text)
      return (
        shape?._tag === 'FunctionPointer' &&
        !ForeignContract.callbackAccessAdmitted(contract, shape.contract)
      )
    })
  )
    return undefined
  return contract === undefined
    ? undefined
    : {
        ...common,
        kind: 'function',
        variadic: input.variadic,
        parameters: parameters,
        result: input.result,
        contract,
      }
}

/** Decodes only the behavioral ABI schema; obsolete or malformed interfaces diagnose at their file. */
export const decode = Effect.fn('AbiManifest.decode')(function* (
  source: SourceFile.SourceFile,
): Effect.fn.Return<Imported, Diagnostic.Diagnostic> {
  const span = Option.getOrThrow(SourceSpan.make(source, 0, source.bytes.length))
  const invalid = () =>
    Diagnostic.foreignDeclarationRestriction('invalid behavioral foreign interface', span)
  const text = yield* Effect.try({
    try: () => new TextDecoder('utf-8', { fatal: true }).decode(SourceFile.toUint8Array(source)),
    catch: invalid,
  })
  const input = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
    Effect.mapError(invalid),
  )
  if (
    !record(input) ||
    !exact(input, ['silkForeignAbi', 'target', 'exports', 'imports']) ||
    input.silkForeignAbi !== 4 ||
    typeof input.target !== 'string' ||
    !Array.isArray(input.exports) ||
    !Array.isArray(input.imports)
  )
    return yield* Effect.fail(invalid())
  const selected = Target.select(input.target)
  if (selected._tag !== 'Resolved' || selected.target.kind !== 'Native')
    return yield* Effect.fail(invalid())
  const exports: Array<Entry> = []
  const imports: Array<Entry> = []
  for (const [direction, inputs, entries] of [
    ['export', input.exports, exports],
    ['import', input.imports, imports],
  ] as const) {
    for (const value of inputs) {
      const entry = inspectEntry(value, direction)
      if (entry === undefined || entries.some((prior) => prior.symbol === entry.symbol))
        return yield* Effect.fail(invalid())
      entries.push(entry)
    }
    entries.sort(compareEntries)
  }
  return {
    manifest: {
      silkForeignAbi: 4,
      target: selected.target.id,
      exports: exports,
      imports: imports,
    },
    span,
  }
})

const entryKey = (self: Entry): string =>
  self.kind === 'function'
    ? `function:(${self.parameters.join(',')}${self.variadic ? ',...' : ''})->${self.result}!${ForeignContract.key(self.contract)}`
    : `data:${self.type}`

/** Compares only visible contracts, preserving both source/interface origins on a disagreement. */
export const check = (
  interfaces: ReadonlyArray<Imported>,
  program: Mir.Module,
): ReadonlyArray<Diagnostic.Diagnostic> => {
  const diagnostics: Array<Diagnostic.Diagnostic> = []
  const claimed = new Map<string, { readonly key: string; readonly span: SourceSpan.SourceSpan }>()
  for (const call of [...program.foreignCalls, ...program.foreignExports])
    claimed.set(call.symbol, {
      key: `function:${CAbi.signatureKey(call.signature)}`,
      span: call.declarationSpan,
    })
  for (const data of program.foreignStatics)
    claimed.set(data.symbol, {
      key: `data:${CAbi.typeText(CAbi.classify(data.type, program.layout.target, 'Parameter'))}`,
      span: data.declarationSpan,
    })
  for (const supplied of interfaces) {
    if (supplied.manifest.target !== program.layout.target.id) {
      diagnostics.push(
        Diagnostic.foreignDeclarationRestriction(
          'foreign interface target does not match the selected target',
          supplied.span,
        ),
      )
      continue
    }
    for (const entry of [...supplied.manifest.exports, ...supplied.manifest.imports]) {
      const key = entryKey(entry)
      const prior = claimed.get(entry.symbol)
      if (prior !== undefined && prior.key !== key)
        diagnostics.push(
          Diagnostic.conflictingForeignSignature(entry.symbol, supplied.span, prior.span),
        )
      else if (prior === undefined) claimed.set(entry.symbol, { key, span: supplied.span })
    }
  }
  return Diagnostic.merge(diagnostics)
}
