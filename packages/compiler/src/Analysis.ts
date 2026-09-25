import type * as ArtifactPlan from './ArtifactPlan.js'
import type * as ArtifactComposition from './ArtifactComposition.js'
import type * as ConfigurationError from './ConfigurationError.js'
import type * as CompilationProfile from './CompilationProfile.js'
import * as AuthoredLowering from './AuthoredLowering.js'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as DeclarationFacts from './DeclarationFacts.js'
import type * as DeclarationIndex from './DeclarationIndex.js'

export { AnalysisUnavailable } from './AnalysisUnavailable.js'

import type { AnalysisUnavailable } from './AnalysisUnavailable.js'
import * as AutoImport from './AutoImport.js'
import * as Backend from './Backend.js'
import * as Completion from './Completion.js'
import * as ConformanceProof from './ConformanceProof.js'
import * as Diagnostic from './Diagnostic.js'
import * as DocBlock from './DocBlock.js'
import * as Elaboration from './Elaboration.js'
import * as ExecutableProperty from './ExecutableProperty.js'
import * as Frontend from './Frontend.js'
import * as FrontendTooling from './FrontendTooling.js'
import * as Instances from './Instances.js'
import * as Intrinsic from './Intrinsic.js'
import * as ForeignAvailability from './ForeignAvailability.js'
import * as ForeignPlanning from './ForeignPlanning.js'
import * as IntrinsicAvailability from './IntrinsicAvailability.js'
import * as ImportUsage from './ImportUsage.js'
import type * as DeclarationLifetime from './DeclarationLifetime.js'
import * as LifetimeElision from './LifetimeElision.js'
import * as Option from 'effect/Option'
import * as Layout from './Layout.js'
import * as LlvmBackend from './LlvmBackend.js'
import type * as Mir from './Mir.js'
import * as MirVerification from './MirVerification.js'
import type * as ModuleClosure from './ModuleClosure.js'
import type * as ModuleSelection from './ModuleSelection.js'
import type * as ModuleSemantics from './ModuleSemantics.js'
import type * as ModuleSurface from './ModuleSurface.js'
import * as ModuleTooling from './ModuleTooling.js'
import * as NameResolution from './NameResolution.js'
import * as OpaqueRealization from './OpaqueRealization.js'
import type * as Ownership from './Ownership.js'
import type * as PhaseReport from './PhaseReport.js'
import * as SemanticDisplay from './SemanticDisplay.js'
import * as Semantic from './Semantic.js'
import * as Preparation from './Preparation.js'

import type * as SemanticInvalidation from './SemanticInvalidation.js'
import * as SemanticOccurrence from './SemanticOccurrence.js'
import * as SourceFile from './SourceFile.js'
import * as SourceResolver from './SourceResolver.js'
import type * as SourceSpan from './SourceSpan.js'
import type * as AuthoredHir from './AuthoredHir.js'
import * as AuthoredWalk from './AuthoredWalk.js'
import * as Location from './Location.js'
import type * as SemanticContext from './SemanticContext.js'
import type * as SyntaxFile from './SyntaxFile.js'
import * as SyntaxTree from './SyntaxTree.js'
import * as Target from './Target.js'
import type * as TestDiscovery from './TestDiscovery.js'
import * as Type from './Type.js'
import * as Tir from './Tir.js'
import * as TypeHint from './TypeHint.js'
import type * as WorkspaceInventory from './WorkspaceInventory.js'

/**
 * The supported analysis facade. Tooling consumes compiler phases exclusively through this
 * module: build a snapshot from one compilation request, then query immutable facts. The
 * data-model vocabularies (syntax elements, diagnostics, fact types) are part of the facade's
 * answers; running phase modules directly is not a supported consumer surface.
 */

/** An available phase artifact or the target failure that prevented its construction. */
export type Targeted<A> =
  | { readonly _tag: 'Available'; readonly value: A }
  | {
      readonly _tag: 'Unavailable'
      readonly error: Target.TargetError | AnalysisUnavailable
    }

/** One immutable frontend analysis snapshot of one compilation request. */
export interface FrontendSnapshot {
  readonly composition?: ArtifactComposition.Resolved
  readonly selection?: ModuleSelection.ModuleSelection
  readonly _tag: 'AnalysisSnapshot' | 'ProjectAnalysisView'
  readonly realization: 'SingleRoot' | 'ProjectView'
  readonly profile?: CompilationProfile.CompilationProfile
  readonly configuration?: ModuleClosure.CompilationRequest['configuration']
  readonly closure: ModuleClosure.Closure
  readonly index: DeclarationIndex.Index
  readonly resolution: NameResolution.Resolution
  readonly session: Semantic.Session
  readonly surfaces: ReadonlyMap<string, ModuleSurface.ModuleSurface>
  readonly semantics: ReadonlyMap<string, ModuleSemantics.ModuleSemantics>
  readonly toolingModules: ReadonlyMap<string, ModuleTooling.ModuleTooling>
  readonly results: ReadonlyMap<string, Elaboration.Result>
  readonly semanticOccurrences: SemanticOccurrence.Index
  readonly anonymousExpressions: ReadonlyMap<string, ReadonlyArray<AnonymousExpression>>
  readonly ownership: ReadonlyMap<string, Ownership.ModuleOwnership>
  readonly diagnostics: ReadonlyArray<Diagnostic.Diagnostic>
  readonly report: ReadonlyArray<PhaseReport.PhaseReport>
  readonly semanticInvalidation?: SemanticInvalidation.SemanticInvalidation
  readonly initialProfile?: CompilationProfile.Initial
  readonly configurationError?: ConfigurationError.ConfigurationError
  readonly requestedTarget?: string
  readonly testCatalog?: TestDiscovery.Catalog
}

/** One true single-root frontend accepted by explicit runtime realization. */
export interface SingleRootFrontendSnapshot extends FrontendSnapshot {
  readonly _tag: 'AnalysisSnapshot'
  readonly realization: 'SingleRoot'
}

/** One immutable runtime realization derived from a completed frontend snapshot. */
export interface Snapshot extends SingleRootFrontendSnapshot {
  readonly artifactPlan?: ArtifactPlan.ArtifactPlan
  readonly profile?: CompilationProfile.CompilationProfile
  readonly instances: Instances.Discovery
  readonly target: Target.Selection
  readonly layoutCatalog: Targeted<Layout.Catalog>
  readonly layout: Targeted<Layout.Plan>
  readonly mir: Targeted<Mir.Module>
}

/** One available anonymous expression type cached for position fallback. */
export interface AnonymousExpression {
  readonly span: ModuleTooling.AnonymousExpression['span']
  readonly type: ModuleTooling.AnonymousExpression['type']
  readonly presentation?: ModuleTooling.AnonymousExpression['presentation']
}

