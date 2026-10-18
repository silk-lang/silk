import type * as ArtifactPlan from './ArtifactPlan.js'
import * as NativeRequirement from './NativeRequirement.js'
import * as DeclarationFacts from './DeclarationFacts.js'
import * as SemanticContext from './SemanticContext.js'
import type * as DeclarationIndex from './DeclarationIndex.js'
/**
 * Module, name, ownership, lowering and backend phases as rows.
 *
 * The split from `project-syntax` is by phase rather than by size: these are the phases that can
 * be *absent* — a target that did not resolve leaves no MIR, a program that did not elaborate
 * leaves no backend output. Each projection here states that absence as a row rather than
 * returning nothing, which is what keeps a broken pipeline readable.
 */

import type * as Backend from './Backend.js'
import type * as CleanupPlan from './CleanupPlan.js'
import type { RowModel, Span } from './InspectorRow.js'
import { spanOf as asSpan } from './InspectorRow.js'
import type * as Instances from './Instances.js'
import type * as Layout from './Layout.js'
import * as Match from './Match.js'
import * as Mir from './Mir.js'
import * as MirVerification from './MirVerification.js'
import type * as ModuleClosure from './ModuleClosure.js'
import type * as NameResolution from './NameResolution.js'
import type * as Ownership from './Ownership.js'
import * as Type from './Type.js'
import * as Tir from './Tir.js'
import * as BodyView from './BodyView.js'

const typeText = (type: Type.Type): string => Type.encode(type)

const callingScalarText = (scalar: Layout.CallingScalar): string =>
  typeof scalar === 'string' ? scalar : `Address<${Type.encode(scalar.element)},i${scalar.bits}>`

export const closureRows = (
  closure: ModuleClosure.Closure,
  spans: SemanticContext.Registry,
): ReadonlyArray<RowModel> => {
  const rows: Array<RowModel> = []

  for (const module of closure.modules) {
    const isRoot = module.name === closure.rootModule
    const spanOfModule = spans.spanOf({
      _tag: 'AuthoredAnchor',
      owner: module.authored.module.owner,
      path: [],
    })
    const span = asSpan(spanOfModule)
    rows.push({
      key: `mod-${module.name}`,
      dot: isRoot ? 'symbol' : 'node',
      label: module.name,
      detail: `${isRoot ? 'root · ' : ''}${module.declarations.length} declaration${
        module.declarations.length === 1 ? '' : 's'
      }`,
      span,
      head: true,
      ...(isRoot ? { tone: 'symbol' as const } : {}),
    })
    rows.push({
      key: `mod-${module.name}-imports`,
      depth: 1,
      label: 'imports',
      detail:
        module.imports.length === 0
          ? 'none'
          : module.imports
              .map((entry) => entry.canonicalTarget ?? entry.sourceSpelling ?? 'unavailable')
              .join(', '),
    })
  }

  rows.push({
    key: 'closure-summary',
    label: 'closure',
    detail: `${closure.modules.length} module${closure.modules.length === 1 ? '' : 's'} · ${
      closure.cycles.length
    } cycle${closure.cycles.length === 1 ? '' : 's'}${closure.cycles.length === 0 ? ' · acyclic' : ''}`,
    head: true,
    ...(closure.cycles.length === 0 ? {} : { tone: 'warning' as const }),
  })

  for (const [index, cycle] of closure.cycles.entries()) {
    rows.push({
      key: `cycle-${index}`,
      depth: 1,
      dot: 'warning',
      label: 'cycle',
      detail: cycle.join(' → '),
      tone: 'warning',
    })
  }

  return rows
}

const declaredTypeText = (fact: DeclarationFacts.DeclaredTypeFact): string => {
  switch (fact._tag) {
    case 'Resolved':
      return typeText(fact.type)
    case 'Unresolved':
      return fact.spelling
    default:
      return 'unavailable'
  }
}

const memberSignature = (member: DeclarationFacts.MemberFact): string => {
  if (member._tag === 'RoleDeclaration')
    return `${member.visibility === 'Public' ? 'pub ' : ''}role`
  const parameters =
    member.typeParameters.length === 0
      ? ''
      : `<${member.typeParameters.map((parameter) => typeText(parameter.type)).join(', ')}>`
  if (member._tag === 'StructDeclaration')
    return `struct${parameters} · ${member.fields.length} field${member.fields.length === 1 ? '' : 's'}`
  if (member._tag === 'UnionDeclaration')
    return `union${parameters} · ${member.variants.length} variant${member.variants.length === 1 ? '' : 's'}`
  if (member._tag === 'EnumDeclaration') {
    const representation =
      member.representation._tag === 'Available'
        ? member.representation.scalar.spelling
        : (member.representation.spelling ?? 'unavailable')
    return `enum(${representation}) · ${member.members.length} member${member.members.length === 1 ? '' : 's'} · ${member.validity._tag.toLowerCase()}`
  }
  if (member._tag === 'ConstantDeclaration' || member._tag === 'PackageParameterDeclaration')
    return `${member.visibility === 'Public' ? 'pub ' : ''}${member._tag === 'PackageParameterDeclaration' ? 'param' : 'const'} · ${declaredTypeText(member.declaredType)}`
  if (member._tag === 'ForeignStaticDeclaration')
    return `${member.direction === 'Import' ? 'extern' : 'export'} static · ${declaredTypeText(member.declaredType)} · ${member.foreign.symbol}`
  if (member._tag === 'AliasDeclaration')
    return `${member.visibility === 'Public' ? 'pub ' : ''}type · ${declaredTypeText(member.target)}`
  if (member._tag === 'ServiceDeclaration' || member._tag === 'InterfaceDeclaration')
    return `${member.visibility === 'Public' ? 'pub ' : ''}${member._tag === 'ServiceDeclaration' ? 'service' : 'interface'}${parameters} · ${member.operations.length} operation${member.operations.length === 1 ? '' : 's'}`
  const values = member.parameters
    .map(
      (parameter) =>
        `${parameter.name._tag === 'Present' ? parameter.name.spelling : '∅'}: ${declaredTypeText(
          parameter.declaredType,
        )}`,
    )
    .join(', ')
  const failures =
    member.functionKind === 'Effect'
      ? ` ! ${member.failureRow.failures.map(typeText).join(' | ') || 'empty'}`
      : ''
  return `${member.visibility === 'Public' ? 'pub ' : ''}${member.test ? 'test ' : ''}${member.functionKind === 'Effect' ? 'effect ' : ''}fn${parameters} · (${values}) -> ${declaredTypeText(
    member.returnType,
  )}${failures}`
}

const memberName = (member: DeclarationFacts.MemberFact): string =>
  member.name._tag === 'Present' ? member.name.spelling : 'unavailable name'

const declaredName = (name: DeclarationFacts.DeclaredName): string =>
  name._tag === 'Present' ? name.spelling : 'unavailable name'

const conformanceLabel = (conformance: DeclarationFacts.ConformanceFact): string => {
  const parameters =
    conformance.typeParameters.length === 0
      ? ''
      : `<${conformance.typeParameters.map((parameter) => declaredName(parameter.name)).join(', ')}>`
  return `impl${parameters} ${declaredTypeText(conformance.capability)} for ${declaredTypeText(conformance.provider)}`
}

