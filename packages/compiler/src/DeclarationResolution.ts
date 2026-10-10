import * as Location from './Location.js'
import type * as ConformanceHead from './ConformanceHead.js'
import * as Constraint from './Constraint.js'
import type {
  BoundFact,
  CanonicalId,
  ConformanceFact,
  ConstraintFact,
  DeclarationFact,
  DeclaredTypeFact,
  FailureRowFact,
  FieldFact,
  InterfaceFact,
  InterfaceOperationApplicationFact,
  MemberFact,
  ModuleHeaders,
  OpaqueResultFact,
  ParameterFact,
  RequirementRoleFact,
  RequirementRowFact,
  ReturnTypeFact,
  RowExpressionDecision,
  ServiceFact,
  StructFact,
  TypeParameterFact,
  TypePathFact,
  TypeResolution,
  TypeResolver,
  UnionFact,
} from './DeclarationFacts.js'
import {
  copyApplication,
  executableLifetimes,
  interfaceApplication,
  lookupDeclaration,
  requirementRoleIdentity,
} from './DeclarationFacts.js'
import type { Index } from './DeclarationIndex.js'
import * as Lifetime from './Lifetime.js'
import * as Diagnostic from './Diagnostic.js'
import * as InterfaceWitnessCompatibility from './InterfaceWitnessCompatibility.js'
import * as InterfaceWitnessInference from './InterfaceWitnessInference.js'
import * as Graph from './internal/Graph.js'
import * as TypeInference from './internal/TypeInference.js'
import * as RequirementRow from './RequirementRow.js'
import * as ResolutionSeams from './ResolutionSeams.js'
import * as RowAlgebra from './RowAlgebra.js'
import type * as SourceSpan from './SourceSpan.js'
import * as Type from './Type.js'
import type * as AuthoredHir from './AuthoredHir.js'

/** Resolves one authored position to a current-revision span, for diagnostics only. */
export type SpanOf = (anchor: AuthoredHir.Anchor) => SourceSpan.SourceSpan
import * as TypeCompatibility from './TypeCompatibility.js'

const resolveExactRepresentation = (
  spanOf: SpanOf,
  module: string,
  fact: Extract<DeclaredTypeFact, { readonly _tag: 'ExactRepresentation' }>,
  resolvers: ResolutionSeams.ResolutionSeams,
  modules: ReadonlyArray<ModuleHeaders>,
): TypeResolution => {
  const arguments_ = fact.arguments.map((argument) =>
    resolveDeclaredType(spanOf, module, argument, resolvers, modules),
  )
  const argumentDiagnostics = arguments_.flatMap((argument) => argument.diagnostics)
  const reject = (diagnostic: Diagnostic.Located, candidate?: MemberFact): TypeResolution => {
    const canonical = candidate?.canonical._tag === 'Canonical' ? candidate.canonical.id : undefined
    return {
      fact: {
        ...fact,
        cause: Diagnostic.identity(diagnostic),
        ...(canonical === undefined ? {} : { itemCandidate: canonical }),
      },
      diagnostics: [...argumentDiagnostics, diagnostic],
    }
  }
  const unresolved = () =>
    Diagnostic.unresolvedExactRepresentationItem(fact.item.spelling, Location.at(fact.anchor))
  const open = (expected: number, actual = arguments_.length) =>
    Diagnostic.openExactRepresentationItem(
      fact.item.spelling,
      expected,
      actual,
      Location.at(fact.anchor),
    )
  const lookup = resolvers.item(module, fact.item)
  if (lookup._tag === 'Ambiguous')
    return reject(
      Diagnostic.ambiguousExactRepresentationItem(
        fact.item.spelling,
        lookup.count,
        Location.at(fact.anchor),
      ),
    )
  if (lookup._tag !== 'Resolved')
    return reject(
      unresolved(),
      lookup._tag === 'Inaccessible' || lookup._tag === 'Unavailable'
        ? lookup.declaration
        : undefined,
    )
  const declaration = lookup.declaration
  if (declaration._tag !== 'FunctionDeclaration' || declaration.functionKind !== 'Ordinary')
    return reject(
      Diagnostic.uncallableExactRepresentationItem(
        fact.item.spelling,
        declaration._tag === 'FunctionDeclaration' ? 'EffectDeclaration' : 'NonCallableDeclaration',
        Location.at(fact.anchor),
      ),
      declaration,
    )
  if (declaration.typeParameters.length !== arguments_.length)
    return reject(open(declaration.typeParameters.length), declaration)
  const supplied = arguments_.map((argument, ordinal) => {
    if (argument.fact._tag === 'Lifetime') return argument.fact.lifetime
    if (argument.fact._tag !== 'Resolved') return undefined
    return genericArgumentForParameter(
      declaration.typeParameters.at(ordinal)?.type,
      argument.fact.type,
    )
  })
  if (supplied.some((argument) => argument === undefined))
    return reject(open(declaration.typeParameters.length), declaration)
  const concrete = supplied.filter(
    (argument): argument is Type.GenericArgument => argument !== undefined,
  )
  const concreteCount = concrete.filter(Type.isRuntimeConcreteGenericArgument).length
  if (concreteCount !== concrete.length)
    return reject(open(declaration.typeParameters.length, concreteCount), declaration)
  const substitution = TypeInference.substitution(
    declaration.typeParameters.map((parameter) => parameter.type),
    concrete,
  )
  if (substitution === undefined)
    return reject(open(declaration.typeParameters.length), declaration)
  const canonical =
    declaration.canonical._tag === 'Canonical' ? declaration.canonical.id : undefined
  if (canonical === undefined) return reject(unresolved(), declaration)
  const declaredReturn = resolveDeclaredType(
    spanOf,
    canonical.module,
    declaration.returnType,
    resolvers,
    modules,
  )
  if (declaredReturn.fact._tag !== 'Resolved') return reject(unresolved(), declaration)
  const declaredParameters = declaration.parameters.map(
    (parameter) =>
      resolveDeclaredType(spanOf, canonical.module, parameter.declaredType, resolvers, modules)
        .fact,
  )
  if (declaredParameters.some((parameter) => parameter._tag !== 'Resolved'))
    return reject(unresolved(), declaration)
  const structural = Type.callable(
    declaredParameters.flatMap((parameter) =>
      parameter._tag === 'Resolved' ? [Type.substitute(parameter.type, substitution)] : [],
    ),
    Type.substitute(declaredReturn.fact.type, substitution),
    { ...executableLifetimes(declaration), environment: Lifetime.staticLifetime },
    'Shared',
    undefined,
    declaration.unsafe,
  )
  const identity = Type.callableIdentityArgument(
    `declaration:${canonical.module}:${canonical.name}`,
    { _tag: 'Declaration', module: canonical.module, name: canonical.name },
    concrete,
  )
  const type = Type.represented(
    structural,
    structural,
    Type.exactRepresentationArgument(identity, structural),
  )
  return {
    fact: {
      _tag: 'Resolved',
      type,
      spelling: fact.spelling,
      anchor: fact.anchor,
      components: arguments_.map((argument) => argument.fact),
      exactItem: { path: fact.item, declaration: canonical },
    },
    diagnostics: argumentDiagnostics,
  }
}