/** The occurrence-first semantic subject selected for a hover request. */
export type HoverSubject =
  | {
      readonly _tag: 'OccurrenceHoverSubject'
      readonly occurrence: SemanticOccurrence.SemanticOccurrence
      readonly presentation: SemanticDisplay.Presentation
      readonly implementedContracts: ReadonlyArray<SemanticDisplay.Presentation>
    }
  | {
      readonly _tag: 'ExpressionHoverSubject'
      readonly expression: AnonymousExpression
      readonly presentation: SemanticDisplay.Presentation
      readonly implementedContracts: ReadonlyArray<SemanticDisplay.Presentation>
    }

/** Source facts that make backend emission unavailable while keeping analysis queryable. */
export class CodegenUnavailable extends Data.TaggedError('CodegenUnavailable')<{
  readonly operation: 'Analysis.codegen'
  readonly message: string
  readonly diagnostics: ReadonlyArray<Diagnostic.Diagnostic>
  readonly resolutionFailures: ReadonlyArray<SourceResolver.SourceResolverError>
}> {}

/** Builds the frontend snapshot of one compilation request. */
export const make = Effect.fn('Analysis.make')(function* (
  request: ModuleClosure.CompilationRequest,
): Effect.fn.Return<
  SingleRootFrontendSnapshot,
  ModuleClosure.ModuleClosureError,
  SourceResolver.SourceResolver
> {
  const { frontend } = yield* Preparation.prepare(request, 'analysis')
  yield* Effect.yieldNow
  const tooling = yield* FrontendTooling.make(frontend)
  return OpaqueRealization.withCatalog(
    {
      _tag: 'AnalysisSnapshot',
      realization: 'SingleRoot',
      ...frontend,
      ...tooling,
    },
    OpaqueRealization.catalogOf(frontend),
  )
})

/** Explicitly derives one immutable runtime snapshot from completed frontend facts. */
export const realize = Effect.fn('Analysis.realize')(function* (
  self: SingleRootFrontendSnapshot,
  target: string | ModuleClosure.CompilationRequest['configuration'] = self.requestedTarget ??
    Target.x8664UnknownLinuxGnu.id,
  options: Frontend.Options = {},
): Effect.fn.Return<Snapshot, ModuleClosure.ModuleClosureError, SourceResolver.SourceResolver> {
  const { frontend, ...realization } = Preparation.realization(
    yield* Preparation.promote(self, target, options),
  )
  const tooling =
    frontend.index === self.index && frontend.closure === self.closure
      ? {
          toolingModules: self.toolingModules,
          semanticOccurrences: self.semanticOccurrences,
          anonymousExpressions: self.anonymousExpressions,
          report: frontend.report,
        }
      : yield* FrontendTooling.make(frontend, self.toolingModules)
  return OpaqueRealization.withCatalog(
    {
      ...frontend,
      ...tooling,
      ...realization,
      _tag: 'AnalysisSnapshot',
      realization: 'SingleRoot',
    },
    OpaqueRealization.catalogOf(frontend),
  )
})

/** Builds and explicitly realizes one compilation request in a single effect. */
export const makeRealized = Effect.fn('Analysis.makeRealized')(function* (
  request: ModuleClosure.CompilationRequest,
): Effect.fn.Return<Snapshot, ModuleClosure.ModuleClosureError, SourceResolver.SourceResolver> {
  const selected =
    request.configuration === undefined && request.target === undefined
      ? { ...request, target: Target.x8664UnknownLinuxGnu.id }
      : request
  const bundle = yield* Preparation.prepare(selected, 'executable')
  const { frontend, ...realization } = Preparation.realization(bundle)
  const tooling = yield* FrontendTooling.make(frontend)
  return OpaqueRealization.withCatalog(
    {
      ...frontend,
      ...tooling,
      ...realization,
      _tag: 'AnalysisSnapshot',
      realization: 'SingleRoot',
    },
    OpaqueRealization.catalogOf(frontend),
  )
})

/** Builds the snapshot of one single-module source. */
export const ofSource = (
  sourceId: string,
  bytes: Uint8Array,
  target?: string,
): Effect.Effect<SingleRootFrontendSnapshot, ModuleClosure.ModuleClosureError> =>
  Effect.provide(
    target === undefined ? make({ root: sourceId }) : make({ root: sourceId, target }),
    SourceResolver.memory(new Map([[sourceId, bytes]])),
  )

/** Builds and explicitly realizes one single-module source. */
export const ofSourceRealized = (
  sourceId: string,
  bytes: Uint8Array,
  target: string = Target.x8664UnknownLinuxGnu.id,
  options: Frontend.Options = {},
): Effect.Effect<Snapshot, ModuleClosure.ModuleClosureError> =>
  Effect.provide(
    Effect.gen(function* () {
      const bundle = yield* Preparation.prepare({ root: sourceId, target }, 'executable', options)
      const { frontend, ...realization } = Preparation.realization(bundle)
      const tooling = yield* FrontendTooling.make(frontend)
      return OpaqueRealization.withCatalog(
        {
          ...frontend,
          ...tooling,
          ...realization,
          _tag: 'AnalysisSnapshot' as const,
          realization: 'SingleRoot' as const,
        },
        OpaqueRealization.catalogOf(frontend),
      )
    }),
    SourceResolver.memory(new Map([[sourceId, bytes]])),
  )

/** Returns every loaded module of the snapshot in canonical identity order. */
export const modules = (self: FrontendSnapshot): ReadonlyArray<ModuleClosure.Module> =>
  self.closure.modules

/** Returns the snapshot's import cycle facts in canonical order. */
export const cycles = (self: FrontendSnapshot): ReadonlyArray<ReadonlyArray<string>> =>
  self.closure.cycles

/** Returns exact immutable source snapshots for every successfully loaded module. */
export const sources = (self: FrontendSnapshot): ReadonlyMap<string, SourceFile.SourceFile> =>
  self.closure.sources

/** Returns the smallest exact-token semantic occurrence containing one byte offset. */
export const semanticOccurrenceAt = (
  self: FrontendSnapshot,
  module: string,
  byteOffset: number,
): SemanticOccurrence.SemanticOccurrence | undefined =>
  SemanticOccurrence.at(self.semanticOccurrences, module, byteOffset)

/** Returns exact-token semantic occurrences overlapping one source range. */
export const semanticOccurrencesInRange = (
  self: FrontendSnapshot,
  module: string,
  range: SourceSpan.SourceSpan,
): ReadonlyArray<SemanticOccurrence.SemanticOccurrence> =>
  SemanticOccurrence.inRange(self.semanticOccurrences, module, range)

/** Returns operational source-resolution failures in canonical module order. */
export const resolutionFailures = (
  self: FrontendSnapshot,
): ReadonlyArray<SourceResolver.SourceResolverError> => self.closure.resolutionFailures

/** Returns the closure's declaration index. */
export const declarationIndex = (self: FrontendSnapshot): DeclarationIndex.Index => self.index

export const nameResolution = (self: FrontendSnapshot): NameResolution.Resolution => self.resolution

/**
 * One module's parsed syntax, for the syntax-only tooling this facade exposes (documentation,
 * import edits, receiver navigation). Semantic queries take spans from the semantic context.
 */
