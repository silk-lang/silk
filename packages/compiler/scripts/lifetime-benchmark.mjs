import * as Layer from 'effect/Layer'
import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as Console from 'effect/Console'
import * as Data from 'effect/Data'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as Analysis from '../dist/Analysis.js'
import * as CleanupPlan from '../dist/CleanupPlan.js'
import * as Elaboration from '../dist/Elaboration.js'
import * as Lifetime from '../dist/Lifetime.js'
import * as Instances from '../dist/Instances.js'
import * as Residualization from '../dist/Residualization.js'
import * as ResidualOwnership from '../dist/ResidualOwnership.js'
import * as StaticValue from '../dist/StaticValue.js'
import * as Target from '../dist/Target.js'
import * as MovePath from '../dist/MovePath.js'
import * as MirVerification from '../dist/MirVerification.js'
import * as NominalVariance from '../dist/NominalVariance.js'
import * as Ownership from '../dist/Ownership.js'
import * as ProjectAnalysis from '../dist/ProjectAnalysis.js'
import * as ResolutionWork from '../dist/ResolutionWork.js'
import * as SourceFile from '../dist/SourceFile.js'
import * as SourceResolver from '../dist/SourceResolver.js'
import * as Type from '../dist/Type.js'
import * as TypeCompatibility from '../dist/TypeCompatibility.js'
import * as TypeOutlives from '../dist/TypeOutlives.js'

class BenchmarkError extends Data.TaggedError('BenchmarkError') {
  /** @param {{ message: string, cause?: unknown }} details */
  constructor(details) {
    super(details)
  }
}
const bytes = (text) => Uint8Array.from(text, (character) => character.charCodeAt(0))
const range = (size) => Array.from({ length: size }, (_, ordinal) => ordinal)
const sumWork = (values) => {
  const sums = {}
  for (const value of values)
    for (const [key, count] of Object.entries(value ?? {}))
      if (typeof count === 'number') sums[key] = (sums[key] ?? 0) + count
  return sums
}

const generators = {
  effectComposition: (size, invalid = false) => ({
    dimensions: { compositionDepth: size },
    invalid,
    source: `effect fn step0<'a>(value: &'a i32) -> &'a i32 { return value }
${range(size)
  .map(
    (i) => `effect fn step${i + 1}<'a>(value: &'a i32) -> &'a i32 { return run step${i}(value) }`,
  )
  .join('\n')}
pub fn main() -> i32 { let value = 42 let result = run step${size}(&value) ${invalid ? 'drop value' : ''} return result.* }`,
  }),
  effectCallbacks: (size, invalid = false) => ({
    dimensions: { callbackApplications: size, binderWidth: 1 },
    invalid,
    source: `import silk.effect { Effect }
effect fn start<'a>(value: &'a i32) -> &'a i32 { return value }
fn identity<'a>(value: &'a i32) -> &'a i32 { return value }
pub fn main() -> i32 { let value = 42 let e0 = start(&value)
${range(size)
  .map((i) => `let e${i + 1} = Effect.map(e${i}, identity)`)
  .join('\n')}
let result = run e${size} ${invalid ? 'drop value' : ''} return result.* }`,
  }),
  effectProviders: (size, invalid = false) => ({
    dimensions: { forwardingDepth: size, selectedProviders: 1 },
    invalid,
    source: `import silk.effect { Effect }
service Clock { effect fn now() -> i32 ? &Clock }
struct Fixed { value: i32 }
impl Clock for Fixed { effect fn now(self: &Self) -> i32 { return self.value } }
effect fn step0<'a>(value: &'a i32) -> &'a i32 ? &Clock { let tick = run Clock.now() return value }
${range(size)
  .map(
    (i) =>
      `effect fn step${i + 1}<'a>(value: &'a i32) -> &'a i32 ? &Clock { return run step${i}(value) }`,
  )
  .join('\n')}
pub fn main() -> i32 { let value = 42 let provider = Fixed { value: 0 }
let pending = Effect.provide(step${size}(&value), &provider) ${invalid ? 'drop provider' : ''}
let result = run pending return result.* }`,
  }),
  partialSuspension: (size, invalid = false) => ({
    dimensions: { conditionalFields: size, suspensionPoints: 1 },
    invalid,
    source: `import silk.ownership {Drop}
struct Token { value: i32 }
impl Drop for Token { fn drop(self: &mut Token) -> () { return () } }
struct Record { ${range(size)
      .map((i) => `f${i}: Token`)
      .join(' ')} }
