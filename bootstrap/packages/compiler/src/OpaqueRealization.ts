import type * as AuthoredHir from './AuthoredHir.js'
import * as BodyBuilder from './BodyBuilder.js'
import type * as DeclarationFacts from './DeclarationFacts.js'
import * as Diagnostic from './Diagnostic.js'
import * as Elaboration from './Elaboration.js'
import * as ExpressionAnalysis from './ExpressionAnalysis.js'
import * as Canonical from './internal/Canonical.js'
import * as Graph from './internal/Graph.js'
import * as TypeInference from './internal/TypeInference.js'
import * as AuthoredLowering from './AuthoredLowering.js'
import * as SemanticContext from './SemanticContext.js'
import * as AuthoredWalk from './AuthoredWalk.js'
import * as Type from './Type.js'
import type * as Tir from './Tir.js'

/** One private runtime field retained by a concrete opaque callable or Effect construction. */
export interface Capture {
  readonly _tag: 'OpaqueCapture'
  readonly ordinal: number
  readonly type: Type.Type
  readonly access: Type.CaptureAccess
}

/** The actual producer specialization and executable site that constructed one realization. */
export interface Construction {
  readonly _tag: 'OpaqueConstruction'
  readonly producer: { readonly module: string; readonly name: string }
  readonly arguments: ReadonlyArray<Type.GenericArgument>
  readonly site?: string
}

/**
 * Compiler-private realization data for one declaration-owned opaque family.
 *
 * This record never participates in public source equality or module surfaces. Importing modules
 * may specialize it through `definitionOf` while tooling continues to expose only the family and
 * its public bound.
 */
export interface Definition {
  readonly _tag: 'OpaqueRealizationDefinition'
  readonly family: Type.OpaqueFamilyKey
  readonly instance: Type.OpaqueRepresentationArgument
  readonly parameters: ReadonlyArray<Type.Parameter>
  readonly realization: Type.RepresentationArgument
  readonly construction: Construction
  readonly target:
    | Type.CallableIdentityArgument
    | Type.EffectIdentityArgument
    | Type.RepresentationParameterArgument
  readonly arguments: ReadonlyArray<Type.GenericArgument>
  readonly captures: ReadonlyArray<Capture>
  readonly access: Type.CallableMode
  readonly cleanup: 'Trivial' | 'Required'
  readonly suspendable: boolean
  readonly bodyFingerprint: string
  readonly targetFingerprint: string
  readonly layoutFingerprint: string
}

/** Complete private opaque-definition catalog for one frontend revision. */
export interface Catalog {
  readonly _tag: 'OpaqueRealizationCatalog'
  readonly definitions: ReadonlyMap<string, Definition>
  readonly diagnostics: ReadonlyArray<Diagnostic.Diagnostic>
}

const catalogs = new WeakMap<object, Catalog>()

/** Associates a compiler phase artifact with its private opaque definitions. */
export const withCatalog = <A extends object>(self: A, catalog: Catalog): A => {
  catalogs.set(self, catalog)
  return self
}

/** Reads the private catalog inside compiler code and compiler-internal tests. */
export const catalogOf = (self: object): Catalog => {
  const catalog = catalogs.get(self)
  if (catalog === undefined)
    throw new RangeError('Compiler artifact has no opaque realization catalog')
  return catalog
}

/** Reads an associated private catalog when an artifact has retained its compiler identity. */
export const catalogOption = (self: object): Catalog | undefined => catalogs.get(self)

/**
 * What one returned expression of a producer shows about its opaque result.
 *
 * Construction publishes these with the body; realization never reads the body again.
 */
export interface Evidence {
  readonly argument: Type.RepresentationArgument
  /** The returned expression, for diagnostics. */
  readonly at: AuthoredHir.Anchor
  readonly captures: ReadonlyArray<Capture>
  readonly suspendable: boolean
}

