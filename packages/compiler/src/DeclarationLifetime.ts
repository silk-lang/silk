import * as Location from './Location.js'
import * as Diagnostic from './Diagnostic.js'
import type * as AuthoredHir from './AuthoredHir.js'
import * as AuthoredIdentity from './AuthoredIdentity.js'
import * as AuthoredWalk from './AuthoredWalk.js'
import * as BodyLifetime from './BodyLifetime.js'
import type * as DeclarationIndex from './DeclarationIndex.js'
import * as Lifetime from './Lifetime.js'
import type * as NameResolution from './NameResolution.js'
import type * as SemanticContext from './SemanticContext.js'
import * as Type from './Type.js'

/** One implicit declaration parameter with the exact annotation which introduced it. */
export interface ImplicitBinder {
  readonly parameter: Type.Parameter
  readonly anchor: AuthoredHir.Anchor
}

/**
 * Header-only region elaboration shared by declaration collection and source presentation.
 *
 * This is plain data: anchors are keyed by `AuthoredIdentity.anchorKey`, and nothing here closes
 * over a `SemanticContext` or retains an authored node. Two fresh analyses of one source must
 * compare equal, so a consumer that needs spans or the authored declaration receives them as
 * arguments instead of reading them back off this record.
 */
export interface Context {
  readonly owner: Lifetime.Owner
  readonly parameters: ReadonlyMap<string, Type.Parameter>
  /** Keyed by `AuthoredIdentity.anchorKey`, since authored positions have no object identity. */
  readonly nominalArguments: ReadonlyMap<string, ReadonlyArray<Lifetime.Lifetime>>
  readonly regions: ReadonlyMap<string, Lifetime.Lifetime>
  readonly callables: ReadonlyMap<string, Type.ExecutableLifetimes>
  readonly implicit: ReadonlyArray<ImplicitBinder>
  readonly diagnostics: ReadonlyArray<Diagnostic.Located>
  readonly explicitEnvironment?: Lifetime.Lifetime
  /** The genuine hidden callable use binder and its authored inputs, before lexical captures. */
  readonly invocationUse?: Type.InvocationUse & { readonly lifetime: Lifetime.Bound }
  /**
   * An ordinary named function's top-level `Effect` result whose omitted environment has no
   * borrowed-input default and elaborated as `'static`. Declaration completion rejects it when
   * some input retains a region or unknown generic contents.
   */
  readonly closedEffectResult?: AuthoredHir.Anchor
}

/** The region assigned to one authored position, if elaboration reached it. */
export const regionOf = (
  self: Context,
  anchor: AuthoredHir.Anchor,
): Lifetime.Lifetime | undefined => self.regions.get(AuthoredIdentity.anchorKey(anchor))

/** The executable contract elaborated for one authored callable type. */
export const callableOf = (
  self: Context,
  anchor: AuthoredHir.Anchor,
): Type.ExecutableLifetimes | undefined => self.callables.get(AuthoredIdentity.anchorKey(anchor))

/** The implicit nominal lifetime arguments elaborated for one authored type occurrence. */
export const nominalArgumentsOf = (
  self: Context,
  anchor: AuthoredHir.Anchor,
): ReadonlyArray<Lifetime.Lifetime> | undefined =>
  self.nominalArguments.get(AuthoredIdentity.anchorKey(anchor))

/** Resolves only lexical lifetime names; ordinary type names never enter this lookup. */
export const named = (
  name: string,
  parameters: ReadonlyMap<string, Type.Parameter>,
): Lifetime.Lifetime | undefined => {
  if (name === "'static") return Lifetime.staticLifetime
  const parameter = parameters.get(name)
  return parameter?.kind === 'Lifetime'
    ? Lifetime.bound(parameter.owner, parameter.ordinal, parameter.name)
    : undefined
}

/** A lifetime name's spelling, normalized to include its leading tick. */
const tickedName = (
  context: SemanticContext.SemanticContext,
  name: AuthoredHir.Name,
): string | undefined => {
  const text = nameText(context, name)
  if (text === undefined) return undefined
  return text.startsWith("'") ? text : `'${text}`
}

