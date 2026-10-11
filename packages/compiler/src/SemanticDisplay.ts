import * as ForeignContract from './ForeignContract.js'
import * as DeclarationFacts from './DeclarationFacts.js'
import type * as Elaboration from './Elaboration.js'
import type * as Intrinsic from './Intrinsic.js'
import * as IntrinsicCatalog from './Intrinsic.js'
import type * as NameResolution from './NameResolution.js'
import * as Lifetime from './Lifetime.js'
import * as RequirementRow from './RequirementRow.js'
import * as RowAlgebra from './RowAlgebra.js'
import * as Type from './Type.js'
import * as TypeInference from './internal/TypeInference.js'

interface Base {
  readonly text: string
  readonly lifetimeRequirements?: ReadonlyArray<string>
}

export type Presentation =
  | (Base & {
      readonly _tag: 'FunctionPresentation'
      readonly name: string
      readonly functionKind: DeclarationFacts.DeclarationFact['functionKind']
    })
  | (Base & { readonly _tag: 'StructPresentation'; readonly name: string })
  | (Base & { readonly _tag: 'UnionPresentation'; readonly name: string })
  | (Base & { readonly _tag: 'UnionVariantPresentation'; readonly name: string })
  | (Base & { readonly _tag: 'EnumPresentation'; readonly name: string })
  | (Base & { readonly _tag: 'EnumMemberPresentation'; readonly name: string })
  | (Base & { readonly _tag: 'EnumOperationPresentation'; readonly name: string })
  | (Base & { readonly _tag: 'ServicePresentation'; readonly name: string })
  | (Base & { readonly _tag: 'RolePresentation'; readonly name: string })
  | (Base & { readonly _tag: 'ServiceOperationPresentation'; readonly name: string })
  | (Base & { readonly _tag: 'ConstantPresentation'; readonly name: string })
  | (Base & { readonly _tag: 'AliasPresentation'; readonly name: string })
  | (Base & { readonly _tag: 'ParameterPresentation'; readonly name: string })
  | (Base & { readonly _tag: 'TypeParameterPresentation'; readonly name: string })
  | (Base & { readonly _tag: 'FieldPresentation'; readonly name: string })
  | (Base & {
      readonly _tag: 'BindingPresentation'
      readonly name: string
      readonly mutability: Elaboration.BindingDeclarationFact['mutability']
    })
  | (Base & { readonly _tag: 'AnonymousCallablePresentation' })
  | (Base & { readonly _tag: 'ImportPresentation'; readonly name: string })
  | (Base & { readonly _tag: 'IntrinsicActorPresentation'; readonly name: string })
  | (Base & {
      readonly _tag: 'IntrinsicOperationPresentation'
      readonly actor: string
      readonly name: string
    })
  | (Base & { readonly _tag: 'ExpressionTypePresentation' })

const declaredType = (fact: DeclarationFacts.DeclaredTypeFact): string =>
  fact._tag === 'Unavailable' ? '_' : fact.spelling

const requirementRole = (fact: DeclarationFacts.RequirementRoleFact): string => {
  switch (fact._tag) {
    case 'DefaultRole':
      return ''
    case 'UnresolvedRole':
    case 'ResolvedRole':
      return ` at ${fact.path.spelling}`
  }
}

const rowExpression = (fact: DeclarationFacts.RowExpressionDecision): string => {
  switch (fact._tag) {
    case 'EmptyRowExpression':
      return ''
    case 'RowParameterExpression':
      return fact.parameter.name
    case 'FailureMemberExpression':
      return declaredType(fact.member)
    case 'RequirementMemberExpression':
      return `${fact.access === 'Exclusive' ? '&mut ' : '&'}${declaredType(fact.capability)}${requirementRole(fact.role)}`
    case 'UnionRowExpression':
      return fact.operands.map(rowExpression).join(' | ')
    case 'WithoutRowExpression':
      return `Without<${rowExpression(fact.source)}, ${rowExpression(fact.selected)}>`
    case 'UnavailableRowExpression':
      return '_'
  }
}

const failureRow = (fact: DeclarationFacts.FailureRowFact): string => {
  const row = rowExpression(fact.expression)
  return row.length === 0 ? '' : ` ! ${row}`
}

const requirementRow = (fact: DeclarationFacts.RequirementRowFact): string => {
  const row = rowExpression(fact.expression)
  return row.length === 0 ? '' : ` ? ${row}`
}

const constraint = (fact: DeclarationFacts.ConstraintFact): string => {
  if (fact._tag === 'MembershipConstraint') {
    return `${rowExpression(fact.selected)} in ${rowExpression(fact.source)}`
  }
  let prefix = ''
  if (fact.mode === 'Exclusive') prefix = '&mut '
  else if (fact.mode === 'Shared') prefix = '&'
  return `${prefix}${declaredType(fact.provider)} provides ${rowExpression(fact.selected)} from ${rowExpression(fact.source)}`
}

