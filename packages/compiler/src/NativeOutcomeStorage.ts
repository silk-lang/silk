import type * as Mir from './Mir.js'
import type * as MirLinearization from './MirLinearization.js'
import * as MirVerification from './MirVerification.js'

/** Runtime selector and cleanup inputs also keep a payload's storage live. */
const selectorLocals = (selectors: ReadonlyArray<Mir.PlaceSelector>): ReadonlyArray<Mir.LocalId> =>
  selectors.flatMap((selector) => {
    if (selector._tag === 'ElementSelector' && selector.index._tag === 'Runtime')
      return [selector.index.local]
    return selector._tag === 'SliceElementSelector' ? [selector.index] : []
  })

const releaseLocals = (releases: ReadonlyArray<Mir.CoroutineFrameRelease>) =>
  releases.flatMap((release) => [
    release.local,
    ...(release.initialization?.flags.map((flag) => flag.local) ?? []),
  ])

/**
 * Counts every ordinary reference conservatively, including destinations. Only the two
 * scalar-result run emitters consume their outcome payload entirely within the operation.
 * Their outcome identity, like a diagnostic release, is not itself a payload read.
 */
const operationLocals = (
  operation: MirLinearization.LinearOperation,
): ReadonlyArray<Mir.LocalId> => {
  switch (operation._tag) {
    case 'RunEffectValue':
      return [operation.destination, operation.effect, ...operation.arguments]
    case 'RunStaticEffect':
      return [
        operation.destination,
        ...operation.captures.map((capture) => capture.source),
        ...operation.arguments,
      ]
    case 'ReleaseDiagnosticOutcome':
    case 'LeaveDiagnosticScope':
      return []
    case 'EnterDiagnosticScope':
      return [operation.state, operation.observer]
    case 'CheckedScalarOutcome':
      return [operation.valid, operation.value, ...operation.operands]
    case 'BindMatch':
      return [
        operation.scrutinee,
        operation.destination,
        ...selectorLocals(operation.selectors ?? []),
      ]
    default:
      return MirVerification.operationLocals(operation)
  }
}

const terminalLocals = (
  terminator: MirLinearization.LinearTerminator,
): ReadonlyArray<Mir.LocalId> => {
  switch (terminator._tag) {
    case 'Return':
      return [terminator.value]
    case 'Branch':
      return [terminator.condition]
    case 'MatchBranch':
    case 'EnumMatchBranch':
      return [terminator.scrutinee, ...selectorLocals(terminator.selectors ?? [])]
    case 'PropagateEffectFailure':
      return [terminator.source, ...releaseLocals(terminator.releases ?? [])]
    case 'Jump':
    case 'Trap':
      return []
  }
}

/**
 * Finds single-definition run outcomes whose payload never needs a local home. The native
 * emitter can consume their caller-owned result storage directly and retain only the separately owned
 * diagnostic slot. Eagerly storing these temporary payloads added per-lane GEP/store pairs
 * to every run in the self-hosted parser despite having no later payload consumer.
 *
 * This is whole-function dead-storage analysis, not an SSA cache: any value reference,
 * address use, repeated definition, or suspension dependency keeps canonical storage.
 * Diagnostic recovery/release metadata alone does not. No returned SSA lanes survive a join
 * in a compiler-side cache, and diagnostic ownership is never removed by this analysis.
 */
export const transientLocals = (
  fn: Mir.MirFunction,
  blocks: ReadonlyArray<MirLinearization.LinearBlock>,
): ReadonlySet<number> => {
  const candidates = new Set<number>()
  const required = new Set<number>()
  const add = (locals: ReadonlyArray<Mir.LocalId>) => {
    for (const local of locals) required.add(local.ordinal)
  }
  for (const block of blocks) {
    for (const operation of block.operations) {
      if (operation._tag === 'RunEffectValue' || operation._tag === 'RunStaticEffect') {
        const root = operation.outcome.ordinal
        if (candidates.has(root) || root < fn.parameterCount) required.add(root)
        if (fn.localTypes.at(root)?._tag === 'EffectOutcome') candidates.add(root)
      }
      add(operationLocals(operation))
      if ('releases' in operation) add(releaseLocals(operation.releases ?? []))
    }
    add(terminalLocals(block.terminator))
  }
  // Resumption may read an outcome through lowering-only frame/transfer storage even
  // when no subsequent MIR operation explicitly mentions its payload.
  for (const region of fn.suspension?.regions ?? []) {
    if (region.operation._tag !== 'ExecutionRelinquish')
      required.add(region.operation.outcome.ordinal)
    if (region._tag === 'RunSuspendableEffectRegion') {
      add(region.liveLocals)
      add(region.relay.state?.slots.map((slot) => slot.local) ?? [])
    }
  }
  for (const root of required) candidates.delete(root)
  return candidates
}