export const moduleSyntax = (
  self: FrontendSnapshot,
  module: string,
): SyntaxFile.SyntaxFile | undefined =>
  self.closure.modules.find((candidate) => candidate.name === module)?.syntax

const syntaxOf = moduleSyntax
/** Returns valid authored import bindings that have no semantic use in their module. */
export const unusedImports = (
  self: FrontendSnapshot,
  module: string,
): ReadonlyArray<ImportUsage.UnusedBinding> => {
  const syntax = syntaxOf(self, module)
  if (syntax === undefined) return []
  return ImportUsage.unused(
    syntax,
    self.resolution.modules.find((scope) => scope.module === module),
    self.semanticOccurrences.modules.get(module),
  )
}
export const moduleScope = (
  self: FrontendSnapshot,
  module: string,
): NameResolution.ModuleScope | undefined => NameResolution.scopeOf(self.resolution, module)
export const lookupName = (
  self: FrontendSnapshot,
  module: string,
  spelling: string,
): NameResolution.Lookup => {
  const scope = moduleScope(self, module)
  return scope === undefined
    ? { _tag: 'Missing', spelling }
    : Semantic.resolveName(self.session, scope, spelling)
}
/** Discovers compiler-owned auto-import actions for one unresolved source occurrence. */
export const autoImportsAt = (
  self: FrontendSnapshot,
  inventory: WorkspaceInventory.WorkspaceInventory,
  module: string,
  byteOffset: number,
): ReadonlyArray<AutoImport.Action> =>
  AutoImport.discover({ snapshot: self, inventory, module, byteOffset })

/** Revalidates and resolves one auto-import candidate against this exact snapshot. */
export const resolveAutoImport = (
  self: FrontendSnapshot,
  inventory: WorkspaceInventory.WorkspaceInventory,
  module: string,
  byteOffset: number,
  candidate: AutoImport.CandidateKey,
) => AutoImport.resolve({ snapshot: self, inventory, module, byteOffset, candidate })

/** Returns one module's raw leading `//!` documentation without interpreting Markdown. */
export const moduleDocumentation = (
  self: FrontendSnapshot,
  module: string,
): DocBlock.DocBlock | undefined => {
  const syntax = syntaxOf(self, module)
  return syntax === undefined ? undefined : DocBlock.ofModule(syntax)
}

/** Returns raw documentation for a source-owned declaration-like syntax node. */
export const documentationOfSyntax = (
  self: FrontendSnapshot,
  module: string,
  node: SyntaxTree.Node,
): DocBlock.DocBlock | undefined => {
  const syntax = syntaxOf(self, module)
  return syntax === undefined ? undefined : DocBlock.ofNode(syntax, node)
}

/** Returns one module's elaborated analysis, or `undefined` for an unknown identity. */
export const moduleAnalysis = (
  self: FrontendSnapshot,
  module: string,
): Elaboration.Result | undefined => self.results.get(module)

/** Plans complete lifetime expansions for declaration headers overlapping a source range. */
export const explicitLifetimes = (
  self: FrontendSnapshot,
  module: string,
  start: number,
  end = start,
): ReadonlyArray<LifetimeElision.LifetimeElision> => {
  const headers = self.index.modules.find((candidate) => candidate.module === module)
  const spans = self.resolution.contexts
  const contexts =
    headers?.members.flatMap((member) => {
      const declarations =
        member._tag === 'ServiceDeclaration' || member._tag === 'InterfaceDeclaration'
          ? member.operations
          : [member]
      return declarations.flatMap(
        (
          declaration,
        ): ReadonlyArray<{
          readonly context: DeclarationLifetime.Context
          readonly semantic: SemanticContext.SemanticContext
          readonly authored: AuthoredHir.Declaration
          readonly header: SourceSpan.SourceSpan
          readonly body: SourceSpan.SourceSpan | undefined
          readonly executable: Type.ExecutableLifetimes | undefined
        }> => {
          if (
            !('lifetimeElaboration' in declaration) ||
            declaration.lifetimeElaboration === undefined
          )
            return []
          const semantic = spans.of(declaration.anchor)
          const authored =
            semantic === undefined
              ? undefined
              : AuthoredWalk.declarationOf(semantic.module, declaration.anchor.owner)
          if (semantic === undefined || authored === undefined) return []
          return [
            {
              context: declaration.lifetimeElaboration,
              semantic,
              authored,
              header: spans.spanOf(declaration.anchor),
              // Every written body counts, not only one retained as a static template.
              body:
                authored.body._tag === 'CallableBody' && authored.body.block !== undefined
                  ? spans.spanOf(authored.body.block.anchor)
                  : undefined,
              executable:
                declaration._tag === 'FunctionDeclaration' ||
                declaration._tag === 'ServiceOperation'
                  ? DeclarationFacts.executableLifetimes(declaration)
                  : undefined,
            },
          ]
        },
      )
    }) ?? []
  return contexts.flatMap(({ context, semantic, authored, header, body, executable }) => {
    // The header anchor presents the declaration head; the body anchor presents its block.
    const declarationEnd = body?.end ?? header.end
    if (header.start > end || declarationEnd < start) return []
    if (body !== undefined && start >= body.start && end <= body.end) return []
    const headerEnd = body?.start ?? header.end
    if (
      self.index.diagnostics.some((located) => {
        if (located.severity !== 'error') return false
        const span = semantic.spanOf(Location.anchorOf(located.span))
        return (
          span.sourceId === header.sourceId && span.start >= header.start && span.start < headerEnd
        )
      })
    )
      return []
    const syntax = moduleSyntax(self, module)
    return syntax === undefined
      ? []
      : Option.toArray(
          LifetimeElision.makeExplicit(syntax, semantic, authored, context, executable),
        )
  })
}

/** Returns the root module's elaborated analysis. The root is always loaded. */
export const rootAnalysis = (self: FrontendSnapshot): Elaboration.Result => {
  const result = self.results.get(self.closure.rootModule)
  if (result === undefined) {
    throw new RangeError(`Snapshot lost its root module ${self.closure.rootModule}`)
  }
  return result
}

/** Resolves the declaration one declaration identity names, canonical or module-local. */
export const declarationForIdentity = (
  self: FrontendSnapshot,
  identity: Extract<SemanticOccurrence.Identity, { readonly _tag: 'DeclarationIdentity' }>,
): DeclarationFacts.MemberFact | undefined => {
  if (identity.id._tag === 'CanonicalDeclarationId')
    return DeclarationFacts.byCanonical(self.index, identity.id)
  const local = identity.id
  return self.index.modules
    .flatMap((module) => module.members)
    .find((member) => member.id.sourceId === local.sourceId && member.id.ordinal === local.ordinal)
}

const serviceOperationForIdentity = (
  self: FrontendSnapshot,
  identity: Extract<SemanticOccurrence.Identity, { readonly _tag: 'ServiceOperationIdentity' }>,
): DeclarationFacts.ServiceOperationFact | undefined =>
  self.index.modules
    .flatMap((module) => module.services)
    .find(
      (service) =>
        service.id.sourceId === identity.id.service.sourceId &&
        service.id.ordinal === identity.id.service.ordinal,
    )
    ?.operations.find(
      (operation) =>
        operation.name._tag === 'Present' && operation.name.spelling === identity.id.name,
    )

