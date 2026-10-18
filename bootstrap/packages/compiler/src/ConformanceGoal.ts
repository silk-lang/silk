/**
 * One concrete conformance question and the finite proof that answers it.
 *
 * A goal is always closed: both the interface application and the provider are fully substituted,
 * so a goal names one specialization rather than a family of them. That is what makes the identity
 * a usable memo key — two occurrences of `Decoder for MappedSchema<Schema>` anywhere in a program
 * are the same question and deserve the same answer exactly once.
 *
 * A proof is a tree, not a flag. Each node records which conformance was selected, the arguments
 * that specialization bound, and the proofs of that conformance's own requirements. Instance
 * discovery reads the tree to find every witness a program actually needs, and lowering reads only
 * the node's own direct target, because a requirement's witness is reached through its own instance
 * rather than through a dictionary passed at run time.
 *
 * A failure carries the chain of goals that led to it. The chain is finite for the same reason the
 * search is: `ConformanceHead` proved at declaration time that requirements strictly descend.
 */
import * as Type from './Type.js'

/** One fully substituted conformance question. */
export interface ConformanceGoal {
  readonly _tag: 'ConformanceGoal'
  readonly capability: Type.Nominal
  readonly provider: Type.Type
}

/** Which declaration answered one goal. */
export type Selection =
  | { readonly _tag: 'IdentitySelection' }
  | { readonly _tag: 'IntrinsicSelection' }
  | { readonly _tag: 'SourceSelection'; readonly module: string; readonly ordinal: number }

/** Why one goal has no admissible witness. */
export type Failure =
  | { readonly _tag: 'MissingWitness' }
  | { readonly _tag: 'AmbiguousWitness'; readonly candidates: number }
  | { readonly _tag: 'UnavailableWitness'; readonly reason: string }
  | { readonly _tag: 'ActiveCycle' }

/** The finite answer to one goal. */
export type Proof =
  | {
      readonly _tag: 'Proved'
      readonly goal: ConformanceGoal
      readonly selection: Selection
      readonly typeArguments: ReadonlyArray<Type.GenericArgument>
      readonly requirements: ReadonlyArray<Proof>
    }
  | {
      readonly _tag: 'Unproved'
      readonly goal: ConformanceGoal
      readonly failure: Failure
      readonly trace: ReadonlyArray<ConformanceGoal>
    }

/** Constructs one concrete goal. */
export const make = (capability: Type.Nominal, provider: Type.Type): ConformanceGoal => ({
  _tag: 'ConformanceGoal' as const,
  capability,
  provider,
})

/** The canonical identity two occurrences of one question share. */
export const key = (self: ConformanceGoal): string =>
  Type.conformanceKey(self.capability, self.provider)

/** Renders one goal the way a diagnostic spells it. */
export const encode = (self: ConformanceGoal): string =>
  `${self.capability.name} for ${Type.encode(self.provider)}`

/** Renders one failure as the sentence a diagnostic reports. */
export const describe = (self: Failure): string => {
  switch (self._tag) {
    case 'MissingWitness':
      return 'no conformance declares this specialization'
    case 'AmbiguousWitness':
      return `${self.candidates} conformances declare this specialization`
    case 'UnavailableWitness':
      return self.reason
    case 'ActiveCycle':
      return 'the proof requires itself'
  }
}

/**
 * Renders the requirement chain that led to a failed goal, outermost first.
 *
 * The chain is the useful half of a failed proof: a missing base witness reported on its own says
 * only that some type lacks a conformance, while the chain says which wrapper asked for it.
 */
export const traceLines = (self: Proof): ReadonlyArray<string> => {
  if (self._tag !== 'Unproved') return []
  return [
    ...self.trace.map((goal, depth) =>
      depth === 0
        ? `required by ${encode(goal)}`
        : `${'  '.repeat(depth)}required by ${encode(goal)}`,
    ),
    `${'  '.repeat(self.trace.length)}${encode(self.goal)}: ${describe(self.failure)}`,
  ]
}
