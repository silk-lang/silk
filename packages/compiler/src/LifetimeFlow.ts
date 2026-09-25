import * as Location from './Location.js'
import * as BodyLifetime from './BodyLifetime.js'
import * as BodyBuilder from './BodyBuilder.js'
import * as BodyControlFlow from './BodyControlFlow.js'
import * as CleanupPlan from './CleanupPlan.js'
import * as DeclarationFacts from './DeclarationFacts.js'
import type * as DeclarationIndex from './DeclarationIndex.js'
import * as Diagnostic from './Diagnostic.js'
import * as Elaboration from './Elaboration.js'
import * as Tir from './Tir.js'
import * as Lifetime from './Lifetime.js'
import type * as MovePath from './MovePath.js'
import * as Ownership from './Ownership.js'
import * as SourceSpan from './SourceSpan.js'
import type * as AuthoredHir from './AuthoredHir.js'
import * as AuthoredIdentity from './AuthoredIdentity.js'
import type * as SemanticContext from './SemanticContext.js'
import * as Type from './Type.js'
import * as TypeOutlives from './TypeOutlives.js'
import * as TypeInference from './internal/TypeInference.js'

/** One concrete source of a semantic borrow, separate from its reusable lifetime contract. */
export interface Origin {
  readonly lifetime: Lifetime.Lifetime
  readonly root?: Ownership.BindingSite
  readonly path?: ReadonlyArray<Elaboration.BorrowSelectorFact>
  readonly parent?: Lifetime.Lifetime
  readonly span: SourceSpan.SourceSpan
  /** The node `span` presents, which is where a diagnostic about this origin reports. */
  readonly at: AuthoredHir.Anchor
  /** The authored position this borrow was created at, for structural containment tests. */
  readonly anchor?: AuthoredHir.Anchor
}

/** Inspectable finite region proof retained independently of TIR and runtime specialization. */
export interface LifetimeFlow {
  readonly controlFlow: BodyControlFlow.BodyControlFlow
  readonly retiredUses: ReadonlyMap<string, ReadonlySet<number>>
  readonly retirementWork: { readonly comparisons: number; readonly comparisonCacheHits: number }
  readonly syntaxPointCount: number
  readonly input: Lifetime.Input
  readonly solution: Lifetime.Solution
  readonly origins: ReadonlyMap<string, Origin>
  readonly spans: ReadonlyMap<number, SourceSpan.SourceSpan>
  /** The authored node behind each point of `spans`. */
  readonly anchors: ReadonlyMap<number, AuthoredHir.Anchor>
  readonly diagnostics: ReadonlyArray<Diagnostic.Located>
}

interface Region {
  readonly lifetime: Lifetime.Lifetime
  readonly unavailable: Set<number>
  readonly required: Set<number>
}

/**
 * Structural enclosure: an authored anchor's local path extends its parent's, so an outer position
 * encloses an inner one exactly when it owns it and its path is a prefix.
 *
 * A nested callable is its own owner, so its positions carry no path below the body that wrote
 * it. Those fall back to presented containment, the only record of where the nested owner sits.
 */
const encloses = (
  context: SemanticContext.SemanticContext,
  outer: AuthoredHir.Anchor,
  inner: AuthoredHir.Anchor,
): boolean => {
  if (AuthoredIdentity.key(outer.owner) !== AuthoredIdentity.key(inner.owner)) {
    const outerSpan = context.spanOf(outer)
    const innerSpan = context.spanOf(inner)
    return outerSpan.start <= innerSpan.start && innerSpan.end <= outerSpan.end
  }
  return (
    outer.path.length <= inner.path.length &&
    outer.path.every((segment, index) => {
      const candidate = inner.path[index]
      return (
        candidate !== undefined &&
        segment.role === candidate.role &&
        segment.occurrence === candidate.occurrence
      )
    })
  )
}

const rootSite = (
  root: Elaboration.BorrowRootFact,
  builder: BodyBuilder.BodyBuilder,
): Ownership.BindingSite => {
  switch (root._tag) {
    case 'BindingRoot':
      return { _tag: 'Let', binding: BodyBuilder.localId(builder, root.binding.id) }
    case 'ParameterRoot':
      return { _tag: 'Parameter', parameter: BodyBuilder.localId(builder, root.parameter.id) }
    case 'PatternRoot':
      return { _tag: 'Pattern', binding: BodyBuilder.localId(builder, root.binding.id) }
    case 'TemporaryRoot':
      return { _tag: 'Temporary', owner: root.owner }
  }
}

const expressionRoot = (
  expression: Elaboration.ExpressionDecision | Tir.Expression,
  context: SemanticContext.SemanticContext,
  builder: BodyBuilder.BodyBuilder,
  throughBorrow = false,
): Elaboration.BorrowRootFact | undefined => {
  if ('origin' in expression) {
    const localRoot = (
      local: Tir.LocalId,
      kind: 'Binding' | 'Parameter' | 'Pattern',
    ): Elaboration.BorrowRootFact | undefined => {
      const semantic = BodyBuilder.semanticOfLocal(builder, local)
      if (kind === 'Binding' && Elaboration.isBindingDeclarationFact(semantic))
        return { _tag: 'BindingRoot', binding: semantic, path: [] }
      if (kind === 'Parameter' && Elaboration.isParameterFact(semantic))
        return { _tag: 'ParameterRoot', parameter: semantic, path: [] }
      if (kind === 'Pattern' && Elaboration.isPatternBindingFact(semantic))
        return { _tag: 'PatternRoot', binding: semantic, path: [] }
      return undefined
    }
    const selector = (value: Tir.BorrowSelector): Elaboration.BorrowSelectorFact => {
      if (value._tag === 'Field')
        return {
          _tag: 'Field',
          field: value.field,
          span: value.span,
          ...(value.at === undefined ? {} : { at: value.at }),
        }
      if (value._tag === 'Index')
        return {
          _tag: 'Index',
          index: value.index,
          array: value.array,
          bounds: value.bounds,
          span: value.span,
          ...(value.at === undefined ? {} : { at: value.at }),
        }
      return {
        _tag: 'SliceIndex',
        index: value.index,
        slice: value.slice,
        span: value.span,
        ...(value.at === undefined ? {} : { at: value.at }),
      }
    }
    const append = (
      root: Elaboration.BorrowRootFact | undefined,
      next: Elaboration.BorrowSelectorFact,
    ): Elaboration.BorrowRootFact | undefined =>
      root === undefined ? undefined : { ...root, path: [...root.path, next] }
    if (expression._tag === 'BindingReference') return localRoot(expression.binding, 'Binding')
    if (expression._tag === 'ParameterReference')
      return localRoot(expression.parameter, 'Parameter')
    if (expression._tag === 'PatternBindingReference')
      return localRoot(expression.binding, 'Pattern')
    if (expression._tag === 'Move')
      return expressionRoot(expression.subject, context, builder, throughBorrow)
    if (expression._tag === 'UnionConvert')
      return expressionRoot(expression.source, context, builder, throughBorrow)
    if (expression._tag === 'Project')
      return append(expressionRoot(expression.subject, context, builder, throughBorrow), {
        _tag: 'Field',
        field: expression.field,
        span: expression.span,
        at: expression.origin.anchor,
      })
    if (expression._tag === 'IndexPlace')
      return append(expressionRoot(expression.subject, context, builder, throughBorrow), {
        _tag: 'Index',
        index: expression.index,
        array: expression.array,
        bounds: expression.bounds,
        span: expression.span,
        at: expression.origin.anchor,
      })
    if (expression._tag === 'SliceIndexPlace')
      return append(expressionRoot(expression.slice, context, builder, throughBorrow), {
        _tag: 'SliceIndex',
        index: expression.index,
        slice: expression.sourceType,
        span: expression.span,
        at: expression.origin.anchor,
      })
    if (throughBorrow && expression._tag === 'ReferentPlace')
      return expressionRoot(expression.subject, context, builder, true)
    if (expression._tag === 'ValueBorrow' || expression._tag === 'SliceBorrow') {
      const root = (() => {
        if (expression.root._tag === 'BindingSliceRoot')
          return localRoot(expression.root.binding, 'Binding')
        if (expression.root._tag === 'ParameterSliceRoot')
          return localRoot(expression.root.parameter, 'Parameter')
        if (expression.root._tag === 'PatternSliceRoot')
          return localRoot(expression.root.binding, 'Pattern')
        return {
          _tag: 'TemporaryRoot' as const,
          owner: expression.root.owner,
          value: expression.root.value,
          path: [],
        }
      })()
      return root === undefined
        ? undefined
        : { ...root, path: [...root.path, ...expression.selectors.map(selector)] }
    }
    return undefined
  }
  if (expression._tag === 'Identifier') {
    if (expression.reference._tag === 'ResolvedBinding')
      return { _tag: 'BindingRoot', binding: expression.reference.binding, path: [] }
    if (expression.reference._tag === 'Resolved')
      return { _tag: 'ParameterRoot', parameter: expression.reference.parameter, path: [] }
    if (expression.reference._tag === 'ResolvedPattern')
      return { _tag: 'PatternRoot', binding: expression.reference.binding, path: [] }
  }
  if (expression._tag === 'Move')
    return expressionRoot(expression.subject, context, builder, throughBorrow)
  if (expression._tag === 'FieldProjection' && expression.state._tag === 'Resolved') {
    const subjectType = Elaboration.constructionExpressionType(expression.subject)
    if (!throughBorrow && subjectType._tag === 'Available' && Type.isReference(subjectType.type))
      return undefined
    const root = expressionRoot(expression.subject, context, builder, throughBorrow)
    return root === undefined
      ? undefined
      : {
          ...root,
          path: [
            ...root.path,
            {
              _tag: 'Field',
              field: expression.state.field.id,
              span: context.spanOf(expression.anchor),
              at: expression.anchor,
            },
          ],
        }
  }
  if (
    expression._tag === 'IndexProjection' &&
    expression.array !== undefined &&
    (expression.bounds._tag === 'Proven' || expression.bounds._tag === 'Runtime')
  ) {
    const root = expressionRoot(expression.subject, context, builder, throughBorrow)
    return root === undefined
      ? undefined
      : {
          ...root,
          path: [
            ...root.path,
            {
              _tag: 'Index',
              index: expression.index,
              array: expression.array,
              bounds: expression.bounds,
              span: context.spanOf(expression.anchor),
              at: expression.anchor,
            },
          ],
        }
  }
  if (throughBorrow && expression._tag === 'ReferentProjection')
    return expressionRoot(expression.subject, context, builder, true)
  if (expression._tag === 'Borrow' && expression.formation._tag !== 'Unavailable')
    return expression.formation.root
  return undefined
}