const unionVariantForIdentity = (
  self: FrontendSnapshot,
  identity: Extract<SemanticOccurrence.Identity, { readonly _tag: 'UnionVariantIdentity' }>,
): readonly [DeclarationFacts.UnionFact, DeclarationFacts.UnionVariantFact] | undefined => {
  const union = DeclarationFacts.byCanonical(self.index, identity.id.union)
  if (union?._tag !== 'UnionDeclaration') return undefined
  const variant = union.variants.find(
    (candidate) =>
      candidate.canonical._tag === 'Canonical' && candidate.canonical.id.name === identity.id.name,
  )
  return variant === undefined ? undefined : ([union, variant] as const)
}

const anchorForIdentity = (
  self: FrontendSnapshot,
  identity: SemanticOccurrence.Identity,
): AuthoredHir.Anchor | undefined => {
  if (identity._tag === 'DeclarationIdentity') return declarationForIdentity(self, identity)?.anchor
  if (identity._tag === 'ServiceOperationIdentity')
    return serviceOperationForIdentity(self, identity)?.anchor
  if (identity._tag === 'EnumMemberIdentity')
    return self.index.modules
      .flatMap((module) => module.enums)
      .find(
        (enum_) =>
          enum_.canonical._tag === 'Canonical' &&
          enum_.canonical.id.module === identity.id.enum.module &&
          enum_.canonical.id.name === identity.id.enum.name,
      )
      ?.members.find(
        (member) =>
          member.canonical._tag === 'Canonical' && member.canonical.id.name === identity.id.name,
      )?.anchor
  if (identity._tag === 'UnionVariantIdentity')
    return unionVariantForIdentity(self, identity)?.[1].anchor
  if (identity._tag === 'EnumAssociatedOperationIdentity')
    return DeclarationFacts.byCanonical(self.index, identity.id.enum)?.anchor
  if (identity._tag === 'TypeParameterIdentity') {
    for (const headers of self.index.modules)
      for (const member of [...headers.members, ...headers.inherentImpls]) {
        const parameter = member.typeParameters.find((candidate) =>
          Type.equals(candidate.type, identity.id),
        )
        if (parameter !== undefined) return parameter.anchor
        if (member._tag === 'ServiceDeclaration')
          for (const operation of member.operations) {
            const operationParameter = operation.typeParameters.find((candidate) =>
              Type.equals(candidate.type, identity.id),
            )
            if (operationParameter !== undefined) return operationParameter.anchor
          }
      }
    return undefined
  }
  if (identity._tag === 'ParameterIdentity') {
    for (const headers of self.index.modules)
      for (const declaration of [
        ...headers.declarations,
        ...headers.services.flatMap((service) => service.operations),
      ]) {
        const parameter = declaration.parameters.find(
          (candidate) =>
            candidate.id.function.sourceId === identity.id.function.sourceId &&
            candidate.id.function.ordinal === identity.id.function.ordinal &&
            candidate.id.ordinal === identity.id.ordinal,
        )
        if (parameter !== undefined) return parameter.anchor
      }
    return undefined
  }
  if (identity._tag === 'FieldIdentity') {
    for (const headers of self.index.modules) {
      const fields = [
        ...headers.structs.flatMap((declaration) => declaration.fields),
        ...headers.unions.flatMap((declaration) =>
          declaration.variants.flatMap((variant) => variant.fields),
        ),
      ]
      for (const field of fields) {
        if (DeclarationFacts.sameFieldId(field.id, identity.id)) return field.anchor
      }
    }
  }
  return undefined
}

/** Returns raw documentation for one authored anchor. */
export const documentationOfAnchor = (
  self: FrontendSnapshot,
  anchor: AuthoredHir.Anchor,
): DocBlock.DocBlock | undefined => {
  const span = self.resolution.contexts.spanOf(anchor)
  const syntax = syntaxOf(self, anchor.owner.module)
  if (syntax === undefined) return undefined
  // Documentation is the direct leading trivia of the innermost *documentable* node covering the
  // span. An enclosing node's block never stands in for an undocumented inner one: a parameter
  // with no `///` of its own must not inherit its operation's documentation.
  const covers = (node: SyntaxTree.Node): boolean =>
    node.span.start <= span.start && node.span.end >= span.end
  let innermost: SyntaxTree.Node | undefined
  let node: SyntaxTree.Node | undefined = covers(syntax.root) ? syntax.root : undefined
  while (node !== undefined) {
    if (DocBlock.isDocumentableKind(node.kind)) innermost = node
    // A lifetime binder takes no `///` of its own, and must not borrow its declaration's either.
    else if (node.kind === 'LifetimeParameter') innermost = undefined
    node = node.children.find(
      (child): child is SyntaxTree.Node => SyntaxTree.isNode(child) && covers(child),
    )
  }
  return innermost === undefined ? undefined : DocBlock.ofNode(syntax, innermost)
}

/** Returns raw documentation for one source-backed semantic identity. */
export const documentationOfIdentity = (
  self: FrontendSnapshot,
  identity: SemanticOccurrence.Identity,
): DocBlock.DocBlock | undefined => {
  const anchor = anchorForIdentity(self, identity)
  return anchor === undefined ? undefined : documentationOfAnchor(self, anchor)
}

/** Resolves one source position and returns the selected declaration's raw documentation. */
export const documentationAt = (
  self: FrontendSnapshot,
  module: string,
  byteOffset: number,
): DocBlock.DocBlock | undefined => {
  const occurrence = semanticOccurrenceAt(self, module, byteOffset)
  return occurrence?.resolution._tag === 'Available'
    ? documentationOfIdentity(self, occurrence.resolution.identity)
    : undefined
}

interface HoverPresentation {
  readonly presentation: SemanticDisplay.Presentation
  readonly type?: Type.Type
}

const hoverPresentation = (
  presentation: SemanticDisplay.Presentation | undefined,
  type?: Type.Type,
): HoverPresentation | undefined => {
  if (presentation === undefined) {
    return undefined
  }
  return { presentation, ...(type === undefined ? {} : { type }) }
}

const nominalDeclarationType = (
  declaration:
    | DeclarationFacts.StructFact
    | DeclarationFacts.UnionFact
    | DeclarationFacts.EnumFact
    | DeclarationFacts.ContractFact,
): Type.Nominal | undefined =>
  declaration.canonical._tag === 'Canonical'
    ? Type.nominal(
        declaration.canonical.id.module,
        declaration.canonical.id.name,
        declaration.typeParameters.map((parameter) => Type.parameterArgument(parameter.type)),
      )
    : undefined

const declaredType = (fact: DeclarationFacts.DeclaredTypeFact): Type.Type | undefined =>
  fact._tag === 'Resolved' ? fact.type : undefined

