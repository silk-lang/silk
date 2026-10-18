import * as Canonical from './internal/Canonical.js'

/** Domain behavior needed to normalize and compare one finite row. */
export interface Policy<Member> {
  /** The key at which union collisions are merged. */
  readonly collisionKey: (member: Member) => string
  /** The exact stored-member identity used by membership and subtraction. */
  readonly memberKey: (member: Member) => string
  /**
   * The identity removed by difference. Domains whose selectors are ordinary members may omit
   * this; domains such as service requirements can remove a key independently of stored metadata.
   */
  readonly differenceKey?: (member: Member) => string
  /** Combines two members with the same collision key. */
  readonly merge: (left: Member, right: Member) => Member
}

/** One immutable finite row in canonical collision-key order. */
export interface FiniteRow<Member> {
  readonly members: ReadonlyArray<Member>
}

const compareText = (left: string, right: string): number => {
  if (left < right) {
    return -1
  }
  if (left > right) {
    return 1
  }
  return 0
}

/** Constructs a canonical row, merging every collision through the supplied domain policy. */
export const make = <Member>(
  policy: Policy<Member>,
  members: Iterable<Member>,
): FiniteRow<Member> => {
  const normalized = new Map<string, Member>()
  for (const member of members) {
    const collisionKey = policy.collisionKey(member)
    const existing = normalized.get(collisionKey)
    normalized.set(collisionKey, existing === undefined ? member : policy.merge(existing, member))
  }
  return {
    members: [...normalized.values()].sort((left, right) =>
      compareText(policy.collisionKey(left), policy.collisionKey(right)),
    ),
  }
}

/** The empty row for a domain. */
export const empty = <Member>(): FiniteRow<Member> => ({ members: [] })

/** Canonical semantic identity of a finite row. */
export const key = <Member>(policy: Policy<Member>, self: FiniteRow<Member>): string =>
  Canonical.record('FiniteRow', [Canonical.array(self.members.map(policy.memberKey))])

/** Extensional equality under exact stored-member identity. */
export const equals = <Member>(
  policy: Policy<Member>,
  left: FiniteRow<Member>,
  right: FiniteRow<Member>,
): boolean => key(policy, left) === key(policy, right)

/** Pointwise row union, using the policy's collision merge. */
export const union = <Member>(
  policy: Policy<Member>,
  left: FiniteRow<Member>,
  right: FiniteRow<Member>,
): FiniteRow<Member> => make(policy, [...left.members, ...right.members])

/** Exact stored-member membership. */
export const has = <Member>(
  policy: Policy<Member>,
  self: FiniteRow<Member>,
  member: Member,
): boolean =>
  self.members.some((candidate) => policy.memberKey(candidate) === policy.memberKey(member))

/** Exact stored-row containment. */
export const isSubset = <Member>(
  policy: Policy<Member>,
  selected: FiniteRow<Member>,
  source: FiniteRow<Member>,
): boolean => selected.members.every((member) => has(policy, source, member))

/** Exact intersection. Collision-compatible but non-identical members do not intersect. */
export const intersection = <Member>(
  policy: Policy<Member>,
  left: FiniteRow<Member>,
  right: FiniteRow<Member>,
): FiniteRow<Member> =>
  make(
    policy,
    left.members.filter((member) => has(policy, right, member)),
  )

/** Total exact difference. Selecting an absent or merely collision-compatible member is a no-op. */
export const difference = <Member>(
  policy: Policy<Member>,
  source: FiniteRow<Member>,
  selected: FiniteRow<Member>,
): FiniteRow<Member> =>
  (() => {
    const differenceKey = policy.differenceKey ?? policy.memberKey
    const selectedKeys = new Set(selected.members.map(differenceKey))
    return make(
      policy,
      source.members.filter((member) => !selectedKeys.has(differenceKey(member))),
    )
  })()

/** Deterministic domain encoding in canonical row order. */
export const encode = <Member>(
  _policy: Policy<Member>,
  self: FiniteRow<Member>,
  encodeMember: (member: Member) => string,
  separator = ' | ',
): string => self.members.map(encodeMember).join(separator)