effect fn delayed(value: i32) -> i32 { return run Intrinsic.suspendEffect(effect { return value }) }
effect fn body(flag: bool) -> i32 {
let record = Record { ${range(size)
      .map((i) => `f${i}: Token { value: ${i} }`)
      .join(', ')} }
${range(size)
  .map((i) => `if flag { let taken${i} = move record.f${i} drop taken${i} }`)
  .join('\n')}
let result = run delayed(42) ${invalid ? 'let missing = record.f0.value' : ''} drop record return result }
pub fn main() -> i32 { return run body(true) }`,
  }),

  exclusiveChains: (size, invalid = false) => ({
    dimensions: { exclusiveReborrowDepth: size, sharedChildCopies: 1 },
    invalid,
    source: `struct Holder<'a> { value: &'a mut i32 }
fn inspect(value: &mut i32) -> i32 {
  let h0 = Holder { value: &mut value.* }
${range(size)
  .map((index) => `let h${index + 1} = Holder { value: &mut h${index}.value.* }`)
  .join('\n')}
  let child = &h${size}.value.* let copied = child drop child
  ${invalid ? 'value.* = 0' : ''}
  let result = copied.* drop copied
${range(size + 1)
  .reverse()
  .map((index) => `drop h${index}`)
  .join('\n')}
  value.* = result return result
}`,
  }),
  dependentCleanup: (size) => ({
    dimensions: { recursiveTypeComponent: size, dependentHooks: size },
    source: `import silk.ownership
${range(size)
  .map(
    (index) => `struct N${index}<'a> { next: &'a mut N${(index + 1) % size}<'a> }
impl<'a> ownership.Drop for N${index}<'a> { fn drop(self: &mut N${index}<'a>) -> () { return () } }
fn consume${index}<'a>(value: N${index}<'a>) { drop value }`,
  )
  .join('\n')}`,
  }),
  exclusiveReplacements: (size, invalid = false) => ({
    dimensions: { replacements: size, genericTypeComparisons: size },
    invalid,
    source: `import silk.ownership {Drop}
struct Guard<'a> { value: &'a mut i32 }
impl<'a> Drop for Guard<'a> { fn drop(self: &mut Guard<'a>) -> () { return () } }
fn inspect<'a, 'b>(slot: &mut Guard<'a>, incoming: Guard<${invalid ? "'b" : "'a"}>) {
${range(size)
  .map(
    (index) =>
      `let next${index} = Intrinsic.replace(slot.*, move ${index === 0 ? 'incoming' : `next${index - 1}`})`,
  )
  .join('\n')}
}`,
  }),
  dependentPartial: (size) => ({
    dimensions: { dependentFields: size, independentlyJoinedFields: size },
    source: `import silk.ownership {Drop}
struct Guard<'a> { value: &'a mut i32 }
impl<'a> Drop for Guard<'a> { fn drop(self: &mut Guard<'a>) -> () { return () } }
struct Record<'a> { ${range(size)
      .map((index) => `f${index}: Guard<'a>`)
      .join(' ')} }
fn inspect<'a>(record: Record<'a>, ${range(size)
      .map((index) => `b${index}: bool`)
      .join(', ')}) {
${range(size)
  .map((index) => `if b${index} { drop record.f${index} }`)
  .join('\n')}
drop record }`,
  }),
  wrappers: (size) => ({
    dimensions: { wrapperDepth: size },
    source: `struct W0<'a> { value: &'a i32 }\n${range(size)
      .map((index) => `struct W${index + 1}<'a> { inner: W${index}<'a> }`)
      .join('\n')}
fn read<'a>(value: W${size}<'a>) -> i32 { return value.${'inner.'.repeat(size)}value.* }`,
  }),
  unions: (size) => ({
    dimensions: { unionWidth: size, independentUnions: 1 },
    source: `union Choice<'a> { ${range(size)
      .map((index) => `V${index} { value: &'a i32 }`)
      .join(', ')} }