/** The static type of the receiver whose member token starts at one offset, when it is known. */
const receiverTypeAt = (
  self: FrontendSnapshot,
  module: string,
  memberStart: number,
): Type.Type | undefined => {
  const root = syntaxOf(self, module)?.root
  if (root === undefined) return undefined
  let subject: SyntaxTree.Node | undefined
  const visit = (node: SyntaxTree.Node): void => {
    if (subject !== undefined) return
    if (node.kind === 'FieldProjectionExpression') {
      const member = SyntaxTree.directToken(node, 'Identifier')
      const candidate = node.children.find(SyntaxTree.isNode)
      if (member?.span.start === memberStart && candidate !== undefined) {
        subject = candidate
        return
      }
    }
    for (const child of node.children) if (SyntaxTree.isNode(child)) visit(child)
  }
  visit(root)
  return subject === undefined
    ? undefined
    : // Facts are presented without the leading trivia a syntax node's span carries.
      anonymousExpressionAt(
        self,
        module,
        AuthoredLowering.firstSignificantStart(subject) ?? subject.span.start,
      )?.type
}

/** The receiver-bound presentation of a member reached through receiver syntax. */
const receiverMethodPresentation = (
  self: FrontendSnapshot,
  module: string,
  occurrence: SemanticOccurrence.SemanticOccurrence,
  identity: SemanticOccurrence.Identity,
): HoverPresentation | undefined => {
  if (identity._tag !== 'DeclarationIdentity') return undefined
  const declaration = declarationForIdentity(self, identity)
  if (
    declaration?._tag !== 'FunctionDeclaration' ||
    declaration.associatedMember?.receiver !== true
  )
    return undefined
  const substitution = SemanticDisplay.receiverSubstitution(
    declaration,
    receiverTypeAt(self, module, occurrence.span.start),
  )
  return hoverPresentation(
    SemanticDisplay.receiverMethod(
      declaration,
      substitution,
      module,
      NameResolution.scopeOf(self.resolution, module),
    ),
    declaredType(declaration.returnType),
  )
}

const presentationOfIdentity = (
  self: FrontendSnapshot,
  module: string,
  identity: SemanticOccurrence.Identity,
): HoverPresentation | undefined => {
  const scope = NameResolution.scopeOf(self.resolution, module)
  if (identity._tag === 'DeclarationIdentity') {
    const declaration = declarationForIdentity(self, identity)
    if (declaration?._tag === 'FunctionDeclaration')
      return hoverPresentation(
        SemanticDisplay.functionDeclaration(declaration),
        declaredType(declaration.returnType),
      )
    if (declaration?._tag === 'StructDeclaration')
      return hoverPresentation(
        SemanticDisplay.structDeclaration(declaration),
        nominalDeclarationType(declaration),
      )
    if (declaration?._tag === 'EnumDeclaration')
      return hoverPresentation(
        SemanticDisplay.enumDeclaration(declaration),
        nominalDeclarationType(declaration),
      )
    if (declaration?._tag === 'UnionDeclaration')
      return hoverPresentation(
        SemanticDisplay.unionDeclaration(declaration),
        nominalDeclarationType(declaration),
      )
    if (declaration?._tag === 'ServiceDeclaration')
      return hoverPresentation(
        SemanticDisplay.serviceDeclaration(declaration),
        nominalDeclarationType(declaration),
      )
    if (declaration?._tag === 'InterfaceDeclaration')
      return hoverPresentation(
        SemanticDisplay.serviceDeclaration(declaration),
        nominalDeclarationType(declaration),
      )
    if (declaration?._tag === 'AliasDeclaration')
      return hoverPresentation(
        SemanticDisplay.aliasDeclaration(declaration),
        declaredType(declaration.target),
      )
    if (
      declaration?._tag === 'ConstantDeclaration' ||
      declaration?._tag === 'PackageParameterDeclaration'
    )
      return hoverPresentation(
        SemanticDisplay.constantDeclaration(declaration),
        declaredType(declaration.declaredType),
      )
    return declaration?._tag === 'ForeignStaticDeclaration'
      ? hoverPresentation(
          SemanticDisplay.foreignStaticDeclaration(declaration),
          declaredType(declaration.declaredType),
        )
      : undefined
  }
  if (identity._tag === 'TypeParameterIdentity') {
    for (const headers of self.index.modules)
      for (const member of [...headers.members, ...headers.inherentImpls]) {
        const parameter = member.typeParameters.find((candidate) =>
          Type.equals(candidate.type, identity.id),
        )
        if (parameter !== undefined)
          return hoverPresentation(SemanticDisplay.typeParameter(parameter))
        if (member._tag === 'ServiceDeclaration')
          for (const operation of member.operations) {
            const operationParameter = operation.typeParameters.find((candidate) =>
              Type.equals(candidate.type, identity.id),
            )
            if (operationParameter !== undefined)
              return hoverPresentation(SemanticDisplay.typeParameter(operationParameter))
          }
      }
    return undefined
  }
  if (identity._tag === 'ParameterIdentity') {
    for (const headers of self.index.modules)
      for (const declaration of [
        ...headers.declarations,
        ...headers.services.flatMap((service) => service.operations),
      ]) {
        const parameter = declaration.parameters.find(
          (candidate) =>
            candidate.id.function.sourceId === identity.id.function.sourceId &&
            candidate.id.function.ordinal === identity.id.function.ordinal &&
            candidate.id.ordinal === identity.id.ordinal,
        )
        if (parameter !== undefined)
          return hoverPresentation(
            SemanticDisplay.parameter(parameter),
            declaredType(parameter.declaredType),
          )
      }
    return undefined
  }
  if (identity._tag === 'FieldIdentity') {
    for (const headers of self.index.modules) {
      const fields = [
        ...headers.structs.flatMap((declaration) => declaration.fields),
        ...headers.unions.flatMap((declaration) =>
          declaration.variants.flatMap((variant) => variant.fields),
        ),
      ]
      for (const field of fields)
        if (DeclarationFacts.sameFieldId(field.id, identity.id))
          return hoverPresentation(SemanticDisplay.field(field), declaredType(field.declaredType))
    }
    return undefined
  }
  // A local is found in the scope that introduces it: bodies publish scopes, never their records.
  if (identity._tag === 'BindingIdentity') {
    for (const result of self.results.values())
      for (const lexical of result.lexicalScopes) {
        const binding = lexical.bindings.find(
          (candidate) =>
            candidate.id.function.sourceId === identity.id.function.sourceId &&
            candidate.id.function.ordinal === identity.id.function.ordinal &&
            candidate.id.ordinal === identity.id.ordinal,
        )
        if (binding !== undefined)
          return hoverPresentation(
            SemanticDisplay.binding(binding, module, scope),
            binding.inferredType._tag === 'Available' ? binding.inferredType.type : undefined,
          )
      }
    return undefined
  }
  if (identity._tag === 'PatternBindingIdentity') {
    const key = SemanticOccurrence.identityKey(identity)
    for (const result of self.results.values())
      for (const lexical of result.lexicalScopes)
        for (const binding of lexical.patternBindings)
          if (
            SemanticOccurrence.identityKey({ _tag: 'PatternBindingIdentity', id: binding.id }) ===
            key
          )
            return hoverPresentation(
              SemanticDisplay.patternBinding(binding, module, scope),
              binding.type._tag === 'Available' ? binding.type.type : undefined,
            )
    return undefined
  }
  if (identity._tag === 'ImportNamespaceIdentity')
    return hoverPresentation(SemanticDisplay.importBinding(identity.spelling, identity.module))
  if (identity._tag === 'ServiceOperationIdentity') {
    const operation = serviceOperationForIdentity(self, identity)
    return operation === undefined
      ? undefined
      : hoverPresentation(
          SemanticDisplay.serviceOperation(operation),
          declaredType(operation.returnType),
        )
  }
  if (identity._tag === 'EnumMemberIdentity') {
    const enum_ = DeclarationFacts.byCanonical(self.index, identity.id.enum)
    if (enum_?._tag !== 'EnumDeclaration') return undefined
    const member = enum_.members.find(
      (candidate) =>
        candidate.canonical._tag === 'Canonical' &&
        candidate.canonical.id.name === identity.id.name,
    )
    return member === undefined
      ? undefined
      : hoverPresentation(SemanticDisplay.enumMember(enum_, member), nominalDeclarationType(enum_))
  }
  if (identity._tag === 'UnionVariantIdentity') {
    const selected = unionVariantForIdentity(self, identity)
    return selected === undefined
      ? undefined
      : hoverPresentation(
          SemanticDisplay.unionVariant(selected[0], selected[1]),
          nominalDeclarationType(selected[0]),
        )
  }
  if (identity._tag === 'EnumAssociatedOperationIdentity') {
    const enum_ = DeclarationFacts.byCanonical(self.index, identity.id.enum)
    const operation =
      enum_?._tag === 'EnumDeclaration'
        ? enum_.associatedOperations.find((candidate) => candidate.id.name === identity.id.name)
        : undefined
    return operation === undefined
      ? undefined
      : hoverPresentation(
          SemanticDisplay.enumAssociatedOperation(operation),
          operation.result.spelling,
        )
  }
  if (identity._tag === 'IntrinsicActorIdentity') {
    const intrinsic = Intrinsic.findActor(identity.id.name)
    return intrinsic === undefined
      ? undefined
      : hoverPresentation(SemanticDisplay.intrinsicActor(intrinsic))
  }
  const intrinsic = Intrinsic.findOperation(identity.id.actor, identity.id.name)
  return intrinsic === undefined
    ? undefined
    : hoverPresentation(SemanticDisplay.intrinsicOperation(intrinsic))
}