export const indexRows = (
  index: DeclarationIndex.Index,
  spans: SemanticContext.Registry,
): ReadonlyArray<RowModel> => {
  const rows: Array<RowModel> = []

  for (const module of index.modules) {
    // A name collision is recorded on the declaration itself, as a non-canonical identity —
    // there is no separate conflict list to read.
    const duplicates = module.members.filter(
      (member) => member.canonical._tag === 'Duplicate',
    ).length
    rows.push({
      key: `idx-${module.module}`,
      label: module.module,
      detail: `${module.members.length} declaration${
        module.members.length === 1 ? '' : 's'
      } · ${module.conformances.length} conformance${
        module.conformances.length === 1 ? '' : 's'
      } · ${duplicates} conflict${duplicates === 1 ? '' : 's'}`,
      head: true,
      ...(duplicates === 0 ? {} : { tone: 'warning' as const }),
    })

    for (const member of module.members) {
      const span = asSpan(spans.spanOf(member.anchor))
      const duplicate = member.canonical._tag === 'Duplicate'
      rows.push({
        key: `idx-${module.module}-${member.id.ordinal}`,
        depth: 1,
        ...(duplicate ? { dot: 'warning' as const, tone: 'warning' as const } : {}),
        label: memberName(member),
        detail: `${memberSignature(member)}${duplicate ? ' · duplicate' : ''}`,
        span,
      })
      if (member._tag === 'EnumDeclaration')
        for (const enumMember of member.members) {
          const memberSpan = asSpan(spans.spanOf(enumMember.anchor))
          rows.push({
            key: `idx-${module.module}-${member.id.ordinal}-enum-member-${enumMember.id.ordinal}`,
            depth: 2,
            label: declaredName(enumMember.name),
            detail:
              enumMember.discriminant._tag === 'Available'
                ? `discriminant ${enumMember.discriminant.value}`
                : 'unavailable discriminant',
            span: memberSpan,
          })
        }
    }

    for (const conformance of module.conformances) {
      const span = asSpan(spans.spanOf(conformance.anchor))
      rows.push({
        key: `idx-${module.module}-conformance-${conformance.ordinal}`,
        depth: 1,
        dot: 'symbol',
        label: conformanceLabel(conformance),
        detail: `${conformance.operations.length} operation${
          conformance.operations.length === 1 ? '' : 's'
        }${conformance.hook === undefined ? '' : ' · drop hook'}`,
        span,
      })
      for (const [ordinal, operation] of conformance.operations.entries()) {
        const operationSpan = asSpan(spans.spanOf(operation.anchor))
        rows.push({
          key: `idx-${module.module}-conformance-${conformance.ordinal}-operation-${ordinal}`,
          depth: 2,
          label: declaredName(operation.name),
          detail:
            operation.target._tag === 'Unavailable'
              ? 'unavailable target'
              : operation.target.spelling,
          span: operationSpan,
        })
      }
      if (conformance.hook !== undefined) {
        const hookSpan = asSpan(spans.spanOf(conformance.hook.anchor))
        rows.push({
          key: `idx-${module.module}-conformance-${conformance.ordinal}-drop-hook`,
          depth: 2,
          label: declaredName(conformance.hook.name),
          detail: `${conformance.hook.functionKind.toLowerCase()} drop hook · ${declaredTypeText(conformance.hook.parameterType)}`,
          span: hookSpan,
        })
      }
    }
  }

  return rows
}

const bindingDetail = (binding: NameResolution.Binding): string => {
  switch (binding._tag) {
    case 'LocalDeclaration':
      return `LocalDeclaration · ${binding.declaration.module}.${binding.declaration.name}`
    case 'IntrinsicActor':
      return 'IntrinsicActor · language intrinsic'
    case 'ModuleNamespace':
      return `ModuleNamespace · ${binding.module}`
    case 'ImportedMember':
      return `ImportedMember · ${binding.declaration.module}.${binding.declaration.name}`
    case 'Unavailable':
      return 'Unavailable · unresolved'
  }
}

const bindingSpan = (
  binding: NameResolution.Binding,
  spans: SemanticContext.Registry,
): Span | undefined => {
  if (binding._tag === 'ModuleNamespace') return asSpan(spans.spanOf(binding.anchor))
  if (binding._tag === 'ImportedMember') return asSpan(spans.spanOf(binding.localAnchor))
  if (binding._tag === 'Unavailable') return asSpan(spans.spanOf(binding.anchor))
  return undefined
}

export const resolutionRows = (
  resolution: NameResolution.Resolution,
  spans: SemanticContext.Registry,
): ReadonlyArray<RowModel> => {
  const rows: Array<RowModel> = []

  for (const scope of resolution.modules) {
    rows.push({
      key: `res-${scope.module}`,
      label: scope.module,
      detail: `${scope.bindings.length} binding${scope.bindings.length === 1 ? '' : 's'} · ${
        scope.conflicts.length
      } conflict${scope.conflicts.length === 1 ? '' : 's'}`,
      head: true,
      ...(scope.conflicts.length === 0 ? {} : { tone: 'warning' as const }),
    })

    for (const [ordinal, binding] of scope.bindings.entries()) {
      const span = bindingSpan(binding, spans)
      rows.push({
        key: `res-${scope.module}-${ordinal}`,
        depth: 1,
        label: binding.spelling,
        detail: bindingDetail(binding),
        ...(span === undefined ? {} : { span }),
        ...(binding._tag === 'Unavailable'
          ? { tone: 'warning' as const, dot: 'warning' as const }
          : {}),
      })
    }

    for (const [ordinal, outcome] of scope.imports.entries()) {
      const unavailable = outcome._tag === 'Unavailable'
      const span = asSpan(
        spans.spanOf({
          _tag: 'AuthoredAnchor',
          owner: outcome.import.declaration.owner,
          path: [],
        }),
      )
      let detail = 'unavailable'
      if (!unavailable) {
        detail = `${outcome.bindings.length} binding${outcome.bindings.length === 1 ? '' : 's'}`
      }
      rows.push({
        key: `res-${scope.module}-import-${ordinal}`,
        depth: 1,
        dot: unavailable ? 'warning' : undefined,
        label: `import ${outcome.import.canonicalTarget ?? outcome.import.sourceSpelling ?? '∅'}`,
        detail,
        span,
        ...(unavailable ? { tone: 'warning' as const } : {}),
      })
    }
  }

  return rows
}

const bindingSiteText = (fact: Ownership.BindingFact): string => {
  switch (fact.site._tag) {
    case 'Parameter':
      return `parameter #${fact.site.parameter.ordinal}`
    case 'Temporary':
      return `temporary n${fact.site.owner.node.node.ordinal}`
    case 'Let':
    case 'Pattern':
      return `let b${fact.site.binding.ordinal}`
  }
}

const loanSiteText = (site: Ownership.BindingSite): string => {
  switch (site._tag) {
    case 'Parameter':
      return `parameter #${site.parameter.ordinal}`
    case 'Let':
      return `let b${site.binding.ordinal}`
    case 'Pattern':
      return `pattern b${site.binding.ordinal}`
    case 'Temporary':
      return `temporary n${site.owner.node.node.ordinal}`
  }
}