// A referent read still demands the lifetime stored in its reference or slice carrier.
// Keep this distinct from expressionRoot: a write through a borrow does not replace its carrier.
const carrierExpression = (
  expression: Elaboration.ExpressionDecision | Tir.Expression,
): Elaboration.ExpressionDecision | Tir.Expression => {
  if ('origin' in expression) {
    if (
      expression._tag === 'Move' ||
      expression._tag === 'ReferentPlace' ||
      expression._tag === 'Project' ||
      expression._tag === 'IndexPlace'
    )
      return carrierExpression(expression.subject)
    if (expression._tag === 'SliceIndexPlace') return carrierExpression(expression.slice)
    if (expression._tag === 'UnionConvert') return carrierExpression(expression.source)
    if (
      (expression._tag === 'ValueBorrow' || expression._tag === 'SliceBorrow') &&
      expression.place !== undefined
    )
      return carrierExpression(expression.place)
    return expression
  }
  const subjectType =
    expression._tag === 'FieldProjection'
      ? Elaboration.constructionExpressionType(expression.subject)
      : Elaboration.unavailableExpressionType
  if (
    expression._tag === 'Borrow' ||
    expression._tag === 'Move' ||
    expression._tag === 'ReferentProjection' ||
    (expression._tag === 'IndexProjection' && expression.array === undefined) ||
    (expression._tag === 'FieldProjection' &&
      subjectType._tag === 'Available' &&
      Type.isReference(subjectType.type))
  )
    return carrierExpression(expression.subject)
  return expression
}

const pathsOverlap = (
  left: ReadonlyArray<Elaboration.BorrowSelectorFact>,
  right: ReadonlyArray<Elaboration.BorrowSelectorFact>,
): boolean => {
  for (const [ordinal, selector] of left.entries()) {
    const other = right.at(ordinal)
    if (other === undefined) return true
    if (
      selector._tag === 'Field' &&
      other._tag === 'Field' &&
      selector.field.ordinal !== other.field.ordinal
    )
      return false
    if (
      selector._tag === 'Index' &&
      other._tag === 'Index' &&
      selector.bounds._tag === 'Proven' &&
      other.bounds._tag === 'Proven' &&
      selector.bounds.index !== other.bounds.index
    )
      return false
  }
  return true
}