export const resolveDeclaredType = (
  spanOf: SpanOf,
  module: string,
  fact: DeclaredTypeFact,
  resolvers: ResolutionSeams.ResolutionSeams,
  modules: ReadonlyArray<ModuleHeaders>,
): TypeResolution => {
  if (fact._tag === 'Lifetime') return { fact, diagnostics: [] }
  if (fact._tag === 'RepresentationParameter') {
    const parameter =
      resolvers.representationBindings?.get(Type.key(fact.parameter)) ?? fact.parameter
    const bound = parameter.representationBound
    if (bound === undefined) return { fact, diagnostics: [] }
    const type = Type.represented(bound, bound, Type.representationParameterArgument(parameter))
    return {
      fact: {
        _tag: 'Resolved',
        type,
        spelling: fact.spelling,
        anchor: fact.anchor,
        path: fact.path,
      },
      diagnostics: [],
    }
  }
  if (fact._tag === 'ExactRepresentation')
    return resolveExactRepresentation(spanOf, module, fact, resolvers, modules)
  if (fact._tag === 'Unresolved') {
    const resolved = resolvers.type(module, fact.path)
    if (resolved.fact._tag !== 'Resolved' || !Type.isNominal(resolved.fact.type)) return resolved
    // A nominal that already carries arguments came through an alias, which applied them.
    if (resolved.fact.type.arguments.length > 0) return resolved
    const declaration = memberByNominal(modules, resolved.fact.type)
    const expected =
      declaration?.typeParameters.length ?? Type.intrinsicNominalArity(resolved.fact.type)
    if (expected === 0) return resolved
    if (
      fact.implicitLifetimeArguments !== undefined &&
      declaration !== undefined &&
      declaration.typeParameters.every((parameter) => parameter.type.kind === 'Lifetime') &&
      expected === fact.implicitLifetimeArguments.length
    ) {
      const type = Type.specializeNominal(resolved.fact.type, fact.implicitLifetimeArguments)
      return {
        fact: { ...resolved.fact, type, spelling: Type.encode(type) },
        diagnostics: resolved.diagnostics,
      }
    }
    const diagnostic = Diagnostic.typeArgumentArity(
      fact.spelling,
      expected,
      0,
      Location.at(fact.anchor),
    )
    return {
      fact: {
        ...fact,
        cause: Diagnostic.identity(diagnostic),
        candidate: resolved.fact.type,
      },
      diagnostics: [diagnostic],
    }
  }
  if (fact._tag === 'Callable' || fact._tag === 'ForeignFunction') {
    const parameters = fact.parameters.map((parameter) =>
      resolveDeclaredType(spanOf, module, parameter, resolvers, modules),
    )
    const result = resolveDeclaredType(spanOf, module, fact.result, resolvers, modules)
    const diagnostics = [
      ...parameters.flatMap((parameter) => parameter.diagnostics),
      ...result.diagnostics,
    ]
    if (
      result.fact._tag === 'Resolved' &&
      parameters.every((parameter) => parameter.fact._tag === 'Resolved')
    ) {
      const resolvedParameters = parameters.flatMap((parameter) =>
        parameter.fact._tag === 'Resolved' ? [parameter.fact.type] : [],
      )
      const type =
        fact._tag === 'Callable'
          ? Type.callable(
              resolvedParameters,
              result.fact.type,
              fact.lifetimes,
              fact.mode,
              undefined,
              fact.unsafe,
            )
          : Type.foreignFunction(
              resolvedParameters,
              result.fact.type,
              fact.contract,
              fact.lifetimes,
            )
      return {
        fact: {
          _tag: 'Resolved',
          type,
          spelling: Type.encode(type),
          anchor: fact.anchor,
          components: [...parameters.map((parameter) => parameter.fact), result.fact],
        },
        diagnostics,
      }
    }
    const resolvedFacts = [...parameters.map((parameter) => parameter.fact), result.fact]
    const cause = resolvedFacts
      .flatMap((resolved) =>
        'cause' in resolved && resolved.cause !== undefined ? [resolved.cause] : [],
      )
      .at(-1)
    return {
      fact: {
        ...fact,
        parameters: parameters.map((parameter) => parameter.fact),
        result: result.fact,
        ...(cause === undefined ? {} : { cause }),
      },
      diagnostics,
    }
  }
  if (fact._tag === 'Effect') {
    const success = resolveDeclaredType(spanOf, module, fact.success, resolvers, modules)
    const failures = fact.failures.map((failure) =>
      resolveDeclaredType(spanOf, module, failure, resolvers, modules),
    )
    const requirements = fact.requirements.map((requirement) => {
      const role = resolveRequirementRole(spanOf, module, requirement.role, resolvers)
      return {
        ...requirement,
        capability: resolveDeclaredType(spanOf, module, requirement.capability, resolvers, modules),
        role,
      }
    })
    const diagnostics: Array<Diagnostic.Located> = [
      ...success.diagnostics,
      ...failures.flatMap((failure) => failure.diagnostics),
      ...requirements.flatMap((requirement) => requirement.capability.diagnostics),
      ...requirements.flatMap((requirement) => requirement.role.diagnostics),
    ]
    const failureTypes: Array<Type.Type> = []
    const symbolicFailureTypes: Array<{
      readonly type: Type.Parameter
      readonly span: SourceSpan.SourceSpan
    }> = []
    let failuresAvailable = true
    for (const failure of failures) {
      if (
        failure.fact._tag === 'Resolved' &&
        Type.isTypeArgument(failure.fact.type) &&
        !Type.isParameter(failure.fact.type)
      ) {
        failureTypes.push(failure.fact.type)
      } else if (
        failure.fact._tag === 'Resolved' &&
        Type.isParameter(failure.fact.type) &&
        failure.fact.type.kind === 'Value'
      ) {
        symbolicFailureTypes.push({ type: failure.fact.type, span: spanOf(failure.fact.anchor) })
      } else if (!(failure.fact._tag === 'Resolved' && Type.isNever(failure.fact.type))) {
        failuresAvailable = false
        if (failure.fact._tag === 'Resolved')
          diagnostics.push(
            Diagnostic.invalidFailureType(
              Type.encode(failure.fact.type),
              Location.at(failure.fact.anchor),
            ),
          )
      }
    }
    const requirementTypes: Array<Type.Requirement> = []
    let requirementsAvailable = true
    for (const requirement of requirements) {
      if (
        requirement.capability.fact._tag === 'Resolved' &&
        requirementRoleIdentity(requirement.role.fact) !== undefined &&
        ((Type.isNominal(requirement.capability.fact.type) &&
          dependencyEligible(modules, requirement.capability.fact.type)) ||
          (Type.isParameter(requirement.capability.fact.type) &&
            requirement.capability.fact.type.kind === 'Value'))
      ) {
        requirementTypes.push({
          capability: requirement.capability.fact.type,
          role: requirementRoleIdentity(requirement.role.fact) ?? RequirementRow.defaultRole,
          access: requirement.access,
        })
      } else {
        requirementsAvailable = false
        if (requirement.capability.fact._tag === 'Resolved')
          diagnostics.push(
            Diagnostic.invalidRequirementType(
              Type.encode(requirement.capability.fact.type),
              Location.at(requirement.anchor),
            ),
          )
      }
    }
    const requirementExpression =
      fact.requirementExpression === undefined
        ? undefined
        : resolveRowExpressionDecision(
            spanOf,
            module,
            fact.requirementExpression,
            resolvers,
            modules,
          )
    if (requirementExpression !== undefined) diagnostics.push(...requirementExpression.diagnostics)
    if (success.fact._tag === 'Resolved' && failuresAvailable && requirementsAvailable) {
      const base = Type.effect(
        success.fact.type,
        failureTypes,
        fact.lifetimes,
        fact.access,
        requirementTypes,
        fact.requirementParameters,
      )
      const failureRow = symbolicFailureTypes.reduce<Type.FailureRow>(
        (row, failure) =>
          RowAlgebra.union(
            Type.failureRowPolicy(),
            row,
            RowAlgebra.singleton(
              Type.failureRowPolicy(),
              Type.failureMemberShape(failure.type),
              failure.span,
            ),
          ),
        base.failureRow,
      )
      const type = Type.effectWithRows(
        success.fact.type,
        failureRow,
        fact.lifetimes,
        fact.access,
        requirementExpression === undefined
          ? base.requirementRow
          : semanticRequirementRow(spanOf, requirementExpression.fact),
      )
      return {
        fact: {
          _tag: 'Resolved',
          type,
          spelling: Type.encode(type),
          anchor: fact.anchor,
          components: [
            success.fact,
            ...failures.map((failure) => failure.fact),
            ...requirements.map((requirement) => requirement.capability.fact),
          ],
        },
        diagnostics: diagnostics,
      }
    }
    const cause = diagnostics.at(-1)
    return {
      fact: {
        ...fact,
        success: success.fact,
        failures: failures.map((failure) => failure.fact),
        requirements: requirements.map((requirement) => ({
          ...requirement,
          capability: requirement.capability.fact,
          role: requirement.role.fact,
        })),
        ...(cause === undefined ? {} : { cause: Diagnostic.identity(cause) }),
      },
      diagnostics: diagnostics,
    }
  }
  if (fact._tag === 'Applied') {
    const target =
      fact.target._tag === 'Unresolved'
        ? resolvers.type(module, fact.target.path)
        : resolveDeclaredType(spanOf, module, fact.target, resolvers, modules)
    const targetDeclaration =
      target.fact._tag === 'Resolved' && Type.isNominal(target.fact.type)
        ? memberByNominal(modules, target.fact.type)
        : undefined
    const targetParameters =
      target.fact._tag === 'Resolved' && Type.isNominal(target.fact.type)
        ? (targetDeclaration?.typeParameters.map((parameter) => parameter.type) ??
          Type.intrinsicNominalParameters(target.fact.type))
        : undefined
    const targetOrdinaryParameters = targetParameters?.filter(
      (parameter) => parameter.kind !== 'Lifetime',
    )
    let argumentOrdinal = 0
    const arguments_ = fact.arguments.map((argument) =>
      argument._tag === 'Lifetime'
        ? resolveGenericArgument(spanOf, module, argument, undefined, resolvers, modules)
        : resolveGenericArgument(
            spanOf,
            module,
            argument,
            targetOrdinaryParameters?.at(argumentOrdinal++),
            resolvers,
            modules,
          ),
    )
    const requirements =
      fact.requirementRow?.requirements.map((requirement) => {
        const role = resolveRequirementRole(spanOf, module, requirement.role, resolvers)
        return {
          ...requirement,
          capability: resolveDeclaredType(
            spanOf,
            module,
            requirement.capability,
            resolvers,
            modules,
          ),
          role,
        }
      }) ?? []
    const diagnostics = [
      ...target.diagnostics,
      ...arguments_.flatMap((argument) => argument.diagnostics),
      ...requirements.flatMap((requirement) => requirement.capability.diagnostics),
      ...requirements.flatMap((requirement) => requirement.role.diagnostics),
    ]
    if (target.fact._tag === 'Resolved' && Type.isNominal(target.fact.type)) {
      const declaration = targetDeclaration
      // An alias to an applied nominal accepts no further arguments.
      const expected =
        target.fact.type.arguments.length > 0
          ? 0
          : (declaration?.typeParameters.length ?? Type.intrinsicNominalArity(target.fact.type))
      const declaredParameters = targetParameters
      const writtenLifetimes = arguments_.filter((argument) => argument.fact._tag === 'Lifetime')
      const ordinaryArguments = arguments_.filter((argument) => argument.fact._tag !== 'Lifetime')
      const valueArguments = ordinaryArguments.map((argument) => argument.argument)
      const lifetimeArguments =
        fact.implicitLifetimeArguments ??
        writtenLifetimes.flatMap((argument) =>
          argument.fact._tag === 'Lifetime' ? [argument.fact.lifetime] : [],
        )
      const requirementTypes = requirements.flatMap(
        (requirement): ReadonlyArray<Type.Requirement> =>
          requirement.capability.fact._tag === 'Resolved' &&
          (Type.isNominal(requirement.capability.fact.type) ||
            (Type.isParameter(requirement.capability.fact.type) &&
              requirement.capability.fact.type.kind === 'Value'))
            ? [
                {
                  capability: requirement.capability.fact.type,
                  role:
                    requirementRoleIdentity(requirement.role.fact) ?? RequirementRow.defaultRole,
                  access: requirement.access,
                },
              ]
            : [],
      )
      const requirementsAvailable =
        requirementTypes.length === requirements.length &&
        requirements.every(
          (requirement) => requirementRoleIdentity(requirement.role.fact) !== undefined,
        )
      const rowArguments: ReadonlyArray<Type.GenericArgument | undefined> =
        fact.requirementRow === undefined
          ? []
          : [
              requirementsAvailable
                ? Type.requirementRowArgument(requirementTypes, fact.requirementRow.parameters)
                : undefined,
            ]
      const written = [...valueArguments, ...rowArguments]
      let lifetimeOrdinal = 0
      let ordinaryOrdinal = 0
      const available =
        declaredParameters === undefined
          ? [...lifetimeArguments, ...written]
          : declaredParameters.map((parameter) =>
              parameter.kind === 'Lifetime'
                ? lifetimeArguments.at(lifetimeOrdinal++)
                : written.at(ordinaryOrdinal++),
            )
      const suppliedCount =
        arguments_.length + rowArguments.length + (fact.implicitLifetimeArguments?.length ?? 0)
      if (expected === suppliedCount && available.every((argument) => argument !== undefined)) {
        const concrete = available.filter(
          (argument): argument is Type.GenericArgument => argument !== undefined,
        )
        let substitution: Type.Substitution | undefined
        if (declaredParameters === undefined) {
          if (concrete.every(Type.isTypeArgument)) {
            substitution = new Map<string, Type.GenericArgument>()
          } else {
            substitution = undefined
          }
        } else {
          substitution = TypeInference.substitution(declaredParameters, concrete)
        }
        if (substitution === undefined) {
          const incompatibleBound = concrete.findIndex((argument, ordinal) => {
            const parameter = declaredParameters?.at(ordinal)
            if (
              parameter === undefined ||
              (parameter.kind !== 'CallableRepresentation' &&
                parameter.kind !== 'EffectRepresentation') ||
              !Type.isRepresentationArgument(argument) ||
              Type.representationArgumentKind(argument) !== parameter.kind ||
              parameter.representationBound === undefined
            )
              return false
            const prior = TypeInference.prefixSubstitution(
              declaredParameters?.slice(0, ordinal) ?? [],
              concrete.slice(0, ordinal),
            )
            if (prior === undefined) return false
            const required = Type.substitute(parameter.representationBound, prior)
            const actual =
              argument._tag === 'RepresentationParameterArgument'
                ? argument.parameter.representationBound
                : argument.contract
            return (
              actual !== undefined &&
              (Type.isCallable(required) || Type.isEffect(required)) &&
              Type.representationAdmissibility(actual, required)._tag === 'Unavailable'
            )
          })
          const incompatibleParameter =
            incompatibleBound < 0 ? undefined : declaredParameters?.at(incompatibleBound)
          const incompatibleArgument =
            incompatibleBound < 0 ? undefined : concrete.at(incompatibleBound)
          const incompatibleSupplied =
            incompatibleBound < 0 ? undefined : arguments_.at(incompatibleBound)
          if (
            incompatibleParameter !== undefined &&
            incompatibleParameter.representationBound !== undefined &&
            incompatibleArgument !== undefined &&
            Type.isRepresentationArgument(incompatibleArgument) &&
            incompatibleSupplied !== undefined
          ) {
            const prior = TypeInference.prefixSubstitution(
              declaredParameters?.slice(0, incompatibleBound) ?? [],
              concrete.slice(0, incompatibleBound),
            )
            const required =
              prior === undefined
                ? incompatibleParameter.representationBound
                : Type.substitute(incompatibleParameter.representationBound, prior)
            const actual =
              incompatibleArgument._tag === 'RepresentationParameterArgument'
                ? incompatibleArgument.parameter.representationBound
                : incompatibleArgument.contract
            let actualParameter: TypeParameterFact | undefined
            if (incompatibleArgument._tag === 'RepresentationParameterArgument') {
              actualParameter = modules
                .flatMap((candidateModule) => candidateModule.members)
                .flatMap((member) => ('typeParameters' in member ? member.typeParameters : []))
                .find(
                  (candidateParameter) =>
                    Type.key(candidateParameter.type) === Type.key(incompatibleArgument.parameter),
                )
            } else {
              actualParameter = undefined
            }
            const requiredParameter = declaration?.typeParameters.at(incompatibleBound)
            if ((Type.isCallable(required) || Type.isEffect(required)) && actual !== undefined)
              diagnostics.push(
                Diagnostic.incompatibleRepresentationBound(
                  incompatibleParameter.name,
                  Type.encode(required),
                  Type.encode(actual),
                  Location.at(incompatibleSupplied.fact.anchor),
                  {
                    ...(requiredParameter === undefined
                      ? {}
                      : { requiredDeclarationSpan: Location.at(requiredParameter.anchor) }),
                    ...(actualParameter === undefined
                      ? {}
                      : { actualDeclarationSpan: Location.at(actualParameter.anchor) }),
                  },
                ),
              )
          }
          const mismatch = concrete.findIndex((argument, ordinal) => {
            const parameter = declaredParameters?.at(ordinal)
            if (parameter === undefined) return false
            if (parameter.kind === 'Lifetime') return !Lifetime.isLifetime(argument)
            if (parameter.kind === 'Value') return !Type.isTypeArgument(argument)
            if (parameter.kind === 'RequirementRow') return !Type.isRequirementRowArgument(argument)
            return (
              !Type.isRepresentationArgument(argument) ||
              Type.representationArgumentKind(argument) !== parameter.kind
            )
          })
          const parameter = declaredParameters?.at(mismatch)
          const supplied = arguments_.at(mismatch)
          if (incompatibleBound < 0 && parameter !== undefined && supplied !== undefined) {
            let suppliedKind: Type.ParameterKind =
              supplied.fact._tag === 'Lifetime' ? 'Lifetime' : 'Value'
            if (supplied.fact._tag === 'Resolved' && Type.isRepresented(supplied.fact.type)) {
              suppliedKind =
                supplied.fact.type.contract._tag === 'CallableType'
                  ? 'CallableRepresentation'
                  : 'EffectRepresentation'
            } else if (
              supplied.fact._tag === 'Resolved' &&
              Type.isParameter(supplied.fact.type) &&
              supplied.fact.type.kind === 'RequirementRow'
            ) {
              suppliedKind = supplied.fact.type.kind
            }
            diagnostics.push(
              Diagnostic.genericParameterKindMismatch(
                parameter.name,
                parameter.kind,
                suppliedKind,
                Location.at(supplied.fact.anchor),
              ),
            )
          }
          const causeDiagnostic = diagnostics.at(-1)
          return {
            fact: {
              ...fact,
              ...(causeDiagnostic === undefined
                ? {}
                : { cause: Diagnostic.identity(causeDiagnostic) }),
            },
            diagnostics: diagnostics,
          }
        }
        const type = Type.specializeNominal(target.fact.type, concrete)
        return {
          fact: {
            _tag: 'Resolved',
            type,
            spelling: Type.encode(type),
            anchor: fact.anchor,
            components: [
              target.fact,
              ...arguments_.map((argument) => argument.fact),
              ...requirements.map((requirement) => requirement.capability.fact),
            ],
          },
          diagnostics: diagnostics,
        }
      }
      if (expected === suppliedCount) {
        const unavailable = [
          ...arguments_,
          ...requirements.map((requirement) => requirement.capability),
        ].find((argument) => argument.fact._tag !== 'Resolved')
        const cause =
          unavailable !== undefined && 'cause' in unavailable.fact
            ? unavailable.fact.cause
            : undefined
        return {
          fact: { ...fact, ...(cause === undefined ? {} : { cause }) },
          diagnostics: diagnostics,
        }
      }
      const diagnostic = Diagnostic.typeArgumentArity(
        fact.spelling,
        expected,
        suppliedCount,
        Location.at(fact.target.anchor),
      )
      diagnostics.push(diagnostic)
      return {
        fact: { ...fact, cause: Diagnostic.identity(diagnostic) },
        diagnostics: diagnostics,
      }
    }
    if (target.fact._tag === 'Resolved') {
      // Only a nominal accepts arguments. An alias can resolve a path to any other type.
      const diagnostic = Diagnostic.typeArgumentArity(
        fact.spelling,
        0,
        fact.arguments.length,
        Location.at(fact.target.anchor),
      )
      diagnostics.push(diagnostic)
      return {
        fact: { ...fact, cause: Diagnostic.identity(diagnostic) },
        diagnostics: diagnostics,
      }
    }
    return { fact, diagnostics: diagnostics }
  }
  if (fact._tag === 'Union') {
    const resolvedMembers = fact.members.map((member) =>
      resolveDeclaredType(spanOf, module, member, resolvers, modules),
    )
    const diagnostics: Array<Diagnostic.Located> = resolvedMembers.flatMap((member) =>
      Array.from(member.diagnostics),
    )
    const members = resolvedMembers.map((member) => member.fact)
    if (members.every((member) => member._tag === 'Resolved')) {
      const available = members.filter(
        (member): member is Extract<DeclaredTypeFact, { readonly _tag: 'Resolved' }> =>
          member._tag === 'Resolved',
      )
      const normalized = Type.union(available.map((member) => member.type))
      if (normalized._tag === 'Normalized') {
        return {
          fact: {
            _tag: 'Resolved' as const,
            type: normalized.type,
            spelling: Type.encode(normalized.type),
            anchor: fact.anchor,
            unionSource: {
              _tag: 'UnionSource' as const,
              members,
              anchor: fact.anchor,
            },
          },
          diagnostics: diagnostics,
        }
      }
      if (normalized._tag === 'InvalidMembers') {
        for (const invalid of normalized.members) {
          const sourceFact = available.find((member) => Type.equals(member.type, invalid))
          diagnostics.push(
            Diagnostic.invalidUnionMember(
              Type.encode(invalid),
              Location.at(sourceFact?.anchor ?? fact.anchor),
            ),
          )
        }
      }
    }
    const cause = diagnostics.at(-1)
    return {
      fact: {
        ...fact,
        members,
        ...(cause === undefined ? {} : { cause: Diagnostic.identity(cause) }),
      },
      diagnostics: diagnostics,
    }
  }
  if (fact._tag === 'Slice') {
    const element = resolveDeclaredType(spanOf, module, fact.element, resolvers, modules)
    if (element.fact._tag === 'Resolved') {
      const type = Type.slice(fact.access, element.fact.type, fact.lifetime)
      return {
        fact: {
          _tag: 'Resolved',
          type,
          spelling: Type.encode(type),
          anchor: fact.anchor,
          components: [element.fact],
          ...(element.fact.exposureCause === undefined
            ? {}
            : { exposureCause: element.fact.exposureCause }),
        },
        diagnostics: element.diagnostics,
      }
    }
    const cause = 'cause' in element.fact ? element.fact.cause : undefined
    return {
      fact: {
        ...fact,
        element: element.fact,
        ...(cause === undefined ? {} : { cause }),
      },
      diagnostics: element.diagnostics,
    }
  }
  if (fact._tag === 'Reference') {
    const target = resolveDeclaredType(spanOf, module, fact.target, resolvers, modules)
    if (target.fact._tag === 'Resolved') {
      const type = Type.reference(fact.access, target.fact.type, fact.lifetime)
      return {
        fact: {
          _tag: 'Resolved',
          type,
          spelling: Type.encode(type),
          anchor: fact.anchor,
          components: [target.fact],
        },
        diagnostics: target.diagnostics,
      }
    }
    return {
      fact: {
        ...fact,
        target: target.fact,
        ...('cause' in target.fact && target.fact.cause !== undefined
          ? { cause: target.fact.cause }
          : {}),
      },
      diagnostics: target.diagnostics,
    }
  }
  if (fact._tag === 'Pointer') {
    const pointee = resolveDeclaredType(spanOf, module, fact.pointee, resolvers, modules)
    if (pointee.fact._tag === 'Resolved') {
      const type = Type.pointer({ ...fact, pointee: pointee.fact.type })
      return {
        fact: {
          _tag: 'Resolved',
          type,
          spelling: Type.encode(type),
          anchor: fact.anchor,
          components: [pointee.fact],
        },
        diagnostics: pointee.diagnostics,
      }
    }
    return {
      fact: {
        ...fact,
        pointee: pointee.fact,
        ...('cause' in pointee.fact && pointee.fact.cause !== undefined
          ? { cause: pointee.fact.cause }
          : {}),
      },
      diagnostics: pointee.diagnostics,
    }
  }
  if (fact._tag !== 'FixedArray') return { fact, diagnostics: [] }
  return (() => {
    const element = resolveDeclaredType(spanOf, module, fact.element, resolvers, modules)
    if (fact.length._tag !== 'Available') {
      return {
        fact: {
          _tag: 'Unavailable' as const,
          anchor: fact.anchor,
          ...(fact.length._tag === 'OutOfRange' ? { cause: fact.length.cause } : {}),
        },
        diagnostics: element.diagnostics,
      }
    }
    if (element.fact._tag === 'Resolved') {
      const type = Type.fixedArray(element.fact.type, fact.length.value)
      return {
        fact: {
          _tag: 'Resolved' as const,
          type,
          spelling: Type.encode(type),
          anchor: fact.anchor,
          components: [element.fact],
          ...(element.fact.exposureCause === undefined
            ? {}
            : { exposureCause: element.fact.exposureCause }),
        },
        diagnostics: element.diagnostics,
      }
    }
    if (element.fact._tag === 'Unresolved') {
      return {
        fact: {
          ...element.fact,
          spelling: fact.spelling,
          anchor: fact.anchor,
        },
        diagnostics: element.diagnostics,
      }
    }
    return {
      fact: {
        _tag: 'Unavailable' as const,
        anchor: fact.anchor,
        ...(element.fact._tag === 'Unavailable' && element.fact.cause !== undefined
          ? { cause: element.fact.cause }
          : {}),
      },
      diagnostics: element.diagnostics,
    }
  })()
}