/** Lazily presents one available occurrence through declaration and scope facts. */
export const occurrencePresentation = (
  self: FrontendSnapshot,
  module: string,
  occurrence: SemanticOccurrence.SemanticOccurrence,
): SemanticDisplay.Presentation | undefined =>
  occurrence.resolution._tag === 'Available'
    ? presentationOfIdentity(self, module, occurrence.resolution.identity)?.presentation
    : undefined

const implementedContractPresentations = (
  self: FrontendSnapshot,
  module: string,
  type: Type.Type | undefined,
): ReadonlyArray<SemanticDisplay.Presentation> => {
  if (type === undefined) return []
  const scope = NameResolution.scopeOf(self.resolution, module)
  return ConformanceProof.implementedContracts(self.index, module, type).map((contract) =>
    SemanticDisplay.scopedNominal(contract, module, scope),
  )
}

/** Returns the smallest cached available anonymous expression containing one byte offset. */
export const anonymousExpressionAt = (
  self: FrontendSnapshot,
  module: string,
  offset: number,
): AnonymousExpression | undefined =>
  (self.anonymousExpressions.get(module) ?? [])
    .filter((candidate) => candidate.span.start <= offset && offset < candidate.span.end)
    .reduce<AnonymousExpression | undefined>((selected, candidate) => {
      if (selected === undefined) return candidate
      return candidate.span.end - candidate.span.start < selected.span.end - selected.span.start
        ? candidate
        : selected
    }, undefined)

/** Selects an occurrence presentation first, with anonymous expression type as a strict fallback. */
export const hoverSubjectAt = (
  self: FrontendSnapshot,
  module: string,
  offset: number,
): HoverSubject | undefined => {
  const occurrence = semanticOccurrenceAt(self, module, offset)
  if (occurrence !== undefined) {
    const answer =
      occurrence.resolution._tag === 'Available'
        ? ((occurrence.role === 'Method'
            ? receiverMethodPresentation(self, module, occurrence, occurrence.resolution.identity)
            : undefined) ?? presentationOfIdentity(self, module, occurrence.resolution.identity))
        : undefined
    return answer === undefined
      ? undefined
      : {
          _tag: 'OccurrenceHoverSubject',
          occurrence,
          presentation: answer.presentation,
          implementedContracts: implementedContractPresentations(self, module, answer.type),
        }
  }
  const expression = anonymousExpressionAt(self, module, offset)
  if (expression === undefined) return undefined
  return {
    _tag: 'ExpressionHoverSubject',
    expression,
    presentation:
      expression.presentation ??
      SemanticDisplay.expressionType(
        expression.type,
        module,
        NameResolution.scopeOf(self.resolution, module),
      ),
    implementedContracts: implementedContractPresentations(self, module, expression.type),
  }
}

/** Returns source-ordered inferred local type hints clipped to one byte range. */
export const typeHints = (
  self: FrontendSnapshot,
  module: string,
  start: number,
  end: number,
): ReadonlyArray<TypeHint.TypeHint> => {
  const scope = NameResolution.scopeOf(self.resolution, module)
  return scope === undefined
    ? []
    : TypeHint.make(
        scope.context,
        (self.results.get(module)?.bodies ?? []).flatMap((body) =>
          body.hidden ? [] : body.results.hints,
        ),
        module,
        scope,
        start,
        end,
      )
}

/** Returns deterministic recovery-aware completion for one module byte offset. */
export const completionAt = (
  self: FrontendSnapshot,
  module: string,
  offset: number,
): Completion.Result | undefined => {
  const source = self.closure.sources.get(module)
  const result = self.results.get(module)
  return source === undefined || result === undefined
    ? undefined
    : Completion.complete({
        source,
        module,
        offset,
        index: self.index,
        resolution: self.resolution,
        session: self.session,
        result,
      })
}

/** Returns every typed expression node in deterministic artifact and node order. */
export const expressionsOf = (
  self: FrontendSnapshot,
  module: string,
): ReadonlyArray<Tir.Expression> => {
  const result = self.results.get(module)
  if (result === undefined) return []
  const found = new Set<Tir.Expression>()
  for (const body of result.bodies)
    for (const statement of body.function.statements)
      for (const expression of Tir.statementExpressions(statement))
        for (const nested of Tir.expressionTree(expression)) found.add(nested)
  return [...found].sort((left, right) => (left.id?.ordinal ?? 0) - (right.id?.ordinal ?? 0))
}