/** Validates one generic body using only its declared assumptions and selected semantic facts. */
export const analyze = (
  declaration: DeclarationFacts.DeclarationFact,
  statements: ReadonlyArray<Tir.Statement>,
  body: BodyLifetime.BodyLifetime,
  index: DeclarationIndex.Index,
  context: SemanticContext.SemanticContext,
  builder: BodyBuilder.BodyBuilder,
  outlivesScope: TypeOutlives.Context = TypeOutlives.context(index.modules),
): LifetimeFlow => {
  const applicationDiagnostics = new Map<string, Diagnostic.Located>()
  // Points are the authored positions BodyLifetime enumerated, addressed by anchor key.
  const entries = [...body.points].flatMap(([key, point]) => {
    const anchor = body.anchors.get(key)
    return anchor === undefined ? [] : [[anchor, point] as const]
  })
  const root = entries.at(0)?.[0] ?? declaration.anchor
  const controlFlow = BodyControlFlow.make(context, statements, root)
  const boundaries = new Map<string, number>()
  const bindingInitializers = new Set<string>()
  const terminalSpans = new Map<number, SourceSpan.SourceSpan>()
  const terminalAnchors = new Map<number, AuthoredHir.Anchor>()
  Elaboration.visitStatements(statements, {
    statement: (statement) => {
      if (statement._tag === 'Bind')
        bindingInitializers.add(AuthoredIdentity.anchorKey(statement.origin.anchor))
      if (statement._tag !== 'Return' && statement._tag !== 'Fail') return
      const key = AuthoredIdentity.anchorKey(statement.origin.anchor)
      if (boundaries.has(key)) return
      const point = body.points.size + boundaries.size
      boundaries.set(key, point)
      terminalSpans.set(point, statement.expression.span)
      terminalAnchors.set(point, statement.expression.origin.anchor)
    },
  })
  const pointCount = body.points.size + boundaries.size
  const allPoints = Array.from({ length: pointCount }, (_, ordinal) => ordinal)
  const spans = new Map(entries.map(([anchor, point]) => [point, context.spanOf(anchor)]))
  for (const [point, span] of terminalSpans) spans.set(point, span)
  const regions = new Map<string, Region>()
  const origins = new Map<string, Origin>()
  const constraints = new Map(body.constraints)
  const patternRoots = new Map<string, Elaboration.BorrowRootFact>()
  const canonicalRoot = (root: Elaboration.BorrowRootFact): Elaboration.BorrowRootFact => {
    const alias =
      root._tag === 'PatternRoot'
        ? patternRoots.get(Ownership.siteKey(rootSite(root, builder)))
        : undefined
    return alias === undefined ? root : { ...alias, path: [...alias.path, ...root.path] }
  }
  const variantBranches: Array<{
    readonly root: Elaboration.BorrowRootFact
    readonly variant: number
    readonly anchor: AuthoredHir.Anchor
  }> = []
  const expressionUses = new Map<string, Elaboration.ExpressionDecision | Tir.Expression>()
  const chargedExpressions = new Set<string>()
  const replacements: Array<{
    readonly root: Ownership.BindingSite
    readonly path: ReadonlyArray<Elaboration.BorrowSelectorFact>
    readonly lifetimes: ReadonlyArray<Lifetime.Lifetime>
    readonly anchor: AuthoredHir.Anchor
  }> = []
  const invalidations: Array<{
    readonly root: Ownership.BindingSite
    readonly path: ReadonlyArray<Elaboration.BorrowSelectorFact>
    readonly expression: Elaboration.ExpressionDecision | Tir.Expression
    readonly after?: AuthoredHir.Anchor
  }> = []
  // A block or match arm introduces a scope; the nearest such ancestor of an authored position is
  // the longest prefix of its own path that a scope-introducing role terminates.
  const scopeRoles = new Set(['body', 'then', 'else', 'arm', 'block'])
  const scopeOf = (anchor: AuthoredHir.Anchor): AuthoredHir.Anchor => {
    for (let length = anchor.path.length - 1; length > 0; length -= 1) {
      const segment = anchor.path[length - 1]
      if (segment !== undefined && scopeRoles.has(segment.role))
        return { _tag: 'AuthoredAnchor', owner: anchor.owner, path: anchor.path.slice(0, length) }
    }
    return root
  }
  const ensure = (lifetime: Lifetime.Lifetime): Region => {
    const key = Lifetime.key(lifetime)
    const previous = regions.get(key)
    if (previous !== undefined) return previous
    const region: Region = { lifetime, unavailable: new Set(), required: new Set() }
    regions.set(key, region)
    if (lifetime._tag === 'IntersectionLifetime')
      for (const member of lifetime.members) {
        ensure(member)
        const bound = { longer: member, shorter: lifetime }
        constraints.set(Lifetime.assumptions([bound]).key, bound)
      }
    return region
  }
  const constrain = (longer: Lifetime.Lifetime, shorter: Lifetime.Lifetime): void => {
    ensure(longer)
    ensure(shorter)
    const bound = { longer, shorter }
    constraints.set(Lifetime.assumptions([bound]).key, bound)
  }
  const requireType = (type: Type.Type, point: number): void => {
    for (const lifetime of Type.storageLifetimes(type)) ensure(lifetime).required.add(point)
  }
  const restrict = (
    lifetime: Lifetime.Lifetime,
    available: Iterable<number>,
    origin: Origin,
  ): void => {
    const region = ensure(lifetime)
    const allowed = new Set(available)
    for (const point of allPoints) if (!allowed.has(point)) region.unavailable.add(point)
    origins.set(Lifetime.key(lifetime), origin)
  }
  const anchor = (
    lifetime: Lifetime.Lifetime,
    source: Elaboration.BorrowRootFact,
    statement: AuthoredHir.Anchor,
    position: AuthoredHir.Anchor,
    referent = false,
  ): void => {
    const span = context.spanOf(position)
    const alias =
      source._tag === 'PatternRoot'
        ? patternRoots.get(Ownership.siteKey(rootSite(source, builder)))
        : undefined
    if (alias !== undefined) {
      anchor(
        lifetime,
        { ...alias, path: [...alias.path, ...source.path] },
        statement,
        position,
        true,
      )
      return
    }
    // Indexing a stored slice borrows its backing allocation, whose validity is
    // independent of the receiver used to retrieve the slice descriptor.
    const sliceIndex = source.path.findLast((selector) => selector._tag === 'SliceIndex')
    if (sliceIndex?._tag === 'SliceIndex') {
      constrain(sliceIndex.slice.lifetime, lifetime)
      origins.set(Lifetime.key(lifetime), {
        lifetime,
        root: rootSite(source, builder),
        path: source.path,
        parent: sliceIndex.slice.lifetime,
        span,
        at: position,
        anchor: position,
      })
      return
    }
    let rootType: Type.Type | undefined
    if (source._tag === 'ParameterRoot' && source.parameter.declaredType._tag === 'Resolved')
      rootType = source.parameter.declaredType.type
    else if (source._tag === 'BindingRoot' && source.binding.inferredType._tag === 'Available')
      rootType = source.binding.inferredType.type
    else if (source._tag === 'PatternRoot' && source.binding.type._tag === 'Available')
      rootType = source.binding.type.type
    if (
      (source.path.length > 0 || referent) &&
      rootType !== undefined &&
      (Type.isReference(rootType) || Type.isSlice(rootType))
    ) {
      constrain(rootType.lifetime, lifetime)
      origins.set(Lifetime.key(lifetime), {
        lifetime,
        root: rootSite(source, builder),
        path: source.path,
        parent: rootType.lifetime,
        span,
        at: position,
        anchor: position,
      })
      return
    }
    let origin = root
    if (source._tag === 'BindingRoot' || source._tag === 'PatternRoot')
      origin = source.binding.anchor
    else if (source._tag === 'TemporaryRoot') origin = statement
    // Array producers already lower to stable hidden locals and loan-ordered cleanup. A binding
    // initializer gives that owner the same lexical validity as a named local; calls and other
    // statement temporaries keep their immediate lifetime. Never hoist across an inner branch.
    const temporaryType =
      source._tag === 'TemporaryRoot'
        ? Elaboration.constructionExpressionType(source.value)
        : Elaboration.unavailableExpressionType
    const retainedArray =
      source._tag === 'TemporaryRoot' &&
      bindingInitializers.has(AuthoredIdentity.anchorKey(statement)) &&
      temporaryType._tag === 'Available' &&
      Type.isFixedArray(temporaryType.type)
    let scope = scopeOf(origin)
    if (source._tag === 'TemporaryRoot') {
      scope = retainedArray
        ? scopeOf(Elaboration.constructionExpressionAnchor(source.value))
        : statement
    }
    const bindingOrder = context.orderOf(origin)
    const available = entries
      .filter(
        ([position]) =>
          encloses(context, scope, position) &&
          (source._tag !== 'BindingRoot' || context.orderOf(position) >= bindingOrder),
      )
      .map(([, point]) => point)
    restrict(lifetime, available, {
      lifetime,
      root: rootSite(source, builder),
      path: source.path,
      span,
      at: position,
      anchor: position,
    })
  }
  const borrowedCapture = (
    expression: Elaboration.ExpressionDecision | Tir.Expression,
    statement: AuthoredHir.Anchor,
  ): void => {
    const source = expressionRoot(expression, context, builder)
    const expressionAnchor = Elaboration.constructionExpressionAnchor(expression)
    const lifetime = BodyLifetime.region(body, expressionAnchor, 'Borrow')
    if (source === undefined || lifetime === undefined) return
    const expressionType = Elaboration.constructionExpressionType(expression)
    const type = expressionType._tag === 'Available' ? expressionType.type : undefined
    if (type !== undefined && (Type.isReference(type) || Type.isSlice(type))) {
      constrain(type.lifetime, lifetime)
      origins.set(Lifetime.key(lifetime), {
        lifetime,
        root: rootSite(source, builder),
        path: source.path,
        parent: type.lifetime,
        span: context.spanOf(expressionAnchor),
        at: expressionAnchor,
        anchor: expressionAnchor,
      })
    } else anchor(lifetime, source, statement, expressionAnchor)
  }
  const bindPatterns = (
    bindings: ReadonlyArray<Elaboration.PatternBindingFact>,
    source: Elaboration.ExpressionDecision | Tir.Expression,
    access: Elaboration.PatternSelectionFact['access'],
  ): void => {
    if (access === 'Move' || access === 'Copy') return
    const root = expressionRoot(source, context, builder, true)
    if (root !== undefined)
      for (const binding of bindings)
        patternRoots.set(
          Ownership.siteKey({
            _tag: 'Pattern',
            binding: BodyBuilder.localId(builder, binding.id),
          }),
          {
            ...root,
            path: [
              ...root.path,
              ...binding.path.map((field): Elaboration.BorrowSelectorFact => ({
                _tag: 'Field',
                field,
                span: context.spanOf(binding.anchor),
                at: binding.anchor,
              })),
            ],
          },
        )
  }
  const visitExpression = (
    expression: Elaboration.ExpressionDecision | Tir.Expression,
    statement: AuthoredHir.Anchor,
    place = false,
  ): void => {
    if ('origin' in expression && expression._tag === 'Unavailable') {
      const semantic = BodyBuilder.semanticOfExpression(builder, expression)
      if (semantic !== undefined) {
        visitExpression(semantic, statement, place)
        return
      }
    }
    const expressionAnchor = Elaboration.constructionExpressionAnchor(expression)
    const expressionType = Elaboration.constructionExpressionType(expression)
    // Synthetic TIR nodes are conversions and other compiler-inserted structure around one
    // authored semantic operation. Their authored child owns the source point and its lifetime
    // obligations; charging both nodes would duplicate requirements and diagnostics.
    const authored = !('origin' in expression) || expression.origin._tag === 'Authored'
    const expressionKey = AuthoredIdentity.anchorKey(expressionAnchor)
    const charged = authored && !chargedExpressions.has(expressionKey)
    if (charged) {
      chargedExpressions.add(expressionKey)
      expressionUses.set(expressionKey, expression)
    }
    const point = charged ? body.points.get(expressionKey) : undefined
    if (charged && expressionType._tag === 'Available') {
      const value = Type.isRepresented(expressionType.type)
        ? expressionType.type.contract
        : expressionType.type
      const inputLifetimes = Type.isCallable(value)
        ? TypeOutlives.inputLifetimes(value.parameters, outlivesScope)
        : undefined
      for (const nominal of Type.nominals(expressionType.type)) {
        const failures = TypeOutlives.application(nominal, outlivesScope, (longer, shorter) => {
          if (Lifetime.outlives(outlivesScope.assumptions, longer, shorter)) return true
          if (
            [...Lifetime.atoms(longer), ...Lifetime.atoms(shorter)].some(
              (member) => member._tag === 'PlaceholderLifetime',
            )
          )
            return false
          if (
            ![...Lifetime.atoms(longer), ...Lifetime.atoms(shorter)].some(
              (member) => member._tag === 'LocalLifetime',
            )
          )
            return false
          constrain(longer, shorter)
          return true
        })
        for (const failure of failures) {
          // Nominals below an invocation binder are validated under the callable's declared
          // preconditions. Free lifetimes and captured values retain the ordinary scope checks.
          if (
            Type.isCallable(value) &&
            Lifetime.atoms(failure.required).some((region) =>
              value.lifetimeBinders.some((binder) => Lifetime.equals(binder, region)),
            ) &&
            Type.isTypeArgument(failure.argument) &&
            Type.satisfiesOutlives(
              failure.argument,
              failure.required,
              [...value.typeOutlives, ...(inputLifetimes?.typeOutlives ?? [])],
              (longer, shorter) =>
                Lifetime.outlives(
                  Lifetime.assumptions([
                    ...value.lifetimeBounds,
                    ...(inputLifetimes?.lifetimeBounds ?? []),
                  ]),
                  longer,
                  shorter,
                ),
            )
          )
            continue
          const diagnostic = Diagnostic.unsatisfiedLifetimeBound(
            Type.encodeGenericArgument(failure.argument),
            Lifetime.display(failure.required),
            Location.at(expressionAnchor),
          )
          applicationDiagnostics.set(
            `${Type.key(nominal)}:${failure.ordinal}:${Lifetime.key(failure.required)}:${context.spanOf(expressionAnchor).start}`,
            diagnostic,
          )
        }
      }
    }
    if (point !== undefined && expressionType._tag === 'Available' && !place)
      requireType(expressionType.type, point)
    if ('origin' in expression) {
      if (expression._tag === 'Match') {
        visitExpression(expression.scrutinee, statement, expression.access === 'Place')
        for (const arm of expression.arms) {
          if (!arm.reachable) continue
          const bindings = arm.bindings.flatMap((binding) => {
            const semantic = BodyBuilder.semanticOfLocal(builder, binding.id)
            return Elaboration.isPatternBindingFact(semantic) ? [semantic] : []
          })
          bindPatterns(bindings, expression.scrutinee, expression.access)
          const selectedRoot = expressionRoot(expression.scrutinee, context, builder)
          if (
            expression.access === 'Place' &&
            selectedRoot !== undefined &&
            arm.member?._tag === 'NominalUnionVariant'
          )
            variantBranches.push({
              root: canonicalRoot(selectedRoot),
              variant: arm.member.variantOrdinal,
              anchor: arm.at ?? expression.origin.anchor,
            })
          if (arm.guard !== undefined) visitExpression(arm.guard, statement)
          if (arm.body._tag === 'Expression') visitExpression(arm.body.expression, statement)
          else visitStatements(arm.body.statements)
        }
        return
      }
      if (expression._tag === 'CallableSection') {
        for (const capture of expression.captures) {
          if (capture.access === 'Shared' || capture.access === 'Exclusive')
            borrowedCapture(capture.value, statement)
          visitExpression(capture.value, statement)
        }
        return
      }
      if (expression._tag === 'EffectBlock') {
        visitStatements(expression.statements)
        return
      }
      if (expression._tag === 'ValueBorrow' || expression._tag === 'SliceBorrow') {
        const formation = expressionRoot(expression, context, builder)
        const type = expression.type
        if (formation !== undefined) {
          if (
            expression.reborrow &&
            (Type.isReference(expression.source) || Type.isSlice(expression.source))
          ) {
            constrain(expression.source.lifetime, type.lifetime)
            origins.set(Lifetime.key(type.lifetime), {
              lifetime: type.lifetime,
              root: rootSite(formation, builder),
              path: formation.path,
              parent: expression.source.lifetime,
              span: context.spanOf(expressionAnchor),
              at: expressionAnchor,
              anchor: expressionAnchor,
            })
          } else anchor(type.lifetime, formation, statement, expressionAnchor)
        }
        if (expression.place !== undefined) visitExpression(expression.place, statement, true)
        for (const child of Tir.expressionChildren(expression))
          if (child !== expression.place) visitExpression(child, statement)
        return
      }
      if (expression._tag === 'Replace') {
        const source = expressionRoot(expression, context, builder)
        if (source !== undefined)
          invalidations.push({ root: rootSite(source, builder), path: source.path, expression })
      }
      if (expression._tag === 'Move') {
        const source = expressionRoot(expression.subject, context, builder)
        if (source !== undefined)
          invalidations.push({ root: rootSite(source, builder), path: source.path, expression })
      }
      if (
        expression._tag === 'Project' ||
        expression._tag === 'IndexPlace' ||
        expression._tag === 'SliceIndexPlace' ||
        expression._tag === 'ReferentPlace'
      ) {
        const subject =
          expression._tag === 'SliceIndexPlace' ? expression.slice : expression.subject
        const subjectType = Elaboration.constructionExpressionType(subject)
        if (
          point !== undefined &&
          subjectType._tag === 'Available' &&
          (Type.isReference(subjectType.type) || Type.isSlice(subjectType.type))
        )
          ensure(subjectType.type.lifetime).required.add(point)
      }
      if (expression._tag === 'Project' || expression._tag === 'ReferentPlace') {
        visitExpression(expression.subject, statement, true)
        return
      }
      if (expression._tag === 'IndexPlace') {
        visitExpression(expression.subject, statement, true)
        visitExpression(expression.index, statement)
        return
      }
      if (expression._tag === 'SliceIndexPlace') {
        visitExpression(expression.slice, statement, true)
        visitExpression(expression.index, statement)
        return
      }
      for (const child of Tir.expressionChildren(expression)) visitExpression(child, statement)
      return
    }
    const current = expression
    if (current._tag === 'Borrow') {
      const formation = current.formation
      const type = current.type._tag === 'Available' ? current.type.type : undefined
      if (
        formation._tag !== 'Unavailable' &&
        type !== undefined &&
        (Type.isReference(type) || Type.isSlice(type))
      ) {
        if (formation._tag === 'ValueReborrow' || formation._tag === 'SliceReborrow') {
          constrain(formation.parent.lifetime, type.lifetime)
          origins.set(Lifetime.key(type.lifetime), {
            lifetime: type.lifetime,
            root: rootSite(formation.root, builder),
            path: formation.root.path,
            parent: formation.parent.lifetime,
            span: context.spanOf(expressionAnchor),
            at: expressionAnchor,
            anchor: expressionAnchor,
          })
        } else anchor(type.lifetime, formation.root, statement, expressionAnchor)
      }
      visitExpression(current.subject, statement, true)
      return
    }
    if (current._tag === 'PlaceReplace') {
      const source = expressionRoot(current.destination, context, builder)
      if (source !== undefined)
        invalidations.push({ root: rootSite(source, builder), path: source.path, expression })
    }
    if (current._tag === 'Move') {
      const source = expressionRoot(current.subject, context, builder)
      if (source !== undefined)
        invalidations.push({ root: rootSite(source, builder), path: source.path, expression })
    }
    if (current._tag === 'FieldProjection' || current._tag === 'IndexProjection') {
      const subject = Elaboration.constructionExpressionType(current.subject)
      if (
        point !== undefined &&
        subject._tag === 'Available' &&
        (Type.isReference(subject.type) || Type.isSlice(subject.type))
      )
        ensure(subject.type.lifetime).required.add(point)
      visitExpression(current.subject, statement, true)
      if (current._tag === 'IndexProjection') visitExpression(current.index, statement)
      return
    }
    if (current._tag === 'ReferentProjection') {
      const subject = Elaboration.constructionExpressionType(current.subject)
      if (point !== undefined && subject._tag === 'Available' && Type.isReference(subject.type))
        ensure(subject.type.lifetime).required.add(point)
      visitExpression(current.subject, statement, true)
      return
    }
    if (current._tag === 'Match') {
      visitExpression(current.scrutinee, statement, current.access === 'Place')
      for (const arm of current.arms) {
        if (!arm.reachable) continue
        bindPatterns(arm.bindings, current.scrutinee, current.access)
        const selectedRoot = expressionRoot(current.scrutinee, context, builder)
        if (
          current.access === 'Place' &&
          selectedRoot !== undefined &&
          arm.pattern._tag === 'UnionVariantPattern' &&
          arm.pattern.coverage?._tag === 'NominalUnionVariant'
        )
          variantBranches.push({
            root: canonicalRoot(selectedRoot),
            variant: arm.pattern.coverage.variantOrdinal,
            anchor: arm.anchor,
          })
        if (arm.guard !== undefined) visitExpression(arm.guard, statement)
        if (arm.body._tag === 'Expression') visitExpression(arm.body.expression, statement)
        else visitStatements(arm.body.statements)
      }
      return
    }
    if (current._tag === 'CallableSection') {
      for (const capture of current.captures)
        if (capture.access === 'Shared' || capture.access === 'Exclusive')
          borrowedCapture(capture.expression, statement)
    }
    if (current._tag === 'EffectBlock') {
      for (const capture of current.captures)
        if (capture.expression !== undefined) {
          visitExpression(capture.expression, statement)
          if (capture.access === 'Shared' || capture.access === 'Exclusive')
            borrowedCapture(capture.expression, statement)
        }
      visitStatements(current.statements)
      return
    }
    for (const child of Elaboration.expressionChildren(current)) visitExpression(child, statement)
  }
  const visitStatements = (statements: ReadonlyArray<Tir.Statement>): void => {
    for (const statement of statements) {
      const syntax = statement.origin.anchor
      if (statement._tag === 'PatternBind' || statement._tag === 'IfLet')
        bindPatterns(
          statement.selection.bindings.flatMap((binding) => {
            const semantic = BodyBuilder.semanticOfLocal(builder, binding.id)
            return Elaboration.isPatternBindingFact(semantic) ? [semantic] : []
          }),
          statement.selection.source ?? statement.selection.subject,
          statement.selection.access,
        )
      for (const expression of BodyBuilder.directStatementExpressions(statement))
        visitExpression(
          expression,
          syntax,
          statement._tag === 'Write' && expression === statement.destination,
        )
      if (statement._tag === 'Write' && statement.destination !== undefined) {
        const destination = expressionRoot(statement.destination, context, builder)
        const source = destination === undefined ? undefined : canonicalRoot(destination)
        if (source !== undefined) {
          const destinationType = Elaboration.constructionExpressionType(statement.destination)
          if (destinationType._tag === 'Available') {
            const lifetimes = Type.storageLifetimes(destinationType.type)
            if (lifetimes.length > 0)
              replacements.push({
                root: rootSite(source, builder),
                path: source.path,
                lifetimes,
                anchor: statement.origin.anchor,
              })
          }
          invalidations.push({
            root: rootSite(source, builder),
            path: source.path,
            expression: statement.value,
            after: statement.origin.anchor,
          })
        }
      }
      if (statement._tag === 'Return' || statement._tag === 'Fail') {
        const boundary = boundaries.get(AuthoredIdentity.anchorKey(statement.origin.anchor))
        const directType = Elaboration.constructionExpressionType(statement.expression)
        const semantic =
          directType._tag === 'Unavailable' && statement.expression._tag === 'Unavailable'
            ? BodyBuilder.semanticOfExpression(builder, statement.expression)
            : undefined
        const expressionType =
          semantic === undefined ? directType : Elaboration.constructionExpressionType(semantic)
        if (expressionType._tag === 'Available' && boundary !== undefined)
          requireType(expressionType.type, boundary)
      } else if (statement._tag === 'Drop') {
        const source = expressionRoot(statement.expression, context, builder)
        if (source !== undefined)
          invalidations.push({
            root: rootSite(source, builder),
            path: source.path,
            expression: statement.expression,
          })
      }
      if (statement._tag === 'Unsafe') visitStatements(statement.statements)
      else if (statement._tag === 'If' || statement._tag === 'IfLet') {
        visitStatements(statement.taken)
        visitStatements(statement.otherwise)
      } else if (statement._tag === 'While') visitStatements(statement.body)
    }
  }
  visitStatements(statements)
  for (const bound of body.constraints.values()) constrain(bound.longer, bound.shorter)
  for (const bound of DeclarationFacts.executableLifetimes(declaration).lifetimeBounds ?? [])
    constrain(bound.longer, bound.shorter)
  // Reachability includes loop backedges and respects branch exits. Re-entering the borrow's
  // creation stops an old loan: the next iteration creates a distinct dynamic loan instance.
  for (const origin of origins.values()) {
    if (origin.root === undefined || origin.parent !== undefined) continue
    const created = BodyControlFlow.at(controlFlow, origin.span)
    if (created === undefined) continue
    const region = ensure(origin.lifetime)
    for (const event of invalidations) {
      if (
        Ownership.siteKey(event.root) !== Ownership.siteKey(origin.root) ||
        !pathsOverlap(origin.path ?? [], event.path)
      )
        continue
      const invalidated = controlFlow.boundaries.get(
        AuthoredIdentity.anchorKey(
          event.after ?? Elaboration.constructionExpressionAnchor(event.expression),
        ),
      )
      if (
        invalidated === undefined ||
        !BodyControlFlow.reaches(controlFlow, created.after, invalidated.after, created.before)
      )
        continue
      for (const [position, point] of entries) {
        const use = controlFlow.boundaries.get(AuthoredIdentity.anchorKey(position))
        if (
          use !== undefined &&
          BodyControlFlow.reaches(controlFlow, invalidated.after, use.after, created.before)
        )
          region.unavailable.add(point)
      }
    }
  }
  const retiredUses = new Map<string, ReadonlySet<number>>()
  const storageDependencies = Lifetime.assumptions([
    ...constraints.values(),
    ...body.activatedConstraints.map(({ bound }) => bound),
  ])
  const retirementWork = { comparisons: 0, comparisonCacheHits: 0 }
  const comparedStorage = new Map<string, boolean>()
  const storageOutlives = (longer: Lifetime.Lifetime, shorter: Lifetime.Lifetime): boolean => {
    retirementWork.comparisons += 1
    const identity = `${Lifetime.key(longer)}:${Lifetime.key(shorter)}`
    const cached = comparedStorage.get(identity)
    if (cached !== undefined) {
      retirementWork.comparisonCacheHits += 1
      return cached
    }
    const result = Lifetime.outlives(storageDependencies, longer, shorter)
    comparedStorage.set(identity, result)
    return result
  }
  // Decompose only requested aggregate carriers. References are leaves; recursive pointee shapes
  // and unmentioned array elements are never materialized by replacement liveness.
  const storedPaths = (
    type: Type.Type,
    lifetime: Lifetime.Lifetime,
    span: SourceSpan.SourceSpan,
    seen: ReadonlySet<string> = new Set(),
  ): ReadonlyArray<{
    readonly path: ReadonlyArray<Elaboration.BorrowSelectorFact>
    readonly type: Type.Type
  }> => {
    if (!Type.storageLifetimes(type).some((stored) => storageOutlives(lifetime, stored))) return []
    if (Type.isNominal(type) && !seen.has(Type.key(type))) {
      const declaration = DeclarationFacts.byCanonical(index, {
        _tag: 'CanonicalDeclarationId',
        module: type.module,
        name: type.name,
      })
      if (declaration?._tag === 'StructDeclaration' || declaration?._tag === 'UnionDeclaration') {
        const substitution = TypeInference.substitution(
          declaration.typeParameters.map((parameter) => parameter.type),
          type.arguments,
        )
        if (substitution !== undefined)
          return (
            declaration._tag === 'StructDeclaration'
              ? declaration.fields
              : declaration.variants.flatMap((variant) => variant.fields)
          ).flatMap((field) =>
            field.declaredType._tag !== 'Resolved'
              ? [{ path: [], type }]
              : storedPaths(
                  Type.substitute(field.declaredType.type, substitution),
                  lifetime,
                  span,
                  new Set(seen).add(Type.key(type)),
                ).map((entry) => ({
                  path: [{ _tag: 'Field', field: field.id, span }, ...entry.path],
                  type: entry.type,
                })),
          )
      }
    }
    return [{ path: [], type }]
  }
  if (replacements.length > 0) {
    for (const [identity, origin] of origins) {
      const created = BodyControlFlow.at(controlFlow, origin.span)
      if (created === undefined || origin.parent !== undefined) continue
      const retired = new Set<number>()
      for (const [position, point] of entries) {
        const span = context.spanOf(position)
        const expression = expressionUses.get(AuthoredIdentity.anchorKey(position))
        const value = expression === undefined ? undefined : carrierExpression(expression)
        const selected = value === undefined ? undefined : expressionRoot(value, context, builder)
        const carrier = selected === undefined ? undefined : canonicalRoot(selected)
        const use = controlFlow.boundaries.get(AuthoredIdentity.anchorKey(position))
        const valueType =
          value === undefined
            ? Elaboration.unavailableExpressionType
            : Elaboration.constructionExpressionType(value)
        if (carrier === undefined || use === undefined || valueType._tag !== 'Available') continue
        const prefix = (
          left: ReadonlyArray<Elaboration.BorrowSelectorFact>,
          right: ReadonlyArray<Elaboration.BorrowSelectorFact>,
        ): boolean =>
          left.length <= right.length &&
          left.every((selector, ordinal) => {
            const selected = right.at(ordinal)
            if (selector._tag === 'Field')
              return (
                selected?._tag === 'Field' &&
                DeclarationFacts.sameFieldId(selector.field, selected.field)
              )
            return (
              selector._tag === 'Index' &&
              selected?._tag === 'Index' &&
              selector.bounds._tag === 'Proven' &&
              selected.bounds._tag === 'Proven' &&
              selector.bounds.index === selected.bounds.index
            )
          })
        const relevant = replacements.filter(
          (replacement) =>
            !(
              origin.anchor !== undefined && encloses(context, replacement.anchor, origin.anchor)
            ) &&
            Ownership.siteKey(replacement.root) === Ownership.siteKey(rootSite(carrier, builder)) &&
            replacement.lifetimes.some((lifetime) => storageOutlives(origin.lifetime, lifetime)),
        )
        const retiredPath = (
          path: ReadonlyArray<Elaboration.BorrowSelectorFact>,
          type: Type.Type,
        ): boolean => {
          const barriers = relevant.flatMap((replacement) => {
            if (!prefix(replacement.path, path)) return []
            const installed = BodyControlFlow.at(controlFlow, context.spanOf(replacement.anchor))
            return installed === undefined ? [] : [installed.after]
          })
          for (const branch of variantBranches) {
            if (
              Ownership.siteKey(rootSite(branch.root, builder)) !==
                Ownership.siteKey(rootSite(carrier, builder)) ||
              !prefix(branch.root.path, path)
            )
              continue
            const field = path.at(branch.root.path.length)
            if (
              field?._tag !== 'Field' ||
              field.field.owner._tag !== 'UnionVariantFieldOwnerId' ||
              field.field.owner.variant.ordinal === branch.variant
            )
              continue
            const entered = BodyControlFlow.at(controlFlow, context.spanOf(branch.anchor))
            if (entered !== undefined) barriers.push(entered.before)
          }
          if (
            barriers.length > 0 &&
            !BodyControlFlow.reaches(controlFlow, created.after, use.after, [
              created.before,
              ...barriers,
            ])
          )
            return true
          if (!Type.isFixedArray(type)) return false
          const selectedIndices = new Map<number, Elaboration.BorrowSelectorFact>()
          for (const replacement of relevant) {
            if (!prefix(path, replacement.path)) continue
            const selector = replacement.path.at(path.length)
            if (
              selector?._tag === 'Index' &&
              selector.bounds._tag === 'Proven' &&
              selector.bounds.index >= 0 &&
              selector.bounds.index < type.length
            )
              selectedIndices.set(selector.bounds.index, selector)
          }
          // Completion follows the touched, proven indices. Never allocate a node per array element.
          return (
            selectedIndices.size === type.length &&
            [...selectedIndices.values()].every((selector) =>
              storedPaths(type.element, origin.lifetime, span).every((entry) =>
                retiredPath([...path, selector, ...entry.path], entry.type),
              ),
            )
          )
        }
        const paths = storedPaths(valueType.type, origin.lifetime, span)
        const retiredEveryPath =
          paths.length > 0 &&
          paths.every((entry) => retiredPath([...carrier.path, ...entry.path], entry.type))
        if (retiredEveryPath) {
          retired.add(point)
          ensure(origin.lifetime).unavailable.delete(point)
        }
      }
      retiredUses.set(identity, retired)
    }
  }
  const universalAssumptions = Lifetime.mergeAssumptions(
    outlivesScope.assumptions,
    Lifetime.assumptions(DeclarationFacts.executableLifetimes(declaration).lifetimeBounds ?? []),
  )
  const universalDiagnostics = new Map<string, Diagnostic.Located>()
  const incoming = new Map<string, Array<Lifetime.Lifetime>>()
  for (const bound of constraints.values()) {
    const predecessors = incoming.get(Lifetime.key(bound.shorter)) ?? []
    predecessors.push(bound.longer)
    incoming.set(Lifetime.key(bound.shorter), predecessors)
  }
  const outgoing = new Map<string, Array<Lifetime.Lifetime>>()
  for (const bound of constraints.values()) {
    const successors = outgoing.get(Lifetime.key(bound.longer)) ?? []
    successors.push(bound.shorter)
    outgoing.set(Lifetime.key(bound.longer), successors)
  }
  for (const { lifetime, parameter } of body.genericStorage.values()) {
    const pending = [...(outgoing.get(Lifetime.key(lifetime)) ?? [])]
    const visited = new Set<string>()
    let publicObligations = 0
    let allProven = true
    while (pending.length > 0) {
      const required = pending.pop()
      if (required === undefined || visited.has(Lifetime.key(required))) continue
      visited.add(Lifetime.key(required))
      if (
        Lifetime.atoms(required).every(
          (member) => member._tag === 'BoundLifetime' || member._tag === 'StaticLifetime',
        )
      ) {
        publicObligations += 1
        const bounds = (body.parameterBounds.get(Type.key(parameter)) ?? []).map((region) => ({
          type: parameter,
          lifetime: region,
        }))
        if (
          !Type.satisfiesOutlives(parameter, required, bounds, (longer, shorter) =>
            Lifetime.outlives(universalAssumptions, longer, shorter),
          )
        ) {
          allProven = false
          const diagnostic = Diagnostic.unsatisfiedLifetimeBound(
            Type.encode(parameter),
            Lifetime.display(required),
            Location.at(declaration.anchor),
          )
          universalDiagnostics.set(`${Type.key(parameter)}:${Lifetime.key(required)}`, diagnostic)
        }
      }
      pending.push(...(outgoing.get(Lifetime.key(required)) ?? []))
    }
    const available = entries.map(([, point]) => point)
    if (allProven && publicObligations > 0) available.push(...boundaries.values())
    restrict(lifetime, available, {
      lifetime,
      span: context.spanOf(declaration.anchor),
      at: declaration.anchor,
    })
  }
  for (const target of regions.values()) {
    if (
      !Lifetime.atoms(target.lifetime).every(
        (member) => member._tag === 'BoundLifetime' || member._tag === 'StaticLifetime',
      )
    )
      continue
    const pending = [...(incoming.get(Lifetime.key(target.lifetime)) ?? [])]
    const visited = new Set<string>()
    while (pending.length > 0) {
      const source = pending.pop()
      if (source === undefined || visited.has(Lifetime.key(source))) continue
      visited.add(Lifetime.key(source))
      const origin = origins.get(Lifetime.key(source))
      // A universal contract extends beyond this body's finite use points. Inference regions and
      // reborrows can reach it through their parents, but owned local storage cannot, even if the
      // constrained value is never subsequently used.
      const finiteStorage =
        source._tag === 'LocalLifetime' && origin?.root !== undefined && origin.parent === undefined
      if (
        finiteStorage ||
        (source._tag === 'BoundLifetime' &&
          !Lifetime.outlives(universalAssumptions, source, target.lifetime))
      ) {
        const diagnostic = Diagnostic.unsatisfiedLifetimeBound(
          Lifetime.display(source),
          Lifetime.display(target.lifetime),
          Location.at(finiteStorage ? origin.at : declaration.anchor),
        )
        universalDiagnostics.set(
          `${Lifetime.key(source)}:${Lifetime.key(target.lifetime)}`,
          diagnostic,
        )
      }
      pending.push(...(incoming.get(Lifetime.key(source)) ?? []))
    }
  }
  const activatedConstraints = body.activatedConstraints.flatMap(({ bound, installed, owner }) => {
    ensure(bound.longer)
    ensure(bound.shorter)
    const installation = controlFlow.boundaries.get(AuthoredIdentity.anchorKey(installed))
    if (installation === undefined) return []
    const ownerBoundary =
      owner === undefined
        ? undefined
        : controlFlow.boundaries.get(AuthoredIdentity.anchorKey(owner))
    const barriers = [
      installation.before,
      ...(ownerBoundary === undefined ? [] : [ownerBoundary.before]),
    ]
    const points = new Set<number>()
    for (const [point, span] of spans) {
      const use = BodyControlFlow.at(controlFlow, span)
      if (
        use !== undefined &&
        BodyControlFlow.reaches(controlFlow, installation.after, use.after, barriers)
      )
        points.add(point)
    }
    return [{ ...bound, points }]
  })
  const input: Lifetime.Input = {
    pointCount,
    regions: [...regions.values()],
    constraints: [...constraints.values()],
    activatedConstraints,
  }
  const solution = Lifetime.solve(input)
  const diagnostics = [
    ...applicationDiagnostics.values(),
    ...universalDiagnostics.values(),
    ...diagnosticsOf(
      solution,
      origins,
      (origin) => Location.at(origin.at),
      new Map(
        [...entries.map(([anchor, point]) => [point, anchor] as const), ...terminalAnchors].map(
          ([point, anchor]) => [point, Location.at(anchor)],
        ),
      ),
      Location.at(declaration.anchor),
      Location.key,
    ),
  ]
  return {
    controlFlow,
    retiredUses,
    retirementWork,
    syntaxPointCount: entries.length,
    input,
    solution,
    origins,
    spans,
    anchors: new Map([
      ...entries.map(([anchor, point]) => [point, anchor] as const),
      ...terminalAnchors,
    ]),
    diagnostics,
  }
}