export const canonicalKey = (id: CanonicalId): string => `${id.module}.${id.name}`

export const memberByNominal = (
  modules: ReadonlyArray<ModuleHeaders>,
  type: Type.Nominal,
): StructFact | UnionFact | ServiceFact | InterfaceFact | undefined => {
  const module = modules.find((candidate) => candidate.module === type.module)
  return [
    ...(module?.structs ?? []),
    ...(module?.unions ?? []),
    ...(module?.services ?? []),
    ...(module?.interfaces ?? []),
  ].find(
    (member) => member.canonical._tag === 'Canonical' && member.canonical.id.name === type.name,
  )
}

const dependencyEligible = (
  modules: ReadonlyArray<ModuleHeaders>,
  capability: Type.Nominal,
): boolean => {
  const member = memberByNominal(modules, capability)
  return (
    (member?._tag === 'InterfaceDeclaration' || member?._tag === 'ServiceDeclaration') &&
    member.dependencyEligible
  )
}

/** Converts one resolved source type to the erased argument kind its declaration parameter owns. */
const genericArgumentForParameter = (
  parameter: Type.Parameter | undefined,
  type: Type.Type,
): Type.GenericArgument => {
  if (parameter?.kind === 'CallableRepresentation' || parameter?.kind === 'EffectRepresentation')
    return Type.isRepresented(type) ? type.representation.argument : type
  if (parameter?.kind === 'RequirementRow') {
    if (Type.isParameter(type) && type.kind === 'RequirementRow')
      return Type.requirementRowArgument([], [type])
    if (Type.isNever(type)) return Type.requirementRowArgument([])
    if (
      Type.isReference(type) &&
      (Type.isNominal(type.target) ||
        (Type.isParameter(type.target) && type.target.kind === 'Value'))
    )
      return Type.requirementRowArgument([
        { capability: type.target, role: 'DefaultRole', access: type.access },
      ])
    if (Type.isUnion(type)) {
      const members = type.members.map((member) => genericArgumentForParameter(parameter, member))
      if (members.every(Type.isRequirementRowArgument))
        return Type.requirementRowArgument(
          members.flatMap(Type.requirementMembers),
          members.flatMap(Type.requirementRowParameters),
        )
    }
    if (Type.isNominal(type) || (Type.isParameter(type) && type.kind === 'Value'))
      return Type.requirementRowArgument([
        { capability: type, role: 'DefaultRole', access: 'Shared' },
      ])
  }
  return type
}