fn keep<'a>(value: Choice<'a>) -> Choice<'a> { return move value }`,
  }),
  loans: (size, invalid = false) => ({
    dimensions: { liveLoans: size, invalidations: invalid ? 1 : 0 },
    invalid,
    source: `fn inspect() -> i32 {
${range(size)
  .map((index) => `let mut v${index} = ${index}\nlet r${index} = &v${index}`)
  .join('\n')}
${invalid ? 'v0 = 100' : ''}
return ${range(size)
      .map((index) => `r${index}.*`)
      .join(' + ')} }`,
  }),
  storedResets: (size) => ({
    dimensions: { consecutiveBorrowedFieldResets: size, oldSourceMutations: size },
    source: `struct Holder<'a> { value: &'a [i32] }
fn read(value: &Holder) -> i32 { return value.value[0] }
fn inspect() -> i32 { let mut source0 = [0] let mut holder = Holder { value: &source0 }
${range(size)
  .map(
    (index) =>
      `let mut source${index + 1} = [${index + 1}] holder.value = &source${index + 1} source${index} = [0]`,
  )
  .join('\n')}
return read(&holder) }`,
  }),
  loanBackedges: (size) => ({
    dimensions: { loopCarriedLoans: size, loopBodies: 1, sourceInvalidations: 1 },
    invalid: true,
    source: `fn inspect() -> i32 {
${range(size)
  .map((index) => `let mut source${index} = ${index} let r${index} = &source${index}`)
  .join('\n')}
let mut sum = 0 while sum < 2 { sum = ${range(size)
      .map((index) => `r${index}.*`)
      .join(' + ')} source0 = 100 }
return sum }`,
  }),
  reborrows: (size) => ({
    dimensions: { reborrowDepth: size },
    source: `fn inspect(value: i32) -> i32 { let r0 = &value
${range(size)
  .map((index) => `let r${index + 1} = &r${index}.*`)
  .join('\n')}
return r${size}.* }`,
  }),
  recursive: (size) => ({
    dimensions: { recursiveTypeComponent: size, recursiveCallComponent: size },
    source: `${range(size)
      .map((index) => `struct N${index}<'a> { next: &'a N${(index + 1) % size}<'a> }`)
      .join('\n')}
${range(size)
  .map((index) => `fn f${index}(value: i32) -> i32 { return f${(index + 1) % size}(value) }`)
  .join('\n')}
fn keep<'a>(value: &'a N0<'a>) -> &'a N0<'a> { return value }`,
  }),
  conformanceCandidates: (size) => ({
    dimensions: { declaredConformances: size, selectedCalls: 1 },
    source: `interface Marker {}
${range(size)
  .map((index) => `struct V${index} {} impl Marker for V${index} {}`)
  .join('\n')}
fn selected<T: Marker>(value: T) { drop value }
fn inspect() { selected(V0 {}) }`,
  }),
  movedFields: (size) => ({
    dimensions: { movedFields: size, branches: 0 },
    source: `struct Token { value: i32 }
struct Record { ${range(size)
      .map((index) => `f${index}: Token`)
      .join(' ')} }
fn inspect(record: Record) {
${range(size)
  .map((index) => `let moved${index} = move record.f${index}`)
  .join('\n')}
drop record }`,
  }),
  sparseArrays: (size) => {
    const length = 2 ** Math.min(size, 30)
    return {
      dimensions: { arrayLength: length, accessedIndices: 2 },
      source: `struct Token { value: i32 }
fn inspect(values: [Token; ${length}]) { let first = move values[0] let last = move values[${length - 1}] drop values }`,
    }
  },
  projections: (size) => ({
    dimensions: { projectionDepth: size, movedFields: 1 },
    source: `struct W0 { value: i32 }
${range(size)
  .map((index) => `struct W${index + 1} { inner: W${index} }`)
  .join('\n')}
fn inspect(value: W${size}) { let moved = move value.${Array.from({ length: size }, () => 'inner').join('.')} drop value }`,
  }),
  joins: (size, invalid = false) => ({
    dimensions: { independentlyJoinedFields: size, loopIterations: 0 },
    invalid,
    source: `struct Token { value: i32 }
struct Record { ${range(size)
      .map((index) => `f${index}: Token`)
      .join(' ')} }
fn inspect(record: Record, ${range(size)
      .map((index) => `b${index}: bool`)
      .join(', ')}) {
${range(size)
  .map((index) => `if b${index} { drop record.f${index} }`)
  .join('\n')}
${invalid ? 'let invalid = move record' : 'drop record'} }`,
  }),
  callbacks: (size) => ({
    dimensions: { anonymousCallbacks: size },
    source: `fn inspect() -> i32 {
${range(size)
  .map((index) => `let f${index} = fn(value: i32) -> i32 { return value }`)
  .join('\n')}
return ${range(size)
      .map((index) => `f${index}(${index})`)
      .join(' + ')} }`,
  }),
  effects: (size) => ({
    dimensions: { effectCaptureDepth: size },
    source: `fn inspect() -> i32 { let e0 = effect { return 1 }
${range(size)
  .map((index) => `let e${index + 1} = effect { return run e${index} }`)
  .join('\n')}
return run e${size} }`,
  }),
}