/**
 * The same region proof under another revision's presentation.
 *
 * Regions, constraints and the solution are about authored nodes and never change. The spans that
 * ownership looks points up by are a function of those nodes, so they are stamped again.
 */
export const present = (
  self: LifetimeFlow,
  context: SemanticContext.SemanticContext,
): LifetimeFlow => {
  return {
    ...self,
    controlFlow: BodyControlFlow.present(self.controlFlow, context),
    // An origin's root and path hold ids and selectors that carry positions of their own.
    origins: new Map(
      [...self.origins].map(([key, origin]) => [key, Tir.stamp(origin, context.spanOf)]),
    ),
    spans: new Map([...self.anchors].map(([point, anchor]) => [point, context.spanOf(anchor)])),
  }
}

/** The proof without positions: what a cache or an encoding holds, and `present` completes. */
export const content = (self: LifetimeFlow): LifetimeFlow => ({
  ...self,
  controlFlow: BodyControlFlow.content(self.controlFlow),
  spans: new Map(),
})

const originSpanKey = (span: SourceSpan.SourceSpan): string =>
  `${span.sourceId}\u0000${span.start}\u0000${span.end}`

const originsBySpanCache = new WeakMap<LifetimeFlow, Map<string, Array<string>>>()

interface RequiredUse {
  /** Source start of the requiring point, when it has a span. */
  readonly start: number | undefined
  readonly retired: boolean
  /** Control-flow point after the requiring use, when the use is an executed boundary. */
  readonly after: number | undefined
}