type GenericArgumentResolution = TypeResolution & {
  readonly argument?: Type.GenericArgument
}

/** Resolves a generic argument with the declaration parameter's kind available as context. */
const resolveGenericArgument = (
  spanOf: SpanOf,
  module: string,
  fact: DeclaredTypeFact,
  parameter: Type.Parameter | undefined,
  resolvers: ResolutionSeams.ResolutionSeams,
  modules: ReadonlyArray<ModuleHeaders>,
): GenericArgumentResolution => {
  if (parameter?.kind === 'RequirementRow' && fact._tag === 'Union') {
    const members = fact.members.map((member) =>
      resolveGenericArgument(spanOf, module, member, parameter, resolvers, modules),
    )
    const diagnostics = members.flatMap((member) => member.diagnostics)
    const arguments_ = members.map((member) => member.argument)
    const argument = arguments_.every(
      (member): member is Type.RequirementRowArgument =>
        member !== undefined && Type.isRequirementRowArgument(member),
    )
      ? Type.requirementRowArgument(
          arguments_.flatMap(Type.requirementMembers),
          arguments_.flatMap(Type.requirementRowParameters),
        )
      : undefined
    const cause = diagnostics.at(-1)
    return {
      fact: {
        ...fact,
        members: members.map((member) => member.fact),
        ...(cause === undefined ? {} : { cause: Diagnostic.identity(cause) }),
      },
      diagnostics,
      ...(argument === undefined ? {} : { argument }),
    }
  }
  const resolved = resolveDeclaredType(spanOf, module, fact, resolvers, modules)
  if (resolved.fact._tag !== 'Resolved') return resolved
  return {
    ...resolved,
    argument: genericArgumentForParameter(parameter, resolved.fact.type),
  }
}

/**
 * Resolves every type parameter's bound to the interface its spelling names in the bounded
 * declaration's own module scope, recording that interface's ordered operation contract.
 *
 * A bound that names nothing, or names a declaration that is not an interface, stays
 * `UnresolvedBound` and is reported once here, at the declaration that wrote it.
 */
export const resolveBounds = (
  spanOf: SpanOf,
  module: string,
  typeParameters: ReadonlyArray<TypeParameterFact>,
  resolvers: ResolutionSeams.ResolutionSeams,
  modules: ReadonlyArray<ModuleHeaders>,
  diagnostics: Array<Diagnostic.Located>,
): ReadonlyArray<TypeParameterFact> => {
  if (
    typeParameters.every(
      (parameter) => parameter.bounds.length === 0 && parameter.representationBound === undefined,
    )
  )
    return typeParameters
  return typeParameters.map((parameter): TypeParameterFact => {
    const representation = parameter.representationBound
    if (representation !== undefined) {
      const resolved = resolveDeclaredType(
        spanOf,
        module,
        representation.contract,
        resolvers,
        modules,
      )
      diagnostics.push(...resolved.diagnostics)
      const contract =
        resolved.fact._tag === 'Resolved' &&
        (Type.isCallable(resolved.fact.type) || Type.isEffect(resolved.fact.type))
          ? resolved.fact.type
          : undefined
      return {
        ...parameter,
        type:
          contract === undefined
            ? parameter.type
            : Type.parameter(
                parameter.type.owner,
                parameter.type.ordinal,
                parameter.type.name,
                parameter.type.kind,
                contract,
                parameter.staticProperties,
              ),
        representationBound: {
          ...representation,
          contract: resolved.fact,
        },
      }
    }
    if (parameter.bounds.length === 0) return parameter
    const parameterName = parameter.name._tag === 'Present' ? parameter.name : undefined
    let boundResolvers: ResolutionSeams.ResolutionSeams
    if (parameterName === undefined) {
      boundResolvers = resolvers
    } else {
      boundResolvers = {
        ...resolvers,
        type: (candidateModule: string, path: TypePathFact): TypeResolution =>
          path.segments.length === 1 && path.spelling === parameterName.spelling
            ? {
                fact: {
                  _tag: 'Resolved' as const,
                  type: parameter.type,
                  spelling: parameterName.spelling,
                  anchor: parameterName.anchor,
                  components: [],
                },
                diagnostics: [],
              }
            : resolvers.type(candidateModule, path),
      }
    }
    const bounds = parameter.bounds.map((bound): BoundFact => {
      const unresolvedCapability =
        bound._tag === 'ResolvedBound'
          ? bound.application.capability
          : (() => {
              const resolved = resolveDeclaredType(
                spanOf,
                module,
                bound.application,
                boundResolvers,
                modules,
              ).fact
              if (resolved._tag === 'Resolved' && Type.isNominal(resolved.type))
                return resolved.type
              return resolved._tag === 'Unresolved' &&
                resolved.candidate !== undefined &&
                Type.isNominal(resolved.candidate)
                ? resolved.candidate
                : undefined
            })()
      const declaration =
        unresolvedCapability === undefined
          ? undefined
          : memberByNominal(modules, unresolvedCapability)
      if (
        unresolvedCapability !== undefined &&
        Type.equals(unresolvedCapability, Type.copyCapability)
      )
        return {
          _tag: 'ResolvedBound' as const,
          spelling: bound.spelling,
          path: bound.path,
          application: copyApplication(parameter.type),
        }
      if (
        unresolvedCapability === undefined ||
        (declaration?._tag !== 'InterfaceDeclaration' &&
          declaration?._tag !== 'ServiceDeclaration') ||
        declaration.canonical._tag !== 'Canonical'
      )
        return bound
      const application = interfaceApplication(declaration, unresolvedCapability, parameter.type)
      return application === undefined
        ? bound
        : {
            _tag: 'ResolvedBound' as const,
            spelling: bound.spelling,
            path: bound.path,
            application,
          }
    })
    const seen = new Set<string>()
    for (const bound of bounds) {
      if (bound._tag !== 'ResolvedBound') {
        diagnostics.push(
          Diagnostic.invalidConformance(
            `unknown interface constraint ${bound.spelling}`,
            Location.at(parameter.anchor),
          ),
        )
        continue
      }
      const key = Type.key(bound.application.capability)
      if (seen.has(key))
        diagnostics.push(
          Diagnostic.invalidConformance(
            `duplicate bound ${bound.spelling}`,
            Location.at(bound.path.anchor),
          ),
        )
      else seen.add(key)
    }
    return { ...parameter, bounds }
  })
}