interface Producer {
  readonly declaration: DeclarationFacts.DeclarationFact
  readonly instance: Type.OpaqueRepresentationArgument
  readonly evidence: ReadonlyArray<Evidence>
  readonly bodyFingerprint: string
}

const familyKey = (family: Type.OpaqueFamilyKey): string => Type.opaqueFamilyKey(family)

const reachableResults = (
  expression: Elaboration.ExpressionDecision | Tir.Expression,
): ReadonlyArray<Elaboration.ExpressionDecision | Tir.Expression> => {
  if (expression._tag !== 'Match') return [expression]
  return expression.arms.flatMap((arm) =>
    arm.reachable && arm.body._tag === 'Expression' ? reachableResults(arm.body.expression) : [],
  )
}

const returnExpressions = (
  statements: ReadonlyArray<Tir.Statement>,
): ReadonlyArray<Elaboration.ExpressionDecision | Tir.Expression> => {
  const found: Array<Elaboration.ExpressionDecision | Tir.Expression> = []
  Elaboration.visitStatements(statements, {
    descendExpressions: false,
    statement: (statement) => {
      if (statement._tag === 'Return') found.push(...reachableResults(statement.expression))
    },
  })
  return found
}

const evidence = (
  argument: Type.RepresentationArgument,
  expression: Elaboration.ExpressionDecision | Tir.Expression,
  builder?: BodyBuilder.BodyBuilder,
): Evidence => ({
  argument,
  at: Elaboration.constructionExpressionAnchor(expression),
  captures: capturesOf(expression, builder),
  suspendable: expressionSuspends(constructionExpression(expression, builder)),
})

const evidenceOf = (
  context: SemanticContext.SemanticContext,
  expression: Elaboration.ExpressionDecision | Tir.Expression,
  expected: Type.Type,
  family: Type.OpaqueFamilyKey,
  builder?: BodyBuilder.BodyBuilder,
): ReadonlyArray<Evidence> => {
  if ('origin' in expression && expression._tag === 'Unavailable' && builder !== undefined) {
    const semantic = BodyBuilder.semanticOfExpression(builder, expression)
    if (semantic !== undefined) return evidenceOf(context, semantic, expected, family, builder)
  }
  if ('origin' in expression && expression._tag === 'UnionConvert')
    return evidenceOf(context, expression.source, expected, family, builder)
  const expressionType = Elaboration.constructionExpressionType(expression)
  const structural =
    expressionType._tag === 'Available'
      ? Type.opaqueRepresentationEvidence(expressionType.type, expected, family)
      : []
  if (structural.length > 0)
    return structural.map((argument) => evidence(argument, expression, builder))
  const nestedFamily = Type.opaqueRepresentationArguments(expected).some((argument) =>
    Type.equalsOpaqueFamily(argument.family, family),
  )
  if (nestedFamily) {
    const argument = ExpressionAnalysis.representationOfExpression(context, expression, builder)
    if (argument !== undefined) return [evidence(argument, expression, builder)]
  }
  const expectedArgument = Type.isRepresented(expected)
    ? expected.representation.argument
    : undefined
  if (
    expectedArgument === undefined ||
    !Type.isOpaqueRepresentationArgument(expectedArgument) ||
    !Type.equalsOpaqueFamily(expectedArgument.family, family)
  )
    return []
  const argument = ExpressionAnalysis.representationOfExpression(context, expression, builder)
  return argument === undefined ? [] : [evidence(argument, expression, builder)]
}

/**
 * The authored body a realization is keyed by.
 *
 * The canonical encoding replaces the source-byte slice the syntax fingerprint took: it is
 * already source-independent, so a re-indented body keeps its realization.
 */
const sourceBodyFingerprint = (
  result: Elaboration.Result,
  declaration: DeclarationFacts.DeclarationFact,
): string => {
  const authored = AuthoredWalk.declarationOf(result.authored.module, declaration.owner)
  return Canonical.record('OpaqueBody', [
    declaration.id.sourceId,
    authored === undefined ? '' : AuthoredLowering.canonicalBody(result.authored, authored),
  ])
}