const requiredUsesCache = new WeakMap<LifetimeFlow, Map<string, ReadonlyArray<RequiredUse>>>()

/** One origin's required points resolved to spans and boundaries once per flow. */
const requiredUses = (
  self: LifetimeFlow,
  solution: Extract<Lifetime.Solution, { readonly _tag: 'Solved' }>,
  key: string,
): ReadonlyArray<RequiredUse> => {
  let byOrigin = requiredUsesCache.get(self)
  if (byOrigin === undefined) {
    byOrigin = new Map()
    requiredUsesCache.set(self, byOrigin)
  }
  let uses = byOrigin.get(key)
  if (uses === undefined) {
    const retired = self.retiredUses.get(key)
    uses = [...(solution.required.get(key) ?? [])].map((point): RequiredUse => {
      const span = self.spans.get(point)
      return {
        start: span?.start,
        retired: retired?.has(point) === true,
        after: span === undefined ? undefined : BodyControlFlow.at(self.controlFlow, span)?.after,
      }
    })
    byOrigin.set(key, uses)
  }
  return uses
}

/** Origin keys grouped by their exact creation span, built once per flow for liveness queries. */
const originsBySpan = (self: LifetimeFlow): ReadonlyMap<string, ReadonlyArray<string>> => {
  let index = originsBySpanCache.get(self)
  if (index === undefined) {
    index = new Map()
    for (const [key, origin] of self.origins) {
      const spanKey = originSpanKey(origin.span)
      const keys = index.get(spanKey)
      if (keys === undefined) index.set(spanKey, [key])
      else keys.push(key)
    }
    originsBySpanCache.set(self, index)
  }
  return index
}