const cleanupText = (cleanup: CleanupPlan.CleanupPlan): string => {
  switch (cleanup._tag) {
    case 'NoCleanup':
      return 'no cleanup'
    case 'ParameterCleanup':
      return `${typeText(cleanup.type)} · symbolic cleanup`
    case 'AllocationCleanup':
      return `${typeText(cleanup.type)} · active reclaim ticket`
    case 'RawBufferCleanup':
      return `${typeText(cleanup.type)} · ${cleanupText(cleanup.allocation)}`
    case 'LocalSharedCoreCleanup':
      return `${typeText(cleanup.type)} · opaque decrement or last ${typeText(cleanup.element)} cleanup`
    case 'ExecutionCleanup':
      return `${typeText(cleanup.type)} · opaque package cleanup · ${cleanupText(cleanup.allocation)}`
    case 'ExecutionRefCleanup':
      return `${typeText(cleanup.type)} · package authority release · ${cleanupText(cleanup.allocation)}`
    case 'HookCleanup':
      return `${typeText(cleanup.type)} · drop hook ${cleanup.hook.module}.${cleanup.hook.name} · ${cleanupText(cleanup.inner)}`
    case 'StructCleanup':
      return `${typeText(cleanup.type)} ${cleanup.fields
        .map(({ field }) => `#${field.ordinal}`)
        .join(' → ')}`
    case 'NominalUnionCleanup':
      return `${typeText(cleanup.type)} active variant · ${cleanup.variants
        .map((variant) => `${variant.ordinal}:${variant.variant.name}`)
        .join(', ')}`
    case 'ArrayCleanup':
      return `${typeText(cleanup.type)} elements in reverse order · ${cleanupText(cleanup.element)}`
    case 'UnionCleanup':
      return `${typeText(cleanup.type)} active case · ${cleanup.cases
        .map((member) => `${member.ordinal}:${typeText(member.member)}`)
        .join(', ')}`
    case 'CallableCleanup':
      return `${typeText(cleanup.type)} captures ${cleanup.slots
        .map(({ ordinal, cleanup: slot }) => `#${ordinal}:${cleanupText(slot)}`)
        .join(' → ')}`
    case 'RepresentedEffectCleanup':
      return `${typeText(cleanup.type)} stored ${typeText(cleanup.contract)} · lanes resolved at the complete instance`
    case 'EffectCleanup':
      return `${typeText(cleanup.type)} captures ${cleanup.slots
        .map(({ ordinal, cleanup: slot }) => `#${ordinal}:${cleanupText(slot)}`)
        .join(' → ')}`
    case 'EffectCompositeCleanup':
      return `${typeText(cleanup.type)} selected Effect alternative · ${cleanup.alternatives
        .map((alternative, ordinal) => `${ordinal}:${cleanupText(alternative)}`)
        .join(', ')}`
    case 'RepresentedCallableCleanup':
      return `${typeText(cleanup.type)} stored ${typeText(cleanup.contract)} · lanes resolved at the complete instance`
  }
}

export const ownershipRows = (
  facts: Ownership.ModuleOwnership,
  spans: SemanticContext.Registry,
): ReadonlyArray<RowModel> => {
  const rows: Array<RowModel> = []

  for (const fn of facts.functions) {
    const span = asSpan(spans.spanOf(fn.declaration.anchor))
    const moves = fn.bindings.filter((binding) => binding.movedAt !== undefined).length
    const cleanups = fn.exits.reduce((total, exit) => total + exit.releases.length, 0)
    rows.push({
      key: `own-${fn.declaration.id.ordinal}`,
      label: memberName(fn.declaration),
      detail: `${fn.bindings.length} binding${fn.bindings.length === 1 ? '' : 's'} · ${moves} move${
        moves === 1 ? '' : 's'
      } · ${cleanups} cleanup${cleanups === 1 ? '' : 's'} · ${fn.verdict._tag}`,
      span,
      head: true,
      ...(fn.verdict._tag === 'Satisfied' ? {} : { tone: 'warning' as const }),
    })

    for (const [ordinal, binding] of fn.bindings.entries()) {
      const bindSpan = asSpan(binding.liveFrom)
      rows.push({
        key: `own-${fn.declaration.id.ordinal}-b${ordinal}`,
        depth: 1,
        label: binding.name ?? '∅',
        detail: `${bindingSiteText(binding)} · ${binding.mutability.toLowerCase()} · ${binding.category._tag.toLowerCase()} · live [${binding.liveFrom.start}, ${binding.liveTo.end})${binding.movedAt === undefined ? '' : ' · moved'}`,
        span: bindSpan,
      })
    }

    for (const [ordinal, exit] of fn.exits.entries()) {
      const exitSpan = asSpan(exit.span)
      rows.push({
        key: `own-${fn.declaration.id.ordinal}-exit${ordinal}`,
        depth: 1,
        label: `exit ${exit.kind.toLowerCase()}`,
        detail: `${
          exit.loanEnds.length === 0
            ? 'no loan endings'
            : `end ${exit.loanEnds.map((loan) => `#${loan.ordinal}`).join(', ')}`
        } · ${
          exit.releases.length === 0
            ? 'no releases'
            : exit.releases
                .map(
                  (release) => `${release.binding.name ?? '∅'} (${cleanupText(release.cleanup)})`,
                )
                .join(', ')
        }`,
        span: exitSpan,
      })
    }

    for (const loan of fn.loans) {
      const loanSpan = asSpan(loan.startSpan)
      rows.push({
        key: `own-${fn.declaration.id.ordinal}-loan-${loan.id.call.node.ordinal}-${loan.id.ordinal}`,
        depth: 1,
        dot: 'symbol',
        tone: 'symbol',
        label: `loan #${loan.id.ordinal} · ${loan.access.toLowerCase()}`,
        detail: `${loanSiteText(loan.root)} · ${loan.origin}${loan.parent === undefined ? '' : ` · parent ${loanSiteText(loan.parent)} suspended`} · r${loan.startRegion.ordinal} → r${loan.endRegion.ordinal}`,
        span: loanSpan,
      })
    }

    for (const callable of fn.callables) {
      const callableSpan = asSpan(callable.span)
      rows.push({
        key: `own-${fn.declaration.id.ordinal}-callable-${callable.site.node.node.ordinal}`,
        depth: 1,
        dot: 'symbol',
        tone: 'symbol',
        label: `callable · ${callable.mode.toLowerCase()}`,
        detail: `${callable.slots.length} slot${callable.slots.length === 1 ? '' : 's'} · retained ${callable.retainedDependencies.join(', ') || 'none'} · drop ${callable.dropOrder.map((ordinal) => `#${ordinal}`).join(' → ') || 'none'}`,
        span: callableSpan,
      })
      for (const slot of callable.slots) {
        rows.push({
          key: `own-${fn.declaration.id.ordinal}-callable-${callable.site.node.node.ordinal}-slot${slot.ordinal}`,
          depth: 2,
          label: `slot #${slot.ordinal} → parameter #${slot.parameterOrdinal}`,
          detail: `${slot.access.toLowerCase()} · ${slot.type === undefined ? 'unavailable type' : typeText(slot.type)} · ${cleanupText(slot.cleanup)}`,
          span: callableSpan,
        })
      }
    }

    for (const replacement of fn.replacements) {
      const replacementSpan = asSpan(replacement.span)
      rows.push({
        key: `own-${fn.declaration.id.ordinal}-replacement-${replacement.span.start}`,
        depth: 1,
        label: 'replace live value',
        detail: `${typeText(replacement.type)} · ${cleanupText(replacement.cleanup)} · r${replacement.region.ordinal}`,
        span: replacementSpan,
      })
    }

    for (const point of fn.fixedPoints) {
      const loopSpan = asSpan(point.span)
      rows.push({
        key: `own-${fn.declaration.id.ordinal}-loop${point.loop.ordinal}`,
        depth: 1,
        dot: point.compatible ? 'ok' : 'warning',
        label: `loop${point.loop.ordinal} fixed point`,
        detail: `${point.compatible ? 'compatible' : 'incompatible'} · ${point.iterations} step${point.iterations === 1 ? '' : 's'} · ${point.repeating.length} repeating path${point.repeating.length === 1 ? '' : 's'}`,
        span: loopSpan,
        ...(point.compatible ? {} : { tone: 'warning' as const }),
      })
    }

    for (const match of fn.matches) {
      const matchSpan = asSpan(match.span)
      rows.push({
        key: `own-${fn.declaration.id.ordinal}-match-${match.span.start}`,
        depth: 1,
        dot: 'symbol',
        label: `match ${match.access.toLowerCase()}`,
        detail: `${match.arms.length} arm${match.arms.length === 1 ? '' : 's'} · arm-local lifetime`,
        span: matchSpan,
      })
      for (const arm of match.arms) {
        const cleanup = arm.cleanup
          .map((entry) => entry.path.map((field) => `#${field.ordinal}`).join('.') || 'payload')
          .join(', ')
        let selection = 'unknown'
        if (arm.universal) selection = '_'
        else if (arm.member !== undefined) selection = Match.encodeIdentity(arm.member)
        rows.push({
          key: `own-${fn.declaration.id.ordinal}-match-${match.span.start}-arm${arm.id.ordinal}`,
          depth: 2,
          label: `arm #${arm.id.ordinal} ${selection}`,
          detail: `${arm.provisionalGuard ? 'provisional guard' : 'direct selection'} · ${arm.bindings.length} binding${arm.bindings.length === 1 ? '' : 's'} · cleanup ${cleanup || 'none'}`,
          span: matchSpan,
        })
      }
    }
  }

  return rows
}

