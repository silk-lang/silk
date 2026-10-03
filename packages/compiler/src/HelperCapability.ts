import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import type * as Backend from './Backend.js'
import type * as CompilationProfile from './CompilationProfile.js'
import * as NativeLinkInput from './NativeLinkInput.js'
import * as Stdlib from './Stdlib.js'
import * as LlvmWasmRuntime from './LlvmWasmRuntime.js'
import type * as Target from './Target.js'
import * as ToolchainIntegrity from './ToolchainIntegrity.js'
import * as Canonical from './internal/Canonical.js'
import type * as ObjectSymbols from './internal/ObjectSymbols.js'

/** Independent compiler-support contracts; selecting one never enables another. */
export type Family =
  | 'memory'
  | 'arithmetic'
  | 'atomics'
  | 'stack-probe'
  | 'stack-protection'
  | 'sanitizer'
  | 'unwind'
export type Scalar = 'pointer' | 'i32' | 'u32' | 'u64' | 'f32' | 'f64'

export interface Contract {
  readonly symbol: string
  readonly family: Family
  readonly callingConvention: 'C'
  readonly parameters: ReadonlyArray<Scalar>
  readonly result: Scalar | 'void'
  readonly pointerBits: 32 | 64
  readonly linkage: 'external'
  readonly visibility: 'default'
  readonly retention: 'explicit-object' | 'platform-symbol'
  readonly lto: 'unsupported'
  readonly authority: string
}

/** One provider with explicit symbol dependencies, suitable for deterministic closure checking. */
export interface Provider {
  readonly id: string
  readonly kind: 'source' | 'platform' | 'bootstrap'
  readonly targets: ReadonlyArray<Target.Id>
  readonly provides: ReadonlyArray<string>
  readonly requires: ReadonlyArray<string>
  readonly root: string
  readonly identity: string
}

export interface Requirement {
  readonly contract: Contract
  readonly provider: Provider
  readonly object: string
  readonly objectDigest: string
  readonly emittedSymbol: string
}

export interface Report {
  readonly schema: 1
  readonly target: Target.Id
  readonly object: string
  readonly objectDigest: string
  readonly requirements: ReadonlyArray<Requirement>
  readonly foreign: ReadonlyArray<string>
  readonly runtime: ReadonlyArray<string>
  readonly platform: ReadonlyArray<string>
  readonly identity: string
}

export class HelperError extends Data.TaggedError('HelperError')<{
  readonly operation: string
  readonly code:
    | 'InvalidObject'
    | 'UnexplainedSymbol'
    | 'UnsupportedFamily'
    | 'MissingProvider'
    | 'IncompatibleProvider'
    | 'ProviderCycle'
    | 'UndeclaredDependency'
    | 'InvalidSupportProfile'
  readonly subject: string
  readonly origins: ReadonlyArray<string>
}> {}

const error = (
  code: HelperError['code'],
  subject: string,
  origins: ReadonlyArray<string>,
): HelperError => new HelperError({ operation: 'HelperCapability.resolve', code, subject, origins })

const memory = ['memcpy', 'memmove', 'memset', 'memcmp', 'bcmp', 'bzero']
const arithmetic = ['fmod', 'fmodf']
const nativeTargets: ReadonlyArray<Target.Id> = [
  'aarch64-apple-darwin',
  'x86_64-unknown-linux-gnu',
  'aarch64-unknown-linux-gnu',
]

/** Normalizes precisely the Mach-O C symbol prefix, preserving every other byte. */
export const symbolName = (target: Target.Target, name: string): string =>
  target.operatingSystem === 'darwin' && name.startsWith('_') ? name.slice(1) : name

const familyOf = (symbol: string): Family | undefined => {
  if (memory.includes(symbol)) return 'memory'
  if (arithmetic.includes(symbol) || /^__(?:u?div|u?mod|mul|float|fix|extend|trunc)/.test(symbol))
    return 'arithmetic'
  if (/^(?:__atomic_|__sync_|__aarch64_(?:cas|swp|ldadd|ldclr|ldeor|ldset))/.test(symbol))
    return 'atomics'
  if (/^(?:__chkstk|___chkstk|__rust_probestack|__probe_stack)/.test(symbol)) return 'stack-probe'
  if (/^__(?:stack_chk|security_)/.test(symbol)) return 'stack-protection'
  if (/^__(?:asan|hwasan|msan|tsan|ubsan|sanitizer)_/.test(symbol)) return 'sanitizer'
  if (/^(?:_Unwind_|__gxx_personality|__gcc_personality)/.test(symbol)) return 'unwind'
  return undefined
}