/** The authored spelling of a lifetime, including its leading tick. */
const lifetimeName = (
  context: SemanticContext.SemanticContext,
  lifetime: AuthoredHir.Lifetime,
): string | undefined => tickedName(context, lifetime.name)

const nameText = (
  context: SemanticContext.SemanticContext,
  name: AuthoredHir.Name,
): string | undefined => {
  if (name._tag === 'Name') return context.textOf(name.text)
  if (name._tag === 'InvalidName') return context.textOf(name.spelling)
  return undefined
}

/** The sole segment of a one-segment path, when the type names one. */
const soleSegment = (type: AuthoredHir.Type): AuthoredHir.Name | undefined =>
  type._tag === 'NamedType' && type.path.segments.length === 1 ? type.path.segments[0] : undefined

/** The `string` type is borrowed like a slice, so it takes part in elision. */
const isStringType = (
  context: SemanticContext.SemanticContext,
  type: AuthoredHir.Type,
): boolean => {
  const segment = soleSegment(type)
  return segment !== undefined && nameText(context, segment) === 'string'
}

/** The header's contract, when the declaration carries one. */
const contractOf = (
  declaration: AuthoredHir.Declaration,
): AuthoredHir.CallableContract | undefined => {
  const header = declaration.header
  return header._tag === 'FunctionHeader' || header._tag === 'OperationHeader'
    ? header.contract
    : undefined
}

/** Every type written directly in one header, in authored order. */
const headerTypes = (declaration: AuthoredHir.Declaration): ReadonlyArray<AuthoredHir.Type> => {
  const header = declaration.header
  switch (header._tag) {
    case 'StructHeader':
      return header.fields.map((field) => field.type)
    case 'TupleHeader':
      return header.elements
    case 'UnionHeader':
      return header.variants.flatMap((variant) => variant.fields.map((field) => field.type))
    case 'AliasHeader':
      return [header.target]
    case 'ConstantHeader':
      return header.type === undefined ? [] : [header.type]
    case 'StaticHeader':
    case 'PackageParameterHeader':
      return [header.type]
    case 'ImplHeader':
      return header.target === undefined ? [header.subject] : [header.subject, header.target]
    case 'EnumHeader':
      return header.representation === undefined ? [] : [header.representation]
    default:
      return []
  }
}

/** The generic parameters a header binds, in authored order. */
const headerGenerics = (
  declaration: AuthoredHir.Declaration,
): ReadonlyArray<AuthoredHir.GenericParameter> => {
  const header = declaration.header
  const contract = contractOf(declaration)
  if (contract !== undefined) return contract.generics
  switch (header._tag) {
    case 'StructHeader':
    case 'TupleHeader':
    case 'UnionHeader':
    case 'ServiceHeader':
    case 'InterfaceHeader':
    case 'AliasHeader':
    case 'ImplHeader':
      return header.generics
    default:
      return []
  }
}

/** Looks up the declared parameters of the nominal one authored type names. */
type NominalParameters = (type: AuthoredHir.Type) => ReadonlyArray<Type.Parameter> | undefined

/**
 * Assigns regions using only a declaration header. Anchors locate authored occurrences; semantic
 * identities use owner and traversal ordinal and never contain source offsets.
 */
export const forHeader = (
  context: SemanticContext.SemanticContext,
  owner: Lifetime.Owner,
  declaration: AuthoredHir.Declaration,
  parameters: ReadonlyMap<string, Type.Parameter>,
  nominalParameters?: NominalParameters,
): Context => elaborate(context, owner, declaration, parameters, undefined, nominalParameters)