const constraints = (facts: ReadonlyArray<DeclarationFacts.ConstraintFact>): string =>
  facts.length === 0 ? '' : ` where ${facts.map(constraint).join(', ')}`

const callableMode = (mode: Type.CallableMode): string => {
  if (mode === 'Exclusive') return 'mut fn'
  if (mode === 'Take') return 'once fn'
  return 'fn'
}

const captureAccess = (access: Elaboration.EffectCaptureFact['access']): string => {
  if (access === 'Copy') return 'Copy'
  if (access === 'Exclusive') return 'exclusive'
  if (access === 'Take') return 'moved'
  return 'shared'
}

/** Renders an anonymous contract and its derived environment without a synthetic declaration. */
export const anonymousCallable = (
  self: Elaboration.CallableSectionExpressionDecision,
  anonymous: NonNullable<Elaboration.CallableSectionExpressionDecision['anonymous']>,
): Presentation => {
  const declaration = self.reference._tag === 'Resolved' ? self.reference.declaration : undefined
  let parameters: ReadonlyArray<string>
  let result: string
  if (declaration !== undefined) {
    parameters = declaration.parameters
      .slice(0, self.remainingParameters.length)
      .map((parameter) => {
        const name = parameter.name._tag === 'Present' ? parameter.name.spelling : '_'
        return `${name}: ${declaredType(parameter.declaredType)}`
      })
    result = `${declaredType(declaration.returnType)}${failureRow(declaration.failureRow)}${requirementRow(declaration.requirementRow)}`
  } else if (self.type._tag === 'Available' && Type.isCallable(self.type.type)) {
    parameters = self.type.type.parameters.map(Type.encode)
    result = Type.encode(self.type.type.result)
  } else {
    parameters = []
    result = '_'
  }
  const captures = anonymous.captures.map((capture) => {
    const name = capture.reference.name._tag === 'Present' ? capture.reference.name.spelling : '_'
    return `${name} (${captureAccess(capture.access)})`
  })
  const contract = `${anonymous.functionKind === 'Effect' ? 'effect ' : ''}fn(${parameters.join(', ')}) -> ${result}`
  return {
    _tag: 'AnonymousCallablePresentation',
    lifetimeRequirements:
      self.type._tag === 'Available' ? lifetimeRequirements(self.type.type, '') : [],
    text: `${contract}\nmode: ${callableMode(self.mode)}\ncaptures: ${captures.length === 0 ? 'none' : captures.join(', ')}`,
  }
}

const typeParameterName = (parameter: DeclarationFacts.TypeParameterFact): string => {
  const name = parameter.name._tag === 'Present' ? parameter.name.spelling : '_'
  const bounds = parameter.lifetimeBounds ?? []
  return `${parameter.type.kind === 'RequirementRow' ? '?' : ''}${name}${bounds.length === 0 ? '' : `: ${bounds.map(Lifetime.display).join(' + ')}`}`
}

const executableParameterNames = (
  declaration: DeclarationFacts.DeclarationFact | DeclarationFacts.ServiceOperationFact,
  parameters: ReadonlyArray<DeclarationFacts.TypeParameterFact> = declaration.typeParameters,
): ReadonlyArray<string> => {
  const lifetimes = DeclarationFacts.executableLifetimes(declaration)
  const names = parameters.map((parameter) => {
    const argument = Type.parameterArgument(parameter.type)
    const additional = Lifetime.isLifetime(argument)
      ? (lifetimes.lifetimeBounds ?? [])
          .filter((bound) => Lifetime.equals(bound.longer, argument))
          .map((bound) => bound.shorter)
      : (lifetimes.typeOutlives ?? [])
          .filter((bound) => Type.key(bound.type) === Type.key(parameter.type))
          .map((bound) => bound.lifetime)
    const bounds = [
      ...new Map(
        [...(parameter.lifetimeBounds ?? []), ...additional].map((bound) => [
          Lifetime.key(bound),
          bound,
        ]),
      ).values(),
    ]
    return typeParameterName({ ...parameter, lifetimeBounds: bounds })
  })
  const declared = new Set(declaration.typeParameters.map((parameter) => Type.key(parameter.type)))
  for (const binder of lifetimes.lifetimeBinders)
    if (!declared.has(Lifetime.key(binder))) names.push(Lifetime.display(binder))
  return names
}