const retainedProofs = (view) => {
  const functions = [...view.results.values()].flatMap(Elaboration.executableFunctions)
  const ownership = [...view.ownership.values()].flatMap((module) => module.functions)
  const types = new Set()
  for (const fn of functions)
    Elaboration.visitStatementFacts(fn.statements, {
      expression: (expression) => {
        if (expression.type._tag === 'Available')
          Type.visit(expression.type.type, (type) => types.add(Type.key(type)))
      },
    })
  const stateNodes = new WeakSet()
  const stateCounts = new WeakMap()
  let uniqueStateNodes = 0
  let stateEdges = 0
  let maxStateNodes = 0
  const inspectState = (state) => {
    const previous = stateCounts.get(state)
    if (previous !== undefined) return previous
    if (!stateNodes.has(state)) {
      stateNodes.add(state)
      uniqueStateNodes += 1
      stateEdges += state.children.length
    }
    const size = 1 + state.children.reduce((sum, child) => sum + inspectState(child.state), 0)
    stateCounts.set(state, size)
    maxStateNodes = Math.max(maxStateNodes, size)
    return size
  }
  const conditional = new Set()
  const inspectConditional = (root, state, path = []) => {
    if (state.initialization === 'Maybe') conditional.add(`${root}/${MovePath.key(path)}`)
    for (const child of state.children)
      inspectConditional(root, child.state, [...path, child.selector])
  }
  for (const fn of ownership) {
    for (const transition of fn.transitions) {
      inspectState(transition.before)
      inspectState(transition.after)
      inspectConditional(
        `${fn.declaration.id.sourceId}:${fn.declaration.id.ordinal}:${Ownership.siteKey(transition.root)}`,
        transition.before,
      )
      inspectConditional(
        `${fn.declaration.id.sourceId}:${fn.declaration.id.ordinal}:${Ownership.siteKey(transition.root)}`,
        transition.after,
      )
    }
    for (const exit of fn.exits)
      for (const release of exit.releases) {
        inspectState(release.initialization)
        inspectConditional(
          `${fn.declaration.id.sourceId}:${fn.declaration.id.ordinal}:${Ownership.siteKey(release.binding.site)}`,
          release.initialization,
        )
      }
  }
  return {
    functions: functions.length,
    hiddenFunctions: [...view.results.values()].reduce(
      (sum, result) => sum + result.hiddenFunctions.length,
      0,
    ),
    retainedTypeKeys: types.size,
    syntaxPoints: functions.reduce((sum, fn) => sum + (fn.lifetimeFlow?.syntaxPointCount ?? 0), 0),
    lifetimeSolver: sumWork(
      functions.map((fn) =>
        fn.lifetimeFlow?.solution._tag === 'Solved' ? fn.lifetimeFlow.solution.work : undefined,
      ),
    ),
    controlFlowReachability: sumWork(functions.map((fn) => fn.lifetimeFlow?.controlFlow.work)),
    controlFlowNodes: functions.reduce(
      (sum, fn) => sum + (fn.lifetimeFlow?.controlFlow.edges.length ?? 0),
      0,
    ),
    reachabilityCacheRows: functions.reduce(
      (sum, fn) => sum + (fn.lifetimeFlow?.controlFlow.queries.size ?? 0),
      0,
    ),
    reachabilityRetainedPoints: functions.reduce(
      (sum, fn) =>
        sum +
        [...(fn.lifetimeFlow?.controlFlow.queries.values() ?? [])].reduce(
          (count, points) => count + points.size,
          0,
        ),
      0,
    ),
    activatedConstraints: functions.reduce(
      (sum, fn) => sum + (fn.lifetimeFlow?.input.activatedConstraints?.length ?? 0),
      0,
    ),
    retirementComparisons: sumWork(functions.map((fn) => fn.lifetimeFlow?.retirementWork)),
    retiredCarrierUses: functions.reduce(
      (sum, fn) =>
        sum +
        [...(fn.lifetimeFlow?.retiredUses.values() ?? [])].reduce(
          (count, points) => count + points.size,
          0,
        ),
      0,
    ),
    finalBodyComparisons: sumWork(functions.map((fn) => fn.comparisonWork)),
    ownershipOperations: sumWork(ownership.map((fn) => fn.work)),
    cleanupLivenessSolver: sumWork(ownership.map((fn) => fn.cleanupLifetimeWork?.liveness)),
    cleanupValiditySolver: sumWork(ownership.map((fn) => fn.cleanupLifetimeWork?.validity)),
    loans: ownership.reduce((sum, fn) => sum + fn.loans.length, 0),
    loanReferents: ownership.reduce(
      (sum, fn) => sum + fn.loans.reduce((count, loan) => count + loan.referents.length, 0),
      0,
    ),
    transitions: ownership.reduce((sum, fn) => sum + fn.transitions.length, 0),
    uniqueStateNodes,
    retainedStateEdges: stateEdges,
    maximumStateNodes: maxStateNodes,
    conditionalPaths: conditional.size,
    nominalVariance: NominalVariance.derive(view.index).work,
    typeOutlives: TypeOutlives.context(view.index.modules).work,
    cleanupDerivation: CleanupPlan.work(view.index),
  }
}