export const instanceRows = (
  discovery: Instances.Discovery,
  spans: SemanticContext.Registry,
): ReadonlyArray<RowModel> => {
  const rows: Array<RowModel> = [
    {
      key: 'roots',
      label: 'artifact roots',
      detail: `${discovery.foreignExports.length} exports · ${discovery.retention.length} retained declarations`,
      head: true,
    },
    {
      key: 'reachable',
      label: 'reachable',
      detail: `${discovery.instances.length} instance${discovery.instances.length === 1 ? '' : 's'}`,
      head: true,
    },
  ]

  for (const [ordinal, instance] of discovery.instances.entries()) {
    const span = asSpan(spans.spanOf(instance.function.declaration.anchor))
    rows.push({
      key: `inst-${ordinal}`,
      depth: 1,
      dot: 'symbol',
      label: `${instance.key.declaration.module}.${instance.key.declaration.name}${
        instance.key.typeArguments.length === 0
          ? ''
          : `<${instance.key.typeArguments.map(Type.encodeGenericArgument).join(', ')}>`
      }`,
      detail: `${instance.substitution.size} substitution${instance.substitution.size === 1 ? '' : 's'} · instantiated once`,
      span,
    })
  }

  for (const [ordinal, callable] of discovery.callables.entries()) {
    const owner = discovery.instances.find(
      (instance) =>
        Tir.artifactKey(instance.view.artifact) === Tir.artifactKey(callable.site.node.artifact),
    )
    const node = owner === undefined ? undefined : BodyView.node(owner.view, callable.site.node)
    rows.push({
      key: `callable-instance-${ordinal}`,
      depth: 1,
      dot: 'symbol',
      tone: 'symbol',
      label: `callable ${callable.target._tag === 'DeclarationCallableTarget' ? callable.target.declaration.name : `${callable.target.actor}.${callable.target.operation}`}`,
      detail: `${typeText(callable.type)} · ${callable.mode.toLowerCase()} · ${callable.captures.map((capture) => `#${capture.ordinal}:${capture.access.toLowerCase()} ${typeText(capture.type)}`).join(', ') || 'no captures'}`,
      ...(node === undefined ? {} : { span: asSpan(node.span) }),
    })
  }

  for (const [ordinal, violation] of discovery.violations.entries()) {
    const caller = discovery.instances.find((instance) => instance.key === violation.caller)
    const span =
      caller === undefined ? undefined : asSpan(spans.spanOf(caller.function.declaration.anchor))
    rows.push({
      key: `inst-violation-${ordinal}`,
      depth: 1,
      dot: 'warning',
      tone: 'warning',
      label: 'polymorphic recursion',
      detail: `${violation.target.declaration.name}<${violation.target.typeArguments.map(Type.encodeGenericArgument).join(', ')}> changes an ancestor specialization`,
      ...(span === undefined ? {} : { span }),
    })
  }

  return rows
}

export const layoutRows = (
  catalog: Layout.Catalog | undefined,
  plan: Layout.Plan | undefined,
  unavailable: string | undefined,
): ReadonlyArray<RowModel> => {
  if (plan === undefined && catalog === undefined) {
    return [
      {
        key: 'layout-unavailable',
        dot: 'warning',
        label: 'layout unavailable',
        detail: unavailable ?? 'the target did not resolve',
        tone: 'warning',
      },
    ]
  }

  const rows: Array<RowModel> = []

  if (plan !== undefined) {
    rows.push({
      key: 'plan',
      label: 'reachable runtime layout',
      detail: `${plan.entries.length} entr${plan.entries.length === 1 ? 'y' : 'ies'}`,
      head: true,
    })
    for (const entry of plan.entries) {
      let representationText: string
      switch (entry.representation._tag) {
        case 'Aggregate':
          representationText = 'aggregate'
          break
        case 'CallableEnvironment':
          representationText = `stored callable · ${entry.representation.fields.length} capture${entry.representation.fields.length === 1 ? '' : 's'}`
          break
        case 'StoredEffectEnvironment':
          representationText = `stored Effect · ${entry.representation.fields.length} capture${entry.representation.fields.length === 1 ? '' : 's'}`
          break
        case 'Repeated':
          representationText = `${entry.representation.length} × ${typeText(entry.representation.element)} · stride ${entry.representation.stride}`
          break
        case 'Slice':
          representationText = `address i${entry.representation.address.bits} + length i32 · stride ${entry.representation.stride}`
          break
        case 'String':
          representationText = `UTF-8 address i${entry.representation.storage.bits} + byte length i${entry.representation.byteLength.size * 8}`
          break
        case 'Union':
          representationText = `sum · tag i${entry.representation.tag.bits} · payload +${entry.representation.payloadOffset}/${entry.representation.payloadSize}`
          break
        case 'NominalUnion':
          representationText = `nominal union · ${entry.representation.variants.length} variants · tag i${entry.representation.tag.bits} · payload +${entry.representation.payloadOffset}/${entry.representation.payloadSize}`
          break
        case 'Reference':
          representationText = `reference · address i${entry.representation.address.bits}`
          break
        case 'SignedInteger':
        case 'UnsignedInteger':
        case 'ScalarEnum':
        case 'Floating':
        case 'Boolean':
          representationText = `i${entry.representation.bits}`
          break
      }
      rows.push({
        key: `plan-${typeText(entry.type)}`,
        depth: 1,
        label: typeText(entry.type),
        detail: `${entry.size} bytes · align ${entry.alignment} · ${representationText}`,
      })
    }
    for (const [ordinal, environment] of plan.callableEnvironments.entries()) {
      const available = environment._tag === 'CallableEnvironment'
      rows.push({
        key: `plan-callable-${ordinal}`,
        depth: 1,
        dot: available ? 'symbol' : 'warning',
        ...(available ? { tone: 'symbol' as const } : { tone: 'warning' as const }),
        label: `callable environment · ${environment.callable.mode.toLowerCase()}`,
        detail: available
          ? `${environment.size} bytes · align ${environment.alignment} · ${environment.fields.map((field) => `#${field.ordinal}@${field.offset} ${field.representation.toLowerCase()}`).join(', ') || 'empty'} · view ${environment.view.pointerBits}-bit`
          : `unavailable · ${environment.reason}`,
      })
    }
    if (plan.literalVerdicts.length > 0) {
      rows.push({
        key: 'plan-word-literals',
        depth: 1,
        label: 'target word literal verdicts',
        detail: `${plan.literalVerdicts.length} target-checked`,
        head: true,
      })
      for (const [ordinal, verdict] of plan.literalVerdicts.entries()) {
        const available = verdict._tag === 'AvailableWordLiteral'
        rows.push({
          key: `plan-word-literal-${ordinal}`,
          depth: 2,
          dot: available ? 'symbol' : 'warning',
          ...(available ? {} : { tone: 'warning' as const }),
          label: `${verdict.type} ${verdict.value.toString()}`,
          detail: `${verdict.bits}-bit · ${available ? 'available' : 'out of range'}`,
          span: asSpan(verdict.span),
        })
      }
    }
  }

  if (catalog !== undefined) {
    rows.push({
      key: 'catalog',
      label: 'nominal catalog',
      detail: `${catalog.entries.length} declaration${catalog.entries.length === 1 ? '' : 's'}`,
      head: true,
    })
    for (const entry of catalog.entries) {
      const unavailableEntry = entry._tag === 'UnavailableLayoutEntry'
      rows.push({
        key: `catalog-${typeText(entry.type)}`,
        depth: 1,
        ...(unavailableEntry ? { dot: 'warning' as const, tone: 'warning' as const } : {}),
        label: typeText(entry.type),
        detail: unavailableEntry
          ? 'unavailable'
          : `${entry.size} bytes · align ${entry.alignment} · ${entry.representation._tag.toLowerCase()}`,
      })
    }
  }

  return rows
}

const localText = (local: Mir.LocalId): string => `_${local.ordinal}`

