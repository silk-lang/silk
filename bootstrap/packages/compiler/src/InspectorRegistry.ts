/**
 * What a pane can show.
 *
 * Panes are keyed by an instance id rather than by phase, so the same phase can be open more than
 * once — two MIR panes side by side is a legitimate thing to want when comparing presets. The
 * phase a pane renders is therefore pane *parameters*, not pane identity.
 *
 * A view now returns rows plus a little header material rather than arbitrary markup. That is
 * what makes the 22px pane header possible: the header needs the pane's meta (`39/48`, `2 fn`,
 * `1 err`) and optional one-line fact strip, and only the view knows them.
 */

import * as Analysis from './Analysis.js'
import * as MirLinearization from './MirLinearization.js'
import * as Elaboration from './Elaboration.js'
import * as Tir from './Tir.js'
import { projectDataFlow } from './InspectorFlowModel.js'
import * as Diagnostic from './Diagnostic.js'
import * as SemanticContext from './SemanticContext.js'
import { backendEmission, toolchainCommands } from './InspectorPanels.js'
import {
  artifactPlanRows,
  arrayValueRows,
  backendControlRows,
  backendTextRows,
  closureRows,
  indexRows,
  instanceRows,
  layoutRows,
  mirRows,
  ownershipRows,
  pipelineRows,
  resolutionRows,
  structValueRows,
  symbolRows,
  toolchainRows,
} from './InspectorProjectBackend.js'
import {
  diagnosticCounts,
  diagnosticEntries,
  diagnosticRows,
  flowRows,
  tirRows,
  tokenRows,
  treeRows,
} from './InspectorProjectSyntax.js'
import type { RowModel } from './InspectorRow.js'
import * as MirVerification from './MirVerification.js'
import type * as SyntaxFile from './SyntaxFile.js'
import * as ToolchainPlan from './ToolchainPlan.js'

/** The root module's retained syntax view, which only the syntax panels read. */
const rootSyntax = (snapshot: Analysis.FrontendSnapshot): SyntaxFile.SyntaxFile => {
  const module = snapshot.closure.modules.find(
    (candidate) => candidate.name === snapshot.closure.rootModule,
  )
  if (module === undefined)
    throw new RangeError(`Snapshot lost its root module ${snapshot.closure.rootModule}`)
  return module.syntax
}

export const viewIds = [
  'source',
  'diagnostics',
  'tokens',
  'tree',
  'flow',
  'closure',
  'index',
  'resolution',
  'tir',
  'struct-values',
  'array-values',
  'ownership',
  'instances',
  'layout',
  'mir',
  // LLVM emission is one target-aware view of the selected program.
  'backend',
  'toolchain',
  'pipeline',
] as const

export type ViewId = (typeof viewIds)[number]

/** One cell of a pane's optional 19px fact strip. */
export interface Fact {
  readonly text: string
  readonly tone?: 'symbol' | 'ok' | 'warning' | 'muted' | undefined
}

/** Everything a view needs to render. Built once per source edit and shared by every pane. */
export interface ViewContext {
  readonly snapshot: Analysis.Snapshot
  /** Every module represented by `snapshot`, keyed by module name. */
  readonly modules: Readonly<Record<string, string>>
  /** Which module the request is rooted at — the entry the driver starts from. */
  readonly root: string
  readonly mode: 'release' | 'debug'
  readonly profile: ToolchainPlan.OptimizationProfile
  /** Pane-local view state, keyed by pane id — the CST filter and trivia toggle live here. */
  readonly filter: string
  readonly showTrivia: boolean
}

/** What a view hands back to its pane. */
export interface ViewResult {
  readonly rows: ReadonlyArray<RowModel>
  /** Right-aligned in the pane header: `39/48`, `2 fn`, `1 err`. */
  readonly meta?: string | undefined
  readonly facts?: ReadonlyArray<Fact> | undefined
  /** Set when the phase produced nothing, and says which phase broke and why. */
  readonly unavailable?: string | undefined
}

export interface ViewDefinition {
  readonly id: ViewId
  readonly title: string
  readonly phase: string
  /** Three-letter code for the picker menu and the span bar. */
  readonly tag: string
  /** Panes in the same group offer each other as one-click sibling tabs. */
  readonly group: string
  readonly hasFilter?: boolean
  readonly project: (context: ViewContext) => ViewResult
}

const noRows: ReadonlyArray<RowModel> = []

