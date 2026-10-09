import type * as DeclarationIndex from './DeclarationIndex.js'
import * as ExecutionAffinity from './ExecutionAffinity.js'
import * as Type from './Type.js'

/**
 * Compiler-owned activation states. Readiness phases and generations are ordinary source policy
 * stored in the package's source control words, so they are not lifecycle states.
 */
export type State = 'Unstarted' | 'Running' | 'Relinquished' | 'Completed' | 'Destroyed'

export type Event = 'Drive' | 'Relinquish' | 'Complete' | 'Drop'

export type Transition =
  | { readonly _tag: 'Transition'; readonly state: State }
  | { readonly _tag: 'FatalIntrinsicStateTrap'; readonly state: State; readonly event: Event }
  | { readonly _tag: 'OwnershipRejected'; readonly state: State; readonly event: Event }

export interface Fact {
  readonly _tag: 'ExecutionSemanticFact'
  readonly identity: 'Intrinsic.Execution'
  readonly result: Type.Type
  readonly affine: true
  readonly copy: false
  readonly threadTransfer: false
  readonly affinity: ExecutionAffinity.ExecutionAffinity
  readonly initial: 'Unstarted'
  readonly states: ReadonlyArray<State>
  readonly loans: {
    readonly externalConstruction: 'Rejected'
    readonly internalStable: 'MayCrossParking'
    readonly cleanup: 'LoanBeforeReferent'
    readonly completionBorrow: 'Rejected'
  }
  readonly localShared: {
    readonly ownedStrongHandle: 'PreservedAcrossParking'
    readonly activeAccess: 'RejectParking'
  }
}

export type FactResult =
  | { readonly _tag: 'Available'; readonly fact: Fact }
  | { readonly _tag: 'Unavailable'; readonly reason: 'NotExecution' | 'UnavailableResult' }

export const states: ReadonlyArray<State> = [
  'Unstarted',
  'Running',
  'Relinquished',
  'Completed',
  'Destroyed',
]

/** Publishes representation-free ownership and lifecycle semantics for one sealed specialization. */
export const ofType = (index: DeclarationIndex.Index, type: Type.Type): FactResult => {
  if (!Type.isExecution(type)) return { _tag: 'Unavailable', reason: 'NotExecution' }
  const result = type.arguments.at(0)
  if (result === undefined || !Type.isTypeArgument(result) || !Type.runtimeAvailable(result))
    return { _tag: 'Unavailable', reason: 'UnavailableResult' }
  return {
    _tag: 'Available',
    fact: {
      _tag: 'ExecutionSemanticFact',
      identity: 'Intrinsic.Execution',
      result,
      affine: true,
      copy: false,
      threadTransfer: false,
      affinity: ExecutionAffinity.ofType(index, type),
      initial: 'Unstarted',
      states,
      loans: {
        externalConstruction: 'Rejected',
        internalStable: 'MayCrossParking',
        cleanup: 'LoanBeforeReferent',
        completionBorrow: 'Rejected',
      },
      localShared: {
        ownedStrongHandle: 'PreservedAcrossParking',
        activeAccess: 'RejectParking',
      },
    },
  }
}

/** Applies the owner-neutral activation contract without selecting storage. */
export const transition = (state: State, event: Event): Transition => {
  if (event === 'Drive') {
    if (state === 'Unstarted' || state === 'Relinquished')
      return { _tag: 'Transition', state: 'Running' }
    if (state === 'Running') return { _tag: 'FatalIntrinsicStateTrap', state, event }
    return { _tag: 'OwnershipRejected', state, event }
  }
  if (event === 'Relinquish' && state === 'Running')
    return { _tag: 'Transition', state: 'Relinquished' }
  if (event === 'Complete' && state === 'Running') return { _tag: 'Transition', state: 'Completed' }
  if (event === 'Drop' && (state === 'Unstarted' || state === 'Relinquished'))
    return { _tag: 'Transition', state: 'Destroyed' }
  return { _tag: 'OwnershipRejected', state, event }
}

export const encode = (self: Fact): string =>
  `${self.identity}<${Type.encode(self.result)}> affine=yes copy=no transfer=no affinity=${ExecutionAffinity.encode(self.affinity)} initial=${self.initial} states=${self.states.join(',')} loans=${self.loans.externalConstruction}/${self.loans.internalStable}/${self.loans.cleanup}/${self.loans.completionBorrow} shared=${self.localShared.ownedStrongHandle}/${self.localShared.activeAccess}`