const placeText = (root: Mir.LocalId, selectors: ReadonlyArray<Mir.PlaceSelector>): string =>
  `${localText(root)}${selectors
    .map((selector) => {
      switch (selector._tag) {
        case 'FieldSelector':
          return `.#${selector.field.ordinal}`
        case 'VariantSelector':
          return `.variant#${selector.ordinal}`
        case 'SliceElementSelector':
          return `[${localText(selector.index)} · ${selector.access.toLowerCase()} slice]`
        case 'ElementSelector': {
          const index =
            selector.index._tag === 'Proven'
              ? selector.index.value
              : localText(selector.index.local)
          return `[${index}/${selector.length}]`
        }
        default:
          return ''
      }
    })
    .join('')}`

const operationLabel = (operation: Mir.Operation): string => {
  switch (operation._tag) {
    case 'DiagnosticUnhandled':
      return `${localText(operation.destination)} = observe unhandled failure`
    case 'NativeAssembly':
      return `${localText(operation.destination)} = assembly ${operation.assembly.constraints} · ${operation.assembly.memory}${operation.assembly.noReturn ? ' · no return' : ''}`
    case 'SetInitialized':
      return `${localText(operation.flag)} = initialized ${operation.initialized}`
    case 'ForeignStaticLoad':
      return `${localText(operation.destination)} = foreign static ${operation.symbol}`
    case 'ForeignFunctionAddress':
      return `${localText(operation.destination)} = foreign address ${operation.symbol}`
    case 'Literal':
      return `${localText(operation.destination)} = const ${operation.value}`
    case 'EnumConstant':
      return `${localText(operation.destination)} = enum ${operation.enum.name}.${operation.member.name} · ${operation.discriminant}`
    case 'EnumValue':
      return `${localText(operation.destination)} = enum value ${localText(operation.source)} → ${operation.representation.scalar}`
    case 'EnumEquality':
      return `${localText(operation.destination)} = enum ${operation.negated ? 'not equals' : 'equals'} ${localText(operation.left)}, ${localText(operation.right)} · ${operation.enum.name}`
    case 'StaticView':
      return `${localText(operation.destination)} = static ${operation.data} · ${operation.length} bytes`
    case 'StaticString':
      return `${localText(operation.destination)} = static string ${operation.data} · ${operation.byteLength} bytes`
    case 'StringFromUtf8Unchecked':
      return `${localText(operation.destination)} = string from UTF-8 ${localText(operation.bytes)} · unsafe`
    case 'StringUtf8Bytes':
      return `${localText(operation.destination)} = UTF-8 bytes ${localText(operation.string)}`
    case 'StringByteLength':
      return `${localText(operation.destination)} = byte length ${localText(operation.string)}`
    case 'StringEqualsExact':
      return `${localText(operation.destination)} = exact string ${operation.negated ? 'not equals' : 'equals'} ${localText(operation.left)}, ${localText(operation.right)}`
    case 'UnpackEffectComposite':
      return `${localText(operation.destination)}, ${localText(operation.matched)} = effect choice #${operation.alternative} ${localText(operation.source)}`
    case 'PackEffectComposite':
      return `${localText(operation.destination)} = effect choice #${operation.alternative} ${localText(operation.source)}`
    case 'Binary':
      return `${localText(operation.destination)} = ${operation.operator.toLowerCase()} ${localText(
        operation.left,
      )}, ${localText(operation.right)}`
    case 'ConvertInteger':
      return `${localText(operation.destination)} = convert ${localText(operation.source)} → ${operation.type._tag}`
    case 'ConvertScalar':
      return `${localText(operation.destination)} = convert ${localText(operation.source)} → ${operation.type._tag}`
    case 'ReinterpretScalar':
      return `${localText(operation.destination)} = reinterpret ${localText(operation.source)} → ${operation.type._tag}`
    case 'FloatUnary':
      return `${localText(operation.destination)} = ${operation.operation.toLowerCase()} ${localText(operation.source)}`
    case 'FloatTranscendental':
      return `${localText(operation.destination)} = ${operation.operation.toLowerCase()} ${localText(operation.source)}`
    case 'CheckedScalar':
      return `${localText(operation.destination)} = ${operation.operation.toLowerCase()} ${operation.operands.map(localText).join(', ')}`
    case 'ValidateLayout':
      return `${localText(operation.destination)} = layout ${localText(operation.bytes)} bytes · align ${localText(operation.alignment)}`
    case 'RepeatLayout':
      return `${localText(operation.destination)} = repeat ${localText(operation.layout)} × ${localText(operation.count)}`
    case 'Allocate':
      return `${localText(operation.destination)} = allocate ${localText(operation.layout)}`
    case 'Move':
      return `${localText(operation.destination)} = move ${localText(operation.source)}`
    case 'BeginLoan':
      return `${localText(operation.destination)} = ${operation.reborrow ? 'reborrow' : 'borrow'} ${operation.access.toLowerCase()} ${localText(operation.root)} · loan #${operation.borrow.ordinal}`
    case 'EndLoan':
      return `end loan #${operation.borrow.ordinal} ${localText(operation.slice)}`
    case 'SliceLength':
      return `${localText(operation.destination)} = length ${localText(operation.slice)}`
    case 'ConvertUnion':
      return `${localText(operation.destination)} = ${operation.conversion.toLowerCase()} ${localText(operation.source)} → ${typeText(operation.targetType.type)}`
    case 'Call':
      return `${localText(operation.destination)} = call ${operation.target.name}(${operation.arguments
        .map(localText)
        .join(', ')})`
    case 'MakeEffect':
      return `${localText(operation.destination)} = effect ${operation.runner.name} captures ${operation.captures.map((capture) => `${capture.access.toLowerCase()} ${localText(capture.source)}`).join(', ') || 'none'}`
    case 'MakeCallable':
      return `${localText(operation.destination)} = callable ${operation.target._tag === 'DeclarationCallableTarget' ? operation.target.declaration.name : `${operation.target.actor}.${operation.target.operation}`} captures ${operation.captures.map((capture) => `${capture.access.toLowerCase()} ${localText(capture.source)}`).join(', ') || 'none'}`
    case 'ApplyCallable':
      return `${localText(operation.destination)} = apply ${operation.callable === undefined ? 'erased section' : localText(operation.callable)}(${operation.arguments.map(localText).join(', ')}) · ${operation.access.toLowerCase()}`
    case 'PackEffectOutcome':
      return `${localText(operation.destination)} = effect outcome tag ${operation.tag} payload ${localText(operation.source)}`
    case 'PackEffectFailureUnion':
      return `${localText(operation.destination)} = effect failure union ${localText(operation.source)} · ${operation.mappings.map((mapping) => `${mapping.source}→${mapping.target}`).join(', ')}`
    case 'PropagateEffectFailure':
      return `propagate effect failure ${localText(operation.source)} · ${operation.tagMappings.map((mapping) => `${mapping.source}→${mapping.target}`).join(', ')}`
    case 'UnpackEffectSuccess':
      return `${localText(operation.destination)} = effect success ${localText(operation.source)}`
    case 'RunEffect':
      return `${localText(operation.destination)} = run ${operation.target.name} · propagate ${operation.tagMappings.map((mapping) => `${mapping.source}→${mapping.target}`).join(', ') || 'none'}`
    case 'RunEffectValue':
      return `${localText(operation.destination)} = run ${localText(operation.effect)} with ${operation.runner.name}`
    case 'RunEffectComposite':
      return `${localText(operation.destination)} = run effect choice ${localText(operation.effect)}`
    case 'RunStaticEffect':
      return `${localText(operation.destination)} = run static ${operation.runner.name} with ${operation.captures.map((capture) => localText(capture.source)).join(', ') || 'no captures'}`
    case 'CatchEffect':
      return `${localText(operation.destination)} = result ${localText(operation.effect)} with ${operation.runner.name}`
    case 'Construct':
      return `${localText(operation.destination)} = construct ${typeText(operation.type.type)} { ${operation.fields
        .map(({ field, value }) => `#${field.ordinal}: ${localText(value)}`)
        .join(', ')} }`
    case 'ConstructUnionVariant':
      return `${localText(operation.destination)} = construct ${typeText(operation.type.type)}.${operation.variant.name}#${operation.variantOrdinal} { ${operation.fields
        .map(({ field, value }) => `${DeclarationFacts.fieldIdKey(field)}: ${localText(value)}`)
        .join(', ')} }`
    case 'ConstructArray':
      return `${localText(operation.destination)} = array [${operation.elements
        .map(localText)
        .join(', ')}]`
    case 'Project':
      return `${localText(operation.destination)} = project ${localText(operation.source)}.#${operation.field.ordinal}`
    case 'ReadPlace':
      return `${localText(operation.destination)} = read ${placeText(operation.root, operation.selectors)}`
    case 'CheckPlace':
      return `check ${placeText(operation.root, operation.selectors)}`
    case 'WritePlace':
      return `write ${placeText(operation.root, operation.selectors)} = ${localText(operation.source)}`
    case 'Drop':
      return `drop ${localText(operation.local)}`
    case 'Match':
      return `${operation.destination === undefined ? 'never' : localText(operation.destination)} = match ${operation.access.toLowerCase()} ${localText(operation.scrutinee)}`
    case 'DiagnosticScope':
      return `${localText(operation.destination)} = observe ${localText(operation.state)} with ${localText(operation.observer)}`
    case 'Conditional':
      return `${localText(operation.destination)} = if ${localText(operation.condition)}`
    case 'ShortCircuit':
      return `${localText(operation.destination)} = ${operation.operator === 'And' ? '&&' : '||'} ${localText(operation.left)}`
    case 'ForeignIndirectCall':
      return `${localText(operation.destination)} = indirect extern C ${localText(operation.callee)}(${operation.arguments.map(localText).join(', ')})`
    case 'ForeignCall':
      return `${localText(operation.destination)} = extern "C" ${operation.symbol}(${operation.arguments.map(localText).join(', ')})`
    case 'SharedFromAllocation':
      return `${localText(operation.destination)} = shared core from ${localText(operation.allocation)} with ${localText(operation.value)}`
    case 'ExecutionFromAllocation':
      return `${localText(operation.destination)} = execution from ${localText(operation.allocation)} with ${localText(operation.body)}`
    case 'ExecutionDrive':
      return `${localText(operation.destination)} = drive ${localText(operation.execution)} with ${localText(operation.branch)}`
    case 'ExecutionRelinquish':
      return `${localText(operation.destination)} = relinquish`
    case 'ExecutionCurrent':
      return `${localText(operation.destination)} = current execution`
    case 'ExecutionRefOf':
      return `${localText(operation.destination)} = execution ref of ${localText(operation.execution)}`
    case 'ExecutionLoad':
      return `${localText(operation.destination)} = load control ${localText(operation.reference)}[${localText(operation.word)}]`
    case 'ExecutionStore':
      return `${localText(operation.destination)} = store control ${localText(operation.reference)}[${localText(operation.word)}] = ${localText(operation.value)}`
    case 'ExecutionNotify':
      return `${localText(operation.destination)} = notify ${localText(operation.reference)}`
    case 'ExecutionLive':
      return `${localText(operation.destination)} = live ${localText(operation.reference)}`
    case 'SharedClone':
      return `${localText(operation.destination)} = clone shared core ${localText(operation.self)}`
    case 'SharedWithMut':
      return `${localText(operation.destination)} = access shared core ${localText(operation.self)} with ${localText(operation.use)} or ${localText(operation.onConflict)}`
    case 'RawBufferFrom':
      return `${localText(operation.destination)} = raw buffer from ${localText(operation.allocation)} × ${localText(operation.count)} · stride ${operation.stride}`
    case 'RawBufferCount':
      return `${localText(operation.destination)} = count ${localText(operation.buffer)}`
    case 'RawBufferSlot':
      return `${localText(operation.destination)} = slot ${localText(operation.buffer)}[${localText(operation.index)}]`
    case 'RawBufferRead':
      return `${localText(operation.destination)} = read ${localText(operation.buffer)}[${localText(operation.index)}]`
    case 'SliceView':
      return `${localText(operation.destination)} = shared view ${localText(operation.slice)}[${localText(operation.offset)}..+${localText(operation.length)}]`
    case 'RawBufferView':
      return `${localText(operation.destination)} = ${operation.access.toLowerCase()} view ${localText(operation.buffer)}[${localText(operation.offset)}..+${localText(operation.length)}]`
    case 'RawBufferCopy':
      return `${localText(operation.destination)} = copy ${localText(operation.source)} into ${localText(operation.buffer)}[${localText(operation.offset)}..+${localText(operation.length)}]`
    case 'RawBufferFill':
      return `${localText(operation.destination)} = fill ${localText(operation.buffer)}[${localText(operation.offset)}..+${localText(operation.length)}] = ${localText(operation.value)}`
    case 'PointerNull':
      return `${localText(operation.destination)} = null pointer`
    case 'PointerIsNull':
      return `${localText(operation.destination)} = is null ${localText(operation.pointer)}`
    case 'PointerAddress':
      return `${localText(operation.destination)} = address of ${localText(operation.pointer)}`
    case 'PointerBytes':
    case 'PointerReinterpret':
    case 'PointerRequalify':
    case 'PointerFromStorage':
      return `${localText(operation.destination)} = pointer from ${localText(operation.source)}`
    case 'PointerAt':
      return `${localText(operation.destination)} = offset ${localText(operation.pointer)} by ${localText(operation.count)}`
    case 'PointerRead':
      return `${localText(operation.destination)} = read pointer ${localText(operation.pointer)}`
    case 'PointerWrite':
      return `${localText(operation.destination)} = write pointer ${localText(operation.pointer)} = ${localText(operation.value)}`
    case 'SlotWrite':
      return `${localText(operation.destination)} = write ${localText(operation.slot)} = ${localText(operation.value)}`
    case 'SlotTake':
      return `${localText(operation.destination)} = take ${localText(operation.slot)}`
    case 'SlotCopy':
      return `${localText(operation.destination)} = copy ${localText(operation.slot)}`
    case 'SlotDrop':
      return `${localText(operation.destination)} = drop in place ${localText(operation.slot)} · ${cleanupText(operation.cleanup)}`
  }
}

