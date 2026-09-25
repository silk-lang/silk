import * as Effect from 'effect/Effect'
import type * as AuthoredHir from './AuthoredHir.js'
import * as AuthoredIdentity from './AuthoredIdentity.js'
import type * as CompilationProfile from './CompilationProfile.js'
import type * as DeclarationIndex from './DeclarationIndex.js'
import * as ConfigurationError from './ConfigurationError.js'
import * as Diagnostic from './Diagnostic.js'
import * as Elaboration from './Elaboration.js'
import * as Graph from './internal/Graph.js'
import * as Canonical from './internal/Canonical.js'
import * as ImportPath from './ImportPath.js'
import * as ModuleClosure from './ModuleClosure.js'
import * as NameResolution from './NameResolution.js'
import type * as ProfileBootstrap from './ProfileBootstrap.js'
import * as Residualization from './Residualization.js'
import * as Semantic from './Semantic.js'
import * as SemanticContext from './SemanticContext.js'
import type * as SourceResolver from './SourceResolver.js'
import type * as SourceSpan from './SourceSpan.js'
import * as Evaluation from './Evaluation.js'
import * as CompilerTrace from './CompilerTrace.js'

/** One completed profile's declaration choices and their full authored provenance. */
export interface ModuleSelection {
  readonly conditions: ReadonlyMap<string, ReadonlyArray<Elaboration.ExpressionDecision>>
  readonly profile: CompilationProfile.CompilationProfile
  /** Decisions per module, keyed by the owner key of the authored conditional declaration. */
  readonly decisions: ReadonlyMap<string, ReadonlyMap<string, boolean>>
  readonly inactiveRanges: ReadonlyMap<string, ReadonlyArray<SourceSpan.SourceSpan>>
  readonly dependencies: string
}

/** One authored conditional declaration awaiting a decision, with the module that authored it. */
interface Condition {
  readonly module: string
  readonly context: SemanticContext.SemanticContext
  readonly declaration: AuthoredHir.Declaration
  readonly header: Extract<AuthoredHir.DeclarationHeader, { readonly _tag: 'ConditionalHeader' }>
}

const conditionKey = (self: Condition): string =>
  `${self.module}\u0000${AuthoredIdentity.key(self.declaration.owner)}`

/** The arms of one conditional declaration, in `then`/`else` order. */
const arms = (
  declaration: AuthoredHir.Declaration,
): ReadonlyArray<AuthoredHir.Declaration | undefined> =>
  declaration.body._tag === 'ConditionalBody'
    ? [declaration.body.thenBranch, declaration.body.elseBranch]
    : []

/** Members authored directly beneath one group arm; a nested condition stays whole. */
const members = (declaration: AuthoredHir.Declaration): ReadonlyArray<AuthoredHir.Declaration> =>
  declaration.body._tag === 'MembersBody' ? declaration.body.members : []

/** Visits only reachable conditions; a pending parent never admits either nested arm. */
const pending = (
  module: ModuleClosure.Module,
  decisions: ReadonlyMap<string, boolean>,
): ReadonlyArray<Condition> => {
  const context = SemanticContext.make(module.authored)
  const found: Array<Condition> = []
  const visit = (declaration: AuthoredHir.Declaration): void => {
    const header = declaration.header
    if (header._tag === 'GroupHeader') {
      members(declaration).forEach(visit)
      return
    }
    if (header._tag !== 'ConditionalHeader') return
    const decision = decisions.get(AuthoredIdentity.key(declaration.owner))
    if (decision === undefined) {
      found.push({ module: module.name, context, declaration, header })
      return
    }
    const [thenArm, elseArm] = arms(declaration)
    const arm = decision ? thenArm : elseArm
    if (arm !== undefined) visit(arm)
  }
  module.authored.module.declarations.forEach(visit)
  return found
}

const inactiveRanges = (
  module: ModuleClosure.Module,
  decisions: ReadonlyMap<string, boolean>,
): ReadonlyArray<SourceSpan.SourceSpan> => {
  const context = SemanticContext.make(module.authored)
  const found: Array<SourceSpan.SourceSpan> = []
  const visit = (declaration: AuthoredHir.Declaration): void => {
    const header = declaration.header
    if (header._tag === 'GroupHeader') {
      members(declaration).forEach(visit)
      return
    }
    if (header._tag !== 'ConditionalHeader') return
    const [thenArm, elseArm] = arms(declaration)
    const decision = decisions.get(AuthoredIdentity.key(declaration.owner))
    if (decision === undefined) {
      for (const arm of [thenArm, elseArm])
        if (arm !== undefined) found.push(context.spanOf(arm.header.anchor))
      return
    }
    const inactive = decision ? elseArm : thenArm
    if (inactive !== undefined) found.push(context.spanOf(inactive.header.anchor))
    const active = decision ? thenArm : elseArm
    if (active !== undefined) visit(active)
  }
  module.authored.module.declarations.forEach(visit)
  return found
}