/** The `extern "C"`/`export "C"` marker and native symbol, when the declaration has one. */
const nativeMarker = (
  self: DeclarationFacts.DeclarationFact,
): { readonly marker: string; readonly symbol: string } | undefined => {
  if (self.foreign !== undefined)
    return { marker: `extern "${self.foreign.abi}" `, symbol: self.foreign.symbol }
  if (self.foreignExport !== undefined)
    return { marker: `export "${self.foreignExport.abi}" `, symbol: self.foreignExport.symbol }
  return undefined
}

/** Renders a declaration in its source-level callable form. */
export const functionDeclaration = (self: DeclarationFacts.DeclarationFact): Presentation => {
  const name = self.name._tag === 'Present' ? self.name.spelling : '_'
  const visibility = self.visibility === 'Public' ? 'pub ' : ''
  const phase = self.phase === 'Static' ? 'static ' : ''
  const native = nativeMarker(self)
  const kind = `${self.test ? 'test ' : ''}${phase}${self.unsafe ? 'unsafe ' : ''}${native?.marker ?? ''}${self.functionKind === 'Effect' ? `effect<${Lifetime.display(DeclarationFacts.executableLifetimes(self).environment)}> fn` : 'fn'}`
  const symbol = native === undefined ? '' : ` as "${native.symbol}"`
  const behavior =
    self.foreign === undefined && self.foreignExport === undefined
      ? ''
      : ForeignContract.source(
          (self.foreign ?? self.foreignExport)?.contract ?? ForeignContract.conservative,
          self.parameters.map((parameter) =>
            parameter.name._tag === 'Present' ? parameter.name.spelling : '_',
          ),
        )
  const parameterNames = executableParameterNames(self)
  const typeParameters = parameterNames.length === 0 ? '' : `<${parameterNames.join(', ')}>`
  const fixedParameters = self.parameters
    .map((parameter) => {
      const parameterName = parameter.name._tag === 'Present' ? parameter.name.spelling : '_'
      const phase = parameter.phase === 'Static' ? 'static ' : ''
      const mutability = parameter.bindingMutability === 'Mutable' ? 'mut ' : ''
      return `${phase}${mutability}${parameterName}: ${declaredType(parameter.declaredType)}`
    })
    .join(', ')
  const parameters = self.foreign?.variadic === true ? `${fixedParameters}, ...` : fixedParameters
  return {
    _tag: 'FunctionPresentation',
    name,
    functionKind: self.functionKind,
    text: `${visibility}${kind} ${name}${typeParameters}(${parameters}) -> ${declaredType(self.returnType)}${failureRow(self.failureRow)}${requirementRow(self.requirementRow)}${constraints(self.constraints)}${symbol}${behavior}`,
  }
}

/**
 * Renders an inherent receiver method as the value side sees it: parameter zero is the receiver
 * the call supplies, so only the written parameters are listed, and the owner binders the receiver
 * type fixes are substituted and dropped from the binder list. Without a substitution the declared
 * binders are kept; the type side presents the complete contract.
 */
export const receiverMethod = (
  self: DeclarationFacts.DeclarationFact,
  substitution: Type.Substitution = new Map(),
  module = '',
  scope?: NameResolution.ModuleScope,
): Presentation => {
  const name = self.name._tag === 'Present' ? self.name.spelling : '_'
  const kind = `${self.unsafe ? 'unsafe ' : ''}${self.functionKind === 'Effect' ? `effect<${Lifetime.display(DeclarationFacts.executableLifetimes(self).environment)}> fn` : 'fn'}`
  const bound = (parameter: DeclarationFacts.TypeParameterFact): boolean =>
    substitution.has(Type.key(parameter.type))
  const free = self.typeParameters.filter((parameter) => !bound(parameter))
  const parameterNames = executableParameterNames(self, free)
  const typeParameters = parameterNames.length === 0 ? '' : `<${parameterNames.join(', ')}>`
  const rendered = (fact: DeclarationFacts.DeclaredTypeFact): string =>
    fact._tag === 'Resolved' && substitution.size > 0
      ? type(Type.substitute(fact.type, substitution), module, scope)
      : declaredType(fact)
  const parameters = self.parameters
    .slice(1)
    .map((parameter) => {
      const parameterName = parameter.name._tag === 'Present' ? parameter.name.spelling : '_'
      const mutability = parameter.bindingMutability === 'Mutable' ? 'mut ' : ''
      return `${mutability}${parameterName}: ${rendered(parameter.declaredType)}`
    })
    .join(', ')
  return {
    _tag: 'FunctionPresentation',
    name,
    functionKind: self.functionKind,
    text: `${kind}${typeParameters}(${parameters}) -> ${rendered(self.returnType)}${failureRow(self.failureRow)}${requirementRow(self.requirementRow)}${constraints(self.constraints)}`,
  }
}

