import * as Effect from 'effect/Effect'

/** A provider-owned semantic operation with a reconstructible canonical address. */
export interface Descriptor {
  readonly _tag: 'SemanticQueryDescriptor'
  readonly family: string
  readonly schema: number
  readonly address: string
  readonly reuse: 'Revision' | 'Session'
}

/** One typed current input that can be read again while validating a prior record. */
export interface InputAddress {
  readonly _tag: 'SemanticInputAddress'
  readonly family: string
  readonly schema: number
  readonly address: string
}

/**
 * A recorded dependency. A record derives a deferred `fingerprint` on first access, so a one-shot
 * session that never validates or persists records never pays for result or input identity.
 */
export interface QueryRead {
  readonly _tag: 'QueryRead'
  readonly descriptor: Descriptor
  readonly fingerprint: string
}

export interface InputRead {
  readonly _tag: 'InputRead'
  readonly input: InputAddress
  readonly fingerprint: string
}

export type Observation = QueryRead | InputRead
export type Observe = (input: InputAddress) => void

/**
 * What a provider reads for one input: its fingerprint, `undefined` when the input is absent, or a
 * deferred derivation of either. A deferred derivation must depend only on what was current when
 * the input was read, because it runs when a validation or persistence first needs it.
 */
export type InputFingerprint = string | undefined | (() => string | undefined)

/** The single dispatcher for one semantic environment. */
export interface Provider {
  readonly execute: (descriptor: Descriptor, observe: Observe) => unknown
  readonly fingerprint: (
    descriptor: Descriptor,
    answer: unknown,
    observations: ReadonlyArray<Observation>,
  ) => string
  readonly read: (input: InputAddress) => InputFingerprint
  /** Whether a successfully returned answer may enter current or revision snapshots. */
  readonly cacheable?: (descriptor: Descriptor, answer: unknown) => boolean
  /** Whether a callback-backed descriptor can execute before its current demand is registered. */
  readonly available?: (descriptor: Descriptor) => boolean
}

export interface Completed<A> {
  readonly descriptor: Descriptor
  readonly key: string
  readonly answer: A
  readonly fingerprint: string
  readonly observations: ReadonlyArray<Observation>
}

/** A bounded transfer object that does not retain its producing session. */
export interface Snapshot {
  readonly _tag: 'SemanticQuerySnapshot'
  readonly records: ReadonlyMap<string, Completed<unknown>>
}

export interface Cycle {
  readonly _tag: 'SemanticQueryCycle'
  readonly key: string
  readonly path: ReadonlyArray<string>
}

export type Result<A> =
  | { readonly _tag: 'Completed'; readonly completed: Completed<A>; readonly reused: boolean }
  | { readonly _tag: 'Cycle'; readonly cycle: Cycle }

export interface Counters {
  readonly _tag: 'SemanticQueryCounters'
  readonly validations: number
  readonly executions: number
  readonly reuses: number
}

export interface Session {
  readonly _tag: 'SemanticQuerySession'
  readonly epoch: string
}

interface Active {
  readonly key: string
  readonly observations: Array<Observation>
  /** Query and input keys already recorded, so recording a dependency stays constant-time. */
  readonly observed: Set<string>
}

interface State {
  readonly provider: Provider
  readonly previous: ReadonlyMap<string, Completed<unknown>>
  readonly current: Map<string, Completed<unknown>>
  readonly active: Array<Active>
  readonly executions: Map<string, number>
  readonly counters: { validations: number; executions: number; reuses: number }
  freshDepth: number
}

const states = new WeakMap<Session, State>()
const missingFingerprint = '\u0000missing'

const stateOf = (self: Session): State => {
  const state = states.get(self)
  if (state === undefined) throw new RangeError('Unknown semantic query session')
  return state
}

export const keyOf = (descriptor: Descriptor): string =>
  descriptor.family +
  ':' +
  descriptor.schema +
  ':' +
  descriptor.address.length +
  ':' +
  descriptor.address

const inputKey = (input: InputAddress): string =>
  input.family + ':' + input.schema + ':' + input.address.length + ':' + input.address