const observe = (project, root, duration) => {
  const view = ProjectAnalysis.view(project, root)
  if (view === undefined) return { unavailable: root }
  const resolution = ResolutionWork.snapshot(ResolutionWork.ofIndex(view.index))
  return {
    elapsedMs: Duration.toMillis(duration),
    diagnostics: Analysis.diagnostics(view).map((diagnostic) => ({
      code: diagnostic.code,
      source: diagnostic.span.sourceId,
      start: diagnostic.span.start,
      end: diagnostic.span.end,
    })),
    queries: project.report.find((phase) => phase.phase === 'Semantic.checkBody')?.counters,
    resolution: { totals: sumWork(resolution), byInitiator: resolution },
    phases: project.report.map(({ phase, elapsedMs }) => ({ phase, elapsedMs })),
    retainedProofs: retainedProofs(view),
  }
}

const checkSource = Effect.fnUntraced(
  /**
   * @param {string} family
   * @param {number} size
   * @param {{ source: string, dimensions: Record<string, number>, invalid?: boolean }} input
   */ function* (family, size, input) {
    const root = `benchmark/${family}/${size}`
    const [duration, project] = yield* Effect.timed(
      ProjectAnalysis.make(
        [SourceFile.make(root, bytes(input.source))].map((source) => source.id),
      ).pipe(
        Effect.provide(
          SourceResolver.overlay([SourceFile.make(root, bytes(input.source))]).pipe(
            Layer.provideMerge(SourceResolver.memory(new Map())),
          ),
        ),
      ),
    )
    const result = observe(project, root, duration)
    let realization
    if (process.argv.includes('--verify-codegen')) {
      const realized = yield* Analysis.ofSourceRealized(
        root,
        bytes(input.source),
        'x86_64-unknown-linux-gnu',
      )
      const diagnostics = diagnosticObservations(Analysis.diagnostics(realized))
      const mir = realized.mir._tag === 'Available' ? realized.mir.value : undefined
      const profiles = []
      for (const mode of ['debug', 'release']) {
        profiles.push(
          mir === undefined || diagnostics.length > 0
            ? { mode, accepted: false, diagnostics }
            : yield* Analysis.codegen(realized, { mode }).pipe(
                Effect.match({
                  onFailure: (error) => ({ mode, accepted: false, error: String(error) }),
                  onSuccess: () => ({ mode, accepted: true }),
                }),
              ),
        )
      }
      realization = {
        instances: realized.instances.instances.length,
        phases: realized.report,
        mirViolations: mir === undefined ? [] : yield* MirVerification.verify(mir),
        frameSlots: mir?.functions
          .flatMap((fn) => fn.suspension?.frame?.states ?? [])
          .map((state) => ({
            slots: state.slots.length,
            conditionalFlags: state.slots.reduce(
              (sum, slot) => sum + (slot.initialization?.flags.length ?? 0),
              0,
            ),
            cleanupReleases: state.failure.releases.length,
          })),
        profiles,
        verdictsAgree: profiles.every((profile) => profile.accepted === !input.invalid),
      }
    }
    return {
      family,
      size,
      dimensions: input.dimensions,
      sourceBytes: input.source.length,
      expectedInvalid: input.invalid ?? false,
      realization,
      expectationMatched: result.diagnostics?.length > 0 === (input.invalid ?? false),
      ...result,
    }
  },
)

const editWorkload = Effect.fnUntraced(
  /** @param {number} size @param {boolean} effectful */ function* (size, effectful = false) {
    const initialLeaf = `pub ${effectful ? 'effect ' : ''}fn borrow<'a>(value: &'a i32) -> &'a i32 { return value }\nfn privateValue() -> i32 { return 1 }`
    const roots = range(size).map((index) =>
      SourceFile.make(
        `growth/Client${index}`,
        bytes(
          `import growth.Leaf\npub ${effectful ? 'effect ' : ''}fn read<'a>(value: &'a i32) -> &'a i32 { return ${effectful ? 'run ' : ''}Leaf.borrow(value) }`,
        ),
      ),
    )
    /** @type {Array<[string, string, Array<SourceFile.SourceFile>]>} */
    const revisions = [
      ['cold', initialLeaf, roots],
      ['warm', initialLeaf, roots],
      ['private-body-edit', initialLeaf.replace('return 1', 'return 22'), roots],
      [
        'alpha-rename',
        initialLeaf.replaceAll("'a", "'renamed").replace('return 1', 'return 22'),
        roots,
      ],
      [
        'exported-bound-edit',
        initialLeaf.replace("borrow<'a>", "borrow<'a: 'static>").replace('return 1', 'return 22'),
        roots,
      ],
      [
        'additional-generic-call',
        initialLeaf,
        roots.map((root, index) =>
          index === 0
            ? SourceFile.make(
                root.id,
                bytes(
                  `import growth.Leaf\npub ${effectful ? 'effect ' : ''}fn read<'a>(value: &'a i32) -> &'a i32 { return ${effectful ? 'run ' : ''}Leaf.borrow(value) }\n${effectful ? 'effect ' : ''}fn additional<'a>(value: &'a i32) -> &'a i32 { return ${effectful ? 'run ' : ''}Leaf.borrow(value) }`,
                ),
              )
            : root,
        ),
      ],
    ]
    const samples = []
    /** @type {ProjectAnalysis.ProjectAnalysis | undefined} */
    let previous
    /** @type {ProjectAnalysis.ProjectAnalysis | undefined} */
    let stable
    for (const [revision, leaf, currentRoots] of revisions) {
      // The additional-call edit branches from the initial checked interface, isolating call count.
      const basis = revision === 'additional-generic-call' ? stable : previous
      const computation =
        basis === undefined
          ? ProjectAnalysis.make(currentRoots.map((source) => source.id)).pipe(
              Effect.provide(SourceResolver.overlay(currentRoots)),
            )
          : ProjectAnalysis.revise(
              basis,
              currentRoots.map((source) => source.id),
            ).pipe(Effect.provide(SourceResolver.overlay(currentRoots)))
      const [duration, project] = yield* Effect.timed(
        computation.pipe(
          Effect.provide(SourceResolver.memory(new Map([['growth/Leaf', bytes(leaf)]]))),
        ),
      )
      if (stable === undefined) stable = project
      previous = project
      samples.push({
        family: effectful ? 'effectModuleFanout' : 'moduleFanout',
        size,
        dimensions: { importingModules: size, revision },
        ...observe(project, currentRoots[0]?.id ?? '', duration),
      })
    }
    return samples
  },
)