/**
 * The owner binders a receiver's static type fixes, inferred by matching parameter zero's declared
 * type against the receiver: `Option<i32>` against `self: Option<T>` binds `T`.
 */
export const receiverSubstitution = (
  self: DeclarationFacts.DeclarationFact,
  receiverType: Type.Type | undefined,
): Type.Substitution => {
  const substitution = new Map<string, Type.GenericArgument>()
  const receiver = self.parameters.at(0)
  if (receiverType === undefined || receiver?.declaredType._tag !== 'Resolved') return substitution
  const pattern = receiver.declaredType.type
  const declared = Type.isReference(pattern) ? pattern.target : pattern
  const actual = Type.isReference(receiverType) ? receiverType.target : receiverType
  TypeInference.infer(declared, actual, substitution)
  return substitution
}

/**
 * Renders a bound's receiver operation as a generic value sees it: operand zero is the receiver the
 * call supplies, so only the written operands are listed.
 */
export const receiverOperation = (
  self: DeclarationFacts.InterfaceOperationApplicationFact,
): Presentation => {
  const name = self.declaration.name._tag === 'Present' ? self.declaration.name.spelling : '_'
  const kind = `${self.unsafe ? 'unsafe ' : ''}${self.functionKind === 'Effect' ? `effect<${Lifetime.display(DeclarationFacts.executableLifetimes(self.declaration).environment)}> fn` : 'fn'}`
  const parameters = self.operands
    .slice(1)
    .map((operand) => {
      const parameterName =
        operand.parameter.name._tag === 'Present' ? operand.parameter.name.spelling : '_'
      return `${parameterName}: ${declaredType(operand.type)}`
    })
    .join(', ')
  return {
    _tag: 'ServiceOperationPresentation',
    name,
    text: `${kind}(${parameters}) -> ${declaredType(self.success)}${failureRow(self.failureRow)}${requirementRow(self.requirementRow)}`,
  }
}

/** Renders a scalar enum declaration without expanding its members. */
export const enumDeclaration = (self: DeclarationFacts.EnumFact): Presentation => {
  const name = self.name._tag === 'Present' ? self.name.spelling : '_'
  const visibility = self.visibility === 'Public' ? 'pub ' : ''
  let representation: string
  if (self.representation.explicit) {
    representation = `(${self.representation._tag === 'Available' ? self.representation.scalar.spelling : (self.representation.spelling ?? '_')})`
  } else {
    representation = ''
  }
  return {
    _tag: 'EnumPresentation',
    name,
    text: `${visibility}enum${representation} ${name}`,
  }
}

export const enumMember = (
  enum_: DeclarationFacts.EnumFact,
  member: DeclarationFacts.EnumMemberFact,
): Presentation => {
  const enumName = enum_.name._tag === 'Present' ? enum_.name.spelling : '_'
  const name = member.name._tag === 'Present' ? member.name.spelling : '_'
  return {
    _tag: 'EnumMemberPresentation',
    name,
    text: `${enumName}.${name}: ${enumName}`,
  }
}

export const enumAssociatedOperation = (
  self: DeclarationFacts.EnumAssociatedOperationFact,
): Presentation => ({
  _tag: 'EnumOperationPresentation',
  name: self.name,
  text: `fn ${self.name}(value: ${self.parameter.name}) -> ${self.result.spelling}`,
})

/** Renders a nominal type declaration without expanding its body. */
export const structDeclaration = (self: DeclarationFacts.StructFact): Presentation => {
  const name = self.name._tag === 'Present' ? self.name.spelling : '_'
  const visibility = self.visibility === 'Public' ? 'pub ' : ''
  const typeParameters =
    self.typeParameters.length === 0
      ? ''
      : `<${self.typeParameters.map(typeParameterName).join(', ')}>`
  const layout =
    self.layout._tag === 'Silk'
      ? ''
      : `extern ${self.layout.abi === undefined ? '_' : JSON.stringify(self.layout.abi)} `
  return {
    _tag: 'StructPresentation',
    name,
    text: `${visibility}${layout}${self.aggregateKind === 'Positional' ? 'tuple' : 'struct'} ${name}${typeParameters}`,
  }
}

/** Renders a nominal tagged-union declaration without expanding its variants. */
export const unionDeclaration = (self: DeclarationFacts.UnionFact): Presentation => {
  const name = self.name._tag === 'Present' ? self.name.spelling : '_'
  const visibility = self.visibility === 'Public' ? 'pub ' : ''
  const typeParameters =
    self.typeParameters.length === 0
      ? ''
      : `<${self.typeParameters.map(typeParameterName).join(', ')}>`
  return {
    _tag: 'UnionPresentation',
    name,
    text: `${visibility}union ${name}${typeParameters}`,
  }
}