const outcomeLabel = (outcome: Mir.Outcome): string => {
  switch (outcome._tag) {
    case 'Return':
      return `return ${localText(outcome.value)}`
    case 'Forward':
      return `forward r${outcome.target.ordinal}`
    case 'Trap':
      return `trap "${outcome.reason}"`
    case 'Repeat':
      return `repeat loop${outcome.loop.ordinal}`
    case 'Exit':
      return `exit loop${outcome.loop.ordinal}`
    case 'Complete':
      return 'complete execution'
    case 'Yield':
      return 'yield condition'
  }
}

const regionOperations = (region: Mir.Region): ReadonlyArray<Mir.Operation> => {
  switch (region._tag) {
    case 'OperationRegion':
      return region.operations
    case 'CleanupRegion':
      return region.releases
    case 'ConditionalRegion':
    case 'LoopRegion':
      return []
  }
}

const regionDetail = (region: Mir.Region): string => {
  const owner = region.ownerLoop === undefined ? '' : ` · owner loop${region.ownerLoop.ordinal}`
  switch (region._tag) {
    case 'OperationRegion':
      return `operations${owner}`
    case 'CleanupRegion':
      return `cleanup${owner}`
    case 'ConditionalRegion':
      return `if ${localText(region.condition)} · r${region.taken.ordinal} / r${region.otherwise.ordinal}${owner}`
    case 'LoopRegion':
      return `loop${region.loop.ordinal} · condition r${region.condition.ordinal} · body r${region.body.ordinal} · following r${region.following.ordinal}${owner}`
  }
}

export const mirRows = (module: Mir.Module): ReadonlyArray<RowModel> => {
  const rows: Array<RowModel> = []

  for (const fn of module.functions) {
    // The module and concrete instance are both identity: different modules may declare the same
    // function name, while one declaration may lower more than one specialization or contract row.
    const instance =
      fn.instance.typeArguments.length === 0
        ? ''
        : `<${fn.instance.typeArguments.map(Type.encodeGenericArgument).join(', ')}>`
    const fnKey = `mir-${JSON.stringify([
      fn.instance.declaration.module,
      fn.instance.declaration.name,
      fn.instance.typeArguments.map(Type.genericArgumentKey),
      fn.instance.contractRow,
    ])}`
    const operationCount = MirVerification.operations(fn).length
    rows.push({
      key: fnKey,
      dot: 'symbol',
      label: `${fn.id.name}${instance}`,
      detail: `fn · entry r${fn.entry.ordinal} · ${fn.regions.length} region${fn.regions.length === 1 ? '' : 's'} · ${operationCount} op${operationCount === 1 ? '' : 's'}`,
      head: true,
      tone: 'symbol',
    })

    for (const region of Mir.regionsTree(Mir.topologicalRegions(fn))) {
      rows.push({
        key: `${fnKey}-r${region.id.ordinal}`,
        depth: 1,
        label: `r${region.id.ordinal} · ${region._tag.replace('Region', '').toLowerCase()}`,
        detail: regionDetail(region),
      })

      for (const [ordinal, operation] of regionOperations(region).entries()) {
        const span = asSpan(operation.provenance.span)
        rows.push({
          key: `${fnKey}-r${region.id.ordinal}-${ordinal}`,
          depth: 2,
          label: operationLabel(operation),
          detail: operation.provenance.generated ? 'generated' : operation._tag.toLowerCase(),
          span,
        })
        if (operation._tag === 'Match') {
          for (const decision of operation.decisions) {
            rows.push({
              key: `${fnKey}-r${region.id.ordinal}-${ordinal}-decision-${Match.encodeIdentity(decision.member)}`,
              depth: 3,
              label: `decision ${Match.encodeIdentity(decision.member)}`,
              detail: decision.candidates
                .map((candidate) => `arm #${candidate.ordinal}`)
                .join(' → '),
            })
          }
          for (const arm of operation.arms) {
            const armSpan = asSpan(arm.provenance.span)
            let selection = 'unknown'
            if (arm.universal) selection = '_'
            else if (arm.member !== undefined) selection = Match.encodeIdentity(arm.member)
            rows.push({
              key: `${fnKey}-r${region.id.ordinal}-${ordinal}-arm${arm.id.ordinal}`,
              depth: 3,
              label: `arm #${arm.id.ordinal} ${selection}`,
              detail: `${arm.guard === undefined ? 'selected' : `guard ${arm.guard.execution.result === undefined ? 'never' : localText(arm.guard.execution.result)}`} · result ${arm.selected.execution.result === undefined ? 'never' : localText(arm.selected.execution.result)} → ${operation.destination === undefined ? 'never' : localText(operation.destination)} · cleanup ${arm.selected.cleanup.length}`,
              span: armSpan,
            })
            for (const binding of arm.bindings) {
              const bindingSpan = asSpan(binding.provenance.span)
              rows.push({
                key: `${fnKey}-r${region.id.ordinal}-${ordinal}-arm${arm.id.ordinal}-binding${binding.id.ordinal}`,
                depth: 4,
                label: `${localText(binding.destination)} = payload ${binding.path.map((field) => `#${field.ordinal}`).join('.')}`,
                detail: `${binding.access.toLowerCase()} · ${typeText(Mir.semanticType(binding.type))}`,
                span: bindingSpan,
              })
            }
          }
        }
      }

      if (region._tag === 'OperationRegion' || region._tag === 'CleanupRegion') {
        const span = asSpan(region.outcome.provenance.span)
        rows.push({
          key: `${fnKey}-r${region.id.ordinal}-outcome`,
          depth: 2,
          label: outcomeLabel(region.outcome),
          detail: 'outcome',
          span,
        })
      } else {
        const span = asSpan(region.provenance.span)
        let label: string
        if (region._tag === 'ConditionalRegion') {
          const following =
            region.following === undefined ? '' : ` · following r${region.following.ordinal}`
          label = `taken r${region.taken.ordinal} · otherwise r${region.otherwise.ordinal}${following}`
        } else {
          label = `condition r${region.condition.ordinal} · body r${region.body.ordinal} · following r${region.following.ordinal}`
        }
        rows.push({
          key: `${fnKey}-r${region.id.ordinal}-control`,
          depth: 2,
          label,
          detail: 'structural edges',
          span,
        })
      }
    }
  }

  return rows
}