/** Returns every canonical or explicitly unavailable field-projection step. */
export const fieldProjectionsOf = (
  self: FrontendSnapshot,
  module: string,
): ReadonlyArray<Extract<Tir.Expression, { readonly _tag: 'Project' }>> =>
  expressionsOf(self, module).filter(
    (expression): expression is Extract<Tir.Expression, { readonly _tag: 'Project' }> =>
      expression._tag === 'Project',
  )

/** Returns every canonical or explicitly unavailable postfix referent-projection step. */
export const referentProjectionsOf = (
  self: FrontendSnapshot,
  module: string,
): ReadonlyArray<Extract<Tir.Expression, { readonly _tag: 'ReferentPlace' }>> =>
  expressionsOf(self, module).filter(
    (expression): expression is Extract<Tir.Expression, { readonly _tag: 'ReferentPlace' }> =>
      expression._tag === 'ReferentPlace',
  )

/** Returns every retained array literal with its ordered elements and completeness state. */
export const arrayLiteralsOf = (
  self: FrontendSnapshot,
  module: string,
): ReadonlyArray<Extract<Tir.Expression, { readonly _tag: 'ArrayConstruct' }>> =>
  expressionsOf(self, module).filter(
    (expression): expression is Extract<Tir.Expression, { readonly _tag: 'ArrayConstruct' }> =>
      expression._tag === 'ArrayConstruct',
  )

/** Returns every retained indexed-place step with its canonical bounds mode. */
export const indexProjectionsOf = (
  self: FrontendSnapshot,
  module: string,
): ReadonlyArray<Extract<Tir.Expression, { readonly _tag: 'IndexPlace' | 'SliceIndexPlace' }>> =>
  expressionsOf(self, module).filter(
    (
      expression,
    ): expression is Extract<Tir.Expression, { readonly _tag: 'IndexPlace' | 'SliceIndexPlace' }> =>
      expression._tag === 'IndexPlace' || expression._tag === 'SliceIndexPlace',
  )

/** Returns canonical fixed-array types used by one module's contracts and expressions. */
export const fixedArrayTypesOf = (
  self: FrontendSnapshot,
  module: string,
): ReadonlyArray<Type.FixedArray> => {
  const found = new Map<string, Type.FixedArray>()
  const add = (type: DeclarationFacts.SemanticType): void => {
    if (!Type.isFixedArray(type)) return
    found.set(Type.key(type), type)
    add(type.element)
  }
  const headers = self.index.modules.find((candidate) => candidate.module === module)
  for (const member of headers?.members ?? []) {
    if (member._tag === 'FunctionDeclaration') {
      for (const parameter of member.parameters) {
        if (parameter.declaredType._tag === 'Resolved') add(parameter.declaredType.type)
      }
      if (member.returnType._tag === 'Resolved') add(member.returnType.type)
    } else if (member._tag === 'StructDeclaration') {
      for (const field of member.fields) {
        if (field.declaredType._tag === 'Resolved') add(field.declaredType.type)
      }
    } else if (member._tag === 'ServiceDeclaration' || member._tag === 'InterfaceDeclaration') {
      for (const operation of member.operations) {
        for (const parameter of operation.parameters)
          if (parameter.declaredType._tag === 'Resolved') add(parameter.declaredType.type)
        if (operation.returnType._tag === 'Resolved') add(operation.returnType.type)
      }
    } else if (
      (member._tag === 'ConstantDeclaration' ||
        member._tag === 'PackageParameterDeclaration' ||
        member._tag === 'ForeignStaticDeclaration') &&
      member.declaredType._tag === 'Resolved'
    ) {
      add(member.declaredType.type)
    }
  }
  for (const expression of expressionsOf(self, module)) {
    if (expression._tag !== 'Unavailable') add(expression.type)
  }
  return [...found.values()]
}

/** Returns one module's ownership facts and cleanup plans, or `undefined` for an unknown identity. */
export const ownershipOf = (
  self: FrontendSnapshot,
  module: string,
): Ownership.ModuleOwnership | undefined => self.ownership.get(module)

/** Returns the snapshot's instance discovery: entry state and ordered instances. */
export const instancesOf = (self: Snapshot): Instances.Discovery => self.instances

/** Returns normalized environment and suspension properties for every realized executable. */
export const executablePropertiesOf = (self: Snapshot): ReadonlyArray<ExecutableProperty.Fact> =>
  ExecutableProperty.derive(self.instances, self.index, Instances.callableIdentity)

/** Returns the snapshot's resolved or unavailable target selection. */
export const targetOf = (self: Snapshot): Target.Selection => self.target

/** Returns the target-selected declaration-wide nominal layout catalog. */
export const layoutCatalogOf = (self: Snapshot): Targeted<Layout.Catalog> => self.layoutCatalog

/** Looks up one nominal declaration's available or unavailable target-selected layout. */
export const nominalLayout = (
  self: Snapshot,
  type: Type.Nominal,
): Layout.CatalogEntry | undefined =>
  self.layoutCatalog._tag === 'Available'
    ? Layout.catalogEntry(self.layoutCatalog.value, type)
    : undefined

/** Returns the snapshot's available or explicitly unavailable layout plan. */
export const layoutOf = (self: Snapshot): Targeted<Layout.Plan> => self.layout

/** Returns every reachable repeated layout without asking tooling to reconstruct arrays. */
export const repeatedLayoutsOf = (self: Snapshot): ReadonlyArray<Layout.Entry> =>
  self.layout._tag === 'Available'
    ? self.layout.value.entries.filter((entry) => entry.representation._tag === 'Repeated')
    : []

/** Returns every reachable array calling shape and its canonical physical paths. */
export const arrayCallingShapesOf = (self: Snapshot): ReadonlyArray<Layout.CallingShape> =>
  self.layout._tag === 'Available'
    ? self.layout.value.callingShapes.filter((shape) => Type.isFixedArray(shape.type))
    : []

/** Returns every match-local ownership and cleanup plan in function/source order. */
export const ownershipMatchesOf = (
  self: FrontendSnapshot,
  module: string,
): ReadonlyArray<Ownership.MatchOwnership> =>
  self.ownership.get(module)?.functions.flatMap((fn) => fn.matches) ?? []

/** Returns every structured MIR match, including nested expression matches, in DAG preorder. */
export const mirMatchesOf = (
  self: Snapshot,
): ReadonlyArray<Extract<Mir.Operation, { readonly _tag: 'Match' }>> => {
  if (self.mir._tag === 'Unavailable') {
    return []
  }
  return self.mir.value.functions.flatMap((fn) =>
    MirVerification.operations(fn).flatMap((operation) =>
      operation._tag === 'Match' ? [operation] : [],
    ),
  )
}

/** Returns the snapshot's available or explicitly unavailable lowered MIR state. */
export const mirOf = (self: Snapshot): Targeted<Mir.Module> => self.mir

/** Returns the snapshot's lowered MIR program for callers that already established availability. */
export const loweredMir = (self: Snapshot): Mir.Module => {
  if (self.mir._tag === 'Available') return self.mir.value
  throw new RangeError(self.mir.error.message)
}