/** The opaque-result evidence of one body, which is empty unless its declaration produces one. */
export const evidenceOfBody = (
  context: SemanticContext.SemanticContext,
  declaration: DeclarationFacts.DeclarationFact,
  statements: ReadonlyArray<Tir.Statement>,
  builder?: BodyBuilder.BodyBuilder,
): ReadonlyArray<Evidence> => {
  const opaque = declaration.opaqueResult
  const expected = declaration.returnType
  if (opaque === undefined || expected._tag !== 'Resolved') return []
  const expressions = returnExpressions(statements)
  const found = expressions.flatMap((expression) =>
    evidenceOf(context, expression, expected.type, opaque.family, builder),
  )
  return found
}

const producers = (results: ReadonlyMap<string, Elaboration.Result>): ReadonlyArray<Producer> =>
  [...results.values()].flatMap((result) => {
    return result.bodies.flatMap((body): ReadonlyArray<Producer> => {
      if (body.hidden) return []
      const opaque = body.declaration.opaqueResult
      const expected = body.declaration.returnType
      if (opaque === undefined || expected._tag !== 'Resolved') return []
      const instance = Type.opaqueRepresentationArguments(expected.type).find((argument) =>
        Type.equalsOpaqueFamily(argument.family, opaque.family),
      )
      if (instance === undefined) return []
      return [
        {
          declaration: body.declaration,
          instance,
          evidence: body.results.opaqueEvidence,
          bodyFingerprint: sourceBodyFingerprint(result, body.declaration),
        },
      ]
    })
  })

const constructionExpression = (
  expression: Elaboration.ExpressionDecision | Tir.Expression,
  builder?: BodyBuilder.BodyBuilder,
): Elaboration.ExpressionDecision | Tir.Expression => {
  if (expression._tag === 'Move') return constructionExpression(expression.subject, builder)
  if ('origin' in expression && expression._tag === 'Unavailable' && builder !== undefined) {
    const semantic = BodyBuilder.semanticOfExpression(builder, expression)
    if (semantic !== undefined) return constructionExpression(semantic, builder)
  }
  if ('origin' in expression && expression._tag === 'BindingReference' && builder !== undefined) {
    const semantic = BodyBuilder.semanticOfLocal(builder, expression.binding)
    if (Elaboration.isBindingDeclarationFact(semantic))
      return constructionExpression(semantic.initializer, builder)
  }
  if (
    !('origin' in expression) &&
    expression._tag === 'Identifier' &&
    expression.reference._tag === 'ResolvedBinding'
  )
    return constructionExpression(expression.reference.binding.initializer, builder)
  return expression
}

const captureType = (
  reference: Elaboration.EffectCaptureFact['reference'],
): Type.Type | undefined => {
  if (reference._tag === 'BindingFact')
    return reference.inferredType._tag === 'Available' ? reference.inferredType.type : undefined
  if (reference._tag === 'PatternBinding')
    return reference.type._tag === 'Available' ? reference.type.type : undefined
  return reference.declaredType._tag === 'Resolved' ? reference.declaredType.type : undefined
}