const fingerprintOf = (read: InputFingerprint): string =>
  (typeof read === 'function' ? read() : read) ?? missingFingerprint

export const make = (epoch: string, provider: Provider, previous?: Snapshot): Session => {
  const session = { _tag: 'SemanticQuerySession' as const, epoch }
  states.set(session, {
    provider,
    previous: previous?.records ?? new Map(),
    current: new Map(),
    active: [],
    executions: new Map(),
    counters: { validations: 0, executions: 0, reuses: 0 },
    freshDepth: 0,
  })
  return session
}

// A session reads each input and query answer once as one value, so a dependency is recorded once
// per address and its fingerprint is derived only when a validation or persistence reads it.
const observeInput = (state: State, active: Active, input: InputAddress): void => {
  const encoded = 'InputRead:' + inputKey(input)
  if (active.observed.has(encoded)) return
  active.observed.add(encoded)
  const read = state.provider.read(input)
  if (typeof read !== 'function') {
    active.observations.push({
      _tag: 'InputRead',
      input,
      fingerprint: read ?? missingFingerprint,
    })
    return
  }
  let fingerprint: string | undefined
  active.observations.push({
    _tag: 'InputRead',
    input,
    get fingerprint() {
      return (fingerprint ??= fingerprintOf(read))
    },
  })
}

const observeParent = (
  state: State,
  descriptor: Descriptor,
  key: string,
  completed: Completed<unknown>,
): void => {
  const parent = state.active.at(-1)
  if (parent === undefined) return
  const encoded = 'QueryRead:' + key
  if (parent.observed.has(encoded)) return
  parent.observed.add(encoded)
  parent.observations.push({
    _tag: 'QueryRead',
    descriptor,
    get fingerprint() {
      return completed.fingerprint
    },
  })
}

const cycle = (state: State, key: string): Result<never> => {
  const ordinal = state.active.findIndex((active) => active.key === key)
  return {
    _tag: 'Cycle',
    cycle: {
      _tag: 'SemanticQueryCycle',
      key,
      path: [...state.active.slice(Math.max(0, ordinal)).map((active) => active.key), key],
    },
  }
}

const storedAs = <A>(stored: Completed<unknown>): Completed<A> =>
  // Family and schema are part of the key and determine the provider answer type.
  stored as Completed<A>

const validateObservation = (self: Session, observation: Observation): boolean => {
  const state = stateOf(self)
  if (observation._tag === 'InputRead')
    return fingerprintOf(state.provider.read(observation.input)) === observation.fingerprint
  if (state.provider.available?.(observation.descriptor) === false) {
    const key = keyOf(observation.descriptor)
    const current = state.current.get(key)
    if (current !== undefined) return current.fingerprint === observation.fingerprint
    const previous = state.previous.get(key)
    if (previous === undefined || state.active.some((active) => active.key === key)) return false
    const reservation: Active = { key, observations: [], observed: new Set() }
    state.active.push(reservation)
    let valid = false
    let removed: Active | undefined
    try {
      valid = validate(self, previous)
    } finally {
      removed = state.active.pop()
    }
    if (removed !== reservation)
      throw new RangeError('Semantic query validation stack is corrupted')
    if (!valid) return false
    state.current.set(key, previous)
    state.counters.reuses += 1
    return previous.fingerprint === observation.fingerprint
  }
  const result = execute<unknown>(self, observation.descriptor, true)
  return result._tag === 'Completed' && result.completed.fingerprint === observation.fingerprint
}

const validate = (self: Session, completed: Completed<unknown>): boolean => {
  const state = stateOf(self)
  state.counters.validations += 1
  for (const observation of completed.observations)
    if (!validateObservation(self, observation)) return false
  return true
}