const binderWorkload = (size) => {
  const parameters = (name) =>
    range(size).map((ordinal) =>
      Lifetime.bound({ module: 'benchmark', name }, ordinal, `a${ordinal}`, [0]),
    )
  const left = parameters('left')
  const right = parameters('right')
  const callable = (binders) =>
    Type.callable(
      binders.map((lifetime) => Type.reference('Shared', 'i32', lifetime)),
      Type.reference('Shared', 'i32', binders[0] ?? Lifetime.staticLifetime),
      {
        environment: Lifetime.staticLifetime,
        lifetimeBinders: binders,
        lifetimeBounds: [],
        typeOutlives: [],
      },
    )
  const context = TypeCompatibility.context()
  const source = callable(left)
  const target = callable(right)
  let result
  for (let repetition = 0; repetition < 32; repetition += 1)
    result = TypeCompatibility.check(source, target, context)
  return {
    family: 'binderWidth',
    size,
    dimensions: { binderWidth: size, repeatedComparisons: 32 },
    compatible: result !== undefined && TypeCompatibility.isCompatible(result),
    work: { ...context.work },
  }
}

const compactResolution = (resolution, details) => {
  const kinds = new Map()
  for (const entry of resolution.byInitiator) {
    const observations = kinds.get(entry.initiator.kind) ?? []
    observations.push(entry)
    kinds.set(entry.initiator.kind, observations)
  }
  return {
    totals: resolution.totals,
    byInitiatorKind: [...kinds].map(([kind, observations]) => ({ kind, ...sumWork(observations) })),
    ...(details ? { byInitiator: resolution.byInitiator } : {}),
  }
}

const resolutionExamples = (results) => {
  const examples = new Map()
  for (const result of results)
    for (const entry of result.resolution?.byInitiator ?? []) {
      const category = `${entry.initiator.kind}:${entry.operation}`
      if (!examples.has(category))
        examples.set(category, {
          family: result.family,
          size: result.size,
          dimensions: result.dimensions,
          ...entry,
        })
    }
  return [...examples.values()]
}

const residualGenerators = {
  dependentOwners: (size) => ({
    dimensions: { dependentOwnerCalls: size, distinctLifetimeArguments: size },
    source: `import silk.ownership {Drop}
struct Guard<'a> { value: &'a mut i32 }
impl<'a> Drop for Guard<'a> { fn drop(self: &mut Guard<'a>) -> () { return () } }
fn owner<T>(value: T) { drop value }
pub fn main() -> i32 {
${range(size)
  .map((index) => `let mut value${index} = ${index} owner(Guard { value: &mut value${index} })`)
  .join('\n')}
return 0 }`,
  }),
  ordinarySpecializations: (size) => ({
    dimensions: { ordinaryOwnerSpecializations: size },
    source: `${range(size)
      .map((index) => `struct V${index} { value: i32 }`)
      .join('\n')}
fn owner<T>(value: T) { drop value }
pub fn main() -> i32 {
${range(size)
  .map((index) => `owner(V${index} { value: ${index} })`)
  .join('\n')}
return 0 }`,
  }),
  selectedBranches: (size) => {
    let branches = 'return value'
    for (let index = size - 2; index >= 0; index -= 1)
      branches = `static if selected == ${index} { return value + ${index} } else { ${branches} }`
    return {
      dimensions: { selectedStaticBranches: size, distinctStaticArguments: size },
      source: `fn choose(static selected: i32, value: i32) -> i32 { ${branches} }
pub fn main() -> i32 { return ${range(size)
        .map((index) => `choose(${index}, 1)`)
        .join(' + ')} }`,
    }
  },
  repeatedStaticQuery: (size) => ({
    dimensions: { repeatedApplications: size, distinctStaticArguments: 1 },
    source: `fn choose(static selected: bool, value: i32) -> i32 {
static if selected { return value } else { return 0 }
}
pub fn main() -> i32 { return choose(true, 42) }`,
  }),
}

