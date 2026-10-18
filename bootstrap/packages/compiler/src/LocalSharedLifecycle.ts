/** Private local-shared access state. It is deliberately not source-observable. */
export type AccessState = 'Available' | 'Active'

export interface StrongState {
  readonly count: bigint
  readonly maximum: bigint
}

export type CloneTransition =
  | { readonly _tag: 'Cloned'; readonly state: StrongState }
  | { readonly _tag: 'StrongOverflow'; readonly state: StrongState }

/** Compares before incrementing, so overflow never mutates the count or creates a handle. */
export const clone = (self: StrongState): CloneTransition =>
  self.count >= self.maximum
    ? { _tag: 'StrongOverflow', state: self }
    : {
        _tag: 'Cloned',
        state: { count: self.count + 1n, maximum: self.maximum },
      }

export type DropTransition =
  | { readonly _tag: 'Decremented'; readonly state: StrongState }
  | { readonly _tag: 'LastHandle' }

/** Selects non-last decrement or the unique terminal cleanup authority. */
export const drop = (self: StrongState): DropTransition =>
  self.count > 1n
    ? {
        _tag: 'Decremented',
        state: { count: self.count - 1n, maximum: self.maximum },
      }
    : { _tag: 'LastHandle' }

export type AccessTransition =
  | { readonly _tag: 'Use'; readonly state: 'Active' }
  | { readonly _tag: 'Conflict'; readonly state: 'Active' }

/** Selects exactly one callback without changing an already-active access. */
export const beginAccess = (self: AccessState): AccessTransition =>
  self === 'Available' ? { _tag: 'Use', state: 'Active' } : { _tag: 'Conflict', state: 'Active' }

/** Ends a normally-returned successful callback before result publication. */
export const endAccess = (_self: 'Active'): 'Available' => 'Available'