/** Refreshes resolved bound applications once every interface header has its completed contracts. */
export const refreshInterfaceApplications = (
  typeParameters: ReadonlyArray<TypeParameterFact>,
  modules: ReadonlyArray<ModuleHeaders>,
): ReadonlyArray<TypeParameterFact> =>
  typeParameters.map((parameter): TypeParameterFact => {
    return {
      ...parameter,
      bounds: parameter.bounds.map((bound): BoundFact => {
        if (bound._tag !== 'ResolvedBound') return bound
        const declaration = memberByNominal(modules, bound.application.capability)
        if (
          declaration?._tag !== 'InterfaceDeclaration' &&
          declaration?._tag !== 'ServiceDeclaration'
        )
          return bound
        const application = interfaceApplication(
          declaration,
          bound.application.capability,
          parameter.type,
        )
        return application === undefined ? bound : { ...bound, application }
      }),
    }
  })

/**
 * Reads one conformance's requirements as the interface applications proof search will follow.
 *
 * A requirement that resolved to something other than an applied interface, or that never stated
 * its provider, contributes nothing here: header validation reports it, and admitting it as a
 * descent step would let a damaged fact stand in for a proof obligation.
 */
export const declaredRequirements = (
  modules: ReadonlyArray<ModuleHeaders>,
  conformance: ConformanceFact,
): ReadonlyArray<ConformanceHead.Requirement> =>
  conformance.requirements.flatMap((requirement): ReadonlyArray<ConformanceHead.Requirement> => {
    if (requirement.capability._tag !== 'Resolved') return []
    const capability = requirement.capability.type
    if (!Type.isNominal(capability)) return []
    if (
      !Type.equals(capability, Type.copyCapability) &&
      memberByNominal(modules, capability) === undefined
    )
      return []
    return [{ capability, provider: requirement.parameter }]
  })

/** Positional specialization shared by interface and service witness validation. */
export const witnessBinding = (
  implementation: DeclarationFact,
  declaredParameters: ReadonlyArray<Type.Parameter>,
): {
  readonly binders: ReadonlyArray<TypeParameterFact>
  readonly parameters: ReadonlyArray<Type.Parameter>
  readonly substitution: Type.Substitution | undefined
} => {
  const binders = implementation.typeParameters.filter(
    (parameter) => parameter.duplicateOf === undefined,
  )
  const parameters = binders.map((parameter) => parameter.type)
  return {
    binders,
    parameters,
    substitution:
      parameters.length === 0
        ? new Map<string, Type.GenericArgument>()
        : TypeInference.substitution(parameters, declaredParameters.map(Type.parameterArgument)),
  }
}

/** Infers an interface witness declaration's own binders without assuming header position. */
/**
 * The rigid region of one owned operand lent to a source witness for a single invocation. The
 * adapter owns the operand for that whole invocation.
 */
const witnessBorrow = (implementation: DeclarationFact): Lifetime.Lifetime =>
  Lifetime.placeholder(
    Lifetime.bound(
      {
        module: implementation.id.sourceId,
        name:
          implementation.name._tag === 'Present'
            ? implementation.name.spelling
            : `witness@${implementation.id.ordinal}`,
      },
      0,
      'witnessBorrow',
    ),
    'owned witness invocation',
  )

