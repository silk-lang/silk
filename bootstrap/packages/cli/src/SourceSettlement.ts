/** The source-tree observations accumulated while waiting for a writer to finish. */
export interface SourceSettlement {
  readonly fingerprint: string
  readonly stableSamples: number
  readonly policy: Policy
}

/** How equal observations are interpreted for this candidate snapshot. */
export type Policy = 'Confirm' | 'AwaitBudget'

export type Observation =
  | { readonly _tag: 'Pending'; readonly settlement: SourceSettlement }
  | { readonly _tag: 'Changed'; readonly fingerprint: string }
  | { readonly _tag: 'Settled'; readonly fingerprint: string }

const ordinaryConfirmationsRequired = 2

/** Maximum observations spent on one candidate before a continuously changing tree proceeds. */
export const maximumObservations = 40

const make = (fingerprint: string, policy: Policy): SourceSettlement => ({
  fingerprint,
  stableSamples: 0,
  policy,
})

/** Classifies the transition from the last compiled entry to the newly loaded candidate. */
export const fromEntryTransition = (
  fingerprint: string,
  compiledEntrySize: number,
  candidateEntrySize: number,
): SourceSettlement =>
  make(fingerprint, compiledEntrySize > 0 && candidateEntrySize === 0 ? 'AwaitBudget' : 'Confirm')

/** Applies the candidate's confirmation policy to one later source-tree observation. */
export const observe = (self: SourceSettlement, fingerprint: string): Observation => {
  if (fingerprint !== self.fingerprint) {
    return { _tag: 'Changed', fingerprint }
  }
  if (self.policy === 'AwaitBudget') {
    const stableSamples = self.stableSamples + 1
    return stableSamples < maximumObservations
      ? { _tag: 'Pending', settlement: { ...self, stableSamples } }
      : { _tag: 'Settled', fingerprint }
  }
  const stableSamples = self.stableSamples + 1
  return stableSamples < ordinaryConfirmationsRequired
    ? { _tag: 'Pending', settlement: { fingerprint, stableSamples, policy: self.policy } }
    : { _tag: 'Settled', fingerprint }
}