/** Renders one variant as a constructor of its complete nominal union parent. */
export const unionVariant = (
  union: DeclarationFacts.UnionFact,
  variant: DeclarationFacts.UnionVariantFact,
): Presentation => {
  const unionName = union.name._tag === 'Present' ? union.name.spelling : '_'
  const variantName = variant.name._tag === 'Present' ? variant.name.spelling : '_'
  const typeParameters =
    union.typeParameters.length === 0
      ? ''
      : `<${union.typeParameters.map(typeParameterName).join(', ')}>`
  const fields =
    variant.kind === 'Unit'
      ? ''
      : ` { ${variant.fields
          .map((field) =>
            field.name._tag === 'Present'
              ? `${field.name.spelling}: ${declaredType(field.declaredType)}`
              : `_: ${declaredType(field.declaredType)}`,
          )
          .join(', ')} }`
  return {
    _tag: 'UnionVariantPresentation',
    name: variantName,
    text: `${unionName}${typeParameters}.${variantName}${fields}: ${unionName}${typeParameters}`,
  }
}

/** Renders one nominal service contract without expanding its operation list. */
export const serviceDeclaration = (
  self: DeclarationFacts.ServiceFact | DeclarationFacts.InterfaceFact,
): Presentation => {
  const name = self.name._tag === 'Present' ? self.name.spelling : '_'
  const visibility = self.visibility === 'Public' ? 'pub ' : ''
  const typeParameters =
    self.typeParameters.length === 0
      ? ''
      : `<${self.typeParameters.map(typeParameterName).join(', ')}>`
  return {
    _tag: 'ServicePresentation',
    name,
    text: `${visibility}${self._tag === 'ServiceDeclaration' ? 'service' : 'interface'} ${name}${typeParameters}`,
  }
}

/** Renders one nominal dependency role declaration. */
export const roleDeclaration = (self: DeclarationFacts.RoleFact): Presentation => {
  const name = self.name._tag === 'Present' ? self.name.spelling : '_'
  const visibility = self.visibility === 'Public' ? 'pub ' : ''
  return {
    _tag: 'RolePresentation',
    name,
    text: `${visibility}role ${name}`,
  }
}

/** Renders a complete operation contract nested beneath a service. */
export const serviceOperation = (self: DeclarationFacts.ServiceOperationFact): Presentation => {
  const name = self.name._tag === 'Present' ? self.name.spelling : '_'
  const kind = `${self.unsafe ? 'unsafe ' : ''}${self.functionKind === 'Effect' ? `effect<${Lifetime.display(DeclarationFacts.executableLifetimes(self).environment)}> fn` : 'fn'}`
  const parameterNames = executableParameterNames(self)
  const typeParameters = parameterNames.length === 0 ? '' : `<${parameterNames.join(', ')}>`
  const parameters = self.parameters
    .map((parameter) => {
      const parameterName = parameter.name._tag === 'Present' ? parameter.name.spelling : '_'
      return `${parameter.phase === 'Static' ? 'static ' : ''}${parameterName}: ${declaredType(parameter.declaredType)}`
    })
    .join(', ')
  const properties = self.staticProperties
    .map((property) =>
      property === 'Intrinsic.NonParking'
        ? ' with Intrinsic.nonParking()'
        : ' with Intrinsic.detached()',
    )
    .join('')
  return {
    _tag: 'ServiceOperationPresentation',
    name,
    text: `${kind} ${name}${typeParameters}(${parameters}) -> ${declaredType(self.returnType)}${failureRow(self.failureRow)}${requirementRow(self.requirementRow)}${constraints(self.constraints)}${properties}`,
  }
}

/** Renders one typed compile-time scalar declaration. */
export const constantDeclaration = (self: DeclarationFacts.ConstantFact): Presentation => {
  const name = self.name._tag === 'Present' ? self.name.spelling : '_'
  const visibility = self.visibility === 'Public' ? 'pub ' : ''
  return {
    _tag: 'ConstantPresentation',
    name,
    text: `${visibility}${self._tag === 'PackageParameterDeclaration' ? 'param' : 'const'} ${name}: ${declaredType(self.declaredType)}`,
  }
}

/** Renders one imported or exported native data binding. */
export const foreignStaticDeclaration = (
  self: DeclarationFacts.ForeignStaticFact,
): Presentation => {
  const name = self.name._tag === 'Present' ? self.name.spelling : '_'
  return {
    _tag: 'ConstantPresentation',
    name,
    text: `${self.direction === 'Import' ? 'unsafe extern' : 'export'} "C" static ${name}: ${declaredType(self.declaredType)}`,
  }
}