/** Returns deterministic shared-MIR Effect normalization decisions for tooling and cost gates. */
export const effectNormalizationOf = (self: Snapshot): ReadonlyArray<Mir.NormalizationVerdict> =>
  self.mir._tag === 'Available' ? (self.mir.value.normalization ?? []) : []

/** Looks up one declaration name within one module. */
export const declarationByName = (
  self: FrontendSnapshot,
  module: string,
  spelling: string,
): DeclarationFacts.DeclarationLookup => DeclarationFacts.lookup(self.index, module, spelling)

/** Looks up one declaration in the shared module-level namespace. */
export const memberByName = (
  self: FrontendSnapshot,
  module: string,
  spelling: string,
): DeclarationFacts.MemberLookup => DeclarationFacts.publishedMember(self.index, module, spelling)

/** Looks up one nominal scalar enum declaration. */
export const enumByName = (
  self: FrontendSnapshot,
  module: string,
  spelling: string,
): DeclarationFacts.EnumLookup => DeclarationFacts.enumByName(self.index, module, spelling)

/** Looks up one declaration-ordered member from a resolved scalar enum. */
export const enumMemberByName = (
  declaration: DeclarationFacts.EnumFact,
  spelling: string,
): DeclarationFacts.EnumMemberLookup =>
  DeclarationFacts.lookupEnumMember(declaration.members, spelling)

/** Looks up one nominal struct declaration. */
export const structByName = (
  self: FrontendSnapshot,
  module: string,
  spelling: string,
): DeclarationFacts.StructLookup => DeclarationFacts.struct(self.index, module, spelling)

/** Looks up one nominal tagged-union declaration. */
export const unionByName = (
  self: FrontendSnapshot,
  module: string,
  spelling: string,
): DeclarationFacts.UnionLookup => DeclarationFacts.unionByName(self.index, module, spelling)

/** Looks up one declaration-ordered variant from a resolved nominal union. */
export const unionVariantByName = (
  declaration: DeclarationFacts.UnionFact,
  spelling: string,
): DeclarationFacts.UnionVariantLookup =>
  DeclarationFacts.lookupUnionVariant(declaration.variants, spelling)

/** Looks up one declaration-ordered field within a resolved nominal-union variant. */
export const unionVariantFieldByName = (
  variant: DeclarationFacts.UnionVariantFact,
  spelling: string,
): DeclarationFacts.FieldLookup => DeclarationFacts.lookupField(variant.fields, spelling)

/** Looks up one declaration-ordered field from a resolved nominal struct. */
export const fieldByName = (
  declaration: DeclarationFacts.StructFact,
  spelling: string,
): DeclarationFacts.FieldLookup => DeclarationFacts.lookupField(declaration.fields, spelling)

/** The compilation's complete diagnostic sequence in deterministic driver order. */
export const diagnostics = (self: FrontendSnapshot): ReadonlyArray<Diagnostic.Diagnostic> =>
  self.diagnostics

/** Returns immutable operational observations for exactly the phases that produced this snapshot. */
export const phases = (self: FrontendSnapshot): ReadonlyArray<PhaseReport.PhaseReport> =>
  self.report

/** Analysis orchestration options; verification is independent of backend emission. */
export interface CodegenRequest extends Backend.CodegenRequest {
  /** Run the optional compiler-invariant audit before emission. Defaults to false. */
  readonly verifyMir?: boolean
}

/** Emits the snapshot's lowered program through LLVM. */
/** What backend emission reads from a realized program; editor indexes are not part of it. */
export type CodegenInput = Pick<
  Snapshot,
  'closure' | 'diagnostics' | 'instances' | 'mir' | 'profile' | 'target'
>

export const codegen = Effect.fn('Analysis.codegen')(function* (
  self: CodegenInput,
  request: CodegenRequest,
): Effect.fn.Return<
  Backend.LlvmBitcodeArtifact,
  | Backend.BackendError
  | MirVerification.MirVerificationError
  | Target.TargetError
  | AnalysisUnavailable
  | CodegenUnavailable
> {
  if (Diagnostic.hasErrors(self.diagnostics) || self.closure.resolutionFailures.length > 0) {
    return yield* new CodegenUnavailable({
      operation: 'Analysis.codegen',
      message: 'Backend emission is unavailable for an invalid analysis snapshot',
      diagnostics: self.diagnostics,
      resolutionFailures: self.closure.resolutionFailures,
    })
  }
  const selected = LlvmBackend.LlvmBackend
  if (self.mir._tag === 'Unavailable') return yield* self.mir.error
  if (request.verifyMir === true) yield* MirVerification.check(self.mir.value)
  const availability = IntrinsicAvailability.select(
    self.instances.intrinsics,
    self.mir.value.layout.target,
  )
  if (availability._tag === 'Unavailable') {
    return yield* new CodegenUnavailable({
      operation: 'Analysis.codegen',
      message: `${selected.name} cannot emit a program with unavailable intrinsics`,
      diagnostics: Diagnostic.merge(self.diagnostics, availability.diagnostics),
      resolutionFailures: self.closure.resolutionFailures,
    })
  }
  const foreign =
    self.target._tag === 'Resolved'
      ? ForeignAvailability.select(
          self.instances.foreignCalls,
          self.target.target,
          self.mir.value.foreignStatics,
          ForeignAvailability.callbackAddresses(self.mir.value),
          ForeignAvailability.staticLoads(self.mir.value),
        )
      : []
  if (foreign.length > 0) {
    return yield* new CodegenUnavailable({
      operation: 'Analysis.codegen',
      message: `${selected.name} cannot emit a program with unavailable foreign functions`,
      diagnostics: Diagnostic.merge(self.diagnostics, foreign),
      resolutionFailures: self.closure.resolutionFailures,
    })
  }
  const planning = ForeignPlanning.check(self.mir.value, self.mir.value.layout.target)
  if (planning.length > 0) {
    return yield* new CodegenUnavailable({
      operation: 'Analysis.codegen',
      message: `${selected.name} cannot emit a program with unplannable native exports`,
      diagnostics: Diagnostic.merge(self.diagnostics, planning),
      resolutionFailures: self.closure.resolutionFailures,
    })
  }
  if (
    request.support &&
    (self.profile === undefined ||
      self.profile.artifact !== 'object' ||
      self.profile.entry.kind !== 'none' ||
      self.profile.runtime.kind !== 'none' ||
      self.profile.libc !== 'none' ||
      self.profile.sanitizers.length !== 0 ||
      self.profile.unwind !== 'none')
  ) {
    return yield* new Backend.BackendError({
      operation: 'Backend.emit',
      backend: 'LLVM',
      message:
        'Support compilation requires an object-only, no-entry, no-runtime, no-libc profile without sanitizers or unwind',
      reason: { _tag: 'UnsupportedMir', detail: 'Invalid support profile' },
    })
  }
  const { verifyMir: _verifyMir, ...emission } = request
  return yield* Backend.emit(selected, self.mir.value, {
    ...emission,
    sources:
      request.sources ??
      new Map(
        self.closure.modules.map((module) => [module.name, module.syntax.source.bytes.slice()]),
      ),
  })
})
