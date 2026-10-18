import * as Effect from 'effect/Effect'
import type * as CompilationProfile from './CompilationProfile.js'
import * as ConfigurationError from './ConfigurationError.js'
import * as ConfigurationOrigin from './ConfigurationOrigin.js'
import * as NativeLinkInput from './NativeLinkInput.js'
import * as NativeRequirement from './NativeRequirement.js'
import * as Canonical from './internal/Canonical.js'

/** An explicit alternative for one logical requirement, with already materialized ordered inputs. */
export interface NativeRequirementBinding {
  readonly kind: NativeRequirement.Kind
  readonly name: string
  readonly alternative: string
  readonly inputs: ReadonlyArray<NativeLinkInput.NativeLinkInput>
  readonly origin: ConfigurationOrigin.ConfigurationOrigin
}

/** Active physical inputs and their selected logical alternatives, preserving build order. */
export interface Resolved {
  readonly inputs: ReadonlyArray<NativeLinkInput.NativeLinkInput>
  readonly choices: ReadonlyArray<{
    readonly kind: NativeRequirement.Kind
    readonly name: string
    readonly alternative: string
  }>
  readonly identity: string
}

const admittedInputs = (
  requirement: NativeRequirement.Merged,
  binding: NativeRequirementBinding,
): boolean => {
  const payloads = binding.inputs.filter((input) => input._tag !== 'SearchPath')
  if (payloads.length === 0) return false
  if (requirement.kind === 'library')
    return payloads.every((input) =>
      input._tag === 'Library'
        ? requirement.linkage === undefined || input.mode.toLowerCase() === requirement.linkage
        : input._tag === 'StaticArchive' && requirement.linkage !== 'dynamic',
    )
  if (requirement.kind === 'framework') return payloads.every((input) => input._tag === 'Framework')
  if (requirement.kind === 'prebuilt-archive')
    return payloads.every((input) => input._tag === 'StaticArchive')
  if (requirement.kind === 'linker-script')
    return payloads.every((input) => input._tag === 'LinkerScript')
  return payloads.every((input) => input._tag === 'Object')
}

/** Resolves only active requirements; final images/modules require every logical supply explicitly. */
export const resolve = Effect.fn('NativeRequirementBinding.resolve')(function* (
  requirements: ReadonlyArray<NativeRequirement.Merged>,
  bindings: ReadonlyArray<NativeRequirementBinding>,
  form: CompilationProfile.Artifact,
): Effect.fn.Return<Resolved, ConfigurationError.ConfigurationError> {
  const needsLink = form === 'executable' || form === 'loadable-module'
  const required = new Map(
    requirements.map((requirement) => [NativeRequirement.key(requirement), requirement]),
  )
  const seen = new Set<string>()
  const conflicts: Array<ConfigurationOrigin.ConfigurationOrigin> = []
  const subjects: Array<string> = []
  const inputs: Array<NativeLinkInput.NativeLinkInput> = []
  const choices: Array<{
    readonly kind: NativeRequirement.Kind
    readonly name: string
    readonly alternative: string
  }> = []
  for (const binding of bindings) {
    const identity = NativeRequirement.key(binding)
    const requirement = required.get(identity)
    if (requirement === undefined) continue
    if (
      seen.has(identity) ||
      !NativeRequirement.isIdentity(binding.alternative) ||
      (requirement.alternatives !== undefined &&
        !requirement.alternatives.includes(binding.alternative)) ||
      !admittedInputs(requirement, binding)
    ) {
      conflicts.push(
        ...requirement.contributions.map((entry) => entry.origin),
        ...bindings
          .filter((entry) => NativeRequirement.key(entry) === identity)
          .map((entry) => entry.origin),
      )
      subjects.push(identity)
      continue
    }
    seen.add(identity)
    choices.push({ kind: binding.kind, name: binding.name, alternative: binding.alternative })
    // Archives and relocatable objects preserve unresolved link dependencies in their plan. Only
    // object/archive payloads can become members of these forms; source names never trigger search.
    if (
      needsLink ||
      binding.kind === 'startup-object' ||
      binding.kind === 'prebuilt-object' ||
      binding.kind === 'prebuilt-archive'
    )
      inputs.push(...binding.inputs.map((input) => ({ ...input })))
  }
  for (const [identity, requirement] of required) {
    if (needsLink && !seen.has(identity) && !subjects.includes(identity)) {
      conflicts.push(...requirement.contributions.map((entry) => entry.origin))
      subjects.push(identity)
    }
  }
  if (subjects.length > 0)
    return yield* ConfigurationError.make(
      'NativeRequirementBinding.resolve',
      'ConflictingBindings',
      'missing or inadmissible explicit native supplies',
      conflicts,
      [...new Set(subjects)].sort(Canonical.compare),
    )
  return {
    inputs: inputs,
    choices: choices,
    identity: Canonical.record(
      'NativeRequirementBindings.v1',
      choices.map((choice) =>
        Canonical.record(NativeRequirement.key(choice), [choice.alternative]),
      ),
    ),
  }
})