/** Ordered roughly the way the compiler runs its phases. */
export const views: ReadonlyArray<ViewDefinition> = [
  {
    id: 'source',
    title: 'Source',
    phase: 'input',
    tag: 'SRC',
    group: 'input',
    // The editor is the one bespoke body; the pane renders a textarea instead of rows.
    project: () => ({ rows: noRows }),
  },
  {
    id: 'tokens',
    title: 'Tokens',
    phase: 'syntax',
    tag: 'TOK',
    group: 'syntax',
    hasFilter: true,
    project: ({ snapshot, showTrivia, filter }) => {
      const syntax = rootSyntax(snapshot)
      const rows = tokenRows(syntax, showTrivia, filter)
      return { rows, meta: `${rows.length}/${syntax.tokens.length}` }
    },
  },
  {
    id: 'tree',
    title: 'Concrete tree',
    phase: 'syntax',
    tag: 'CST',
    group: 'syntax',
    hasFilter: true,
    project: ({ snapshot, showTrivia, filter }) => {
      const syntax = rootSyntax(snapshot)
      const rows = treeRows(syntax, showTrivia, filter)
      const missing = rows.filter((row) => row.dot === 'missing').length
      return {
        rows,
        meta: missing === 0 ? `${rows.length}` : `${rows.length} · ${missing} missing`,
      }
    },
  },
  {
    id: 'closure',
    title: 'Module closure',
    phase: 'modules',
    tag: 'MOD',
    group: 'modules',
    project: ({ snapshot }) => {
      const closure = snapshot.closure
      return {
        rows: closureRows(closure, SemanticContext.fromModules(closure.modules)),
        meta: `${closure.modules.length} mod`,
      }
    },
  },
  {
    id: 'index',
    title: 'Declaration index',
    phase: 'headers',
    tag: 'IDX',
    group: 'modules',
    project: ({ snapshot }) => {
      const index = Analysis.declarationIndex(snapshot)
      const spans = SemanticContext.fromModules(snapshot.closure.modules)
      const declarations = index.modules.reduce((total, module) => total + module.members.length, 0)
      return {
        rows: indexRows(index, spans),
        meta: `${declarations} decl`,
      }
    },
  },
  {
    id: 'resolution',
    title: 'Name resolution',
    phase: 'names',
    tag: 'NAM',
    group: 'names',
    project: ({ snapshot }) => {
      const resolution = Analysis.nameResolution(snapshot)
      const spans = resolution.contexts
      const bindings = resolution.modules.reduce((total, scope) => total + scope.bindings.length, 0)
      return {
        rows: resolutionRows(resolution, spans),
        meta: `${bindings} bind`,
      }
    },
  },
  {
    id: 'tir',
    title: 'Typed TIR',
    phase: 'elaboration',
    tag: 'TIR',
    group: 'semantics',
    project: ({ snapshot }) => {
      const tir = Analysis.rootAnalysis(snapshot).tir
      const conversions = (snapshot.results.get(snapshot.closure.rootModule)?.tir.functions ?? [])
        .flatMap((fn) => fn.statements.flatMap(Tir.statementExpressions))
        .flatMap(Tir.expressionTree)
        .filter((expression) => expression._tag === 'UnionConvert')
      return {
        rows: tirRows(tir, SemanticContext.fromModules(snapshot.closure.modules)),
        facts:
          conversions.length === 0
            ? undefined
            : [{ text: `${conversions.length} union conversion`, tone: 'symbol' }],
        meta: `${tir.functions.length} fn${conversions.length === 0 ? '' : ` · ${conversions.length} union`}`,
      }
    },
  },
  {
    id: 'flow',
    title: 'Data flow',
    phase: 'semantics',
    tag: 'FLO',
    group: 'semantics',
    /**
     * Value flow is the one view about *relationships* rather than about a tree: which argument
     * binds to which parameter and how values move through the statically selected operations.
     */
    project: ({ snapshot }) => {
      const flow = projectDataFlow(Analysis.rootAnalysis(snapshot))
      if (flow.status === 'Empty') {
        return { rows: noRows, unavailable: `No value path — ${flow.summary}` }
      }
      return {
        rows: flowRows(flow),
        meta: flow.status.toLowerCase(),
      }
    },
  },
  {
    id: 'struct-values',
    title: 'Struct values',
    phase: 'elaboration + ABI',
    tag: 'STR',
    group: 'semantics',
    /**
     * One aggregate story in one pane: literal field mappings (source order vs canonical order),
     * projection chains, and compiler-owned scalar calling shapes.
     */
    project: ({ snapshot, root }) => {
      const literals = Analysis.expressionsOf(snapshot, root).filter(
        (expression): expression is Extract<Tir.Expression, { readonly _tag: 'Construct' }> =>
          expression._tag === 'Construct',
      )
      const projections = Analysis.fieldProjectionsOf(snapshot, root)
      const layout = Analysis.layoutOf(snapshot)
      const shapes = layout._tag === 'Available' ? layout.value.callingShapes : []
      return {
        rows: structValueRows(snapshot.index, literals, projections, shapes),
        meta: `${literals.length} lit · ${projections.length} proj`,
      }
    },
  },
  {
    id: 'array-values',
    title: 'Array values',
    phase: 'elaboration + layout',
    tag: 'ARR',
    group: 'semantics',
    project: ({ snapshot, root }) => {
      const types = Analysis.fixedArrayTypesOf(snapshot, root)
      const literals = Analysis.arrayLiteralsOf(snapshot, root)
      const projections = Analysis.indexProjectionsOf(snapshot, root)
      return {
        rows: arrayValueRows(
          SemanticContext.fromModules(snapshot.closure.modules),
          types,
          literals,
          projections,
          Analysis.repeatedLayoutsOf(snapshot),
          Analysis.arrayCallingShapesOf(snapshot),
        ),
        meta: `${literals.length} lit · ${projections.length} index`,
      }
    },
  },
  {
    id: 'ownership',
    title: 'Ownership + cleanup',
    phase: 'ownership',
    tag: 'OWN',
    group: 'semantics',
    project: ({ snapshot }) => {
      const facts = Analysis.ownershipOf(snapshot, snapshot.closure.rootModule)
      if (facts === undefined) {
        return {
          rows: noRows,
          unavailable: 'Ownership unavailable — the root module did not elaborate',
        }
      }
      const matches = Analysis.ownershipMatchesOf(snapshot, snapshot.closure.rootModule)
      const loans = facts.functions.reduce((total, fn) => total + fn.loans.length, 0)
      const summaryFacts: Array<Fact> = []
      if (matches.length > 0) {
        summaryFacts.push({ text: `${matches.length} match lifetime`, tone: 'symbol' })
      }
      if (loans > 0) summaryFacts.push({ text: `${loans} lexical loan`, tone: 'symbol' })
      return {
        rows: ownershipRows(facts, SemanticContext.fromModules(snapshot.closure.modules)),
        facts: summaryFacts.length === 0 ? undefined : summaryFacts,
        meta: `${facts.functions.length} fn${matches.length === 0 ? '' : ` · ${matches.length} match`}${loans === 0 ? '' : ` · ${loans} loan`}`,
      }
    },
  },
  {
    id: 'instances',
    title: 'Instances',
    phase: 'discovery',
    tag: 'INS',
    group: 'discovery',
    project: ({ snapshot }) => {
      const discovery = Analysis.instancesOf(snapshot)
      return {
        rows: [
          ...instanceRows(discovery, SemanticContext.fromModules(snapshot.closure.modules)),
          ...artifactPlanRows(snapshot.artifactPlan),
        ],
        meta: `${discovery.instances.length} inst`,
      }
    },
  },
  {
    id: 'layout',
    title: 'Target layout',
    phase: 'layout',
    tag: 'LAY',
    group: 'backend',
    project: ({ snapshot }) => {
      const catalog = Analysis.layoutCatalogOf(snapshot)
      const plan = Analysis.layoutOf(snapshot)
      const target = Analysis.targetOf(snapshot)
      const unions =
        plan._tag === 'Available'
          ? plan.value.entries.filter((entry) => entry.representation._tag === 'Union')
          : []
      const slices =
        plan._tag === 'Available'
          ? plan.value.entries.filter((entry) => entry.representation._tag === 'Slice')
          : []
      const rows = layoutRows(
        catalog._tag === 'Available' ? catalog.value : undefined,
        plan._tag === 'Available' ? plan.value : undefined,
        plan._tag === 'Available' ? undefined : plan.error.message,
      )
      const facts: Array<Fact> = []
      if (target._tag === 'Resolved') {
        facts.push(
          { text: target.target.id },
          {
            text: `${target.target.endianness} endian · ptr ${target.target.pointerSize} B`,
            tone: 'muted',
          },
        )
        if (unions.length > 0) {
          facts.push({ text: `${unions.length} sum layout`, tone: 'symbol' })
        }
        if (slices.length > 0) {
          facts.push({ text: `${slices.length} slice layout`, tone: 'symbol' })
        }
      } else {
        facts.push({ text: 'target unavailable', tone: 'warning' })
      }
      return { rows, facts, meta: plan._tag === 'Available' ? `${plan.value.entries.length}` : '—' }
    },
  },
  {
    id: 'mir',
    title: 'Control DAG',
    phase: 'lowering',
    tag: 'MIR',
    group: 'backend',
    // Lowering is target-aware, so MIR is absent whenever the target did not resolve; the pane
    // says which failure it was rather than rendering an empty graph.
    project: ({ snapshot }) => {
      const mir = Analysis.mirOf(snapshot)
      if (mir._tag !== 'Available') {
        return { rows: noRows, unavailable: `MIR unavailable — ${mir.error.message}` }
      }
      const regions = mir.value.functions.reduce((total, fn) => total + fn.regions.length, 0)
      const conversions = mir.value.functions
        .flatMap(MirVerification.operations)
        .filter((operation) => operation._tag === 'ConvertUnion')
      const matches = Analysis.mirMatchesOf(snapshot)
      const normalization = Analysis.effectNormalizationOf(snapshot)
      const normalized = normalization.filter((verdict) => verdict._tag === 'Normalized')
      const rejected = normalization.length - normalized.length
      const summaryFacts: Array<Fact> = []
      if (matches.length > 0) {
        summaryFacts.push({ text: `${matches.length} structured match`, tone: 'symbol' })
      }
      if (conversions.length > 0) {
        summaryFacts.push({ text: `${conversions.length} ConvertUnion`, tone: 'symbol' })
      }
      if (normalized.length > 0) {
        summaryFacts.push({ text: `${normalized.length} Effect normalization`, tone: 'symbol' })
      }
      if (rejected > 0) {
        summaryFacts.push({ text: `${rejected} normalization guard`, tone: 'warning' })
      }
      return {
        rows: mirRows(mir.value),
        facts: summaryFacts.length === 0 ? undefined : summaryFacts,
        meta: `${mir.value.functions.length} fn · ${regions} region${regions === 1 ? '' : 's'}${matches.length === 0 ? '' : ` · ${matches.length} match`}${conversions.length === 0 ? '' : ` · ${conversions.length} union`}${normalized.length === 0 ? '' : ` · ${normalized.length} normalized`}`,
      }
    },
  },
  {
    id: 'backend',
    title: 'Backend output',
    phase: 'backend',
    tag: 'IR',
    group: 'backend',
    project: ({ snapshot, mode }) => {
      const emission = backendEmission(snapshot, mode)
      if (emission._tag === 'Rejected') {
        return {
          rows: noRows,
          facts: [{ text: 'Rejected', tone: 'warning' }],
          unavailable: `Emission rejected — ${emission.message}`,
        }
      }
      const artifact = emission.artifact
      const bytes = artifact.bitcode
      const text = artifact.ir

      return {
        rows: [
          ...symbolRows(artifact.symbols),
          // Emission succeeded, so the snapshot's lowered MIR is available.
          ...backendControlRows(MirLinearization.llvmControl(Analysis.loweredMir(snapshot))),
          ...backendTextRows(text),
        ],
        facts: [
          ...artifact.symbols.slice(0, 2).map((entry): Fact => ({
            text: `${entry.symbol} → ${entry.declaration.module}.${entry.declaration.name}`,
            tone: 'symbol',
          })),
          {
            text: `${artifact.backend} · ${bytes.length} B · ${mode}`,
            tone: 'muted',
          },
        ],
        meta: `${bytes.length} B`,
      }
    },
  },
  {
    id: 'toolchain',
    title: 'Toolchain (planned)',
    phase: 'native',
    tag: 'TCH',
    group: 'backend',
    project: ({ snapshot }) => {
      const commands = toolchainCommands(snapshot)
      if (commands._tag === 'Unavailable') {
        return { rows: noRows, unavailable: `Toolchain unavailable — ${commands.message}` }
      }
      return {
        rows: toolchainRows(commands.commands),
        facts: [
          { text: `clang · ${commands.target} · ${snapshot.profile?.optimization}`, tone: 'muted' },
        ],
        meta: `${commands.commands.length} cmd`,
      }
    },
  },
  {
    id: 'pipeline',
    title: 'Pipeline',
    phase: 'all phases',
    tag: 'PIP',
    group: 'all',
    /**
     * How far the program got, one row per phase.
     *
     * Every other view is about a phase; this one is about the pipeline, which is why it is worth
     * a pane of its own — it is the fastest way to see which phase a program died in before
     * opening the pane that explains why.
     */
    project: ({ snapshot, profile }) => {
      const analysis = Analysis.rootAnalysis(snapshot)
      const discovery = Analysis.instancesOf(snapshot)
      const layout = Analysis.layoutOf(snapshot)
      const mir = Analysis.mirOf(snapshot)
      const ownership = Analysis.ownershipOf(snapshot, snapshot.closure.rootModule)
      const emission = backendEmission(snapshot, ToolchainPlan.codegenModeFor(profile))
      const countFor = (phase: string): number =>
        Analysis.diagnostics(snapshot).filter((diagnostic) => diagnostic.phase === phase).length

      let backendOutputs = 'emission rejected'
      if (emission._tag === 'Emitted') {
        backendOutputs = `${emission.artifact.bitcode.length} bitcode bytes`
      }

      const phases = [
        {
          phase: 'syntax (lex + parse)',
          outputs: `${rootSyntax(snapshot).tokens.length} tokens · ${Elaboration.sourceBodyCount(analysis)} declarations`,
          diagnostics: countFor('lexical') + countFor('parser'),
        },
        {
          phase: 'module closure',
          outputs: `${Analysis.modules(snapshot).length} modules · ${
            Analysis.cycles(snapshot).length
          } cycles`,
          diagnostics: countFor('module'),
        },
        {
          phase: 'declaration index',
          outputs: `${Analysis.declarationIndex(snapshot).modules.reduce(
            (sum, module) => sum + module.members.length,
            0,
          )} headers`,
          diagnostics: 0,
        },
        {
          phase: 'name resolution',
          outputs: `${Analysis.nameResolution(snapshot).modules.reduce(
            (sum, module) => sum + module.bindings.length,
            0,
          )} bindings`,
          diagnostics: countFor('semantic'),
        },
        {
          phase: 'elaboration (TIR)',
          outputs: `${analysis.tir.functions.length} typed functions`,
          diagnostics: 0,
        },
        {
          phase: 'ownership + cleanup',
          outputs: `${ownership?.functions.length ?? 0} checked functions`,
          diagnostics: countFor('ownership'),
        },
        {
          phase: 'instance discovery',
          outputs: `${discovery.instances.length} instances`,
          diagnostics: 0,
        },
        {
          phase: 'target layout',
          outputs:
            layout._tag === 'Available'
              ? `${layout.value.target.id} · ${layout.value.entries.length} runtime entries`
              : layout.error.message,
          diagnostics: countFor('layout'),
        },
        {
          phase: 'MIR lowering',
          outputs:
            mir._tag === 'Available'
              ? `${mir.value.functions.length} lowered functions`
              : mir.error.message,
          diagnostics: 0,
        },
        {
          phase: 'backend',
          outputs: backendOutputs,
          diagnostics: countFor('backend'),
        },
        { phase: 'native toolchain', outputs: 'object · runtime · link', diagnostics: 0 },
      ]

      const blocked = phases.filter((entry) => entry.diagnostics > 0).length
      return {
        rows: pipelineRows(phases),
        meta: blocked === 0 ? `${phases.length} phases` : `${blocked} blocked`,
      }
    },
  },
  {
    id: 'diagnostics',
    title: 'Diagnostics',
    phase: 'all phases',
    tag: 'DX',
    group: 'all',
    project: ({ snapshot }) => {
      const analysis = Analysis.rootAnalysis(snapshot)
      const syntax = rootSyntax(snapshot)
      const entries = diagnosticEntries(
        syntax.lexicalDiagnostics,
        syntax.parserDiagnostics,
        Diagnostic.publishAll(
          analysis.diagnostics,
          SemanticContext.fromModules(snapshot.closure.modules),
        ),
      )
      const counts = diagnosticCounts(entries)
      return {
        rows: diagnosticRows(entries),
        meta: counts.errors === 0 ? 'clean' : `${counts.errors} err`,
      }
    },
  },
]

const byId: ReadonlyMap<string, ViewDefinition> = new Map(views.map((view) => [view.id, view]))

export const viewById = (id: string): ViewDefinition | undefined => byId.get(id)

/** Sibling phases offered as one-click tabs in a pane header. */
export const siblingsOf = (view: ViewDefinition): ReadonlyArray<ViewDefinition> =>
  views
    .filter((candidate) => candidate.group === view.group && candidate.id !== view.id)
    .slice(0, 2)