const capturesOf = (
  expression: Elaboration.ExpressionDecision | Tir.Expression,
  builder?: BodyBuilder.BodyBuilder,
): ReadonlyArray<Capture> => {
  const construction = constructionExpression(expression, builder)
  if ('origin' in construction && construction._tag === 'CallableSection')
    return construction.captures.flatMap((capture): ReadonlyArray<Capture> => {
      const type = Elaboration.constructionExpressionType(capture.value)
      if (type._tag !== 'Available') return []
      return [
        {
          _tag: 'OpaqueCapture',
          ordinal: capture.ordinal,
          type: type.type,
          access: capture.access,
        },
      ]
    })
  if (!('origin' in construction) && construction._tag === 'CallableSection')
    return construction.captures.flatMap((capture): ReadonlyArray<Capture> => {
      const type = Elaboration.constructionExpressionType(capture.expression)
      if (type._tag !== 'Available') return []
      return [
        {
          _tag: 'OpaqueCapture',
          ordinal: capture.ordinal,
          type: type.type,
          access: capture.access,
        },
      ]
    })
  if ('origin' in construction && construction._tag === 'EffectBlock' && builder !== undefined)
    return construction.captures.flatMap((capture, ordinal): ReadonlyArray<Capture> => {
      const local = capture.binding ?? capture.pattern ?? capture.parameter
      if (local === undefined) return []
      const semantic = BodyBuilder.semanticOfLocal(builder, local)
      if (
        !Elaboration.isBindingDeclarationFact(semantic) &&
        !Elaboration.isPatternBindingFact(semantic) &&
        !Elaboration.isParameterFact(semantic)
      )
        return []
      const type = captureType(semantic)
      return type === undefined
        ? []
        : [
            {
              _tag: 'OpaqueCapture',
              ordinal,
              type,
              access: capture.access,
            },
          ]
    })
  if (!('origin' in construction) && construction._tag === 'EffectBlock')
    return construction.captures.flatMap((capture, ordinal): ReadonlyArray<Capture> => {
      const type = captureType(capture.reference)
      return type === undefined
        ? []
        : [
            {
              _tag: 'OpaqueCapture',
              ordinal,
              type,
              access: capture.access,
            },
          ]
    })
  return []
}

const expressionSuspends = (
  expression: Elaboration.ExpressionDecision | Tir.Expression,
): boolean => {
  let suspendable = false
  Elaboration.visitExpressionDecisions(expression, {
    expression: (current) => {
      if (current._tag === 'Run') suspendable = true
    },
    node: (current) => {
      if (current._tag === 'Run') suspendable = true
    },
  })
  return suspendable
}

const accessOf = (argument: Type.RepresentationArgument): Definition['access'] => {
  const contract =
    argument._tag === 'RepresentationParameterArgument'
      ? argument.parameter.representationBound
      : argument.contract
  if (contract === undefined) {
    return 'Shared'
  }
  if (Type.isCallable(contract)) {
    return contract.mode
  }
  return contract.access
}

const targetOf = (argument: Type.RepresentationArgument): Definition['target'] => {
  if (argument._tag === 'ExactRepresentationArgument') return argument.identity
  if (argument._tag === 'RepresentationParameterArgument') return argument
  throw new RangeError('An opaque realization cannot target another unresolved opaque family')
}

const argumentsOf = (
  argument: Type.RepresentationArgument,
): ReadonlyArray<Type.GenericArgument> => {
  if (
    argument._tag === 'ExactRepresentationArgument' &&
    Type.isCallableIdentityArgument(argument.identity)
  ) {
    return argument.identity.typeArguments
  }
  if (argument._tag === 'OpaqueRepresentationArgument') {
    return argument.arguments
  }
  return []
}

const constructionSite = (argument: Type.RepresentationArgument): string | undefined => {
  if (argument._tag !== 'ExactRepresentationArgument') return undefined
  if (Type.isCallableIdentityArgument(argument.identity)) {
    if (argument.identity.environment === undefined) {
      return undefined
    }
    return Type.callableEnvironmentKey(argument.identity.environment)
  }
  return argument.identity.identity
}

const constructionOf = (
  producer: Producer,
  realization: Type.RepresentationArgument,
  inherited: Definition | undefined,
): Construction => {
  if (inherited !== undefined) return inherited.construction
  const site = constructionSite(realization)
  return {
    _tag: 'OpaqueConstruction',
    producer: { ...producer.instance.family.producer },
    arguments: [...producer.instance.arguments],
    ...(site === undefined ? {} : { site }),
  }
}

