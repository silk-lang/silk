import * as Lifetime from './Lifetime.js'
import * as AuthoredIdentity from './AuthoredIdentity.js'
import type * as CleanupPlan from './CleanupPlan.js'
import type * as DeclarationFacts from './DeclarationFacts.js'
import * as ExecutionAffinity from './ExecutionAffinity.js'
import * as Tir from './Tir.js'
import * as LocalSharedOwnership from './LocalSharedOwnership.js'
import * as Match from './Match.js'
import * as MovePath from './MovePath.js'
import type { BindingSite, ModuleOwnership, Verdict } from './Ownership.js'
import { referentKey } from './Ownership.js'
import type * as SourceSpan from './SourceSpan.js'
import * as Type from './Type.js'

const spanText = (span: SourceSpan.SourceSpan): string => `[${span.start}, ${span.end})`

const identityLabel = (declaration: DeclarationFacts.DeclarationFact): string => {
  switch (declaration.canonical._tag) {
    case 'Canonical':
      return `${declaration.canonical.id.module}.${declaration.canonical.id.name}`
    case 'Duplicate':
      return `duplicate:${declaration.canonical.original.module}.${declaration.canonical.original.name}#${declaration.id.ordinal}`
    case 'Unidentified':
      return `unidentified#${declaration.id.ordinal}`
  }
}

const verdictText = (verdict: Verdict): string => {
  switch (verdict._tag) {
    case 'Satisfied':
      return 'satisfied'
    case 'Violation':
      return 'violation'
    case 'Unavailable':
      return 'unavailable'
  }
}

const siteText = (site: BindingSite): string => {
  if (site._tag === 'Parameter') {
    return `p${site.parameter.ordinal}`
  }
  if (site._tag === 'Let') {
    return `b${site.binding.ordinal}`
  }
  if (site._tag === 'Pattern') {
    return `l${site.binding.ordinal}`
  }
  return `t${Tir.nodeRefKey(site.owner.node)}`
}