const contractOf = (symbol: string, target: Target.Target): Contract | undefined => {
  const family = familyOf(symbol)
  if (family === undefined || (!memory.includes(symbol) && !arithmetic.includes(symbol)))
    return undefined
  const size: Scalar = target.pointerSize === 4 ? 'u32' : 'u64'
  const float: Scalar = symbol === 'fmodf' ? 'f32' : 'f64'
  let parameters: ReadonlyArray<Scalar> = ['pointer', 'pointer', size]
  let result: Scalar | 'void' = symbol === 'memcmp' || symbol === 'bcmp' ? 'i32' : 'pointer'
  if (family === 'arithmetic') {
    parameters = [float, float]
    result = float
  } else if (symbol === 'memset') parameters = ['pointer', 'i32', size]
  else if (symbol === 'bzero') {
    parameters = ['pointer', size]
    result = 'void'
  }
  let authority =
    family === 'memory' ? 'LLVM-22.1-memory/C11-7.24' : 'LLVM-22.1-frem/selected-libc-fmod'
  if (symbol === 'bcmp' || symbol === 'bzero')
    authority = 'LLVM-22.1-target-library/selected-strings.h'
  return {
    symbol,
    family,
    callingConvention: 'C',
    pointerBits: target.pointerSize === 4 ? 32 : 64,
    parameters: parameters,
    result,
    linkage: 'external',
    visibility: 'default',
    retention: family === 'memory' ? 'explicit-object' : 'platform-symbol',
    lto: 'unsupported',
    authority,
  }
}

/**
 * Stable identity of every helper contract/provider the selected profile can admit. This is a
 * distribution policy identity, deliberately independent of one generated artifact's references.
 */
export const policyIdentity = (profile: CompilationProfile.Facts): string => {
  const symbols = [
    ...memory.filter(
      (symbol) =>
        (symbol !== 'bcmp' || profile.target.operatingSystem === 'linux') &&
        (symbol !== 'bzero' || profile.target.operatingSystem === 'darwin'),
    ),
    ...(profile.libc !== 'none' && profile.target.kind === 'Native' ? arithmetic : []),
  ]
  const entries: Array<string> = []
  for (const symbol of symbols) {
    const contract = contractOf(symbol, profile.target)
    if (contract === undefined) continue
    let kind: Provider['kind'] = 'source'
    let root = `silk.support.${symbol}`
    if (contract.family === 'arithmetic') {
      kind = 'platform'
      root = profile.target.operatingSystem === 'darwin' ? 'libSystem' : 'm'
    } else if (profile.target.kind === 'WebAssembly') {
      kind = 'bootstrap'
      root = 'llvm-wasm-memory.v1'
    }
    let content = 'selected-platform-supply-v1'
    if (kind === 'source') content = Stdlib.find(root.replaceAll('.', '/'))?.digest ?? 'Missing'
    else if (kind === 'bootstrap')
      content = ToolchainIntegrity.contentDigest(LlvmWasmRuntime.source)
    const providerIdentity = ToolchainIntegrity.contentDigest(
      Canonical.record(`${kind}:${root}:${symbol}:v1`, [profile.target.id, profile.libc, content]),
    )
    entries.push(
      Canonical.record(symbol, [
        providerIdentity,
        contract.family,
        contract.callingConvention,
        Canonical.array(contract.parameters),
        contract.result,
        String(contract.pointerBits),
        contract.linkage,
        contract.visibility,
        contract.retention,
        contract.lto,
        contract.authority,
      ]),
    )
  }
  return ToolchainIntegrity.contentDigest(
    Canonical.record('HelperPolicy.v1', [Canonical.array(entries)]),
  )
}

/** Selects the initial permanent source/platform and explicit Wasm bootstrap providers. */
export const provider = Effect.fn('HelperCapability.provider')(function* (
  symbol: string,
  profile: CompilationProfile.Facts,
): Effect.fn.Return<Provider, HelperError> {
  const family = familyOf(symbol)
  if (family === undefined) return yield* error('UnexplainedSymbol', symbol, [profile.target.id])
  if (!memory.includes(symbol) && !arithmetic.includes(symbol))
    return yield* error('UnsupportedFamily', `${family}:${symbol}`, [profile.target.id])
  if (family === 'arithmetic' && (profile.libc === 'none' || profile.target.kind !== 'Native'))
    return yield* error('MissingProvider', symbol, [profile.target.id, profile.libc])
  if (
    (symbol === 'bcmp' && profile.target.operatingSystem !== 'linux') ||
    (symbol === 'bzero' && profile.target.operatingSystem !== 'darwin')
  )
    return yield* error('MissingProvider', symbol, [profile.target.id])
  const targets = nativeTargets.filter(
    (id) =>
      (symbol !== 'bcmp' || id.includes('linux')) && (symbol !== 'bzero' || id.includes('darwin')),
  )
  let kind: Provider['kind'] = 'source'
  let root = `silk.support.${symbol}`
  if (family === 'arithmetic') {
    kind = 'platform'
    root = profile.target.operatingSystem === 'darwin' ? 'libSystem' : 'm'
  } else if (profile.target.kind === 'WebAssembly') {
    kind = 'bootstrap'
    root = 'llvm-wasm-memory.v1'
  }
  let content = 'selected-platform-supply-v1'
  if (kind === 'source') {
    const source = Stdlib.find(root.replaceAll('.', '/'))
    if (source === undefined) return yield* error('MissingProvider', root, [profile.target.id])
    content = source.digest
  } else if (kind === 'bootstrap')
    content = ToolchainIntegrity.contentDigest(LlvmWasmRuntime.source)
  const id = `${kind}:${root}:${symbol}:v1`
  return {
    id,
    kind,
    root,
    provides: [symbol],
    requires: [],
    targets: kind === 'bootstrap' ? [profile.target.id] : targets,
    identity: ToolchainIntegrity.contentDigest(
      Canonical.record(id, [profile.target.id, profile.libc, content]),
    ),
  }
})