const fingerprints = (
  instance: Type.OpaqueRepresentationArgument,
  realization: Type.RepresentationArgument,
  captures: ReadonlyArray<Capture>,
  access: Definition['access'],
  cleanup: Definition['cleanup'],
  suspendable: boolean,
): Pick<Definition, 'targetFingerprint' | 'layoutFingerprint'> => ({
  targetFingerprint: Canonical.record('OpaqueTarget', [
    Type.genericArgumentKey(targetOf(realization)),
    Type.key(instance.contract),
  ]),
  layoutFingerprint: Canonical.record('OpaqueLayout', [
    access,
    cleanup,
    String(suspendable),
    Canonical.array(
      captures.map((capture) =>
        Canonical.record('Capture', [
          String(capture.ordinal),
          Type.key(capture.type),
          capture.access,
        ]),
      ),
    ),
  ]),
})

const definition = (
  producer: Producer,
  realization: Type.RepresentationArgument,
  source: Evidence | undefined,
  inherited: Definition | undefined,
): Definition => {
  const captures = source === undefined ? (inherited?.captures ?? []) : source.captures
  const access = accessOf(realization)
  const cleanup = captures.some((capture) => capture.access === 'Take') ? 'Required' : 'Trivial'
  const suspendable = source === undefined ? (inherited?.suspendable ?? false) : source.suspendable
  const computedFingerprints = fingerprints(
    producer.instance,
    realization,
    captures,
    access,
    cleanup,
    suspendable,
  )
  return {
    _tag: 'OpaqueRealizationDefinition',
    family: producer.instance.family,
    instance: producer.instance,
    parameters: producer.declaration.typeParameters.map((parameter) => parameter.type),
    realization,
    construction: constructionOf(producer, realization, inherited),
    target: targetOf(realization),
    arguments: argumentsOf(realization),
    captures,
    access,
    cleanup,
    suspendable,
    bodyFingerprint: producer.bodyFingerprint,
    ...computedFingerprints,
  }
}

const specializeRealization = (
  producer: Producer,
  instance: Type.OpaqueRepresentationArgument,
  realization: Type.RepresentationArgument,
): Type.RepresentationArgument | undefined => {
  const substitution = TypeInference.substitution(
    producer.declaration.typeParameters.map((parameter) => parameter.type),
    instance.arguments,
  )
  if (substitution === undefined) return undefined
  const specialized = Type.substituteGenericArgument(realization, substitution)
  return Type.isRepresentationArgument(specialized) ? specialized : undefined
}

const specializeDefinition = (
  found: Definition,
  instance: Type.OpaqueRepresentationArgument,
): Definition | undefined => {
  const substitution = TypeInference.substitution(found.parameters, instance.arguments)
  if (substitution === undefined) return undefined
  const realization = Type.substituteGenericArgument(found.realization, substitution)
  if (!Type.isRepresentationArgument(realization)) return undefined
  const captures = found.captures.map((capture) => ({
    ...capture,
    type: Type.substitute(capture.type, substitution),
  }))
  const constructionArguments = found.construction.arguments.map((argument) =>
    Type.substituteGenericArgument(argument, substitution),
  )
  const site = constructionSite(realization)
  const access = accessOf(realization)
  const cleanup = captures.some((capture) => capture.access === 'Take') ? 'Required' : 'Trivial'
  return {
    ...found,
    instance,
    realization,
    construction: {
      _tag: 'OpaqueConstruction',
      producer: found.construction.producer,
      arguments: constructionArguments,
      ...(site === undefined ? {} : { site }),
    },
    target: targetOf(realization),
    arguments: argumentsOf(realization),
    captures,
    access,
    cleanup,
    ...fingerprints(instance, realization, captures, access, cleanup, found.suspendable),
  }
}

