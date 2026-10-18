import type * as FiniteRow from './FiniteRow.js'

/** Access stored by a service requirement row. */
export type Access = 'Shared' | 'Exclusive'

/** Access used by a provider-selection constraint. */
export type ProviderAccess = Access | 'Take'

/** Opaque canonical identity of one dependency role. */
export type Role = string

export const defaultRole: Role = 'DefaultRole'

export const declaredRole = (module: string, name: string): Role => `${module}::${name}`

export const roleKey = (role: Role): string => role

export const roleName = (role: Role): string => role.split('::').at(-1) ?? role

/** One requirement key plus the access demanded at that key. */
export interface Member<Capability> {
  readonly capability: Capability
  readonly role: Role
  readonly access: Access
}

/** Canonical identity of one service-role requirement independently from access. */
export const key = <Capability>(
  capabilityKey: (capability: Capability) => string,
  member: Pick<Member<Capability>, 'capability' | 'role'>,
): string => `${capabilityKey(member.capability)}@${roleKey(member.role)}`

/** Constructs the finite-row policy for a capability identity domain. */
export const policy = <Capability>(
  capabilityKey: (capability: Capability) => string,
): FiniteRow.Policy<Member<Capability>> => ({
  collisionKey: (member: Member<Capability>) => key(capabilityKey, member),
  memberKey: (member: Member<Capability>) =>
    `${capabilityKey(member.capability)}@${roleKey(member.role)}:${member.access}`,
  differenceKey: (member: Member<Capability>) => key(capabilityKey, member),
  merge: (left: Member<Capability>, right: Member<Capability>): Member<Capability> => ({
    capability: left.capability,
    role: left.role,
    access: left.access === 'Exclusive' || right.access === 'Exclusive' ? 'Exclusive' : 'Shared',
  }),
})

/** Whether a fixed provider mode may satisfy a stored requirement access. */
export const providerCanSelect = (providerAccess: ProviderAccess, storedAccess: Access): boolean =>
  providerAccess !== 'Shared' || storedAccess === 'Shared'