/** Validates a selected provider graph, reporting the full path for missing edges and cycles. */
export const closure = Effect.fn('HelperCapability.closure')(function* (
  roots: ReadonlyArray<string>,
  providers: ReadonlyArray<Provider>,
  target: Target.Target,
): Effect.fn.Return<ReadonlyArray<Provider>, HelperError> {
  const bySymbol = new Map<string, Provider>()
  for (const candidate of providers) {
    for (const symbol of candidate.provides) {
      const previous = bySymbol.get(symbol)
      if (previous !== undefined && previous.id !== candidate.id)
        return yield* error('IncompatibleProvider', symbol, [previous.id, candidate.id])
      bySymbol.set(symbol, candidate)
    }
  }
  const complete = new Set<string>(),
    selected: Array<Provider> = []
  const pending: Array<{ symbol: string; path: ReadonlyArray<string>; exiting: boolean }> = [
    ...roots,
  ]
    .sort()
    .reverse()
    .map((symbol) => ({ symbol, path: [], exiting: false }))
  while (pending.length > 0) {
    const next = pending.pop()
    if (next === undefined) break
    const candidate = bySymbol.get(next.symbol)
    if (candidate === undefined)
      return yield* error('MissingProvider', next.symbol, [...next.path, next.symbol])
    if (!candidate.targets.includes(target.id))
      return yield* error('IncompatibleProvider', candidate.id, [target.id])
    if (next.exiting) {
      complete.add(candidate.id)
      selected.push(candidate)
      continue
    }
    if (next.path.includes(candidate.id))
      return yield* error('ProviderCycle', next.symbol, [...next.path, candidate.id])
    if (complete.has(candidate.id)) continue
    pending.push({ ...next, exiting: true })
    for (const symbol of [...candidate.requires].sort().reverse())
      pending.push({ symbol, path: [...next.path, candidate.id], exiting: false })
  }
  return selected
})

/**
 * The symbol classes an object's emitting artifact declared. Accounting reads only their names, so
 * a reused object carries these instead of its whole backend artifact.
 */
export interface Declarations {
  readonly foreignImports: ReadonlyArray<Pick<Backend.ForeignImport, 'symbol'>>
  readonly foreignStatics: ReadonlyArray<Pick<Backend.ForeignStatic, 'symbol' | 'direction'>>
  readonly nativeRuntimeSymbols: ReadonlyArray<string>
}