/** Tests concrete loan liveness at an access using the solved holder uses and source CFG. */
export const liveAt = (
  self: LifetimeFlow,
  start: SourceSpan.SourceSpan,
  access: SourceSpan.SourceSpan,
  end: SourceSpan.SourceSpan,
  write = false,
): boolean | undefined => {
  if (self.solution._tag !== 'Solved') return undefined
  const origins = originsBySpan(self).get(originSpanKey(start))
  if (origins === undefined) return undefined
  const created = BodyControlFlow.at(self.controlFlow, start)
  const accessed = BodyControlFlow.at(self.controlFlow, access)
  if (created === undefined || accessed === undefined) return undefined
  const at = write
    ? (BodyControlFlow.writeAt(self.controlFlow, access) ?? accessed.after)
    : accessed.before
  if (!BodyControlFlow.reaches(self.controlFlow, created.after, at, created.before)) return false
  let observedHolderUse = false
  const reachable = BodyControlFlow.reachable(self.controlFlow, at, created.before)
  for (const key of origins)
    for (const use of requiredUses(self, self.solution, key)) {
      if (use.start !== undefined && use.start >= start.end) observedHolderUse = true
      if (use.retired) continue
      if (use.after !== undefined && BodyControlFlow.includes(reachable, use.after)) return true
    }
  const retainedEnd = BodyControlFlow.at(self.controlFlow, end)
  if (
    !observedHolderUse &&
    retainedEnd !== undefined &&
    BodyControlFlow.includes(reachable, retainedEnd.after)
  )
    return true

  return false
}