const elaborate = (
  context: SemanticContext.SemanticContext,
  owner: Lifetime.Owner,
  declaration: AuthoredHir.Declaration,
  parameters: ReadonlyMap<string, Type.Parameter>,
  body: BodyLifetime.BodyLifetime | undefined,
  nominalParameters: NominalParameters | undefined,
): Context => {
  const nominalArguments = new Map<string, ReadonlyArray<Lifetime.Lifetime>>()
  const regions = new Map<string, Lifetime.Lifetime>()
  const callables = new Map<string, Type.ExecutableLifetimes>()
  const implicit: Array<ImplicitBinder> = []
  const diagnostics: Array<Diagnostic.Located> = []
  const names = new Set(parameters.keys())
  const bindings = new Map<string, Lifetime.Lifetime>()
  for (const [name, parameter] of parameters)
    if (parameter.kind === 'Lifetime')
      bindings.set(name, Lifetime.bound(parameter.owner, parameter.ordinal, parameter.name))
  bindings.set("'static", Lifetime.staticLifetime)
  let ordinal = Math.max(-1, ...[...parameters.values()].map((parameter) => parameter.ordinal)) + 1
  let callableOrdinal = 0

  const setRegion = (anchor: AuthoredHir.Anchor, value: Lifetime.Lifetime): void => {
    regions.set(AuthoredIdentity.anchorKey(anchor), value)
  }
  const getRegion = (anchor: AuthoredHir.Anchor): Lifetime.Lifetime | undefined =>
    regions.get(AuthoredIdentity.anchorKey(anchor))

  const fresh = (anchor: AuthoredHir.Anchor): Lifetime.Lifetime | undefined => {
    const position = ordinal++
    if (body !== undefined) return BodyLifetime.region(body, anchor, 'Annotation')
    let name = `'life${position}`
    while (names.has(name)) name += '_'
    names.add(name)
    const parameter = Type.parameter(owner, position, name, 'Lifetime')
    implicit.push({ parameter, anchor })
    return Lifetime.bound(owner, position, name)
  }

  const resolve = (
    anchor: AuthoredHir.Anchor,
    lifetime: AuthoredHir.Lifetime,
    scope: ReadonlyMap<string, Lifetime.Lifetime>,
  ): Lifetime.Lifetime | undefined => {
    const name = lifetimeName(context, lifetime)
    if (name === undefined) {
      diagnostics.push(Diagnostic.ambiguousLifetimeElision(Location.at(lifetime.anchor)))
      return undefined
    }
    const value = scope.get(name)
    if (value === undefined)
      diagnostics.push(Diagnostic.unknownLifetime(name, Location.at(lifetime.anchor)))
    else setRegion(anchor, value)
    return value
  }

  /** An effect environment is the intersection of every lifetime it names. */
  const resolveEnvironment = (
    anchor: AuthoredHir.Anchor,
    environment: ReadonlyArray<AuthoredHir.Lifetime>,
    scope: ReadonlyMap<string, Lifetime.Lifetime>,
  ): Lifetime.Lifetime | undefined => {
    const members = environment.flatMap((lifetime) => {
      const member = resolve(anchor, lifetime, scope)
      return member === undefined ? [] : [member]
    })
    if (members.length === 0 || members.length !== environment.length) return undefined
    const value = Lifetime.intersection(members)
    setRegion(anchor, value)
    return value
  }

  /** Takes the written lifetime when present, else elides one. */
  const region = (
    anchor: AuthoredHir.Anchor,
    written: AuthoredHir.Lifetime | undefined,
    scope: ReadonlyMap<string, Lifetime.Lifetime>,
    output: boolean,
    defaultOutput: Lifetime.Lifetime | undefined,
    allocate: (anchor: AuthoredHir.Anchor) => Lifetime.Lifetime | undefined,
  ): Lifetime.Lifetime | undefined => {
    if (written !== undefined) return resolve(anchor, written, scope)
    const value = output && body === undefined ? defaultOutput : allocate(anchor)
    if (value === undefined)
      diagnostics.push(Diagnostic.ambiguousLifetimeElision(Location.at(anchor)))
    else setRegion(anchor, value)
    return value
  }

  /** Supplies the lifetime arguments a nominal leaves unwritten. */
  const nominal = (
    type: AuthoredHir.Type,
    scope: ReadonlyMap<string, Lifetime.Lifetime>,
    output: boolean,
    defaultOutput: Lifetime.Lifetime | undefined,
    allocate: (anchor: AuthoredHir.Anchor) => Lifetime.Lifetime | undefined,
    written: ReadonlyArray<AuthoredHir.GenericArgument> = [],
  ): void => {
    const binders =
      nominalParameters?.(type)?.filter((parameter) => parameter.kind === 'Lifetime') ?? []
    if (binders.length === 0) return
    if (written.some((argument) => argument._tag === 'Lifetime')) return
    const arguments_ = binders.flatMap(() => {
      const value = region(type.anchor, undefined, scope, output, defaultOutput, allocate)
      return value === undefined ? [] : [value]
    })
    if (arguments_.length === binders.length)
      nominalArguments.set(AuthoredIdentity.anchorKey(type.anchor), arguments_)
  }

  const walkType = (
    type: AuthoredHir.Type,
    scope: ReadonlyMap<string, Lifetime.Lifetime>,
    output = false,
    defaultOutput?: Lifetime.Lifetime,
    allocate: (anchor: AuthoredHir.Anchor) => Lifetime.Lifetime | undefined = fresh,
    quantified = false,
  ): void => {
    switch (type._tag) {
      case 'ReferenceType': {
        region(type.anchor, type.lifetime, scope, output, defaultOutput, allocate)
        walkType(type.referent, scope, output, defaultOutput, allocate, quantified)
        return
      }
      case 'SliceType': {
        region(type.anchor, type.lifetime, scope, output, defaultOutput, allocate)
        walkType(type.element, scope, output, defaultOutput, allocate, quantified)
        return
      }
      case 'NamedType': {
        if (isStringType(context, type))
          region(type.anchor, undefined, scope, output, defaultOutput, allocate)
        else nominal(type, scope, output, defaultOutput, allocate)
        return
      }
      case 'AppliedType': {
        walkApplied(type, scope, output, defaultOutput, allocate, quantified)
        return
      }
      case 'CallableType':
      case 'ForeignFunctionType': {
        walkCallable(type, scope, output, defaultOutput, allocate, quantified)
        return
      }
      case 'FixedArrayType': {
        walkType(type.element, scope, output, defaultOutput, allocate, quantified)
        return
      }
      case 'PointerType': {
        walkType(type.pointee, scope, output, defaultOutput, allocate, quantified)
        return
      }
      case 'ExactRepresentationType': {
        walkType(type.subject, scope, output, defaultOutput, allocate, quantified)
        return
      }
      case 'OpaqueResultType': {
        for (const parameter of type.binders) {
          if (parameter._tag === 'RowParameter') continue
          // A binder's bound is a contract of its own, not part of the output it sits in: it
          // elides like any other generic bound rather than taking the output's default region.
          for (const bound of parameter.bounds)
            if (bound._tag !== 'Lifetime') walkType(bound, scope)
        }
        walkType(type.result, scope, output, defaultOutput, allocate, quantified)
        return
      }
      case 'UnionType': {
        for (const member of type.members)
          walkOperand(member, scope, output, defaultOutput, allocate, quantified)
        return
      }
      case 'RowWithout': {
        walkOperand(type.source, scope, output, defaultOutput, allocate, quantified)
        walkOperand(type.removed, scope, output, defaultOutput, allocate, quantified)
        return
      }
      case 'InvalidType': {
        for (const retained of type.retained)
          walkType(retained, scope, output, defaultOutput, allocate, quantified)
        return
      }
      default:
        return
    }
  }

  const walkOperand = (
    operand: AuthoredHir.RowOperand,
    scope: ReadonlyMap<string, Lifetime.Lifetime>,
    output: boolean,
    defaultOutput: Lifetime.Lifetime | undefined,
    allocate: (anchor: AuthoredHir.Anchor) => Lifetime.Lifetime | undefined,
    quantified: boolean,
  ): void => {
    if (operand._tag === 'Requirement') {
      // A requirement's own access marker denotes service access, not a stored borrow.
      setRegion(operand.anchor, Lifetime.staticLifetime)
      walkType(operand.capability, scope, output, defaultOutput, allocate, quantified)
      return
    }
    if (operand._tag === 'ReferenceType' && operand.lifetime === undefined) {
      // A row position that parses as a type spells the same access marker as a reference type.
      setRegion(operand.anchor, Lifetime.staticLifetime)
      walkType(operand.referent, scope, output, defaultOutput, allocate, quantified)
      return
    }
    walkType(operand, scope, output, defaultOutput, allocate, quantified)
  }

  const walkApplied = (
    type: Extract<AuthoredHir.Type, { readonly _tag: 'AppliedType' }>,
    scope: ReadonlyMap<string, Lifetime.Lifetime>,
    output: boolean,
    defaultOutput: Lifetime.Lifetime | undefined,
    allocate: (anchor: AuthoredHir.Anchor) => Lifetime.Lifetime | undefined,
    quantified: boolean,
    closedEnvironment?: Lifetime.Lifetime,
  ): void => {
    const target = type.target
    const targetSegment = soleSegment(target)
    const builtin = targetSegment === undefined ? undefined : nameText(context, targetSegment)
    const environment = type.arguments.environment
    if (builtin === 'Effect' || builtin === 'string') {
      // The written environment, a single written lifetime argument, or an elided region.
      const writtenLifetime = type.arguments.arguments.find(
        (argument): argument is AuthoredHir.Lifetime => argument._tag === 'Lifetime',
      )
      let value: Lifetime.Lifetime | undefined
      if (environment !== undefined && environment.length > 0)
        value = resolveEnvironment(type.anchor, environment, scope)
      else if (writtenLifetime === undefined && closedEnvironment !== undefined)
        value = closedEnvironment
      else value = region(type.anchor, writtenLifetime, scope, output, defaultOutput, allocate)
      if (value !== undefined) setRegion(type.anchor, value)
      for (const argument of type.arguments.arguments)
        if (argument !== writtenLifetime)
          walkArgument(argument, scope, output, defaultOutput, allocate, quantified)
      if (type.arguments.failures !== undefined)
        walkType(type.arguments.failures, scope, output, defaultOutput, allocate, quantified)
      if (type.arguments.requirements !== undefined)
        for (const member of type.arguments.requirements.members)
          walkOperand(member, scope, output, defaultOutput, allocate, quantified)
      return
    }
    nominal(type, scope, output, defaultOutput, allocate, type.arguments.arguments)
    // The target names a nominal; it is not itself a separate borrowed occurrence.
    const ordinaryParameters =
      nominalParameters?.(type)?.filter((parameter) => parameter.kind !== 'Lifetime') ?? []
    let argumentOrdinal = 0
    for (const argument of type.arguments.arguments) {
      if (argument._tag === 'Lifetime') {
        resolve(argument.anchor, argument, scope)
        continue
      }
      const parameter = ordinaryParameters.at(argumentOrdinal++)
      if (parameter?.kind === 'RequirementRow' && argument._tag !== 'RequirementSelector')
        walkOperand(argument, scope, output, defaultOutput, allocate, quantified)
      else walkArgument(argument, scope, output, defaultOutput, allocate, quantified)
    }
    if (type.arguments.failures !== undefined)
      walkType(type.arguments.failures, scope, output, defaultOutput, allocate, quantified)
    if (type.arguments.requirements !== undefined)
      for (const member of type.arguments.requirements.members)
        walkOperand(member, scope, output, defaultOutput, allocate, quantified)
  }

  const walkArgument = (
    argument: AuthoredHir.GenericArgument,
    scope: ReadonlyMap<string, Lifetime.Lifetime>,
    output: boolean,
    defaultOutput: Lifetime.Lifetime | undefined,
    allocate: (anchor: AuthoredHir.Anchor) => Lifetime.Lifetime | undefined,
    quantified: boolean,
  ): void => {
    if (argument._tag === 'Lifetime') {
      resolve(argument.anchor, argument, scope)
      return
    }
    if (argument._tag === 'RequirementSelector') {
      walkType(argument.subject, scope, output, defaultOutput, allocate, quantified)
      return
    }
    walkType(argument, scope, output, defaultOutput, allocate, quantified)
  }

  const walkCallable = (
    type: Extract<AuthoredHir.Type, { readonly _tag: 'CallableType' | 'ForeignFunctionType' }>,
    scope: ReadonlyMap<string, Lifetime.Lifetime>,
    output: boolean,
    defaultOutput: Lifetime.Lifetime | undefined,
    allocate: (anchor: AuthoredHir.Anchor) => Lifetime.Lifetime | undefined,
    quantified: boolean,
  ): void => {
    const environment =
      type._tag === 'ForeignFunctionType'
        ? Lifetime.staticLifetime
        : region(type.anchor, type.environment, scope, output, defaultOutput, allocate)
    if (environment !== undefined) setRegion(type.anchor, environment)
    const binderPath = [callableOrdinal++]
    const scopeBindings = new Map(scope)
    const binders: Array<Lifetime.Bound> = []
    let invocationUseLifetime: Lifetime.Bound | undefined
    let invalidInvocationUse = quantified
    if (quantified && type.binders.length > 0)
      diagnostics.push(
        Diagnostic.invalidLifetimeBinder(
          'Nested quantified callable contracts are not supported',
          Location.at(type.anchor),
        ),
      )
    for (const parameter of type.binders) {
      if (parameter._tag !== 'LifetimeParameter') {
        invalidInvocationUse = true
        diagnostics.push(
          Diagnostic.invalidLifetimeBinder(
            'A callable lifetime binder accepts only lifetime parameters',
            Location.at(parameter.anchor),
          ),
        )
        continue
      }
      const spelled = tickedName(context, parameter.name)
      if (
        spelled === undefined ||
        spelled === "'static" ||
        binders.some((binder) => Lifetime.display(binder) === spelled)
      ) {
        invalidInvocationUse = true
        diagnostics.push(
          Diagnostic.invalidLifetimeBinder(
            'Lifetime binders must have distinct names other than static',
            Location.at(parameter.anchor),
          ),
        )
        continue
      }
      const binder = Lifetime.bound(owner, binders.length, spelled, binderPath)
      binders.push(binder)
      scopeBindings.set(spelled, binder)
      if (parameter.invocationUse === true) {
        let invalid: string | undefined
        if (type._tag === 'ForeignFunctionType')
          invalid = 'A foreign callable cannot carry an invocation-use lifetime'
        else if (parameter.bounds.length > 0)
          invalid = 'An invocation-use lifetime cannot declare bounds'
        else if (invocationUseLifetime !== undefined)
          invalid = 'A callable accepts only one invocation-use lifetime'
        if (invalid !== undefined) {
          invalidInvocationUse = true
          diagnostics.push(Diagnostic.invalidLifetimeBinder(invalid, Location.at(parameter.anchor)))
        } else invocationUseLifetime = binder
      }
    }
    const lifetimeBounds: Array<Lifetime.Outlives> = []
    for (const parameter of type.binders) {
      if (parameter._tag !== 'LifetimeParameter') continue
      const spelled = tickedName(context, parameter.name)
      const longer = spelled === undefined ? undefined : scopeBindings.get(spelled)
      if (longer === undefined) continue
      for (const bound of parameter.bounds) {
        if (bound._tag !== 'Lifetime') continue
        const shorter = resolve(bound.anchor, bound, scopeBindings)
        if (shorter !== undefined) lifetimeBounds.push({ longer, shorter })
      }
    }
    const invocationRegion = (): Lifetime.Lifetime => {
      let name = `call${binders.length}`
      while (scopeBindings.has(`'${name}`)) name += '_'
      const binder = Lifetime.bound(owner, binders.length, name, binderPath)
      scopeBindings.set(`'${name}`, binder)
      binders.push(binder)
      return binder
    }
    for (const parameter of type.parameters)
      walkType(parameter, scopeBindings, false, undefined, invocationRegion, true)
    const candidates = type.parameters.flatMap((parameter) => {
      const value = getRegion(parameter.anchor)
      return value === undefined ? [] : [value]
    })
    walkType(
      type.result,
      scopeBindings,
      true,
      candidates.length === 1 ? candidates.at(0) : undefined,
      invocationRegion,
      true,
    )
    if (environment !== undefined)
      callables.set(AuthoredIdentity.anchorKey(type.anchor), {
        environment,
        lifetimeBinders: binders,
        lifetimeBounds: Lifetime.assumptions(lifetimeBounds).bounds,
        ...(invocationUseLifetime === undefined || invalidInvocationUse
          ? {}
          : {
              invocationUse: {
                lifetime: invocationUseLifetime,
                parameters: type.parameters.map((_, ordinal) => ordinal),
              },
            }),
      })
  }

  /** An `Effect` application that writes neither an environment nor a lifetime. */
  const isOmittedEffect = (type: Extract<AuthoredHir.Type, { readonly _tag: 'AppliedType' }>) => {
    const segment = soleSegment(type.target)
    return (
      segment !== undefined &&
      nameText(context, segment) === 'Effect' &&
      (type.arguments.environment === undefined || type.arguments.environment.length === 0) &&
      !type.arguments.arguments.some((argument) => argument._tag === 'Lifetime')
    )
  }
  let closedEffectResult: AuthoredHir.Anchor | undefined

  /** A position that can supply the elided output region. */
  const isCandidate = (type: AuthoredHir.Type): boolean =>
    type._tag === 'ReferenceType' ||
    type._tag === 'SliceType' ||
    isStringType(context, type) ||
    (type._tag === 'AppliedType' && isStringType(context, type.target))

  for (const parameter of headerGenerics(declaration)) {
    if (parameter._tag === 'RowParameter') continue
    for (const bound of parameter.bounds)
      if (bound._tag === 'Lifetime') resolve(bound.anchor, bound, bindings)
      else walkType(bound, bindings)
  }

  const contract = contractOf(declaration)
  if (contract === undefined || body !== undefined) {
    for (const type of headerTypes(declaration)) walkType(type, bindings)
    if (contract !== undefined) {
      for (const parameter of contract.parameters) walkType(parameter.type, bindings)
      if (contract.result !== undefined) walkType(contract.result, bindings)
      if (contract.failures !== undefined) walkType(contract.failures, bindings)
      if (contract.requirements !== undefined)
        for (const member of contract.requirements.members)
          walkOperand(member, bindings, false, undefined, fresh, false)
    }
    // A body writes annotations of its own — explicit call type arguments, binding and pattern
    // types — and each can elide a region. Elaborating only the header would leave those anchors
    // without one, so an elided `string` inside a body would read as an ambiguous output.
    if (body !== undefined && declaration.body._tag === 'CallableBody') {
      const block = declaration.body.block
      if (block !== undefined)
        for (const type of AuthoredWalk.bodyTypes(block)) walkType(type, bindings)
    }
  } else {
    const candidates: Array<Lifetime.Lifetime> = []
    let receiver: Lifetime.Lifetime | undefined
    for (const parameter of contract.parameters) {
      walkType(parameter.type, bindings)
      const value = getRegion(parameter.type.anchor)
      if (value === undefined) continue
      if (isCandidate(parameter.type)) candidates.push(value)
      if (isCandidate(parameter.type) && nameText(context, parameter.name) === 'self')
        receiver = value
    }
    const defaultOutput = receiver ?? (candidates.length === 1 ? candidates.at(0) : undefined)
    const result = contract.result
    // LIFE-004: with no borrowed-input default, an ordinary named function's own result Effect is
    // provisionally `'static`; completion confirms that no input retains anything.
    if (
      result?._tag === 'AppliedType' &&
      !contract.effect &&
      'name' in declaration.header &&
      declaration.header.name._tag === 'Name' &&
      defaultOutput === undefined &&
      isOmittedEffect(result)
    ) {
      closedEffectResult = result.anchor
      walkApplied(result, bindings, true, defaultOutput, fresh, false, Lifetime.staticLifetime)
    } else if (result !== undefined) walkType(result, bindings, true, defaultOutput)
    if (contract.failures !== undefined) walkType(contract.failures, bindings, true, defaultOutput)
    if (contract.requirements !== undefined)
      for (const member of contract.requirements.members)
        walkOperand(member, bindings, true, defaultOutput, fresh, false)
  }

  const written = contract?.environment
  const explicitEnvironment =
    written === undefined || written.length === 0
      ? undefined
      : resolveEnvironment(declaration.header.anchor, written, bindings)

  return {
    owner,
    ...(explicitEnvironment === undefined ? {} : { explicitEnvironment }),
    ...(closedEffectResult === undefined ? {} : { closedEffectResult }),
    parameters: new Map(parameters),
    nominalArguments,
    regions,
    callables,
    implicit: implicit,
    diagnostics: diagnostics,
  }
}

