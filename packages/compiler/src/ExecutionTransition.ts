import * as ExecutionLifecycle from './ExecutionLifecycle.js'

/** Stable target-neutral identity for one independently owned execution package. */
export interface Identity {
  readonly _tag: 'ExecutionIdentity'
  readonly package: number
  readonly root: number
}

/** Complete compiler-owned activation state from which every backend transition is derived. */
export interface State {
  readonly _tag: 'ExecutionTransitionState'
  readonly identity: Identity
  readonly execution: ExecutionLifecycle.State
}

export type Event = 'Start' | 'Relinquish' | 'Resume' | 'Complete' | 'Cancel'

export interface Edge {
  readonly _tag: 'ExecutionTransitionEdge'
  readonly event: Event
  readonly before: State
  readonly after: State
  readonly cleanup: ReadonlyArray<'Frames' | 'Body' | 'Endpoint' | 'Authority'>
}

/**
 * The complete backend-neutral activation authority carried by MIR for one exact package plan.
 * Readiness policy is ordinary source over the package's control words and never appears here.
 */
export interface Authority {
  readonly _tag: 'ExecutionTransitionAuthority'
  readonly package: number
  readonly root: number
  readonly edges: ReadonlyArray<Edge>
}

export type Result =
  | Edge
  | {
      readonly _tag: 'ExecutionTransitionViolation'
      readonly event: Event
      readonly state: State
    }
  | {
      readonly _tag: 'FatalExecutionTrap'
      readonly event: 'Start' | 'Resume'
      readonly state: State
    }

const state = (identity: Identity, execution: State['execution']): State => ({
  _tag: 'ExecutionTransitionState',
  identity,
  execution,
})

const edge = (event: Event, before: State, after: State, cleanup: Edge['cleanup'] = []): Edge => ({
  _tag: 'ExecutionTransitionEdge',
  event,
  before,
  after,
  cleanup,
})

const violation = (self: State, event: Event): Result => ({
  _tag: 'ExecutionTransitionViolation',
  event,
  state: self,
})

/** Creates one deterministic Unstarted package/root pair before source body execution. */
export const initialize = (packageIdentity: number, root: number): State =>
  state({ _tag: 'ExecutionIdentity', package: packageIdentity, root }, 'Unstarted')

/** Starts an Unstarted body or resumes a Relinquished frame chain; anything else traps. */
export const drive = (self: State): Result => {
  const event = self.execution === 'Relinquished' ? 'Resume' : 'Start'
  const logical = ExecutionLifecycle.transition(self.execution, 'Drive')
  if (logical._tag === 'FatalIntrinsicStateTrap')
    return { _tag: 'FatalExecutionTrap', event, state: self }
  if (logical._tag !== 'Transition') return violation(self, event)
  return edge(event, self, state(self.identity, logical.state))
}

/** Saves the running frame chain and returns the drive through its suspension callback. */
export const relinquish = (self: State): Result => {
  const logical = ExecutionLifecycle.transition(self.execution, 'Relinquish')
  return logical._tag === 'Transition'
    ? edge('Relinquish', self, state(self.identity, logical.state))
    : violation(self, 'Relinquish')
}

/** Completes a running body, releasing frames and endpoint before the handle authority. */
export const complete = (self: State): Result => {
  const logical = ExecutionLifecycle.transition(self.execution, 'Complete')
  return logical._tag === 'Transition'
    ? edge('Complete', self, state(self.identity, logical.state), [
        'Frames',
        'Endpoint',
        'Authority',
      ])
    : violation(self, 'Complete')
}

/** Drops an Unstarted body or cancels a Relinquished frame chain top-down. */
export const cancel = (self: State): Result => {
  const logical = ExecutionLifecycle.transition(self.execution, 'Drop')
  if (logical._tag !== 'Transition') return violation(self, 'Cancel')
  return edge(
    'Cancel',
    self,
    state(self.identity, logical.state),
    self.execution === 'Unstarted'
      ? ['Body', 'Endpoint', 'Authority']
      : ['Frames', 'Endpoint', 'Authority'],
  )
}

/** Validates one edge independently of a backend's fused physical tags. */
export const verifyEdge = (self: Edge): ReadonlyArray<string> => {
  const violations: Array<string> = []
  if (self.before.identity.package !== self.after.identity.package)
    violations.push('PackageProvenance')
  if (self.before.identity.root !== self.after.identity.root) violations.push('LogicalRoot')
  if (self.cleanup.length > 0 && self.cleanup.at(-1) !== 'Authority')
    violations.push('AuthorityBeforeCleanup')
  return violations
}

const requiredEdge = (result: Result): Edge => {
  if (result._tag !== 'ExecutionTransitionEdge')
    throw new RangeError(`canonical execution transition ${result.event} was rejected`)
  return result
}

/** Builds the complete legal branch table that MIR validates before backend lowering. */
export const authority = (packageIdentity: number, root: number): Authority => {
  const unstarted = initialize(packageIdentity, root)
  const started = requiredEdge(drive(unstarted))
  const relinquished = requiredEdge(relinquish(started.after))
  const resumed = requiredEdge(drive(relinquished.after))
  return {
    _tag: 'ExecutionTransitionAuthority',
    package: packageIdentity,
    root,
    edges: [
      started,
      requiredEdge(complete(started.after)),
      relinquished,
      resumed,
      requiredEdge(complete(resumed.after)),
      requiredEdge(cancel(unstarted)),
      requiredEdge(cancel(relinquished.after)),
    ],
  }
}

/** Rejects forged, incomplete, reordered, or internally-invalid MIR transition authority. */
export const verifyAuthority = (self: Authority): ReadonlyArray<string> => {
  const violations = self.edges.flatMap(verifyEdge)
  const expected = authority(self.package, self.root)
  if (self.edges.length !== expected.edges.length) violations.push('IncompleteTransitionAuthority')
  if (
    self.edges.some((candidate, ordinal) => {
      const expectedEdge = expected.edges.at(ordinal)
      return expectedEdge === undefined || encode(candidate) !== encode(expectedEdge)
    })
  )
    violations.push('NonCanonicalTransitionAuthority')
  return [...new Set(violations)]
}

/** Deterministic MIR inspection of a complete per-package transition authority. */
export const encodeAuthority = (self: Authority): ReadonlyArray<string> =>
  self.edges.map(
    (candidate, ordinal) =>
      `execution-transition package=${self.package} root=${self.root} edge=${ordinal} ${encode(candidate)}`,
  )

/** Compact private activation-word tag selected by LLVM lowering only after MIR validation. */
export const tagOf = (execution: State['execution']): number => {
  switch (execution) {
    case 'Unstarted':
      return 0
    case 'Running':
      return 1
    case 'Relinquished':
      return 2
    case 'Completed':
      return 3
    case 'Destroyed':
      return 4
  }
}

/** Representation-free deterministic inspection of one state or transition edge. */
export const encode = (self: State | Edge): string => {
  if (self._tag === 'ExecutionTransitionState')
    return `execution id=e${self.identity.package} root=x${self.identity.root} state=${self.execution.toLowerCase()}`
  return `${encode(self.before)} --${self.event.toLowerCase()} cleanup=${self.cleanup.map((item) => item.toLowerCase()).join(',') || 'none'}--> ${encode(self.after)}`
}