const compactOwnership = (observations) => {
  const groups = new Map()
  for (const observation of observations) {
    const key = JSON.stringify([observation.declaration, observation.reason, observation.branch])
    const group = groups.get(key) ?? {
      declaration: observation.declaration,
      reason: observation.reason,
      branch: observation.branch,
      requests: 0,
      executedWork: {},
    }
    group.requests += 1
    group.executedWork = sumWork([group.executedWork, observation.work])
    groups.set(key, group)
  }
  return [...groups.values()]
}

const diagnosticObservations = (diagnostics) =>
  diagnostics.map((diagnostic) => ({
    code: diagnostic.code,
    source: diagnostic.span.sourceId,
    start: diagnostic.span.start,
    end: diagnostic.span.end,
  }))

const residualWorkload = Effect.fnUntraced(
  /**
   * @param {string} family
   * @param {number} size
   * @param {{ source: string, dimensions: Record<string, number> }} input
   */ function* (family, size, input) {
    const root = `benchmark/residual/${family}/${size}`
    const target = Target.x8664UnknownLinuxGnu
    const [frontendDuration, snapshot] = yield* Effect.timed(
      Analysis.ofSource(root, bytes(input.source)),
    )
    const diagnostics = diagnosticObservations(Analysis.diagnostics(snapshot))
    if (diagnostics.length > 0)
      return yield* new BenchmarkError({
        message: `${family}/${size} frontend rejected: ${diagnostics.map((diagnostic) => `${diagnostic.code} ${diagnostic.source}:${diagnostic.start}-${diagnostic.end}`).join(', ')}`,
      })
    const [residualDuration, residual] = yield* Effect.timed(
      Effect.try({
        try: () => {
          if (family !== 'repeatedStaticQuery') {
            const discovery = Instances.discover(
              root,
              snapshot.results,
              snapshot.index,
              target,
              snapshot.resolution,
            )
            return {
              instanceCount: discovery.instances.length,
              diagnostics: diagnosticObservations(discovery.residualizationDiagnostics),
              unavailableOwnership: discovery.unavailableOwnership.length,
              specializationFailures: discovery.specializationFailures.length,
              violations: discovery.violations.length,
              retainedRoots: discovery.retention.length,
              residualBodies: discovery.counters.residualBodies,
              residualOwnership: discovery.counters.residualOwnership,
              bodyReasons: discovery.residualBodies,
              ownershipReasons: compactOwnership(discovery.residualOwnership),
            }
          }
          const declaration = snapshot.results
            .get(root)
            ?.functions.find(
              (fact) =>
                fact.declaration.canonical._tag === 'Canonical' &&
                fact.declaration.canonical.id.name === 'choose',
            )?.declaration
          if (declaration?.canonical._tag !== 'Canonical') return { unavailableDeclaration: true }
          const application = {
            declaration: declaration.canonical.id,
            typeArguments: [],
            evidence: [],
            contractRow: [],
            staticArguments: [StaticValue.boolean(true)],
          }
          const bodies = Residualization.make(
            target,
            snapshot.results,
            snapshot.resolution,
            snapshot.index,
          )
          const ownership = ResidualOwnership.make()
          const plan = Ownership.localSharedAccessBoundaryPlan(snapshot.results)
          const failures = []
          for (let repetition = 0; repetition < size; repetition += 1) {
            const body = Residualization.residualize(bodies, application)
            if (body._tag !== 'ResidualBody') {
              failures.push({
                failure: body.failure._tag,
                diagnostics: diagnosticObservations(body.diagnostics),
              })
              continue
            }
            const checked = ResidualOwnership.check(
              ownership,
              Ownership.input(body.function, body.fact, snapshot.index, plan),
              'SelectedStaticBody',
            )
            failures.push(...diagnosticObservations([...body.diagnostics, ...checked.diagnostics]))
          }
          return {
            failures,
            residualBodies: Residualization.counters(bodies),
            residualOwnership: ResidualOwnership.counters(ownership),
            bodyReasons: Residualization.observations(bodies),
            ownershipReasons: compactOwnership(ResidualOwnership.observations(ownership)),
          }
        },
        catch: (cause) =>
          new BenchmarkError({ message: `${family}/${size} residual query failed`, cause }),
      }),
    )
    if (
      residual.unavailableDeclaration ||
      residual.unavailableEntry ||
      residual.unavailableOwnership ||
      residual.specializationFailures ||
      residual.violations ||
      residual.diagnostics?.length ||
      residual.failures?.length
    )
      return yield* new BenchmarkError({
        message: `${family}/${size} residual rejected: ${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(residual)}`,
      })
    return {
      family,
      size,
      dimensions: input.dimensions,
      sourceBytes: input.source.length,
      frontend: {
        elapsedMs: Duration.toMillis(frontendDuration),
        diagnostics,
        queries: snapshot.report.find((phase) => phase.phase === 'Semantic.checkBody')?.counters,
      },
      residual: { elapsedMs: Duration.toMillis(residualDuration), ...residual },
    }
  },
)