/**
 * A body's lookup of the declared parameters of the nominal an annotation names.
 *
 * `parametersOf` must read only `scope`, `index`, the semantic context, and the elaboration's own
 * parameters: a body shares one elaborated context per lookup identity across its annotation sites.
 */
export interface NominalBinders {
  readonly scope: NameResolution.ModuleScope
  readonly index: DeclarationIndex.Index
  readonly parametersOf: NominalParameters
}

/** One body elaboration and every input it was computed from. */
interface BodyElaboration {
  readonly context: SemanticContext.SemanticContext
  readonly declaration: AuthoredHir.Declaration
  readonly parameters: ReadonlyArray<readonly [string, Type.Parameter]>
  readonly scope: NameResolution.ModuleScope | undefined
  readonly index: DeclarationIndex.Index | undefined
  readonly elaborated: Context
}

/**
 * Body elaborations by their analysis-scoped domain. A body elaboration allocates every region from
 * the already registered `BodyLifetime` points and walks every annotation in the declaration, so it
 * is pure in its inputs and each annotation site of one body reads the same result. Computing it
 * per site made annotation-heavy bodies quadratic.
 */
const bodyElaborations = new WeakMap<BodyLifetime.BodyLifetime, Array<BodyElaboration>>()

const sameParameters = (
  left: ReadonlyArray<readonly [string, Type.Parameter]>,
  right: ReadonlyMap<string, Type.Parameter>,
): boolean => {
  if (left.length !== right.size) return false
  let ordinal = 0
  for (const [name, parameter] of right) {
    const entry = left[ordinal++]
    if (entry === undefined || entry[0] !== name || entry[1] !== parameter) return false
  }
  return true
}