/** Renders an alias by its erased target: the alias name never survives resolution. */
export const aliasDeclaration = (self: DeclarationFacts.AliasFact): Presentation => {
  const name = self.name._tag === 'Present' ? self.name.spelling : '_'
  const visibility = self.visibility === 'Public' ? 'pub ' : ''
  return {
    _tag: 'AliasPresentation',
    name,
    text: `${visibility}type ${name} = ${declaredType(self.target)}`,
  }
}

export const parameter = (self: DeclarationFacts.ParameterFact): Presentation => {
  const name = self.name._tag === 'Present' ? self.name.spelling : '_'
  const phase = self.phase === 'Static' ? 'static ' : ''
  const mutability = self.bindingMutability === 'Mutable' ? 'mut ' : ''
  return {
    _tag: 'ParameterPresentation',
    name,
    text: `${phase}${mutability}${name}: ${declaredType(self.declaredType)}`,
  }
}

export const typeParameter = (self: DeclarationFacts.TypeParameterFact): Presentation => {
  const name = self.name._tag === 'Present' ? self.name.spelling : self.type.name
  let kind = 'type'
  if (self.type.kind === 'Lifetime') kind = 'lifetime'
  else if (self.type.kind === 'RequirementRow') kind = 'requirement row'
  return { _tag: 'TypeParameterPresentation', name, text: `${kind} ${name}` }
}

export const field = (self: DeclarationFacts.FieldFact): Presentation => {
  const name = self.name._tag === 'Present' ? self.name.spelling : '_'
  return {
    _tag: 'FieldPresentation',
    name,
    text: `${self.visibility === 'Public' ? 'pub ' : ''}${name}: ${declaredType(self.declaredType)}`,
  }
}

const importedMemberSpelling = (
  self: Type.Nominal,
  scope: NameResolution.ModuleScope | undefined,
): string | undefined =>
  scope?.bindings.find(
    (binding) =>
      binding._tag === 'ImportedMember' &&
      binding.declaration.module === self.module &&
      binding.declaration.name === self.name &&
      !scope.conflicts.some((conflict) => conflict.spelling === binding.spelling),
  )?.spelling

const namespaceSpelling = (
  module: string,
  scope: NameResolution.ModuleScope | undefined,
): string | undefined =>
  scope?.bindings.find(
    (binding) =>
      binding._tag === 'ModuleNamespace' &&
      binding.module === module &&
      !scope.conflicts.some((conflict) => conflict.spelling === binding.spelling),
  )?.spelling

/** Renders an inferred type with the shortest unambiguous spelling available in one module. */
export const type = (
  self: Type.Type,
  module: string,
  scope?: NameResolution.ModuleScope,
): string => {
  if (Type.equals(self, Type.unit)) return '()'
  if (typeof self === 'string') return self
  if (Type.isString(self)) return `string<${Lifetime.display(self.lifetime)}>`
  if (Type.isNominal(self)) {
    const anonymous = Type.anonymousAggregateDisplay(self)
    if (anonymous !== undefined) return anonymous
    let base: string
    if (self.module === module || self.module === 'silk/core') {
      base = self.name
    } else {
      const imported = importedMemberSpelling(self, scope)
      if (imported !== undefined) base = imported
      else {
        const namespace = namespaceSpelling(self.module, scope)
        base = namespace === undefined ? `${self.module}.${self.name}` : `${namespace}.${self.name}`
      }
    }
    return self.arguments.length === 0
      ? base
      : `${base}<${self.arguments.map((argument) => genericArgument(argument, module, scope)).join(', ')}>`
  }
  if (Type.isParameter(self)) return self.name
  if (Type.isFixedArray(self)) return `Array<${type(self.element, module, scope)}, ${self.length}>`
  if (Type.isSlice(self))
    return `&${Lifetime.display(self.lifetime)} ${self.access === 'Exclusive' ? 'mut ' : ''}[${type(self.element, module, scope)}]`
  if (Type.isReference(self))
    return `&${Lifetime.display(self.lifetime)} ${self.access === 'Exclusive' ? 'mut ' : ''}${type(self.target, module, scope)}`
  if (Type.isPointer(self))
    return `${self.mutable ? '*mut ' : '*const '}${type(self.pointee, module, scope)}`
  if (Type.isCallable(self)) {
    let mode: string
    if (self.mode === 'Exclusive') {
      mode = 'mut '
    } else if (self.mode === 'Take') {
      mode = 'once '
    } else {
      mode = ''
    }
    const binder =
      self.lifetimeBinders.length === 0
        ? ''
        : `for<${self.lifetimeBinders
            .map((binder) => {
              const bounds = self.lifetimeBounds.filter((bound) =>
                Lifetime.equals(bound.longer, binder),
              )
              return `${Lifetime.display(binder)}${bounds.length === 0 ? '' : `: ${bounds.map((bound) => Lifetime.display(bound.shorter)).join(' + ')}`}`
            })
            .join(', ')}> `
    return `${binder}${self.unsafe ? 'unsafe ' : ''}${mode}fn<${Lifetime.display(self.environment)}>(${self.parameters.map((entry) => type(entry, module, scope)).join(', ')}) -> ${type(self.result, module, scope)}`
  }
  if (Type.isEffect(self)) {
    const failureText = RowAlgebra.encode(
      Type.failureRowPolicy(),
      self.failureRow,
      (failure) => type(failure, module, scope),
      (parameter_) => parameter_.name,
      (member) => member.parameter.name,
    )
    const failures = failureText.length === 0 ? '' : ` ! ${failureText}`
    const requirementText = RowAlgebra.encode(
      Type.requirementRowPolicy(),
      self.requirementRow,
      (requirement) =>
        Type.encodeRequirement(requirement, (capability) => type(capability, module, scope)),
      (parameter_) => parameter_.name,
      (member) =>
        `${member.access === 'Exclusive' ? '&mut ' : '&'}${member.capability.name}${member.role === RequirementRow.defaultRole ? '' : ` at ${RequirementRow.roleName(member.role)}`}`,
    )
    const requirements = requirementText.length === 0 ? '' : ` ? ${requirementText}`
    return `Effect<${Lifetime.display(self.environment)}; ${type(self.success, module, scope)}${failures}${requirements}>`
  }
  if (Type.isRepresented(self)) return type(self.contract, module, scope)
  if (Type.isForeignFunction(self)) return Type.encode(self)
  return self.members.map((member) => type(member, module, scope)).join(' | ')
}