/** True when a loaded authored module contains a module-level condition. */
export const required = (closure: ModuleClosure.Facts): boolean =>
  closure.modules.some((module) => pending(module, new Map()).length > 0)

/** Every name one declaration publishes into its module scope, alias-aware for imports. */
const publishedNames = (
  context: SemanticContext.SemanticContext,
  declaration: AuthoredHir.Declaration,
): ReadonlyArray<{ readonly spelling: string; readonly anchor: AuthoredHir.Anchor }> => {
  const header = declaration.header
  const named = (
    name: AuthoredHir.Name,
  ): ReadonlyArray<{ readonly spelling: string; readonly anchor: AuthoredHir.Anchor }> => {
    const spelling = SemanticContext.nameText(context, name)
    return spelling === undefined ? [] : [{ spelling, anchor: name.anchor }]
  }
  if (header._tag === 'ImportHeader') {
    if (header.alias !== undefined) return named(header.alias)
    if (header.members !== undefined)
      return header.members.flatMap((member) => named(member.alias ?? member.name))
    const last = header.path.segments.at(-1)
    if (last === undefined) return []
    const spelling = SemanticContext.nameText(context, last)
    return spelling === undefined || ImportPath.isReservedSpelling(spelling)
      ? []
      : [{ spelling, anchor: last.anchor }]
  }
  return 'name' in header ? named(header.name) : []
}

/** Follows explicit import aliases without loading unavailable modules or admitting declarations. */
const availabilityNames = (
  closure: ModuleClosure.Facts,
  moduleName: string,
  spelling: string,
  visited: ReadonlySet<string> = new Set(),
): ReadonlyArray<string> => {
  const key = `${moduleName}\u0000${spelling}`
  if (visited.has(key)) return []
  const next = new Set([...visited, key])
  const module = closure.modules.find((candidate) => candidate.name === moduleName)
  if (module === undefined) return [key]
  const context = SemanticContext.make(module.authored)
  const names = [key]
  for (const imported of module.imports) {
    if (imported.canonicalTarget === undefined) continue
    for (const member of imported.header.members ?? []) {
      const local = SemanticContext.nameText(context, member.alias ?? member.name)
      const original = SemanticContext.nameText(context, member.name)
      if (local !== spelling || original === undefined) continue
      names.push(...availabilityNames(closure, imported.canonicalTarget, original, next))
    }
  }
  return names
}

/** Finds controlling conditions for a failed bootstrap dependency, including import aliases. */
export const availabilityOrigins = (
  closure: ModuleClosure.Facts,
  span: SourceSpan.SourceSpan,
): ReadonlyArray<SourceSpan.SourceSpan> => {
  const origin = closure.modules.find((module) => module.syntax.source.id === span.sourceId)
  if (origin === undefined) return []
  const context = SemanticContext.make(origin.authored)
  // The failing span names one authored binder; its spelling is the name the arms must publish.
  const name = context.presentation.entries.find(
    (entry) => entry.span.start === span.start && entry.span.end === span.end,
  )?.spelling
  if (name === undefined) return []
  const names = new Set(availabilityNames(closure, origin.name, name))
  return closure.modules.flatMap((module) => {
    const moduleContext = SemanticContext.make(module.authored)
    const visit = (
      declaration: AuthoredHir.Declaration,
      parents: ReadonlyArray<SourceSpan.SourceSpan>,
    ): ReadonlyArray<SourceSpan.SourceSpan> => {
      const header = declaration.header
      if (header._tag === 'ConditionalHeader') {
        const span = moduleContext.spanOf(declaration.header.anchor)
        return arms(declaration).flatMap((arm) =>
          arm === undefined ? [] : visit(arm, [...parents, span]),
        )
      }
      if (header._tag === 'GroupHeader')
        return members(declaration).flatMap((member) => visit(member, parents))
      if (parents.length === 0) return []
      return publishedNames(moduleContext, declaration).flatMap((published) =>
        names.has(`${module.name}\u0000${published.spelling}`)
          ? [...parents, moduleContext.spanOf(published.anchor)]
          : [],
      )
    }
    return module.authored.module.declarations.flatMap((declaration) => visit(declaration, []))
  })
}