/** Accounts actual object references against explicit source/runtime contracts and helper ABIs. */
export const reconcile = Effect.fn('HelperCapability.reconcile')(function* (
  inventory: ObjectSymbols.Inventory,
  artifact: Declarations,
  profile: CompilationProfile.Facts,
  object: string,
  objectDigest: string,
): Effect.fn.Return<Report, HelperError> {
  const foreignNames = new Set([
    ...artifact.foreignImports.map((entry) => entry.symbol),
    ...artifact.foreignStatics
      .filter((entry) => entry.direction === 'Import')
      .map((entry) => entry.symbol),
  ])
  const runtimeNames = new Set(artifact.nativeRuntimeSymbols)
  const requirements: Array<Requirement> = [],
    foreign: Array<string> = [],
    runtime: Array<string> = [],
    platform: Array<string> = []
  for (const entry of [...inventory.symbols]
    .filter((entry) => !entry.defined)
    .sort((a, b) => Canonical.compare(a.name, b.name))) {
    const symbol = symbolName(profile.target, entry.name)
    if (foreignNames.has(symbol)) {
      foreign.push(symbol)
      continue
    }
    if (runtimeNames.has(symbol)) {
      runtime.push(symbol)
      continue
    }
    if (
      (inventory.format === 'elf' && symbol === '_GLOBAL_OFFSET_TABLE_') ||
      (inventory.format === 'wasm' &&
        [
          '__stack_pointer',
          '__heap_base',
          '__memory_base',
          '__table_base',
          '__indirect_function_table',
        ].includes(symbol))
    ) {
      platform.push(symbol)
      continue
    }
    const selected = yield* provider(symbol, profile).pipe(
      Effect.mapError(
        (failure) =>
          new HelperError({
            operation: failure.operation,
            code: failure.code,
            subject: failure.subject,
            origins: [object, ...failure.origins],
          }),
      ),
    )
    const contract = contractOf(symbol, profile.target)
    if (contract === undefined) return yield* error('UnsupportedFamily', symbol, [object])
    requirements.push({
      contract,
      provider: selected,
      object,
      objectDigest,
      emittedSymbol: entry.name,
    })
  }
  const identity = ToolchainIntegrity.contentDigest(
    Canonical.record('HelperReport.v1', [
      profile.target.id,
      objectDigest,
      Canonical.array(
        requirements.map((entry) =>
          Canonical.record(entry.contract.symbol, [
            entry.provider.identity,
            entry.contract.authority,
            ...entry.contract.parameters,
            entry.contract.result,
          ]),
        ),
      ),
      Canonical.array(foreign),
      Canonical.array(runtime),
      Canonical.array(platform),
    ]),
  )
  return {
    schema: 1,
    target: profile.target.id,
    object,
    objectDigest,
    requirements: requirements,
    foreign: foreign,
    runtime: runtime,
    platform: platform,
    identity,
  }
})

/** Verifies the classified C signatures before an ordinary source provider can supply a helper. */
export const verifyExports = Effect.fn('HelperCapability.verifyExports')(function* (
  providers: ReadonlyArray<Provider>,
  exports: ReadonlyArray<Backend.ForeignExport>,
  target: Target.Target,
): Effect.fn.Return<void, HelperError> {
  const ids = providers.map((provider) => provider.id)
  const provides = providers.flatMap((provider) => provider.provides)
  if (exports.length !== provides.length)
    return yield* error('IncompatibleProvider', 'Unexpected source export set', ids)
  const scalar = (type: string): string => (type.startsWith('pointer<') ? 'pointer' : type)
  for (const provider of providers)
    for (const symbol of provider.provides) {
      const expected = contractOf(symbol, target)
      const actual = exports.find((entry) => entry.symbol === symbol)
      if (
        expected === undefined ||
        actual === undefined ||
        actual.variadic ||
        scalar(actual.result) !== expected.result ||
        actual.parameters.length !== expected.parameters.length ||
        actual.parameters.some((type, index) => scalar(type) !== expected.parameters[index])
      )
        return yield* error('IncompatibleProvider', `C ABI mismatch: ${symbol}`, [
          provider.id,
          target.id,
        ])
    }
})

/**
 * Rejects emitted dependencies that escape the providers' declared closure, including self calls.
 * The providers share one object, so a dependency between two of them that neither declared is
 * resolved inside it and not seen here; declared cycles are rejected by {@link closure}.
 */
export const verifyProviders = Effect.fn('HelperCapability.verifyProviders')(function* (
  providers: ReadonlyArray<Provider>,
  inventory: ObjectSymbols.Inventory,
  target: Target.Target,
): Effect.fn.Return<void, HelperError> {
  const references = new Set(
    [
      ...inventory.references,
      ...inventory.symbols.filter((entry) => !entry.defined).map((entry) => entry.name),
    ].map((name) => symbolName(target, name)),
  )
  const defined = new Set(
    inventory.symbols
      .filter((entry) => entry.defined)
      .map((entry) => symbolName(target, entry.name)),
  )
  for (const provider of providers)
    for (const symbol of provider.provides) {
      if (!defined.has(symbol))
        return yield* error('MissingProvider', symbol, [provider.id, 'missing export'])
      if (references.has(symbol))
        return yield* error('ProviderCycle', symbol, [provider.id, symbol, provider.id])
    }
  const requires = new Set(providers.flatMap((provider) => provider.requires))
  for (const entry of inventory.symbols.filter((entry) => !entry.defined)) {
    const symbol = symbolName(target, entry.name)
    if (!requires.has(symbol))
      return yield* error(
        'UndeclaredDependency',
        symbol,
        providers.map((provider) => provider.id),
      )
  }
})

/** Physical library requirements belonging only to the selected platform helper providers. */
export const linkInputs = (
  reports: ReadonlyArray<Report>,
): ReadonlyArray<NativeLinkInput.NativeLinkInput> =>
  [
    ...new Set(
      reports.flatMap((report) =>
        report.requirements
          .filter((entry) => entry.provider.kind === 'platform' && entry.provider.root === 'm')
          .map(() => 'm'),
      ),
    ),
  ].map((name) => NativeLinkInput.library(name, 'Dynamic'))