/** Renders one erased generic argument for tooling without exposing a runtime descriptor. */
export const genericArgument = (
  self: Type.GenericArgument,
  module: string,
  scope?: NameResolution.ModuleScope,
): string => {
  if (Lifetime.isLifetime(self)) return Lifetime.display(self)
  if (Type.isUnavailableGenericArgument(self)) {
    return Type.encodeGenericArgument(self)
  }
  if (Type.isRepresentationParameterArgument(self)) {
    return self.parameter.name
  }
  if (Type.isOpaqueRepresentationArgument(self)) {
    return Type.encodeGenericArgument(self)
  }
  if (Type.isExactRepresentationArgument(self)) {
    return Type.encodeGenericArgument(self)
  }
  if (Type.isCompositeEffectRepresentationArgument(self)) {
    return Type.encodeGenericArgument(self)
  }
  if (Type.isEffectIdentityArgument(self)) {
    return `effect@${self.identity}`
  }
  if (Type.isCallableIdentityArgument(self)) {
    return `callable@${self.identity}`
  }
  if (Type.isRequirementRowArgument(self)) {
    return `? ${RowAlgebra.encode(
      Type.requirementRowPolicy(),
      self.row,
      (requirement) =>
        Type.encodeRequirement(requirement, (capability) => type(capability, module, scope)),
      (parameter_) => parameter_.name,
      (member) =>
        `${member.access === 'Exclusive' ? '&mut ' : '&'}${member.capability.name}${member.role === RequirementRow.defaultRole ? '' : ` at ${RequirementRow.roleName(member.role)}`}`,
    )}`
  }
  return type(self, module, scope)
}

const scopedNominalBase = (
  self: Type.Nominal,
  module: string,
  scope: NameResolution.ModuleScope | undefined,
): string => {
  const anonymous = Type.anonymousAggregateDisplay(self)
  if (anonymous !== undefined) return anonymous
  if (self.module === module) return self.name
  const imported = importedMemberSpelling(self, scope)
  if (imported !== undefined) return imported
  const namespace = namespaceSpelling(self.module, scope)
  return namespace === undefined ? `${self.module}.${self.name}` : `${namespace}.${self.name}`
}

function scopedGenericArgumentText(
  self: Type.GenericArgument,
  module: string,
  scope: NameResolution.ModuleScope | undefined,
): string {
  if (Lifetime.isLifetime(self)) return Lifetime.display(self)
  if (Type.isUnavailableGenericArgument(self)) return Type.encodeGenericArgument(self)
  if (Type.isRepresentationParameterArgument(self)) return self.parameter.name
  if (
    Type.isOpaqueRepresentationArgument(self) ||
    Type.isExactRepresentationArgument(self) ||
    Type.isCompositeEffectRepresentationArgument(self)
  )
    return Type.encodeGenericArgument(self)
  if (Type.isEffectIdentityArgument(self)) return `effect@${self.identity}`
  if (Type.isCallableIdentityArgument(self)) return `callable@${self.identity}`
  if (Type.isRequirementRowArgument(self))
    return `? ${RowAlgebra.encode(
      Type.requirementRowPolicy(),
      self.row,
      (requirement) =>
        Type.encodeRequirement(requirement, (capability) =>
          scopedTypeText(capability, module, scope),
        ),
      (parameter_) => parameter_.name,
      (member) =>
        `${member.access === 'Exclusive' ? '&mut ' : '&'}${member.capability.name}${member.role === RequirementRow.defaultRole ? '' : ` at ${RequirementRow.roleName(member.role)}`}`,
    )}`
  return scopedTypeText(self, module, scope)
}