const executeProvider = <A>(self: Session, descriptor: Descriptor, publish: boolean): Result<A> => {
  const state = stateOf(self)
  const key = keyOf(descriptor)
  const active: Active = { key, observations: [], observed: new Set() }
  state.active.push(active)
  try {
    state.counters.executions += 1
    state.executions.set(key, (state.executions.get(key) ?? 0) + 1)
    const answer = state.provider.execute(descriptor, (input) =>
      observeInput(state, active, input),
    ) as A
    const observations = active.observations
    // Result identity walks the whole answer; only a dependent read or persistence needs it, so a
    // root query with neither never pays. The answer and observations are frozen: same value later.
    let fingerprint: string | undefined
    const completed: Completed<A> = {
      descriptor,
      key,
      answer,
      get fingerprint() {
        return (fingerprint ??= state.provider.fingerprint(descriptor, answer, observations))
      },
      observations,
    }
    if (publish && state.provider.cacheable?.(descriptor, answer) !== false)
      state.current.set(key, completed)
    const removed = state.active.pop()
    if (removed !== active) throw new RangeError('Semantic query reservation stack is corrupted')
    observeParent(state, descriptor, key, completed)
    return { _tag: 'Completed', completed, reused: false }
  } catch (cause) {
    if (state.active.at(-1) === active) state.active.pop()
    throw cause
  }
}

const execute = <A>(self: Session, descriptor: Descriptor, allowReuse: boolean): Result<A> => {
  const state = stateOf(self)
  const key = keyOf(descriptor)
  const publish = state.freshDepth === 0
  if (state.active.some((active) => active.key === key)) return cycle(state, key)
  if (allowReuse && publish) {
    const current = state.current.get(key)
    if (current !== undefined) {
      state.counters.reuses += 1
      observeParent(state, descriptor, key, current)
      return { _tag: 'Completed', completed: storedAs<A>(current), reused: true }
    }
    const previous = descriptor.reuse === 'Revision' ? state.previous.get(key) : undefined
    if (previous !== undefined) {
      const reservation: Active = { key, observations: [], observed: new Set() }
      state.active.push(reservation)
      let valid = false
      let removed: Active | undefined
      try {
        valid = validate(self, previous)
      } finally {
        removed = state.active.pop()
      }
      if (removed !== reservation)
        throw new RangeError('Semantic query validation stack is corrupted')
      if (valid) {
        state.current.set(key, previous)
        state.counters.reuses += 1
        observeParent(state, descriptor, key, previous)
        return {
          _tag: 'Completed',
          completed: storedAs<A>(previous),
          reused: true,
        }
      }
    }
  }
  return executeProvider(self, descriptor, publish)
}

export const query = <A>(self: Session, descriptor: Descriptor): Result<A> =>
  execute(self, descriptor, true)

/** Bypasses both current and previous reuse for this root and every nested provider. */
export const fresh = <A>(self: Session, descriptor: Descriptor): Result<A> => {
  const state = stateOf(self)
  state.freshDepth += 1
  try {
    return execute(self, descriptor, false)
  } finally {
    state.freshDepth -= 1
  }
}

export const queryEffect = Effect.fn('SemanticQuery.query')(function* <A>(
  self: Session,
  descriptor: Descriptor,
): Effect.fn.Return<Completed<A>, Cycle> {
  yield* Effect.yieldNow
  const result = query<A>(self, descriptor)
  return result._tag === 'Cycle' ? yield* Effect.fail(result.cycle) : result.completed
})

export const completed = <A>(self: Session, descriptor: Descriptor): Completed<A> | undefined => {
  const stored = stateOf(self).current.get(keyOf(descriptor))
  return stored === undefined ? undefined : storedAs<A>(stored)
}

export const snapshot = (self: Session): Snapshot => ({
  _tag: 'SemanticQuerySnapshot',
  records: new Map(
    [...stateOf(self).current].filter(([, completed]) => completed.descriptor.reuse === 'Revision'),
  ),
})

export const executionCount = (self: Session, descriptor: Descriptor): number =>
  stateOf(self).executions.get(keyOf(descriptor)) ?? 0

export const counters = (self: Session): Counters => {
  const counters = stateOf(self).counters
  return { _tag: 'SemanticQueryCounters', ...counters }
}

export const isActive = (self: Session, descriptor: Descriptor): boolean =>
  stateOf(self).active.some((active) => active.key === keyOf(descriptor))

export const observe = (self: Session, input: InputAddress): void => {
  const state = stateOf(self)
  const active = state.active.at(-1)
  if (active !== undefined) observeInput(state, active, input)
}