const main = Effect.fn('LifetimeBenchmark.main')(function* () {
  const argument = process.argv
    .find((argument) => argument.startsWith('--sizes='))
    ?.slice('--sizes='.length)
  const sizes = (argument ?? '4,8,16').split(',').map(Number)
  if (sizes.some((size) => !Number.isSafeInteger(size) || size < 2 || size > 128))
    return yield* new BenchmarkError({ message: 'sizes must be integers from 2 through 128' })
  const residualOnly = process.argv.includes('--residual-only')
  const effectOutcomes = process.argv.includes('--effect-outcomes')
  const families =
    process.argv
      .find((argument) => argument.startsWith('--families='))
      ?.slice('--families='.length)
      .split(',') ??
    (effectOutcomes
      ? ['effectComposition', 'effectCallbacks', 'effectProviders', 'partialSuspension']
      : undefined)
  if (families?.some((family) => !(family in generators)))
    return yield* new BenchmarkError({ message: 'families must name source workload generators' })
  const results = []
  for (const size of sizes) {
    if (residualOnly) {
      for (const [family, generate] of Object.entries(residualGenerators))
        results.push(yield* residualWorkload(family, size, generate(size)))
      continue
    }
    for (const [family, generate] of Object.entries(generators))
      if (families === undefined || families.includes(family))
        results.push(yield* checkSource(family, size, generate(size)))
    for (const family of [
      'loans',
      'joins',
      'exclusiveChains',
      'exclusiveReplacements',
      'effectComposition',
      'effectCallbacks',
      'effectProviders',
      'partialSuspension',
    ])
      if (families === undefined || families.includes(family))
        results.push(yield* checkSource(`${family}-invalid`, size, generators[family](size, true)))
    if (families === undefined || effectOutcomes) {
      results.push(binderWorkload(size))
      results.push(...(yield* editWorkload(size, effectOutcomes)))
    }
  }
  const memory = yield* Effect.try({
    try: () => ({
      heapUsed: process.memoryUsage().heapUsed,
      processMaxRss: process.resourceUsage().maxRSS,
    }),
    catch: (cause) =>
      new BenchmarkError({ message: 'cannot read process resource observation', cause }),
  })
  let pipeline = 'target-neutral frontend; no backend emission or optimizer'
  if (residualOnly)
    pipeline =
      'frontend then target-selected residual queries; no MIR, backend emission or optimizer'
  else if (process.argv.includes('--verify-codegen'))
    pipeline = 'frontend, realized MIR, debug and release LLVM emission'
  yield* Console.log(
    yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }))({
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        pipeline,
        ...(residualOnly ? { target: Target.x8664UnknownLinuxGnu.id } : {}),
        memoryUnits: { heapUsed: 'bytes', processMaxRss: 'host resourceUsage maxRSS units' },
        ...memory,
      },
      dimensions: sizes,
      attribution: {
        retainedProofs:
          'Cumulative proof artifacts in this snapshot, including reused bodies; query counters report actual work for this revision.',
        comparisons:
          'Final source-body comparison contexts; anonymous preliminary analysis is not included.',
        conditionalPaths:
          'Required conditional state paths; --verify-codegen additionally reports realized frame flags and cleanup releases.',
        resolution:
          'Actual reachable-index name/path/associated/conformance discovery and explicitly observed selected-call provider loops, keyed by their initiating request. Intermediate discarded declaration indexes and unobserved standalone provider oracles are outside this report. Lifetime actors receive no resolver.',
        residualOwnership: residualOnly
          ? 'Actual source-proof hits, cache hits and checker executions; executedWork sums only new checks. Frontend elapsed time is separate. Ownership observations group exact declaration, reason and branch.'
          : 'With --verify-codegen, realization phases report actual residual body and ownership query work.',
      },
      resolutionExamples: resolutionExamples(results),
      results: results.map((result) =>
        result.resolution === undefined
          ? result
          : {
              ...result,
              resolution: compactResolution(result.resolution, process.argv.includes('--details')),
            },
      ),
    }),
  )
})

NodeRuntime.runMain(main())