function scopedTypeText(
  self: Type.Type,
  module: string,
  scope: NameResolution.ModuleScope | undefined,
): string {
  if (!Type.isNominal(self)) return type(self, module, scope)
  const base = scopedNominalBase(self, module, scope)
  return self.arguments.length === 0
    ? base
    : `${base}<${self.arguments
        .map((argument) => scopedGenericArgumentText(argument, module, scope))
        .join(', ')}>`
}

/** Renders a nominal through source-valid imports without the inferred-type core shortcut. */
export const scopedNominal = (
  self: Type.Nominal,
  module: string,
  scope?: NameResolution.ModuleScope,
): Presentation => ({
  _tag: 'ExpressionTypePresentation',
  text: scopedTypeText(self, module, scope),
})

/** Renders the selector syntax for one successfully inferred service requirement. */
export const providerSelector = (
  self: Pick<Type.Requirement, 'role'> & { readonly capability: Type.Nominal },
  module: string,
  scope?: NameResolution.ModuleScope,
): Presentation => ({
  _tag: 'ExpressionTypePresentation',
  text: `${scopedTypeText(self.capability, module, scope)}${
    self.role === RequirementRow.defaultRole ? '' : ` at ${RequirementRow.roleName(self.role)}`
  }`,
})

const lifetimeRequirements = (
  self: Type.Type,
  module: string,
  scope?: NameResolution.ModuleScope,
): ReadonlyArray<string> => {
  const contract = Type.isRepresented(self) ? self.contract : self
  if (!Type.isCallable(contract) && !Type.isEffect(contract)) return []
  const nested = Type.isCallable(contract)
    ? lifetimeRequirements(contract.result, module, scope)
    : []
  return [
    ...new Set([
      ...contract.typeOutlives.map(
        (bound) => `${type(bound.type, module, scope)}: ${Lifetime.display(bound.lifetime)}`,
      ),
      ...nested,
    ]),
  ]
}

export const binding = (
  self: Elaboration.ScopeBinding,
  module: string,
  scope?: NameResolution.ModuleScope,
): Presentation | undefined => {
  if (self.name._tag !== 'Present' || self.inferredType._tag !== 'Available') return undefined
  return {
    _tag: 'BindingPresentation',
    name: self.name.spelling,
    mutability: self.mutability,
    lifetimeRequirements: lifetimeRequirements(self.inferredType.type, module, scope),
    text: `let ${self.mutability === 'Mutable' ? 'mut ' : ''}${self.name.spelling}: ${type(self.inferredType.type, module, scope)}`,
  }
}

export const patternBinding = (
  self: Elaboration.PatternBindingFact,
  module: string,
  scope?: NameResolution.ModuleScope,
): Presentation | undefined => {
  if (self.name._tag !== 'Present' || self.type._tag !== 'Available') return undefined
  return {
    _tag: 'BindingPresentation',
    name: self.name.spelling,
    mutability: 'Immutable',
    lifetimeRequirements: lifetimeRequirements(self.type.type, module, scope),
    text: `let ${self.name.spelling}: ${type(self.type.type, module, scope)}`,
  }
}

export const importBinding = (name: string, target: string): Presentation => ({
  _tag: 'ImportPresentation',
  name,
  text: `import ${target} as ${name}`,
})

export const intrinsicActor = (self: Intrinsic.Actor): Presentation => ({
  _tag: 'IntrinsicActorPresentation',
  name: self.spelling,
  text: `${self.kind === 'Type' ? 'intrinsic type' : 'intrinsic namespace'} ${self.spelling}`,
})

export const intrinsicOperation = (self: Intrinsic.Operation): Presentation => ({
  _tag: 'IntrinsicOperationPresentation',
  actor: self.id.actor,
  name: self.spelling,
  text: IntrinsicCatalog.signature(self),
})

export const expressionType = (
  self: Type.Type,
  module: string,
  scope?: NameResolution.ModuleScope,
): Presentation => ({
  _tag: 'ExpressionTypePresentation',
  text: type(self, module, scope),
  lifetimeRequirements: lifetimeRequirements(self, module, scope),
})