/** Maps unavailable names to the pending conditions that control their declaration's availability. */
const availabilityCycles = (
  closure: ModuleClosure.Facts,
  failures: ReadonlyArray<{
    readonly condition: Condition
    readonly diagnostics: ReadonlyArray<Diagnostic.Diagnostic>
  }>,
  target: string,
): ReadonlyArray<Diagnostic.Diagnostic> => {
  const owners = new Map<string, Array<string>>()
  for (const { condition } of failures) {
    const context = condition.context
    const visit = (declaration: AuthoredHir.Declaration): void => {
      const header = declaration.header
      if (header._tag === 'ConditionalHeader' || header._tag === 'GroupHeader') {
        for (const child of header._tag === 'GroupHeader'
          ? members(declaration)
          : arms(declaration))
          if (child !== undefined) visit(child)
        return
      }
      for (const published of publishedNames(context, declaration)) {
        const key = `${condition.module}\u0000${published.spelling}`
        owners.set(key, [...(owners.get(key) ?? []), conditionKey(condition)])
      }
    }
    for (const arm of arms(condition.declaration)) if (arm !== undefined) visit(arm)
  }
  const edges = new Map<string, ReadonlyArray<string>>()
  for (const failure of failures) {
    const targets = failure.diagnostics.flatMap((diagnostic) => {
      const reason = diagnostic.reason
      if (!('spelling' in reason)) return []
      const module =
        reason._tag === 'UnknownImportedMember' ? reason.module : failure.condition.module
      return availabilityNames(closure, module, reason.spelling).flatMap(
        (name) => owners.get(name) ?? [],
      )
    })
    edges.set(conditionKey(failure.condition), targets)
  }
  const spanOf = (condition: Condition): SourceSpan.SourceSpan =>
    condition.context.spanOf(condition.header.anchor)
  return Graph.stronglyConnected([...edges.keys()], (key) => edges.get(key) ?? []).flatMap(
    (component) => {
      if (
        component.length === 1 &&
        !(edges.get(component[0] ?? '') ?? []).includes(component[0] ?? '')
      )
        return []
      const conditions = failures.filter((failure) =>
        component.includes(conditionKey(failure.condition)),
      )
      return conditions.map(({ condition }) =>
        Diagnostic.staticEvaluationCycle(
          'module declaration availability',
          target,
          conditions.map((dependency) => ({
            kind: 'Call',
            label: 'condition dependency',
            arguments: [],
            span: spanOf(dependency.condition),
          })),
          spanOf(condition),
        ),
      )
    },
  )
}

/** Builds static evaluation inputs without elaborating unrelated executable bodies. */
const coordinator = (
  closure: ModuleClosure.Facts,
  completion: ProfileBootstrap.Completion,
  trace: CompilerTrace.CompilerTrace,
  headers: Headers,
): Residualization.Coordinator => {
  const { index, resolution } = headers
  const session = Semantic.makeSession(
    `module-selection:${completion.profile.identity}`,
    index,
    resolution,
    completion.profile.identity,
  )
  const results = new Map<string, Elaboration.Result>()
  for (const module of closure.modules) {
    const headers = index.modules.find((candidate) => candidate.module === module.name)
    const scope = NameResolution.scopeOf(resolution, module.name)
    if (headers === undefined || scope === undefined)
      throw new RangeError(`Module selection lost headers for ${module.name}`)
    results.set(
      module.name,
      Elaboration.elaborateModule({
        authored: module.authored,
        headers: { ...headers, declarations: [], constants: [] },
        scope,
        index,
        session,
      }),
    )
  }
  return Residualization.make(
    completion.profile,
    results,
    resolution,
    index,
    undefined,
    completion.values,
    trace,
  )
}

/** Completed declaration headers and name resolution of one module closure. */
export interface Headers {
  readonly index: DeclarationIndex.Index
  readonly resolution: NameResolution.Resolution
}

/**
 * Resolves one selection transaction against a stable, memoized source supply. `initialHeaders`
 * are the bootstrap headers of `initial`'s modules, which the first evaluation pass reuses
 * instead of analyzing the same closure again.
 */