/**
 * Emitted backend text, one row per line.
 *
 * IR is already line-oriented, so it keeps the lead column as a line number and puts the whole
 * line in the label — `white-space: pre` in the row grammar is what preserves its indentation.
 */
export const backendTextRows = (ir: string): ReadonlyArray<RowModel> =>
  ir.split('\n').map((line, index) => ({
    key: `ir-${index}`,
    lead: index + 1,
    label: line,
  }))

/** Backend-local jumps/branches with canonical region and source provenance kept visible. */
export const backendControlRows = (
  control: ReadonlyArray<Backend.ControlProvenance>,
): ReadonlyArray<RowModel> => [
  {
    key: 'backend-control',
    label: 'control conversion',
    detail: `${control.length} emitted construct${control.length === 1 ? '' : 's'}`,
    head: true,
  },
  ...control.map((entry, ordinal) => {
    const span = asSpan(entry.span)
    return {
      key: `backend-control-${entry.function.name}-${entry.region.ordinal}-${ordinal}`,
      depth: 1,
      label: `${entry.construct} · r${entry.region.ordinal}`,
      detail: `${entry.targets.map((target) => `r${target.ordinal}`).join(', ') || 'terminal'}${entry.loop === undefined ? '' : ` · loop${entry.loop.ordinal}`}`,
      span,
    }
  }),
]

export const symbolRows = (
  symbols: ReadonlyArray<{
    readonly symbol: string
    readonly declaration: { readonly module: string; readonly name: string }
  }>,
): ReadonlyArray<RowModel> =>
  symbols.map((entry) => ({
    key: `sym-${entry.symbol}`,
    dot: 'symbol',
    label: entry.symbol,
    detail: `${entry.declaration.module}.${entry.declaration.name}`,
    tone: 'symbol',
  }))

/**
 * Canonical struct-value facts: literals, projections, calling shapes.
 *
 * The literal's two orders are the point: the source wrote `{ right: 2, left: 1 }` but the
 * canonical struct order is `left, right`, and the compiler owns that reordering. Showing both
 * on one row pair is what makes the reordering inspectable rather than folklore.
 */
export const structValueRows = (
  index: DeclarationIndex.Index,
  literals: ReadonlyArray<Extract<Tir.Expression, { readonly _tag: 'Construct' }>>,
  projections: ReadonlyArray<Extract<Tir.Expression, { readonly _tag: 'Project' }>>,
  shapes: ReadonlyArray<Layout.CallingShape>,
): ReadonlyArray<RowModel> => {
  const rows: Array<RowModel> = []
  const fieldName = (nominal: Type.Nominal, field: DeclarationFacts.FieldId): string => {
    const declaration = DeclarationFacts.byCanonical(index, {
      _tag: 'CanonicalDeclarationId',
      module: nominal.module,
      name: nominal.name,
    })
    if (declaration?._tag !== 'StructDeclaration') return `#${field.ordinal}`
    const fact = declaration.fields.at(field.ordinal)
    return fact === undefined ? `#${field.ordinal}` : declaredName(fact.name)
  }

  rows.push({
    key: 'literals',
    label: 'struct construction',
    detail: literals.length === 0 ? 'no struct literals' : `${literals.length}`,
    head: true,
  })
  for (const literal of literals) {
    const span = asSpan(literal.span)
    const key = `lit-${span.start}-${span.end}`
    rows.push({
      key,
      depth: 1,
      dot: 'symbol',
      label: typeText(literal.nominal),
      detail: 'fields resolved',
      span,
    })
    rows.push({
      key: `${key}-source`,
      depth: 2,
      label: 'source order',
      detail:
        literal.evaluationOrder.map((field) => fieldName(literal.nominal, field)).join(', ') ||
        'empty',
    })
    rows.push({
      key: `${key}-canonical`,
      depth: 2,
      label: 'canonical order',
      detail:
        literal.fields.map(({ field }) => fieldName(literal.nominal, field)).join(', ') || 'empty',
    })
  }

  rows.push({
    key: 'projections',
    label: 'field projection chain',
    detail: projections.length === 0 ? 'none' : `${projections.length}`,
    head: true,
  })
  for (const projection of projections) {
    const span = asSpan(projection.span)
    rows.push({
      key: `proj-${span.start}-${span.end}`,
      depth: 1,
      label: `${typeText(projection.nominal)}.${fieldName(projection.nominal, projection.field)}`,
      detail: projection.access.toLowerCase(),
      span,
    })
  }

  rows.push({
    key: 'shapes',
    label: 'compiler-owned calling shapes',
    detail: shapes.length === 0 ? 'none reachable' : `${shapes.length}`,
    head: true,
  })
  for (const shape of shapes) {
    rows.push({
      key: `shape-${typeText(shape.type)}`,
      depth: 1,
      label: typeText(shape.type),
      detail:
        shape.lanes
          .map((lane) => `${callingScalarText(lane.type)}:${selectorPathText(lane.path)}`)
          .join(', ') || 'zero runtime lanes',
    })
  }

  return rows
}

const selectorPathText = (path: ReadonlyArray<Layout.Selector>): string =>
  path
    .map((selector) => {
      switch (selector._tag) {
        case 'ElementSelector':
          return `[${selector.index}]`
        case 'FieldId':
          return `#${selector.ordinal}`
        case 'UnionTagSelector':
          return 'tag'
        case 'UnionPayloadSelector':
          return `payload[${selector.slot}]`
        case 'NominalUnionTagSelector':
          return 'nominal-tag'
        case 'NominalUnionPayloadSelector':
          return `nominal-payload[${selector.slot}]`
        case 'SliceAddressSelector':
          return 'address'
        default:
          return 'length'
      }
    })
    .join('.')