const stronglyConnectedCycles = (
  keys: Iterable<string>,
  dependencies: (key: string) => Iterable<string>,
): ReadonlyArray<ReadonlyArray<string>> => {
  const orderedKeys = [...new Set(keys)].sort()
  const known = new Set(orderedKeys)
  const neighbors = (key: string): ReadonlyArray<string> =>
    [...new Set(dependencies(key))].filter((dependency) => known.has(dependency)).sort()
  return Graph.stronglyConnected(orderedKeys, neighbors).filter(
    (component) =>
      component.length > 1 || neighbors(component[0] ?? '').includes(component[0] ?? ''),
  )
}

const inlineLayoutCycles = (
  definitions: ReadonlyMap<string, Definition>,
): ReadonlyArray<ReadonlyArray<string>> =>
  stronglyConnectedCycles(definitions.keys(), (key) =>
    (definitions.get(key)?.captures ?? []).flatMap((capture) =>
      Type.opaqueRepresentationArguments(capture.type).map((argument) =>
        familyKey(argument.family),
      ),
    ),
  )

const unresolvedRealizationCycles = (
  pending: ReadonlyArray<Producer>,
): ReadonlyArray<ReadonlyArray<string>> => {
  const byFamily = new Map(
    pending.map((producer) => [familyKey(producer.instance.family), producer]),
  )
  return stronglyConnectedCycles(byFamily.keys(), (key) =>
    (byFamily.get(key)?.evidence ?? []).flatMap((evidence) =>
      evidence.argument._tag === 'OpaqueRepresentationArgument'
        ? [familyKey(evidence.argument.family)]
        : [],
    ),
  )
}