export const inferInterfaceWitnessTarget = (
  implementation: DeclarationFact,
  contract: InterfaceOperationApplicationFact | undefined,
): InterfaceWitnessInference.Inference | undefined => {
  if (
    contract === undefined ||
    implementation.parameters.length !== contract.operands.length ||
    implementation.returnType._tag !== 'Resolved'
  )
    return undefined
  const binders = implementation.typeParameters
    .filter((parameter) => parameter.duplicateOf === undefined)
    .map((parameter) => parameter.type)
  const constraints: Array<InterfaceWitnessInference.Constraint> = []
  for (const [ordinal, operand] of contract.operands.entries()) {
    const pattern = implementation.parameters.at(ordinal)?.declaredType
    if (pattern?._tag !== 'Resolved' || operand.type._tag !== 'Resolved') return undefined
    const name =
      operand.parameter.name._tag === 'Present'
        ? operand.parameter.name.spelling
        : `#${ordinal + 1}`
    // An owned operand can be lent to a source witness for this invocation. Its temporary borrow
    // is rigid: it cannot satisfy a static precondition or escape through the promised result.
    let actual =
      Type.isReference(pattern.type) &&
      !Type.isReference(operand.type.type) &&
      !Type.isSlice(operand.type.type)
        ? Type.reference(pattern.type.access, operand.type.type, witnessBorrow(implementation))
        : operand.type.type
    // Source-witness lowering explicitly reborrows an exclusive operand for a weaker witness.
    // Infer against that adapter's input without permitting implicit access conversion in calls.
    if (
      Type.isReference(pattern.type) &&
      Type.isReference(actual) &&
      pattern.type.access === 'Shared' &&
      actual.access === 'Exclusive'
    )
      actual = Type.reference('Shared', actual.target, actual.lifetime)
    else if (
      Type.isSlice(pattern.type) &&
      Type.isSlice(actual) &&
      pattern.type.access === 'Shared' &&
      actual.access === 'Exclusive'
    )
      actual = Type.slice('Shared', actual.element, actual.lifetime)
    constraints.push({
      label: Type.equals(
        Type.isReference(operand.type.type) ? operand.type.type.target : operand.type.type,
        contract.provider,
      )
        ? `receiver ${name}`
        : `parameter ${name}`,
      pattern: pattern.type,
      actual,
    })
  }
  constraints.push({
    label: 'success',
    pattern: implementation.returnType.type,
    actual: contract.success._tag === 'Resolved' ? contract.success.type : 'never',
  })
  const covered = new Set(
    constraints.flatMap((constraint) => [
      ...Type.parameters(constraint.pattern).map(Type.key),
      ...Type.freeLifetimes(constraint.pattern).map(Lifetime.key),
    ]),
  )
  // A witness binder that occurs only in its written retained environment is determined by the
  // promised environment: structural matching binds it only when the written environment is
  // exactly that region. Anything else, such as an intersection of several free binders against
  // one promised region, fails inference and the mapping stays rejected. Compatibility itself is
  // unchanged; this only names the binder.
  const environment = implementation.lifetimeElaboration?.explicitEnvironment
  if (
    environment !== undefined &&
    contract.functionKind === 'Effect' &&
    binders.some((binder) => !covered.has(Type.key(binder)))
  ) {
    constraints.push({
      label: 'environment',
      pattern: Type.effect(Type.unit, [], { environment, lifetimeBinders: [] }),
      actual: Type.effect(Type.unit, [], {
        environment: contract.lifetimes.environment,
        lifetimeBinders: [],
      }),
    })
    for (const atom of Lifetime.atoms(environment)) covered.add(Lifetime.key(atom))
  }
  if (binders.some((binder) => !covered.has(Type.key(binder))))
    constraints.push({
      label: 'failure and requirement rows',
      pattern: Type.effectWithRows(
        Type.unit,
        implementation.failureRow.row,
        { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
        'Shared',
        implementation.requirementRow.row,
      ),
      actual: Type.effectWithRows(
        Type.unit,
        contract.failureRow.row,
        { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
        'Shared',
        contract.requirementRow.row,
      ),
    })
  return InterfaceWitnessInference.infer(binders, constraints)
}

const compatibilityOperand = (
  parameter: ParameterFact,
  type: Type.Type,
  provider: Type.Type,
): InterfaceWitnessCompatibility.Operand => ({
  name: parameter.name._tag === 'Present' ? parameter.name.spelling : '_',
  type,
  receiver: Type.equals(Type.isReference(type) ? type.target : type, provider),
})

/** Checks one source witness against the complete applied interface contract it will implement. */
export const interfaceWitnessCompatibility = (
  contract: InterfaceOperationApplicationFact | undefined,
  implementation: DeclarationFact,
  substitution: Type.Substitution,
  conformanceParameters: ReadonlyArray<TypeParameterFact>,
): InterfaceWitnessCompatibility.Compatibility | undefined => {
  if (contract === undefined || contract.success._tag !== 'Resolved') return undefined
  const writtenLifetimes = (
    parameters: ReadonlyArray<TypeParameterFact>,
  ): Type.ExecutableLifetimes => ({
    environment: Lifetime.staticLifetime,
    lifetimeBinders: parameters.flatMap((parameter) =>
      parameter.type.kind === 'Lifetime'
        ? [Lifetime.bound(parameter.type.owner, parameter.type.ordinal, parameter.type.name)]
        : [],
    ),
    lifetimeBounds: parameters.flatMap((parameter) =>
      parameter.type.kind === 'Lifetime'
        ? (parameter.lifetimeBounds ?? []).map((shorter) => ({
            longer: Lifetime.bound(
              parameter.type.owner,
              parameter.type.ordinal,
              parameter.type.name,
            ),
            shorter,
          }))
        : [],
    ),
    typeOutlives: parameters.flatMap((parameter) => {
      const argument = Type.parameterArgument(parameter.type)
      let type: Type.Type | undefined
      if (Type.isTypeArgument(argument)) type = argument
      else if (Type.isRepresentationArgument(argument)) type = Type.representedType(argument)
      return type === undefined
        ? []
        : (parameter.lifetimeBounds ?? []).map((lifetime) => ({ type, lifetime }))
    }),
  })
  const expectedLifetimes = contract.lifetimes
  const actualLifetimes = writtenLifetimes(implementation.typeParameters)
  const conformanceLifetimes = writtenLifetimes(conformanceParameters)
  const lifetimeCompatibility = InterfaceWitnessCompatibility.lifetimeContract(
    expectedLifetimes,
    {
      ...actualLifetimes,
      lifetimeBinders: expectedLifetimes.lifetimeBinders,
      lifetimeBounds: (actualLifetimes.lifetimeBounds ?? []).map((bound) => ({
        longer: Type.substituteLifetime(bound.longer, substitution),
        shorter: Type.substituteLifetime(bound.shorter, substitution),
      })),
      typeOutlives: (actualLifetimes.typeOutlives ?? []).map((bound) => ({
        type: Type.substitute(bound.type, substitution),
        lifetime: Type.substituteLifetime(bound.lifetime, substitution),
      })),
    },
    TypeCompatibility.context({
      assumptions: Lifetime.assumptions(conformanceLifetimes.lifetimeBounds ?? []),
      typeBounds: conformanceLifetimes.typeOutlives ?? [],
    }),
  )
  if (lifetimeCompatibility._tag === 'Incompatible') return lifetimeCompatibility
  if (contract.functionKind === 'Effect' && implementation.functionKind === 'Effect') {
    // An owned operand lent to this witness stays with the adapter for the whole invocation, so
    // exactly that rigid borrow does not shorten the promised environment. It still cannot escape
    // through the success value, which the operand and success checks below compare as written.
    const lent = Lifetime.key(witnessBorrow(implementation))
    const witnessEnvironment = Lifetime.intersection(
      Lifetime.atoms(
        Type.substituteLifetime(executableLifetimes(implementation).environment, substitution),
      ).filter((atom) => Lifetime.key(atom) !== lent),
    )
    const environmentCompatibility = InterfaceWitnessCompatibility.environment(
      contract.lifetimes.environment,
      witnessEnvironment,
      // The promised retained bounds (each captured region outlives the environment) hold here.
      TypeCompatibility.context({
        assumptions: Lifetime.assumptions([
          ...(conformanceLifetimes.lifetimeBounds ?? []),
          ...(expectedLifetimes.lifetimeBounds ?? []),
        ]),
        typeBounds: [
          ...(conformanceLifetimes.typeOutlives ?? []),
          ...(expectedLifetimes.typeOutlives ?? []),
        ],
      }),
    )
    if (environmentCompatibility._tag === 'Incompatible') return environmentCompatibility
  }
  const contractOperands = contract.operands.flatMap((operand) =>
    operand.type._tag === 'Resolved'
      ? [compatibilityOperand(operand.parameter, operand.type.type, contract.provider)]
      : [],
  )
  const witnessOperands = implementation.parameters.flatMap((parameter) =>
    parameter.declaredType._tag === 'Resolved'
      ? [
          compatibilityOperand(
            parameter,
            Type.substitute(parameter.declaredType.type, substitution),
            contract.provider,
          ),
        ]
      : [],
  )
  if (
    contractOperands.length !== contract.operands.length ||
    witnessOperands.length !== implementation.parameters.length ||
    implementation.returnType._tag !== 'Resolved'
  )
    return undefined
  const witnessRows = Type.substitute(
    Type.effectWithRows(
      Type.unit,
      implementation.failureRow.row,
      { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
      'Shared',
      implementation.requirementRow.row,
    ),
    substitution,
  )
  if (!Type.isEffect(witnessRows)) return undefined
  return InterfaceWitnessCompatibility.check(
    {
      functionKind: contract.functionKind,
      unsafe: contract.unsafe,
      operands: contractOperands,
      success: contract.success.type,
      failures: [
        ...contract.failureRow.failures,
        ...Type.failureMemberParameters(contract.failureRow.row),
      ],
      requirements: contract.requirementRow.requirements,
      requirementParameters: contract.requirementRow.parameters,
    },
    {
      functionKind: implementation.functionKind,
      unsafe: implementation.unsafe,
      operands: witnessOperands,
      success: Type.substitute(implementation.returnType.type, substitution),
      failures: [...Type.failureMembers(witnessRows), ...Type.failureMemberParameters(witnessRows)],
      requirements: Type.requirementMembers(witnessRows),
      requirementParameters: Type.requirementRowParameters(witnessRows),
    },
  )
}

/** Checks a sealed witness against the interface's literal operand ownership contract. */
export const sealedWitnessCompatibility = (
  contract: InterfaceOperationApplicationFact | undefined,
  parameters: ReadonlyArray<Type.Type>,
  result: Type.Type,
): InterfaceWitnessCompatibility.Compatibility | undefined => {
  if (contract === undefined || contract.success._tag !== 'Resolved') return undefined
  const operands = contract.operands.flatMap((operand) =>
    operand.type._tag === 'Resolved'
      ? [compatibilityOperand(operand.parameter, operand.type.type, contract.provider)]
      : [],
  )
  if (operands.length !== contract.operands.length) return undefined
  return InterfaceWitnessCompatibility.check(
    {
      functionKind: contract.functionKind,
      unsafe: contract.unsafe,
      operands: operands,
      success: contract.success.type,
      failures: [
        ...contract.failureRow.failures,
        ...Type.failureMemberParameters(contract.failureRow.row),
      ],
      requirements: contract.requirementRow.requirements,
      requirementParameters: contract.requirementRow.parameters,
    },
    {
      functionKind: 'Ordinary',
      unsafe: false,
      operands: parameters.map((type, ordinal) => ({
        name: operands.at(ordinal)?.name ?? '_',
        type,
        receiver: false,
      })),
      success: result,
      failures: [],
      requirements: [],
      requirementParameters: [],
    },
  )
}

/** Finds the first implementation bound the conformance header never promises. */
export const unpromisedWitnessBound = (
  binding: ReturnType<typeof witnessBinding>,
  arguments_: ReadonlyArray<Type.GenericArgument>,
  conformance: ConformanceFact,
): { readonly binder: TypeParameterFact; readonly bound: BoundFact } | undefined => {
  for (const [position, binder] of binding.binders.entries()) {
    const argument = arguments_.at(position)
    const header =
      argument !== undefined && Type.isTypeArgument(argument) && Type.isParameter(argument)
        ? conformance.typeParameters.find((parameter) => Type.equals(parameter.type, argument))
            ?.type
        : undefined
    for (const bound of binder.bounds) {
      if (bound._tag !== 'ResolvedBound') return { binder, bound }
      if (
        header === undefined ||
        !conformance.requirements.some(
          (requirement) =>
            requirement.capability._tag === 'Resolved' &&
            Type.isNominal(requirement.capability.type) &&
            requirement.capability.type.module === bound.application.capability.module &&
            requirement.capability.type.name === bound.application.capability.name &&
            Type.equals(requirement.parameter, header),
        )
      )
        return { binder, bound }
    }
  }
  return undefined
}

/**
 * Finds the first `where` constraint of a witness that neither the conformance head nor the
 * implemented operation promises. `substitution` maps the witness's binders onto the head.
 */
export const unpromisedWitnessConstraint = (
  implementation: DeclarationFact,
  substitution: Type.Substitution,
  givens: ReadonlyArray<Constraint.Constraint>,
): Constraint.Constraint | undefined =>
  implementation.constraintContracts
    .map((constraint) => Constraint.substitute(constraint, substitution))
    .find((constraint) => !Constraint.isImplied(constraint, givens))

/** Resolves one retained type fact through a supplied module resolver and complete index. */
export const resolveTypeFact = (
  spanOf: SpanOf,
  index: Index,
  module: string,
  fact: DeclaredTypeFact,
  resolver: TypeResolver,
): TypeResolution =>
  resolveDeclaredType(
    spanOf,
    module,
    fact,
    ResolutionSeams.make(resolver, () => ({ _tag: 'Missing' })),
    index.modules,
  )

/** Resolves a construction argument with its declared kind before normalizing value unions. */
export const resolveGenericArgumentFact = (
  spanOf: SpanOf,
  index: Index,
  module: string,
  fact: DeclaredTypeFact,
  parameter: Type.Parameter | undefined,
  resolver: TypeResolver,
): GenericArgumentResolution =>
  resolveGenericArgument(
    spanOf,
    module,
    fact,
    parameter,
    ResolutionSeams.make(resolver, () => ({ _tag: 'Missing' })),
    index.modules,
  )

const resolveRequirementRole = (
  spanOf: SpanOf,
  module: string,
  role: RequirementRoleFact,
  resolvers: ResolutionSeams.ResolutionSeams,
): {
  readonly fact: RequirementRoleFact
  readonly diagnostics: ReadonlyArray<Diagnostic.Located>
} => {
  if (role._tag !== 'UnresolvedRole') return { fact: role, diagnostics: [] }
  const resolution = resolvers.item(module, role.path)
  let declaration: MemberFact | undefined
  if (resolution._tag === 'Resolved' || resolution._tag === 'Inaccessible') {
    declaration = resolution.declaration
  } else if (resolution._tag === 'Unavailable') {
    declaration = resolution.declaration
  } else {
    declaration = undefined
  }
  if (
    resolution._tag === 'Resolved' &&
    declaration?._tag === 'RoleDeclaration' &&
    declaration.canonical._tag === 'Canonical'
  )
    return {
      fact: {
        _tag: 'ResolvedRole',
        role: RequirementRow.declaredRole(
          declaration.canonical.id.module,
          declaration.canonical.id.name,
        ),
        path: role.path,
        declaration: declaration.canonical.id,
      },
      diagnostics: [],
    }
  return {
    fact: role,
    diagnostics: [
      Diagnostic.invalidRequirementType(
        `role ${role.path.spelling}`,
        Location.at(role.path.anchor),
      ),
    ],
  }
}

const resolveRowExpressionDecision = (
  spanOf: SpanOf,
  module: string,
  fact: RowExpressionDecision,
  resolvers: ResolutionSeams.ResolutionSeams,
  modules: ReadonlyArray<ModuleHeaders>,
): {
  readonly fact: RowExpressionDecision
  readonly diagnostics: ReadonlyArray<Diagnostic.Located>
} => {
  switch (fact._tag) {
    case 'EmptyRowExpression':
    case 'RowParameterExpression':
    case 'UnavailableRowExpression':
      return { fact, diagnostics: [] }
    case 'FailureMemberExpression': {
      const member = resolveDeclaredType(spanOf, module, fact.member, resolvers, modules)
      return {
        fact: { ...fact, member: member.fact },
        diagnostics: member.diagnostics,
      }
    }
    case 'RequirementMemberExpression': {
      const capability = resolveDeclaredType(spanOf, module, fact.capability, resolvers, modules)
      const role = resolveRequirementRole(spanOf, module, fact.role, resolvers)
      return {
        fact: { ...fact, capability: capability.fact, role: role.fact },
        diagnostics: [...capability.diagnostics, ...role.diagnostics],
      }
    }
    case 'UnionRowExpression': {
      const operands = fact.operands.map((operand) =>
        resolveRowExpressionDecision(spanOf, module, operand, resolvers, modules),
      )
      return {
        fact: {
          ...fact,
          operands: operands.map((operand) => operand.fact),
        },
        diagnostics: operands.flatMap((operand) => operand.diagnostics),
      }
    }
    case 'WithoutRowExpression': {
      const source = resolveRowExpressionDecision(spanOf, module, fact.source, resolvers, modules)
      const selected = resolveRowExpressionDecision(
        spanOf,
        module,
        fact.selected,
        resolvers,
        modules,
      )
      return {
        fact: { ...fact, source: source.fact, selected: selected.fact },
        diagnostics: [...source.diagnostics, ...selected.diagnostics],
      }
    }
  }
}

export const resolveConstraintFacts = (
  spanOf: SpanOf,
  module: string,
  constraints: ReadonlyArray<ConstraintFact>,
  resolvers: ResolutionSeams.ResolutionSeams,
  modules: ReadonlyArray<ModuleHeaders>,
): {
  readonly facts: ReadonlyArray<ConstraintFact>
  readonly diagnostics: ReadonlyArray<Diagnostic.Located>
} => {
  const diagnostics: Array<Diagnostic.Located> = []
  const facts = constraints.map((constraint): ConstraintFact => {
    const selected = resolveRowExpressionDecision(
      spanOf,
      module,
      constraint.selected,
      resolvers,
      modules,
    )
    const source = resolveRowExpressionDecision(
      spanOf,
      module,
      constraint.source,
      resolvers,
      modules,
    )
    diagnostics.push(...selected.diagnostics, ...source.diagnostics)
    if (constraint._tag === 'MembershipConstraint')
      return { ...constraint, selected: selected.fact, source: source.fact }
    const provider = resolveDeclaredType(spanOf, module, constraint.provider, resolvers, modules)
    diagnostics.push(...provider.diagnostics)
    return {
      ...constraint,
      provider: provider.fact,
      selected: selected.fact,
      source: source.fact,
    }
  })
  return { facts: facts, diagnostics: diagnostics }
}

const semanticFailureRow = (spanOf: SpanOf, fact: RowExpressionDecision): Type.FailureRow => {
  switch (fact._tag) {
    case 'EmptyRowExpression':
    case 'RequirementMemberExpression':
    case 'UnavailableRowExpression':
      return RowAlgebra.concrete(Type.failureRowPolicy(), [])
    case 'RowParameterExpression':
      return RowAlgebra.concrete(Type.failureRowPolicy(), [])
    case 'FailureMemberExpression':
      if (fact.member._tag !== 'Resolved') return RowAlgebra.concrete(Type.failureRowPolicy(), [])
      if (Type.isParameter(fact.member.type) && fact.member.type.kind === 'Value')
        return RowAlgebra.singleton(
          Type.failureRowPolicy(),
          Type.failureMemberShape(fact.member.type),
          spanOf(fact.anchor),
        )
      return Type.isFailureValue(fact.member.type)
        ? RowAlgebra.concrete(Type.failureRowPolicy(), Type.failureLeaves(fact.member.type))
        : RowAlgebra.concrete(Type.failureRowPolicy(), [])
    case 'UnionRowExpression':
      return fact.operands.reduce<Type.FailureRow>(
        (row, operand) =>
          RowAlgebra.union(Type.failureRowPolicy(), row, semanticFailureRow(spanOf, operand)),
        RowAlgebra.concrete(Type.failureRowPolicy(), []),
      )
    case 'WithoutRowExpression':
      return RowAlgebra.without(
        Type.failureRowPolicy(),
        semanticFailureRow(spanOf, fact.source),
        semanticFailureRow(spanOf, fact.selected),
      )
  }
}

const semanticRequirementRow = (
  spanOf: SpanOf,
  fact: RowExpressionDecision,
): Type.RequirementsRow => {
  switch (fact._tag) {
    case 'EmptyRowExpression':
    case 'FailureMemberExpression':
    case 'UnavailableRowExpression':
      return RowAlgebra.concrete(Type.requirementRowPolicy(), [])
    case 'RowParameterExpression':
      return fact.parameter.kind === 'RequirementRow'
        ? RowAlgebra.parameter<Type.Requirement, Type.Parameter, Type.RequirementMemberShape>(
            fact.parameter,
          )
        : RowAlgebra.concrete(Type.requirementRowPolicy(), [])
    case 'RequirementMemberExpression': {
      if (fact.capability._tag !== 'Resolved')
        return RowAlgebra.concrete(Type.requirementRowPolicy(), [])
      const role = requirementRoleIdentity(fact.role)
      if (role === undefined) return RowAlgebra.concrete(Type.requirementRowPolicy(), [])
      if (Type.isNominal(fact.capability.type))
        return RowAlgebra.concrete(Type.requirementRowPolicy(), [
          {
            capability: fact.capability.type,
            access: fact.access,
            role,
          },
        ])
      if (Type.isParameter(fact.capability.type) && fact.capability.type.kind === 'Value')
        return RowAlgebra.singleton(
          Type.requirementRowPolicy(),
          Type.requirementMemberShape(fact.capability.type, fact.access, role),
          spanOf(fact.anchor),
        )
      return RowAlgebra.concrete(Type.requirementRowPolicy(), [])
    }
    case 'UnionRowExpression':
      return fact.operands.reduce<Type.RequirementsRow>(
        (row, operand) =>
          RowAlgebra.union(
            Type.requirementRowPolicy(),
            row,
            semanticRequirementRow(spanOf, operand),
          ),
        RowAlgebra.concrete(Type.requirementRowPolicy(), []),
      )
    case 'WithoutRowExpression':
      return RowAlgebra.without(
        Type.requirementRowPolicy(),
        semanticRequirementRow(spanOf, fact.source),
        semanticRequirementRow(spanOf, fact.selected),
      )
  }
}

export const semanticConstraints = (
  spanOf: SpanOf,
  constraints: ReadonlyArray<ConstraintFact>,
): ReadonlyArray<Constraint.Constraint> =>
  constraints.flatMap((constraint): ReadonlyArray<Constraint.Constraint> => {
    if (constraint._tag === 'ProviderConstraint') {
      if (constraint.provider._tag !== 'Resolved') return []
      const provider = Type.isReference(constraint.provider.type)
        ? constraint.provider.type.target
        : constraint.provider.type
      return [
        Constraint.providerSelection(
          constraint.mode,
          provider,
          semanticRequirementRow(spanOf, constraint.selected),
          semanticRequirementRow(spanOf, constraint.source),
        ),
      ]
    }
    if (constraint.domain === 'Requirement')
      return [
        Constraint.requirementSubset(
          semanticRequirementRow(spanOf, constraint.selected),
          semanticRequirementRow(spanOf, constraint.source),
        ),
      ]
    return [
      Constraint.failureSubset(
        semanticFailureRow(spanOf, constraint.selected),
        semanticFailureRow(spanOf, constraint.source),
      ),
    ]
  })

export const resolveFailureRow = (
  spanOf: SpanOf,
  module: string,
  row: FailureRowFact,
  resolvers: ResolutionSeams.ResolutionSeams,
  modules: ReadonlyArray<ModuleHeaders>,
): {
  readonly fact: FailureRowFact
  readonly diagnostics: ReadonlyArray<Diagnostic.Located>
} => {
  if (row.anchor === undefined) return { fact: row, diagnostics: [] }
  const diagnostics: Array<Diagnostic.Located> = []
  const expression = resolveRowExpressionDecision(
    spanOf,
    module,
    row.expression,
    resolvers,
    modules,
  )
  // Legacy member facts and the symbolic expression share the same source nodes. Resolve the
  // expression for semantic shape, while the member pass below remains the single diagnostic owner.
  const members = row.members.map((member) => {
    const resolved = resolveDeclaredType(spanOf, module, member, resolvers, modules)
    diagnostics.push(...resolved.diagnostics)
    return resolved.fact
  })
  const failures = new Map<string, Type.Type>()
  let available = row.parameters.length === 0
  for (const member of members) {
    if (member._tag !== 'Resolved' || !Type.isFailureValue(member.type)) {
      available = false
      if (member._tag === 'Resolved')
        diagnostics.push(
          Diagnostic.invalidFailureType(Type.encode(member.type), Location.at(member.anchor)),
        )
      continue
    }
    if (!Type.isParameter(member.type))
      for (const leaf of Type.failureLeaves(member.type)) failures.set(Type.key(leaf), leaf)
  }
  return {
    fact: {
      ...row,
      members: members,
      failures: [...failures.values()].sort(Type.compare),
      expression: expression.fact,
      row: semanticFailureRow(spanOf, expression.fact),
      available,
    },
    diagnostics: diagnostics,
  }
}

export const resolveRequirementRow = (
  spanOf: SpanOf,
  module: string,
  row: RequirementRowFact,
  resolvers: ResolutionSeams.ResolutionSeams,
  modules: ReadonlyArray<ModuleHeaders>,
): {
  readonly fact: RequirementRowFact
  readonly diagnostics: ReadonlyArray<Diagnostic.Located>
} => {
  if (row.anchor === undefined) return { fact: row, diagnostics: [] }
  const diagnostics: Array<Diagnostic.Located> = []
  const expression = resolveRowExpressionDecision(
    spanOf,
    module,
    row.expression,
    resolvers,
    modules,
  )
  // The entry pass below owns diagnostics for these same source nodes.
  const entries = row.entries.map((entry) => {
    const capability = resolveDeclaredType(spanOf, module, entry.capability, resolvers, modules)
    const role = resolveRequirementRole(spanOf, module, entry.role, resolvers)
    diagnostics.push(...capability.diagnostics, ...role.diagnostics)
    return { ...entry, capability: capability.fact, role: role.fact }
  })
  const requirements: Array<Type.Requirement> = []
  let available = row.parameters.length === 0
  for (const entry of entries) {
    if (
      entry.capability._tag === 'Resolved' &&
      requirementRoleIdentity(entry.role) !== undefined &&
      ((Type.isNominal(entry.capability.type) &&
        dependencyEligible(modules, entry.capability.type)) ||
        (Type.isParameter(entry.capability.type) && entry.capability.type.kind === 'Value'))
    ) {
      requirements.push({
        capability: entry.capability.type,
        role: requirementRoleIdentity(entry.role) ?? RequirementRow.defaultRole,
        access: entry.access,
      })
    } else {
      available = false
      if (entry.capability._tag === 'Resolved')
        diagnostics.push(
          Diagnostic.invalidRequirementType(
            Type.encode(entry.capability.type),
            Location.at(entry.anchor),
          ),
        )
    }
  }
  const normalized = Type.requirementMembers(
    Type.effect(
      'never',
      [],
      { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
      'Shared',
      requirements,
    ),
  )
  return {
    fact: {
      ...row,
      entries: entries,
      requirements: normalized,
      expression: expression.fact,
      row: semanticRequirementRow(spanOf, expression.fact),
      available,
    },
    diagnostics: diagnostics,
  }
}

export const attachExposure = (
  spanOf: SpanOf,
  fact: DeclaredTypeFact,
  modules: ReadonlyArray<ModuleHeaders>,
  diagnostics: Array<Diagnostic.Located>,
): DeclaredTypeFact => {
  if (fact._tag !== 'Resolved') return fact
  // An exact representation names a callable declaration rather than a nominal, so the private
  // leak it can create is invisible to the nominal walk below and is reported on its own terms.
  const leaked = Type.exactRepresentationDeclarations(fact.type).find((target) => {
    const owner = modules.find((candidate) => candidate.module === target.module)
    const found = lookupDeclaration(owner?.declarations ?? [], target.name)
    return found._tag === 'Resolved' && found.declaration.visibility === 'Private'
  })
  if (leaked !== undefined) {
    const diagnostic = Diagnostic.privateExactRepresentationLeak(
      leaked.name,
      Location.at(fact.anchor),
    )
    diagnostics.push(diagnostic)
    return { ...fact, exposureCause: Diagnostic.identity(diagnostic) }
  }
  const nominal = Type.nominals(fact.type).find(
    (candidate) => memberByNominal(modules, candidate)?.visibility === 'Private',
  )
  if (nominal === undefined) return fact
  const target = memberByNominal(modules, nominal)
  if (target?.visibility !== 'Private') return fact
  const diagnostic = Diagnostic.privateTypeExposure(Type.encode(nominal), Location.at(fact.anchor))
  diagnostics.push(diagnostic)
  return { ...fact, exposureCause: Diagnostic.identity(diagnostic) }
}

/**
 * The type parameters each canonical struct reaches inline, keyed by canonical struct key. A
 * parameter absent from a struct's set is one the struct only ever holds behind an indirection.
 * A struct missing from the map is one this index cannot see, and its arguments are all treated
 * as inline.
 */
type InlineParameters = ReadonlyMap<string, ReadonlySet<number>>

/**
 * Walks the nominals and parameters whose layout one type's layout actually requires.
 *
 * A struct embeds its fields, so a field reaches everything its type names outside an indirecting
 * position. `RawBuffer<T>`, `Slot<T>`, and `SharedCore<T>` are compiler-owned indirections: their
 * representations do not embed `T`, so the walk names them and stops rather than descending into
 * the element. Every other nominal is entered only through the arguments its own declaration
 * reaches inline, which `inlineParameters` supplies.
 * References and slices store addresses, so their pointee layouts are also indirect. Arrays,
 * callables, effects, and unions descend exactly as `Type.nominals` does, so this graph is
 * narrower than the reported dependency graph and never wider.
 */
const inlineReach = (
  self: Type.Type,
  inlineParameters: InlineParameters,
  visit: (reached: Type.Nominal | Type.Parameter) => void,
): void => {
  const descend = (type: Type.Type): void => {
    if (Type.isNominal(type)) {
      visit(type)
      if (
        Type.isRawBuffer(type) ||
        Type.isSlot(type) ||
        Type.isSharedCore(type) ||
        Type.isExecution(type)
      )
        return
      const inline = inlineParameters.get(`${type.module}.${type.name}`)
      for (const [ordinal, argument] of type.arguments.entries())
        if ((inline === undefined || inline.has(ordinal)) && Type.isTypeArgument(argument))
          descend(argument)
      return
    }
    if (Type.isParameter(type)) {
      visit(type)
      return
    }
    if (Type.isFixedArray(type)) {
      descend(type.element)
      return
    }
    if (Type.isReference(type) || Type.isSlice(type)) return
    // A raw pointer is one address; its layout never embeds the pointee.
    if (Type.isPointer(type)) return
    // A C function pointer is likewise one address; its signature does not embed its types.
    if (Type.isForeignFunction(type)) return
    if (Type.isCallable(type)) {
      for (const parameter of type.parameters) descend(parameter)
      descend(type.result)
      return
    }
    if (Type.isEffect(type)) {
      descend(type.success)
      for (const failure of Type.failureMembers(type)) descend(failure)
      for (const requirement of Type.requirementMembers(type)) descend(requirement.capability)
      return
    }
    if (Type.isUnion(type)) for (const member of type.members) descend(member)
  }
  descend(self)
}

/**
 * The monotone least fixed point of "struct `S` reaches its own parameter `i` inline".
 *
 * Every parameter starts indirected. A round marks a parameter inline as soon as one of the
 * struct's own fields reaches it under `inlineReach`, and marking a parameter can only open more
 * descents, so the sets only grow and the loop terminates. Because it is the least fixed point,
 * the answer does not depend on the order structs or modules arrive in.
 */
type InlineAggregateFact = StructFact | UnionFact

const aggregateFields = (self: InlineAggregateFact): ReadonlyArray<FieldFact> =>
  self._tag === 'StructDeclaration'
    ? self.fields
    : self.variants.flatMap((variant) => variant.fields)

export const inlineParametersOf = (
  aggregates: ReadonlyArray<InlineAggregateFact>,
): InlineParameters => {
  const declarations = new Map<string, InlineAggregateFact>()
  for (const aggregate of aggregates)
    if (aggregate.canonical._tag === 'Canonical')
      declarations.set(canonicalKey(aggregate.canonical.id), aggregate)
  const inline = new Map<string, Set<number>>()
  for (const key of declarations.keys()) inline.set(key, new Set())
  for (let growing = true; growing;) {
    growing = false
    for (const [key, aggregate] of declarations) {
      const reached = inline.get(key)
      if (reached === undefined || aggregate.typeParameters.length === 0) continue
      // Keyed by position, matching how `TypeInference.substitution` binds arguments to parameters.
      const own = new Map(
        aggregate.typeParameters.map(
          (parameter, position) => [Type.key(parameter.type), position] as const,
        ),
      )
      for (const field of aggregateFields(aggregate)) {
        if (field.declaredType._tag !== 'Resolved') continue
        inlineReach(field.declaredType.type, inline, (member) => {
          if (!Type.isParameter(member)) return
          const ordinal = own.get(Type.key(member))
          if (ordinal === undefined || reached.has(ordinal)) return
          reached.add(ordinal)
          growing = true
        })
      }
    }
  }
  return inline
}

/** Names every canonical struct one field reaches inline, for cycle detection only. */
export const inlineNeighbors = (
  field: FieldFact,
  inlineParameters: InlineParameters,
): ReadonlyArray<string> => {
  if (field.declaredType._tag !== 'Resolved') return []
  const reached: Array<string> = []
  inlineReach(field.declaredType.type, inlineParameters, (member) => {
    if (Type.isParameter(member)) return
    reached.push(`${member.module}.${member.name}`)
  })
  return reached
}

export const stronglyConnected = (
  aggregates: ReadonlyArray<InlineAggregateFact>,
  inlineParameters: InlineParameters,
): ReadonlyArray<ReadonlyArray<InlineAggregateFact>> => {
  const canonical = aggregates
    .filter((aggregate) => aggregate.canonical._tag === 'Canonical')
    .sort((left, right) => {
      const leftId = left.canonical._tag === 'Canonical' ? left.canonical.id : undefined
      const rightId = right.canonical._tag === 'Canonical' ? right.canonical.id : undefined
      return leftId === undefined || rightId === undefined
        ? 0
        : canonicalKey(leftId).localeCompare(canonicalKey(rightId))
    })
  const byKey = new Map(
    canonical.flatMap((aggregate) =>
      aggregate.canonical._tag === 'Canonical'
        ? [[canonicalKey(aggregate.canonical.id), aggregate] as const]
        : [],
    ),
  )
  return Graph.stronglyConnected(byKey.keys(), (key) => {
    const aggregate = byKey.get(key)
    return (aggregate === undefined ? [] : aggregateFields(aggregate))
      .flatMap((field) => inlineNeighbors(field, inlineParameters))
      .filter((neighbor) => byKey.has(neighbor))
      .sort()
  }).map((component) =>
    component
      .flatMap((memberKey) => {
        const member = byKey.get(memberKey)
        return member === undefined ? [] : [member]
      })
      .sort((left, right) => {
        if (left.canonical._tag !== 'Canonical' || right.canonical._tag !== 'Canonical') return 0
        return canonicalKey(left.canonical.id).localeCompare(canonicalKey(right.canonical.id))
      }),
  )
}

export const resolveOpaqueResult = (
  spanOf: SpanOf,
  module: string,
  opaqueResult: OpaqueResultFact | undefined,
  resolvers: ResolutionSeams.ResolutionSeams,
  modules: ReadonlyArray<ModuleHeaders>,
  diagnostics: Array<Diagnostic.Located>,
): OpaqueResultFact | undefined => {
  if (opaqueResult === undefined) return undefined
  const binder = resolveBounds(
    spanOf,
    module,
    [opaqueResult.binder],
    resolvers,
    modules,
    diagnostics,
  ).at(0)
  if (binder === undefined) return undefined
  if (binder.type.kind !== 'CallableRepresentation' && binder.type.kind !== 'EffectRepresentation')
    diagnostics.push(
      Diagnostic.invalidOpaqueResultBinder(
        binder.name._tag === 'Present' ? binder.name.spelling : binder.type.name,
        binder.type.kind,
        Location.at(binder.anchor),
      ),
    )
  return { ...opaqueResult, binder }
}

const opaqueEnclosingArgument = (parameter: Type.Parameter): Type.GenericArgument => {
  if (parameter.kind === 'RequirementRow') return Type.requirementRowArgument([], [parameter])
  if (parameter.kind === 'CallableRepresentation' || parameter.kind === 'EffectRepresentation')
    return Type.representationParameterArgument(parameter)
  return parameter
}

export const closeOpaqueReturnType = (
  fact: ReturnTypeFact,
  opaqueResult: OpaqueResultFact | undefined,
  enclosing: ReadonlyArray<TypeParameterFact>,
): { readonly fact: ReturnTypeFact; readonly opaqueResult?: OpaqueResultFact } => {
  const bound = opaqueResult?.binder.type.representationBound
  if (fact._tag !== 'Resolved' || opaqueResult === undefined || bound === undefined)
    return { fact, ...(opaqueResult === undefined ? {} : { opaqueResult }) }
  const argument = Type.opaqueRepresentationArgument(
    opaqueResult.family,
    bound,
    enclosing.map((parameter) => opaqueEnclosingArgument(parameter.type)),
  )
  const closed = Type.substitute(
    fact.type,
    new Map([[Type.key(opaqueResult.binder.type), argument]]),
  )
  return {
    fact: { ...fact, type: closed, spelling: Type.encode(closed) },
    opaqueResult: {
      ...opaqueResult,
      publicSignature: {
        bound: Type.key(bound),
        result: Type.key(closed),
        enclosingKinds: enclosing.map((parameter) => parameter.type.kind),
      },
    },
  }
}

/** Resolves all retained type paths and validates public exposure and inline dependencies. */