/**
 * Assigns local annotation variables in the enclosing body's canonical declaration scope.
 *
 * Elaboration covers the whole declaration, so it is computed once per body, declaration,
 * parameter environment, and nominal lookup, and shared by every annotation site. Its diagnostics
 * are read only to suppress duplicates, never reported, so sharing cannot repeat one.
 */
export const forBody = (
  context: SemanticContext.SemanticContext,
  body: BodyLifetime.BodyLifetime,
  declaration: AuthoredHir.Declaration,
  parameters: ReadonlyMap<string, Type.Parameter>,
  nominal?: NominalBinders,
): Context => {
  const known = bodyElaborations.get(body) ?? []
  const previous = known.find(
    (entry) =>
      entry.context === context &&
      entry.declaration === declaration &&
      entry.scope === nominal?.scope &&
      entry.index === nominal?.index &&
      sameParameters(entry.parameters, parameters),
  )
  if (previous !== undefined) return previous.elaborated
  const elaborated = elaborate(
    context,
    body.owner,
    declaration,
    parameters,
    body,
    nominal?.parametersOf,
  )
  known.push({
    context,
    declaration,
    parameters: [...parameters],
    scope: nominal?.scope,
    index: nominal?.index,
    elaborated,
  })
  bodyElaborations.set(body, known)
  return elaborated
}