/**
 * Reports a solution in the caller's coordinates: elaboration reports at locations, the cleanup
 * replay in ownership at the spans ownership still works in.
 */
const diagnosticsOf = <L>(
  solution: Lifetime.Solution,
  origins: ReadonlyMap<string, Origin>,
  originAt: (origin: Origin) => L,
  points: ReadonlyMap<number, L>,
  fallback: L,
  keyOf: (position: L) => string,
): ReadonlyArray<Diagnostic.Diagnostic<L>> => {
  if (solution._tag !== 'Solved')
    return [
      Diagnostic.invalidLifetimeBinder(
        `Invalid finite lifetime domain: ${solution.dimension}`,
        fallback,
      ),
    ]
  const diagnostics = new Map<string, Diagnostic.Diagnostic<L>>()
  for (const violation of solution.violations) {
    const origin = origins.get(Lifetime.key(violation.lifetime))
    const span = points.get(violation.point) ?? fallback
    const diagnostic = Diagnostic.expiredLifetime(
      Lifetime.display(violation.lifetime),
      span,
      origin === undefined ? undefined : originAt(origin),
    )
    diagnostics.set(`${Lifetime.key(violation.lifetime)}:${keyOf(span)}`, diagnostic)
  }
  return [...diagnostics.values()]
}

/** Retains only cleanup hooks which can observe initialized borrowed components. */
export const cleanupLifetimes = (
  cleanup: CleanupPlan.CleanupPlan,
  state: MovePath.State,
): ReadonlyArray<Lifetime.Lifetime> => {
  if (state.initialization === 'Missing' && state.children.length === 0) return []
  if (cleanup._tag === 'HookCleanup' || cleanup._tag === 'ParameterCleanup')
    return Type.storageLifetimes(cleanup.type)
  const child = (selector: MovePath.Selector): MovePath.State =>
    state.children.find(
      (entry) =>
        entry.selector._tag === selector._tag &&
        (entry.selector._tag === 'ConstantIndex' && selector._tag === 'ConstantIndex'
          ? entry.selector.index === selector.index
          : entry.selector._tag !== 'ConstantIndex' &&
            selector._tag !== 'ConstantIndex' &&
            entry.selector.ordinal === selector.ordinal),
    )?.state ?? { initialization: state.initialization, children: [] }
  if (cleanup._tag === 'StructCleanup')
    return cleanup.fields.flatMap((field) =>
      cleanupLifetimes(field.cleanup, child({ _tag: 'Field', ordinal: field.field.ordinal })),
    )
  if (cleanup._tag === 'NominalUnionCleanup')
    return cleanup.variants.flatMap((variant) =>
      state.activeVariant !== undefined && state.activeVariant !== variant.ordinal
        ? []
        : variant.fields.flatMap((field) => {
            const variantState = child({ _tag: 'Variant', ordinal: variant.ordinal })
            const fieldState = variantState.children.find(
              (entry) =>
                entry.selector._tag === 'Field' && entry.selector.ordinal === field.field.ordinal,
            )?.state ?? { initialization: variantState.initialization, children: [] }
            return cleanupLifetimes(field.cleanup, fieldState)
          }),
    )
  if (cleanup._tag === 'ArrayCleanup') {
    const elements = state.children.filter((entry) => entry.selector._tag === 'ConstantIndex')
    const retained = elements.flatMap((entry) => cleanupLifetimes(cleanup.element, entry.state))
    // One inherited-state representative covers every unmentioned index, regardless of length.
    if (elements.length < cleanup.length)
      retained.push(
        ...cleanupLifetimes(cleanup.element, {
          initialization: state.initialization,
          children: [],
        }),
      )
    return retained
  }
  if (cleanup._tag === 'UnionCleanup')
    return cleanup.cases.flatMap((entry) => cleanupLifetimes(entry.cleanup, state))
  if (cleanup._tag === 'CallableCleanup' || cleanup._tag === 'EffectCleanup')
    return cleanup.slots.flatMap((slot) => cleanupLifetimes(slot.cleanup, state))
  if (cleanup._tag === 'EffectCompositeCleanup')
    return cleanup.alternatives.flatMap((alternative) => cleanupLifetimes(alternative, state))
  if (
    cleanup._tag === 'RepresentedCallableCleanup' ||
    cleanup._tag === 'RepresentedEffectCleanup' ||
    cleanup._tag === 'LocalSharedCoreCleanup'
  )
    return Type.storageLifetimes(cleanup.type)
  return []
}