/** Builds all private definitions and diagnoses non-finite or divergent opaque families. */
export const analyze = (results: ReadonlyMap<string, Elaboration.Result>): Catalog => {
  // Producers and their evidence span several modules, so spans resolve through the closure's
  // registry rather than any one module's context.
  const spanOf = SemanticContext.fromModules([...results.values()]).spanOf
  const pending = producers(results)
  const producersByFamily = new Map(
    pending.map((producer) => [familyKey(producer.instance.family), producer]),
  )
  const resolved = new Map<string, ReadonlyMap<string, Type.RepresentationArgument>>()
  for (const producer of pending) {
    const leaves = new Map<string, Type.RepresentationArgument>()
    for (const evidence of producer.evidence) {
      if (evidence.argument._tag === 'OpaqueRepresentationArgument') continue
      leaves.set(Type.genericArgumentKey(evidence.argument), evidence.argument)
    }
    resolved.set(familyKey(producer.instance.family), leaves)
  }

  let changed = true
  while (changed) {
    changed = false
    for (const producer of pending) {
      const key = familyKey(producer.instance.family)
      const current = new Map(resolved.get(key) ?? [])
      for (const evidence of producer.evidence) {
        if (evidence.argument._tag !== 'OpaqueRepresentationArgument') continue
        const dependencyKey = familyKey(evidence.argument.family)
        const dependency = producersByFamily.get(dependencyKey)
        if (dependency === undefined) continue
        for (const argument of resolved.get(dependencyKey)?.values() ?? []) {
          const specialized = specializeRealization(dependency, evidence.argument, argument)
          if (specialized !== undefined)
            current.set(Type.genericArgumentKey(specialized), specialized)
        }
      }
      if (current.size !== (resolved.get(key)?.size ?? 0)) {
        resolved.set(key, current)
        changed = true
      }
    }
  }

  const diagnostics: Array<Diagnostic.Diagnostic> = []
  const definitions = new Map<string, Definition>()
  const invalid = new Set<string>()
  const realizationCycles = unresolvedRealizationCycles(
    pending.filter(
      (producer) => (resolved.get(familyKey(producer.instance.family))?.size ?? 0) === 0,
    ),
  )
  const cyclic = new Set(realizationCycles.flat())
  for (const cycle of realizationCycles) {
    for (const key of cycle) invalid.add(key)
    const producer = producersByFamily.get(cycle.at(0) ?? '')
    if (producer === undefined) continue
    diagnostics.push(
      Diagnostic.opaqueRealizationCycle(
        cycle,
        spanOf(producer.declaration.opaqueResult?.anchor ?? producer.declaration.anchor),
      ),
    )
  }
  for (const producer of pending) {
    const key = familyKey(producer.instance.family)
    const alternatives = [...(resolved.get(key)?.entries() ?? [])].sort(([left], [right]) => {
      if (left < right) {
        return -1
      }
      if (left > right) {
        return 1
      }
      return 0
    })
    if (alternatives.length > 1) {
      invalid.add(key)
      diagnostics.push(
        Diagnostic.divergentOpaqueRealization(
          key,
          alternatives.map(([identity]) => identity),
          producer.evidence.map((evidence) => spanOf(evidence.at)),
          spanOf(producer.declaration.opaqueResult?.anchor ?? producer.declaration.anchor),
        ),
      )
    } else if (alternatives.length === 0 && !cyclic.has(key)) {
      invalid.add(key)
      diagnostics.push(
        Diagnostic.missingOpaqueRealization(
          key,
          spanOf(producer.declaration.opaqueResult?.anchor ?? producer.declaration.anchor),
        ),
      )
    }
  }

  let progress = true
  while (progress) {
    progress = false
    for (const producer of pending) {
      const key = familyKey(producer.instance.family)
      if (invalid.has(key) || definitions.has(key)) continue
      const realization = [...(resolved.get(key)?.values() ?? [])].at(0)
      if (realization === undefined) continue
      const direct = producer.evidence.find(
        (evidence) =>
          evidence.argument._tag !== 'OpaqueRepresentationArgument' &&
          Type.equalsGenericArgument(evidence.argument, realization),
      )
      const dependency = producer.evidence
        .filter(
          (
            evidence,
          ): evidence is Evidence & { readonly argument: Type.OpaqueRepresentationArgument } =>
            evidence.argument._tag === 'OpaqueRepresentationArgument',
        )
        .map((evidence) => {
          const found = definitions.get(familyKey(evidence.argument.family))
          return found === undefined ? undefined : specializeDefinition(found, evidence.argument)
        })
        .filter(
          (candidate): candidate is Definition =>
            candidate !== undefined &&
            Type.equalsGenericArgument(candidate.realization, realization),
        )
        .find((candidate) => candidate !== undefined)
      if (direct === undefined && dependency === undefined) continue
      const built = definition(producer, realization, direct, dependency)
      definitions.set(key, built)
      progress = true
    }
  }

  for (const cycle of inlineLayoutCycles(definitions)) {
    for (const key of cycle) {
      definitions.delete(key)
      invalid.add(key)
    }
    const producer = producersByFamily.get(cycle.at(0) ?? '')
    if (producer === undefined) continue
    diagnostics.push(
      Diagnostic.inlineOpaqueLayoutCycle(
        cycle,
        spanOf(producer.declaration.opaqueResult?.anchor ?? producer.declaration.anchor),
      ),
    )
  }

  return {
    _tag: 'OpaqueRealizationCatalog',
    definitions: new Map([...definitions].sort(([left], [right]) => (left < right ? -1 : 1))),
    diagnostics: Diagnostic.merge(diagnostics),
  }
}

/** Looks up and specializes one compiler-private definition for an opaque family instance. */
export const definitionOf = (
  self: Catalog,
  instance: Type.OpaqueRepresentationArgument,
): Definition | undefined => {
  const found = self.definitions.get(familyKey(instance.family))
  return found === undefined ? undefined : specializeDefinition(found, instance)
}

/** Stable source family identity used by incremental dependency maps and test fixtures. */
export const key = (self: Definition): string => familyKey(self.family)