/** Canonical array facts from syntax through backend-neutral ABI paths. */
export const arrayValueRows = (
  _spans: SemanticContext.Registry,
  types: ReadonlyArray<Type.FixedArray>,
  literals: ReadonlyArray<Extract<Tir.Expression, { readonly _tag: 'ArrayConstruct' }>>,
  projections: ReadonlyArray<
    Extract<Tir.Expression, { readonly _tag: 'IndexPlace' | 'SliceIndexPlace' }>
  >,
  layouts: ReadonlyArray<Layout.Entry>,
  shapes: ReadonlyArray<Layout.CallingShape>,
): ReadonlyArray<RowModel> => {
  const rows: Array<RowModel> = [
    {
      key: 'array-types',
      label: 'canonical array types',
      detail: types.length === 0 ? 'none' : `${types.length}`,
      head: true,
    },
    ...types.map((type, ordinal): RowModel => ({
      key: `array-type-${ordinal}`,
      depth: 1,
      dot: 'symbol',
      label: typeText(type),
      detail: `length ${type.length} · element ${typeText(type.element)}`,
      tone: 'symbol',
    })),
    {
      key: 'array-literals',
      label: 'literal elements',
      detail: literals.length === 0 ? 'none' : `${literals.length}`,
      head: true,
    },
  ]

  for (const [literalOrdinal, literal] of literals.entries()) {
    const span = asSpan(literal.span)
    const key = `array-literal-${literalOrdinal}`
    rows.push({
      key,
      depth: 1,
      dot: 'ok',
      label: typeText(literal.type),
      detail: `${literal.elements.length} element${literal.elements.length === 1 ? '' : 's'}`,
      span,
    })
    for (const [elementOrdinal, element] of literal.elements.entries()) {
      const elementSpan = asSpan(element.span)
      rows.push({
        key: `${key}-element-${elementOrdinal}`,
        depth: 2,
        label: `[${elementOrdinal}]`,
        detail: element._tag === 'Unavailable' ? 'unavailable' : typeText(element.type),
        span: elementSpan,
        ...(element._tag === 'Unavailable'
          ? { dot: 'warning' as const, tone: 'warning' as const }
          : {}),
      })
    }
  }

  rows.push({
    key: 'array-indexes',
    label: 'checked place chains',
    detail: projections.length === 0 ? 'none' : `${projections.length}`,
    head: true,
  })
  for (const [ordinal, projection] of projections.entries()) {
    const span = asSpan(projection.span)
    if (projection._tag === 'SliceIndexPlace') {
      rows.push({
        key: `array-index-${ordinal}`,
        depth: 1,
        dot: 'ok',
        label: `${typeText(projection.sourceType)}[index]`,
        detail: `${projection.access} · runtime slice check`,
        span,
      })
      continue
    }
    let boundsDetail = 'bounds unavailable'
    switch (projection.bounds._tag) {
      case 'Proven':
        boundsDetail = `proven ${projection.bounds.index}/${projection.bounds.length}`
        break
      case 'Runtime':
        boundsDetail = `runtime check < ${projection.bounds.length}`
        break
    }
    rows.push({
      key: `array-index-${ordinal}`,
      depth: 1,
      dot: 'ok',
      label: `${typeText(projection.array)}[index]`,
      detail: `${projection.access} · ${boundsDetail}`,
      span,
    })
  }

  rows.push({
    key: 'array-layouts',
    label: 'repeated layouts + calling paths',
    detail: `${layouts.length} layout${layouts.length === 1 ? '' : 's'} · ${shapes.length} shape${shapes.length === 1 ? '' : 's'}`,
    head: true,
  })
  for (const entry of layouts) {
    if (entry.representation._tag !== 'Repeated') continue
    rows.push({
      key: `array-layout-${typeText(entry.type)}`,
      depth: 1,
      label: typeText(entry.type),
      detail: `${entry.size} B · align ${entry.alignment} · stride ${entry.representation.stride}`,
    })
  }
  for (const shape of shapes) {
    rows.push({
      key: `array-shape-${typeText(shape.type)}`,
      depth: 1,
      label: `${typeText(shape.type)} lanes`,
      detail:
        shape.lanes
          .map((lane) => `${callingScalarText(lane.type)}:${selectorPathText(lane.path)}`)
          .join(', ') || 'zero runtime lanes',
    })
  }

  return rows
}

/**
 * The whole pipeline as one row per phase.
 *
 * Every other view answers "what did this phase produce"; this one answers "how far did the
 * program get". It is the only view that is about the pipeline rather than about a phase, which
 * is why it remains part of the static project inspector.
 */
export const pipelineRows = (
  phases: ReadonlyArray<{
    readonly phase: string
    readonly outputs: string
    readonly diagnostics: number
  }>,
): ReadonlyArray<RowModel> =>
  phases.map((entry) => ({
    key: `phase-${entry.phase}`,
    dot: entry.diagnostics === 0 ? 'ok' : 'error',
    label: entry.phase,
    detail: `${entry.outputs} · ${
      entry.diagnostics === 0 ? 'no diagnostics' : `${entry.diagnostics} diagnostics`
    }`,
    ...(entry.diagnostics === 0 ? {} : { tone: 'error' as const }),
  }))

/** 16 bytes per row, offset in the lead column — the shape a hex dump has always had. */
export const hexRows = (bytes: Uint8Array): ReadonlyArray<RowModel> => {
  const rows: Array<RowModel> = []
  for (let offset = 0; offset < bytes.length; offset += 16) {
    rows.push({
      key: `hex-${offset}`,
      lead: offset.toString(16).padStart(6, '0'),
      label: Array.from(bytes.slice(offset, offset + 16), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join(' '),
    })
  }
  return rows
}

export const toolchainRows = (
  commands: ReadonlyArray<readonly [string, string]>,
): ReadonlyArray<RowModel> => [
  {
    key: 'commands',
    label: 'planned commands',
    detail: String(commands.length),
    head: true,
  },
  ...commands.map(([name, text]) => ({
    key: `cmd-${name}`,
    depth: 1,
    label: name,
    detail: text,
  })),
  {
    key: 'scope',
    label: 'build scope',
    detail: 'owned intermediates',
    head: true,
  },
  {
    key: 'scope-1',
    depth: 1,
    label: '1',
    detail: 'scope opens: a named temporary directory owns every intermediate',
  },
  {
    key: 'scope-2',
    depth: 1,
    label: '2',
    detail: 'program.bc and program.o are written as path-backed scope artifacts',
  },
  {
    key: 'scope-3',
    depth: 1,
    label: '3',
    detail: 'only an explicit save-temps promotion copies an artifact out durably',
  },
  {
    key: 'scope-4',
    depth: 1,
    label: '4',
    detail: 'scope exit removes the directory after success or failure alike',
  },
]

/** Projects the logical artifact and every active requirement origin without physical path inference. */
export const artifactPlanRows = (
  plan: ArtifactPlan.ArtifactPlan | undefined,
): ReadonlyArray<RowModel> => {
  if (plan === undefined)
    return [{ key: 'artifact-plan', label: 'artifact plan', detail: 'unavailable' }]
  const rows: Array<RowModel> = [
    {
      key: 'artifact-plan',
      label: 'artifact plan',
      detail: `${plan.form} · ${plan.stage}`,
      head: true,
    },
    { key: 'artifact-identity', label: 'identity', detail: plan.identity, depth: 1 },
    {
      key: 'artifact-application',
      label: 'application',
      detail: plan.composition.application,
      depth: 1,
    },
    {
      key: 'artifact-runtime',
      label: 'runtime',
      detail: JSON.stringify({
        request: plan.composition.request,
        resolved: plan.composition.runtime,
      }),
      depth: 1,
    },
    {
      key: 'artifact-loader',
      label: 'loader entry',
      detail: JSON.stringify(plan.composition.loader),
      depth: 1,
    },
  ]
  for (const [index, root] of plan.roots.entries())
    rows.push({
      key: `artifact-root-${index}`,
      label: 'root',
      detail: `${root.declaration.module}.${root.declaration.name}`,
      depth: 1,
    })
  for (const [index, entry] of plan.exports.entries())
    rows.push({
      key: `artifact-export-${index}`,
      label: entry.symbol,
      detail: entry.signature,
      depth: 1,
    })
  for (const [index, requirement] of plan.requirements.entries()) {
    rows.push({
      key: `artifact-requirement-${index}`,
      label: `${requirement.kind} ${requirement.name}`,
      detail: NativeRequirement.encode(requirement),
      depth: 1,
    })
    for (const [ordinal, contribution] of requirement.contributions.entries())
      rows.push({
        key: `artifact-requirement-${index}-${ordinal}`,
        label: NativeRequirement.scopeKey(contribution.scope),
        detail: contribution.origin.source,
        depth: 2,
        ...(contribution.origin.span === undefined
          ? {}
          : { span: asSpan(contribution.origin.span) }),
      })
  }
  return rows
}