const orderedSourcePoints = new WeakMap<
  LifetimeFlow,
  ReadonlyArray<readonly [number, SourceSpan.SourceSpan]>
>()

const cleanupSourcePoint = (
  self: LifetimeFlow,
  exit: SourceSpan.SourceSpan,
): number | undefined => {
  let points = orderedSourcePoints.get(self)
  if (points === undefined) {
    points = [...self.spans]
      .filter(([point]) => point < self.syntaxPointCount)
      .sort((left, right) => left[1].end - right[1].end || left[1].start - right[1].start)
    orderedSourcePoints.set(self, points)
  }
  let low = 0
  let high = points.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    const entry = points.at(middle)
    if (entry !== undefined && entry[1].end <= exit.end) low = middle + 1
    else high = middle
  }
  const selected = points.at(low - 1)
  return low > 0 && selected?.[1].sourceId === exit.sourceId ? selected[0] : undefined
}

/** Adds destructor uses from initialized remainders before checking conflicting place access. */
export const withCleanupUses = (
  self: LifetimeFlow,
  exits: ReadonlyArray<Ownership.ExitPlan>,
): LifetimeFlow => {
  const regions = new Map(
    self.input.regions.map((region) => [
      Lifetime.key(region.lifetime),
      {
        ...region,
        required: new Set(region.required),
      },
    ]),
  )
  let changed = false
  for (const exit of exits) {
    const required = exit.releases.flatMap((release) =>
      cleanupLifetimes(release.cleanup, release.initialization),
    )
    if (required.length === 0) continue
    // The final source point before the ordered release is a CFG point, so loan reachability
    // includes the cleanup without fabricating source statements or expanding partial states.
    const selected = cleanupSourcePoint(self, exit.span)
    if (selected === undefined) continue
    for (const lifetime of required) {
      const region = regions.get(Lifetime.key(lifetime))
      if (region !== undefined && !region.required.has(selected)) {
        region.required.add(selected)
        changed = true
      }
    }
  }
  if (!changed) return self
  const input = { ...self.input, regions: [...regions.values()] }
  return { ...self, input, solution: Lifetime.solve(input) }
}

/** Checks actual branch-specific destruction after ownership has produced ordered releases. */
export const validateCleanup = (
  self: LifetimeFlow,
  ownership: Ownership.FunctionOwnership,
  context: SemanticContext.SemanticContext,
): {
  readonly diagnostics: ReadonlyArray<Diagnostic.Diagnostic>
  readonly work?: Lifetime.Work
} => {
  // Fresh destructor points are outside the analyzed domain, so the solver treats every region as
  // available there. A region is actually available at one exactly when it is available at its
  // exit's source point and its root is not released earlier in that exit; violations at fresh
  // points are derived from the solved requirements by that rule instead of inserting each
  // release point into each region's availability.
  const regions = new Map(
    self.input.regions.map((region) => [
      Lifetime.key(region.lifetime),
      { ...region, required: new Set(region.required) },
    ]),
  )
  const activatedConstraints = (self.input.activatedConstraints ?? []).map((bound) => ({
    ...bound,
    points: new Set(bound.points),
  }))
  const spans = new Map(self.spans)
  const roots = new Map<string, string | undefined>()
  for (const key of regions.keys()) {
    const root = self.origins.get(key)?.root
    roots.set(key, root === undefined ? undefined : Ownership.siteKey(root))
  }
  const firstPoint = self.input.pointCount
  const fresh: Array<{
    readonly sourcePoint: number | undefined
    readonly releases: ReadonlyMap<string, number>
    readonly release: number
  }> = []
  let pointCount = firstPoint
  for (const exit of ownership.exits) {
    const sourcePoint = cleanupSourcePoint(self, exit.span)
    // Fresh destructor points never equal the source point, so membership tests against it
    // are fixed for the whole exit.
    const activeBounds =
      sourcePoint === undefined
        ? []
        : activatedConstraints.filter((bound) => bound.points.has(sourcePoint))
    // The first release ordinal of each root within this exit.
    const releases = new Map<string, number>()
    for (const [ordinal, release] of exit.releases.entries()) {
      const point = pointCount++
      spans.set(point, exit.span)
      fresh.push({ sourcePoint, releases, release: ordinal })
      // Ordered destructor points inherit the bounds active at this exit, including
      // dependencies installed after the holder's original acquisition.
      for (const bound of activeBounds) bound.points.add(point)
      for (const lifetime of cleanupLifetimes(release.cleanup, release.initialization))
        regions.get(Lifetime.key(lifetime))?.required.add(point)
      const root = Ownership.siteKey(release.binding.site)
      if (!releases.has(root)) releases.set(root, ordinal)
    }
  }
  const availableAtFresh = (key: string, region: Lifetime.Region, point: number): boolean => {
    const at = fresh[point - firstPoint]
    if (at === undefined || at.sourcePoint === undefined) return false
    if (region.unavailable.has(at.sourcePoint)) return false
    const root = roots.get(key)
    const released = root === undefined ? undefined : at.releases.get(root)
    return released === undefined || released >= at.release
  }
  const solved = Lifetime.solve({
    ...self.input,
    pointCount,
    regions: [...regions.values()],
    activatedConstraints,
  })
  let solution: Lifetime.Solution = solved
  if (solved._tag === 'Solved') {
    // Keep the solver's order: regions in input order, each region's points ascending.
    const analyzed = new Map<string, Array<(typeof solved.violations)[number]>>()
    for (const violation of solved.violations) {
      const key = Lifetime.key(violation.lifetime)
      const entries = analyzed.get(key)
      if (entries === undefined) analyzed.set(key, [violation])
      else entries.push(violation)
    }
    const violations: Array<(typeof solved.violations)[number]> = []
    for (const [key, region] of regions) {
      violations.push(...(analyzed.get(key) ?? []))
      if (region.lifetime._tag === 'StaticLifetime') continue
      const late = [...(solved.required.get(key) ?? [])]
        .filter((point) => point >= firstPoint)
        .sort((left, right) => left - right)
      for (const point of late)
        if (!availableAtFresh(key, region, point))
          violations.push({ lifetime: region.lifetime, point })
    }
    solution = { ...solved, violations }
  }
  return {
    diagnostics: diagnosticsOf(
      solution,
      self.origins,
      (origin) => origin.span,
      spans,
      context.spanOf(ownership.declaration.anchor),
      SourceSpan.key,
    ),
    ...(solution._tag === 'Solved' ? { work: solution.work } : {}),
  }
}

const sourceCache = new WeakMap<LifetimeFlow, Map<string, ReadonlyArray<Origin>>>()

/** Resolves every concrete loan contributing to a result through already checked lifetime edges. */
export const sources = (self: LifetimeFlow, type: Type.Type): ReadonlyArray<Origin> => {
  let cache = sourceCache.get(self)
  if (cache === undefined) {
    cache = new Map()
    sourceCache.set(self, cache)
  }
  const identity = Type.key(type)
  const cached = cache.get(identity)
  if (cached !== undefined) return cached
  const parents = new Map<string, Array<string>>()
  for (const bound of self.input.constraints) {
    const shorter = Lifetime.key(bound.shorter)
    const entries = parents.get(shorter) ?? []
    entries.push(Lifetime.key(bound.longer))
    parents.set(shorter, entries)
  }
  const pending = Type.storageLifetimes(type).map(Lifetime.key)
  const visited = new Set(pending)
  const result: Array<Origin> = []
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const key = pending.at(cursor)
    if (key === undefined) continue
    const origin = self.origins.get(key)
    if (origin !== undefined) result.push(origin)
    for (const parent of parents.get(key) ?? [])
      if (!visited.has(parent)) {
        visited.add(parent)
        pending.push(parent)
      }
  }
  const ordered = result.sort((left, right) => {
    const leftKey = Lifetime.key(left.lifetime)
    const rightKey = Lifetime.key(right.lifetime)
    if (leftKey < rightKey) return -1
    if (leftKey > rightKey) return 1
    return 0
  })
  cache.set(identity, ordered)
  return ordered
}