export const select = Effect.fn('ModuleSelection.select')(function* (
  request: ModuleClosure.ProjectRequest,
  initial: ModuleClosure.ProjectClosure,
  completion: ProfileBootstrap.Completion,
  initialHeaders: Headers,
): Effect.fn.Return<
  {
    readonly closure: ModuleClosure.ProjectClosure
    readonly selection: ModuleSelection
  },
  ModuleClosure.ModuleClosureError,
  SourceResolver.SourceResolver
> {
  const trace = yield* CompilerTrace.capture()
  const decisions = new Map<string, Map<string, boolean>>()
  const bootstrapModules = new Set(initial.modules.map((module) => module.name))
  const dependencies: Array<string> = []
  const expressions = new Map<string, Map<number, Elaboration.ExpressionDecision>>()
  let closure = initial
  let diagnostics: ReadonlyArray<Diagnostic.Diagnostic> = []
  while (true) {
    const conditions = closure.modules.flatMap((module) =>
      pending(module, decisions.get(module.name) ?? new Map()),
    )
    if (conditions.length === 0) break
    const evaluation = coordinator(
      closure,
      completion,
      trace,
      closure === initial ? initialHeaders : NameResolution.analyze(closure),
    )
    const failures: Array<Diagnostic.Diagnostic> = []
    const failedConditions: Array<{
      readonly condition: Condition
      readonly diagnostics: ReadonlyArray<Diagnostic.Diagnostic>
    }> = []
    let progressed = false
    for (const condition of conditions) {
      const result = yield* Residualization.evaluateModuleCondition(
        evaluation,
        condition.declaration,
      )
      if (result.expression !== undefined) {
        let module = expressions.get(condition.module)
        if (module === undefined) {
          module = new Map()
          expressions.set(condition.module, module)
        }
        // Conditions of one module publish in authored document order, not byte order.
        module.set(condition.context.orderOf(condition.header.anchor), result.expression)
      }
      if (result.outcome._tag === 'Complete' && result.outcome.value._tag === 'BooleanValue') {
        let module = decisions.get(condition.module)
        if (module === undefined) {
          module = new Map()
          decisions.set(condition.module, module)
        }
        module.set(AuthoredIdentity.key(condition.declaration.owner), result.outcome.value.value)
        progressed = true
      } else {
        // Selection diagnostics join the module closure's, which are in source coordinates.
        const registry = SemanticContext.registryOf(condition.context)
        const published = Diagnostic.publishAll(result.diagnostics, registry)
        failedConditions.push({ condition, diagnostics: published })
        failures.push(...published)
        if (result.outcome._tag === 'Failed')
          failures.push(
            Diagnostic.publish(
              Evaluation.diagnostic(result.outcome.failure, completion.profile.target.id),
              registry,
            ),
          )
      }
    }
    dependencies.push(Residualization.dependencies(evaluation))
    if (!progressed) {
      diagnostics = Diagnostic.merge(
        failures,
        availabilityCycles(closure, failedConditions, completion.profile.target.id),
      )
      break
    }
    closure = yield* ModuleClosure.loadProject({
      ...request,
      previous: closure,
      selection: decisions,
    })
    const conditionalSchemas = closure.modules.flatMap((module) =>
      bootstrapModules.has(module.name)
        ? []
        : module.declarations.flatMap((declaration) =>
            declaration.header._tag === 'PackageParameterHeader' ? [{ module, declaration }] : [],
          ),
    )
    if (conditionalSchemas.length > 0) {
      diagnostics = conditionalSchemas.map(({ module, declaration }) => {
        const span = SemanticContext.make(module.authored).spanOf(declaration.header.anchor)
        return Diagnostic.invalidConfiguration(
          ConfigurationError.make(
            'ModuleSelection.select',
            'DependencyCycle',
            'conditionally available package schema',
            [{ source: span.sourceId, provenance: 'literal', span }],
          ),
          span,
        )
      })
      break
    }
  }
  return {
    closure: {
      ...closure,
      diagnostics: Diagnostic.merge(closure.diagnostics, diagnostics),
    },
    selection: {
      conditions: new Map(
        [...expressions].map(([module, values]) => [
          module,
          [...values.entries()].sort(([a], [b]) => a - b).map(([, expression]) => expression),
        ]),
      ),
      profile: completion.profile,
      decisions: new Map([...decisions].map(([name, values]) => [name, new Map(values)])),
      inactiveRanges: new Map(
        closure.modules.map((module) => [
          module.name,
          inactiveRanges(module, decisions.get(module.name) ?? new Map()),
        ]),
      ),
      dependencies: Canonical.array(dependencies),
    },
  }
})