const cleanupText = (cleanup: CleanupPlan.CleanupPlan): string => {
  if (cleanup._tag === 'NoCleanup') return `none:${Type.encode(cleanup.type)}`
  if (cleanup._tag === 'ParameterCleanup') return `parameter:${Type.key(cleanup.type)}`
  if (cleanup._tag === 'AllocationCleanup')
    return `allocation:${Type.encode(cleanup.type)} ticket=${cleanup.ticket}`
  if (cleanup._tag === 'RawBufferCleanup')
    return `raw-buffer:${Type.encode(cleanup.type)} owner=(${cleanupText(cleanup.allocation)})`
  if (cleanup._tag === 'LocalSharedCoreCleanup')
    return `local-shared-core:${Type.encode(cleanup.type)} opaque-last(payload-helper=${Type.encode(cleanup.element)},allocation=${cleanupText(cleanup.allocation)})`
  if (cleanup._tag === 'ExecutionCleanup')
    return `execution:${Type.encode(cleanup.type)} metadata=package-owned allocation=${cleanupText(cleanup.allocation)}`
  if (cleanup._tag === 'WakeCleanup')
    return `wake:${Type.encode(cleanup.type)} authority=generation allocation=${cleanupText(cleanup.allocation)}`
  if (cleanup._tag === 'ArrayCleanup') {
    return `array:${Type.encode(cleanup.type)} length=${cleanup.length} element=(${cleanupText(cleanup.element)})`
  }
  if (cleanup._tag === 'UnionCleanup') {
    return `union:${Type.encode(cleanup.type)} cases=${cleanup.cases
      .map(
        (member) =>
          `${member.ordinal}:${Type.encode(member.member)}(${cleanupText(member.cleanup)})`,
      )
      .join(',')}`
  }
  if (cleanup._tag === 'NominalUnionCleanup') {
    return `nominal-union:${Type.encode(cleanup.type)} variants=${cleanup.variants
      .map(
        (variant) =>
          `${variant.ordinal}:${variant.variant.name}(${variant.fields
            .map((field) => `#${field.field.ordinal}(${cleanupText(field.cleanup)})`)
            .join(',')})`,
      )
      .join(',')}`
  }
  if (cleanup._tag === 'CallableCleanup') {
    const environment =
      cleanup.environment._tag === 'CallableEnvironmentSite'
        ? Tir.executableSiteLabel(cleanup.environment.site)
        : Type.callableEnvironmentKey(cleanup.environment.identity)
    return `callable:${Type.encode(cleanup.type)} environment=${environment} slots=${cleanup.slots.map((slot) => `#${slot.ordinal}(${cleanupText(slot.cleanup)})`).join(',') || 'none'}`
  }
  if (cleanup._tag === 'EffectCleanup') {
    return `effect:${Type.encode(cleanup.type)} site=${Tir.executableSiteLabel(cleanup.site)} slots=${cleanup.slots.map((slot) => `#${slot.ordinal}(${cleanupText(slot.cleanup)})`).join(',') || 'none'}`
  }
  if (cleanup._tag === 'EffectCompositeCleanup') {
    return `effect-composite:${Type.encode(cleanup.type)} alternatives=${cleanup.alternatives.map((alternative, ordinal) => `${ordinal}(${cleanupText(alternative)})`).join(',')}`
  }
  if (cleanup._tag === 'RepresentedCallableCleanup') {
    return `represented-callable:${Type.encode(cleanup.contract)}`
  }
  if (cleanup._tag === 'RepresentedEffectCleanup') {
    return `represented-effect:${Type.encode(cleanup.contract)}`
  }
  if (cleanup._tag === 'HookCleanup') {
    return `hook:${Type.encode(cleanup.type)} target=${cleanup.hook.module}.${cleanup.hook.name}${
      cleanup.typeArguments.length === 0
        ? ''
        : `<${cleanup.typeArguments.map(Type.encodeGenericArgument).join(',')}>`
    } inner=(${cleanupText(cleanup.inner)})`
  }
  return `struct:${Type.encode(cleanup.type)} fields=${cleanup.fields
    .map((field) => `#${field.field.ordinal}(${cleanupText(field.cleanup)})`)
    .join(',')}`
}

/**
 * Deterministic textual encoding of one module's ownership facts and cleanup plans for
 * debugging, inspection, and golden tests. No compatibility promise attaches to this format.
 */
export const encode = (self: ModuleOwnership): string =>
  [
    `ownership-module ${self.module}`,
    ...self.functions.flatMap((fn) => [
      `fn ${identityLabel(fn.declaration)} ${verdictText(fn.verdict)}`,
      ...fn.bindings.map((binding) => {
        let category: string
        if (binding.category._tag === 'Copyable') {
          category = 'copyable'
        } else if (binding.category._tag === 'Unavailable') {
          category = 'unavailable'
        } else {
          category = `move-only ${Type.encode(binding.category.type)}`
        }
        return `  binding ${siteText(binding.site)} ${binding.name ?? '?'} ${category} affinity=${ExecutionAffinity.encode(binding.executionAffinity)} obligations=${LocalSharedOwnership.encode(binding.localSharedObligations)} live ${spanText(binding.liveFrom)}..${spanText(binding.liveTo)}${binding.movedAt === undefined ? '' : ` moved ${spanText(binding.movedAt)}`}`
      }),
      ...fn.loans.map((loan) => {
        let origin = 'array'
        if (loan.origin === 'SliceReborrow') {
          const parent = loan.parent === undefined ? '?' : siteText(loan.parent)
          origin = `reborrow parent=${parent} suspended=${loan.suspendsParent}`
        } else if (loan.origin === 'ReturnedView') origin = 'returned-view'
        return `  loan l${loan.id.ordinal} ${loan.access.toLowerCase()} ${siteText(loan.root)} referents=${loan.referents.map(referentKey).join(',')} ${origin} region=${loan.startRegion.ordinal}->${loan.endRegion.ordinal} ${spanText(loan.startSpan)}..${spanText(loan.endSpan)}`
      }),
      ...fn.invocations.map(
        (invocation) =>
          `  invocation ${AuthoredIdentity.anchorKey(invocation.obligation.origin)} binder=${Lifetime.key(invocation.obligation.binder)} region=${Lifetime.key(invocation.obligation.lifetime)} result=${Tir.nodeRefKey(invocation.result)} retained=${invocation.retained} inputs=${invocation.inputs.map((input) => `p${input.parameter}:${Tir.nodeRefKey(input.argument)}:${input.transfer.toLowerCase()}${input.capture === undefined ? '' : ` capture=#${input.capture.ordinal}:${Tir.nodeRefKey(input.capture.callee)}${input.capture.path === undefined ? '' : ` via=${input.capture.path.map((step) => `${step._tag.toLowerCase()}@${Tir.executableSiteLabel(step.site)}${step._tag === 'Capture' ? `.#${step.ordinal}` : ''}`).join('/')}`}`}:${Type.encode(input.type)}:${input.conditionalContents ? 'conditional' : 'concrete'}:referents=${input.referents.map(referentKey).join(',') || 'none'}`).join(';')} end=${invocation.end.region.ordinal}:${spanText(invocation.end.span)} cleanup=${invocation.end.cleanupOnly}`,
      ),
      ...fn.replacements.map(
        (replacement) =>
          `  replace region=${replacement.region.ordinal} type=${Type.encode(replacement.type)} cleanup=${cleanupText(replacement.cleanup)} ${spanText(replacement.span)}`,
      ),
      ...fn.callables.map(
        (callable) =>
          `  callable ${Tir.executableSiteLabel(callable.site)} ${callable.mode.toLowerCase()} affinity=${ExecutionAffinity.encode(callable.executionAffinity)} obligations=${LocalSharedOwnership.encode(callable.localSharedObligations)} slots=${callable.slots.map((slot) => `#${slot.ordinal}:p${slot.parameterOrdinal}:${slot.access.toLowerCase()}:${slot.type === undefined ? '?' : Type.encode(slot.type)}:${ExecutionAffinity.encode(slot.executionAffinity)}:${LocalSharedOwnership.encode(slot.localSharedObligations)}:${cleanupText(slot.cleanup)}`).join(',') || 'none'} retained=${callable.retainedDependencies.join(',') || 'none'} drop=${callable.dropOrder.map((ordinal) => `#${ordinal}`).join(',') || 'none'}`,
      ),
      ...fn.transitions.map(
        (transition) =>
          `  ${transition.kind.toLowerCase()} ${siteText(transition.root)}${transition.path.length === 0 ? '' : `/${MovePath.key(transition.path)}`} ${spanText(transition.span)} ${MovePath.encodeState(transition.before)} -> ${MovePath.encodeState(transition.after)}`,
      ),
      ...fn.exits.map((exit) => {
        let label: string
        switch (exit.kind) {
          case 'Return':
            label = 'return'
            break
          case 'ScopeEnd':
            label = 'scope-end'
            break
          case 'ArmEnd':
            label = `arm-end ${exit.arm === 'Otherwise' ? 'otherwise' : 'taken'}`
            break
          case 'LoopFallthrough':
            label = `loop${exit.target?.ordinal ?? '?'} fallthrough`
            break
          case 'Break':
            label = `break loop${exit.target?.ordinal ?? '?'}`
            break
          case 'Continue':
            label = `continue loop${exit.target?.ordinal ?? '?'}`
            break
          case 'Propagation':
            label = 'propagation'
            break
        }
        const loanEnds = exit.loanEnds.map((loan) => `l${loan.ordinal}`).join(',') || 'none'
        if (
          exit.releases.length === 0 &&
          exit.temporaries.length === 0 &&
          exit.matches.length === 0
        ) {
          return `  exit ${label} ${spanText(exit.span)} loan-ends ${loanEnds} releases none`
        }
        return [
          `  exit ${label} ${spanText(exit.span)} loan-ends ${loanEnds}`,
          ...exit.releases.map(
            (release) =>
              `    release ${siteText(release.binding.site)} initialization=${MovePath.encodeState(release.initialization)}${release.fields.length === 0 ? '' : ` fields ${release.fields.map((field) => `#${field.ordinal}`).join(',')}`}${release.cleanup._tag === 'ArrayCleanup' || release.cleanup._tag === 'CallableCleanup' ? ` cleanup ${cleanupText(release.cleanup)}` : ''}`,
          ),
          ...exit.temporaries.map(
            (temporary) =>
              `    temporary #${temporary.ordinal} ${spanText(temporary.span)} cleanup ${cleanupText(temporary.cleanup)}`,
          ),
          ...exit.matches.flatMap((match) =>
            match.cleanup.map(
              (field) =>
                `    match-payload #${match.ordinal} ${Tir.nodeRefKey(match.id.node)} arm=${match.arm.ordinal} path=${field.path.map((part) => `#${part.ordinal}`).join('.') || 'payload'} cleanup ${cleanupText(field.cleanup)}`,
            ),
          ),
        ].join('\n')
      }),
      ...fn.fixedPoints.map(
        (point) =>
          `  loop${point.loop.ordinal} fixed-point ${point.compatible ? 'compatible' : 'incompatible'} iterations=${point.iterations} incoming=${point.incoming.map(siteText).join(',') || 'none'} repeating=${point.repeating.map((state) => `[${state.map(siteText).join(',')}]`).join(',') || 'none'} following=${point.following.map(siteText).join(',') || 'none'}`,
      ),
      ...fn.matches.map((match) =>
        [
          `  match ${match.access.toLowerCase()} ${spanText(match.span)}`,
          ...match.arms.map((arm) => {
            let member = 'unknown'
            if (arm.universal) member = '_'
            else if (arm.member !== undefined) member = Match.encodeIdentity(arm.member)
            return `    arm #${arm.id.ordinal} ${member} guard=${arm.provisionalGuard} bindings=${arm.bindings.map(siteText).join(',') || 'none'} cleanup=${arm.cleanup.map((entry) => `${entry.path.map((field) => `#${field.ordinal}`).join('.') || 'payload'}(${cleanupText(entry.cleanup)})`).join(',') || 'none'}`
          }),
        ].join('\n'),
      ),
    ]),
    '',
  ].join('\n')
