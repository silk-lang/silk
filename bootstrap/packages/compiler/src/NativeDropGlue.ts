import * as Emitter from '@silklang/llvm/Emitter'
import type * as FunctionActor from '@silklang/llvm/Function'
import type * as LlvmType from '@silklang/llvm/Type'
import type * as Value from '@silklang/llvm/Value'
import * as CleanupPlan from './CleanupPlan.js'
import * as Mir from './Mir.js'
import type * as MovePath from './MovePath.js'
import * as NativeAggregate from './NativeAggregate.js'
import * as NativeArgument from './NativeArgument.js'
import * as NativeCall from './NativeCall.js'
import * as NativeDiagnosticContext from './NativeDiagnosticContext.js'
import type * as NativeDiagnosticDispatch from './NativeDiagnosticDispatch.js'
import * as NativeDiagnosticFailure from './NativeDiagnosticFailure.js'
import type * as NativeExecutionStorage from './NativeExecutionStorage.js'
import type * as NativeLanePointer from './NativeLanePointer.js'
import type * as NativeLoweringContext from './NativeLoweringContext.js'
import * as NativePayload from './NativePayload.js'
import * as NativePlace from './NativePlace.js'
import * as NativeResult from './NativeResult.js'
import type * as NativeStorage from './NativeStorage.js'
import type * as NativeType from './NativeType.js'
import type * as NativeValue from './NativeValue.js'
import * as SilkType from './Type.js'

/**
 * Out-of-line drop glue: one LLVM function per distinct stored cleanup, called from every site
 * that drops that cleanup. Inline expansion at each exit made cleanup code scale with
 * exits × live owners × plan size; a call keeps each site constant-size.
 */
export interface NativeDropGlue {
  readonly program: Mir.Module
  readonly i8: LlvmType.Type
  readonly i32: LlvmType.Type
  readonly pointer: LlvmType.Type
  readonly usizeType?: LlvmType.Type
  readonly free?: FunctionActor.Function
  readonly executionStorage?: NativeExecutionStorage.NativeExecutionStorage
  readonly executionRelease?: FunctionActor.Function
  readonly resumeThunks: NativeAggregate.Context['resumeThunks']
  readonly declared: ReadonlyArray<NativeLoweringContext.DeclaredFunction>
  readonly types: NativeType.LoweringContext
  readonly lanePointers: NativeLanePointer.Context
  readonly diagnosticDispatch: NativeDiagnosticDispatch.NativeDiagnosticDispatch
  /** Helpers bucketed by a cheap key; members are distinguished by structural equality. */
  readonly helpers: Map<string, Array<Helper>>
  /** Helpers declared so far; numbers the next helper's symbol. */
  declaredCount: number
  /** Declared helpers whose bodies are not yet emitted, in declaration order. */
  readonly pending: Array<Helper>
}

interface Helper {
  readonly plan: CleanupPlan.CleanupPlan
  readonly type: Mir.Type
  readonly representation: NativePlace.NativePlace['representation']
  readonly declared: NativeLoweringContext.DeclaredFunction
  /** Hooks or runtime helpers may write the caller's address-taken roots. */
  readonly runsUserCode: boolean
}

export const make = (
  context: Omit<NativeDropGlue, 'helpers' | 'declaredCount' | 'pending'>,
): NativeDropGlue => ({
  ...context,
  helpers: new Map(),
  declaredCount: 0,
  pending: [],
})

const children = (self: CleanupPlan.CleanupPlan): ReadonlyArray<CleanupPlan.CleanupPlan> => {
  switch (self._tag) {
    case 'RawBufferCleanup':
    case 'LocalSharedCoreCleanup':
    case 'ExecutionCleanup':
    case 'ExecutionRefCleanup':
      return [self.allocation]
    case 'HookCleanup':
      return [self.inner]
    case 'StructCleanup':
      return self.fields.map((field) => field.cleanup)
    case 'NominalUnionCleanup':
      return self.variants.flatMap((variant) => variant.fields.map((field) => field.cleanup))
    case 'ArrayCleanup':
      return [self.element]
    case 'UnionCleanup':
      return self.cases.map((entry) => entry.cleanup)
    case 'CallableCleanup':
    case 'EffectCleanup':
      return self.slots.map((slot) => slot.cleanup)
    case 'EffectCompositeCleanup':
      return self.alternatives
    default:
      return []
  }
}

const some = (
  self: CleanupPlan.CleanupPlan,
  predicate: (plan: CleanupPlan.CleanupPlan) => boolean,
): boolean => predicate(self) || children(self).some((child) => some(child, predicate))

/** Leaf actions an inline expansion repeats at every site: hook calls and reclaims. */
const weight = (self: CleanupPlan.CleanupPlan): number => {
  switch (self._tag) {
    case 'NoCleanup':
    case 'ParameterCleanup':
    case 'RepresentedCallableCleanup':
    case 'RepresentedEffectCleanup':
      return 0
    case 'AllocationCleanup':
    case 'RawBufferCleanup':
    case 'ExecutionCleanup':
      return 1
    case 'HookCleanup':
      return 1 + weight(self.inner)
    case 'LocalSharedCoreCleanup':
    case 'ExecutionRefCleanup':
      return 2
    default:
      return children(self).reduce((total, child) => total + weight(child), 0)
  }
}

const complete = (state: MovePath.State): boolean =>
  state.initialization === 'Initialized' &&
  (state.discriminant === undefined || state.discriminant === 'Initialized') &&
  state.children.every((child) => complete(child.state))

/**
 * Whether a drop may call shared glue: the owner is wholly initialized, its plan repeats more than
 * one leaf action, and no caller-selected local-shared control block is threaded through it.
 */
export const admits = (
  plan: CleanupPlan.CleanupPlan,
  initialization: { readonly state: MovePath.State } | undefined,
  localSharedBlock: unknown,
): boolean =>
  localSharedBlock === undefined &&
  (initialization === undefined || complete(initialization.state)) &&
  CleanupPlan.hasEffect(plan) &&
  weight(plan) > 1

/**
 * Structural equality over plain compiler data; plans are rebuilt per site, never shared.
 *
 * Every glue request deep-compares its plan and type against the bucket's helpers, which
 * profiled at ~8 s of self time over a 24k-function module, so this walks plain loops instead of
 * allocating key arrays and per-entry closures.
 */
const equal = (left: unknown, right: unknown): boolean => {
  if (left === right) return true
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null)
    return false
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false
    // Holes in `left` are skipped, as `every` skipped them.
    for (let index = 0; index < left.length; index += 1)
      if (index in left && !equal(left[index], right[index])) return false
    return true
  }
  if (Array.isArray(right)) return false
  // Anything but plain records (maps, sets, class instances) only matches by identity: a
  // missed share costs one more helper, a false share would release the wrong owner.
  if (Object.getPrototypeOf(left) !== Object.prototype) return false
  if (Object.getPrototypeOf(right) !== Object.prototype) return false
  // Both are plain records, so `for...in` visits exactly their own enumerable keys.
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  let unmatched = 0
  for (const key in leftRecord) {
    unmatched += 1
    if (!Object.hasOwn(rightRecord, key) || !equal(leftRecord[key], rightRecord[key])) return false
  }
  for (const _key in rightRecord) unmatched -= 1
  return unmatched === 0
}

const helperSymbol = (ordinal: number) => `silk_drop_glue_${ordinal}`

const request = (
  self: NativeDropGlue,
  builder: Emitter.Module,
  plan: CleanupPlan.CleanupPlan,
  place: NativePlace.NativePlace,
): Helper => {
  const key = `${plan._tag}\u0000${SilkType.encode(plan.type)}\u0000${place.view}\u0000${place.representation}`
  const bucket = self.helpers.get(key) ?? []
  const existing = bucket.find(
    (helper) =>
      helper.representation === place.representation &&
      equal(helper.type, place.type) &&
      equal(helper.plan, plan),
  )
  if (existing !== undefined) return existing
  const { program, pointer } = self
  const base = program.functions.at(0)
  if (base === undefined) throw new RangeError('Drop glue requested by a module without functions')
  const symbol = helperSymbol(self.declaredCount)
  const diagnostics = Mir.hasDiagnosticObservation(program)
  const parameters = diagnostics
    ? [
        pointer,
        pointer,
        NativeDiagnosticFailure.type({
          builder,
          pointer,
          word: Emitter.integerType(builder, program.layout.target.pointerSize * 8),
        }),
      ]
    : [pointer]
  const voidType = Emitter.voidType(builder)
  const id = { ...base.id, name: symbol }
  const { suspension: _suspension, ...rest } = base
  const fn: Mir.MirFunction = {
    ...rest,
    id,
    instance: { ...base.instance, declaration: id },
    parameterCount: 0,
    localTypes: [],
  }
  const helper: Helper = {
    plan,
    type: place.type,
    representation: place.representation,
    runsUserCode: some(
      plan,
      (entry) =>
        entry._tag === 'HookCleanup' ||
        entry._tag === 'LocalSharedCoreCleanup' ||
        entry._tag === 'ExecutionCleanup' ||
        entry._tag === 'ExecutionRefCleanup',
    ),
    declared: {
      fn,
      symbol,
      publicSymbol: symbol,
      // Never inlined back: a drop site stays one call however large its owner's cleanup is.
      handle: Emitter.declareFunction(
        builder,
        symbol,
        Emitter.functionType(builder, voidType, parameters),
        {
          linkage: 'internal',
          attributes: Emitter.functionAttributes(builder, {
            functionAttributes: Emitter.attributeSet(builder, [
              Emitter.flagAttribute(builder, 'noinline'),
            ]),
          }),
        },
      ),
      resultType: voidType,
      emittedResultType: voidType,
      resultLaneCount: 0,
      suspendable: false,
      parameterTypes: parameters,
      argumentParameters: [],
      ...(diagnostics ? { diagnosticParameter: 1 } : {}),
      linear: [],
    },
  }
  bucket.push(helper)
  self.helpers.set(key, bucket)
  self.declaredCount += 1
  self.pending.push(helper)
  return helper
}

/**
 * Drops a stored owner through its shared glue. Returns false, leaving the caller to expand the
 * plan inline, when the place cannot be rebuilt from its address alone or the caller cannot
 * forward its diagnostic context.
 */
export const drop = (
  self: NativeDropGlue,
  context: NativeAggregate.Context,
  plan: CleanupPlan.CleanupPlan,
  place: NativePlace.NativePlace,
  tag: string,
): boolean => {
  const rebuilt = NativePlace.make(
    self.program.layout,
    place.type,
    place.base,
    place.representation,
  )
  if (
    rebuilt.view !== place.view ||
    rebuilt.size !== place.size ||
    rebuilt.alignment !== place.alignment
  )
    return false
  if (
    Mir.hasDiagnosticObservation(self.program) &&
    context.call.synchronous.diagnostic === undefined
  )
    return false
  const helper = request(self, context.builder, plan, place)
  const base = NativePlace.base(place, context.storage, `${tag}_glue_base`)
  // The helper takes the already-physical storage address, not a logical argument shape.
  const target: NativeCall.DeclaredTarget = {
    handle: helper.declared.handle,
    resultLaneCount: 0,
    suspendable: false,
    ...(helper.declared.diagnosticParameter === undefined
      ? {}
      : { diagnosticParameter: helper.declared.diagnosticParameter }),
  }
  if (helper.runsUserCode) {
    // Address-taken roots are reloaded after the call, exactly as after an inline hook call.
    NativeResult.sourceValues(
      NativeResult.materialize(
        context.storage,
        NativeCall.callSynchronous(
          context.call.synchronous,
          target,
          NativeArgument.fromValues([base]),
          `${tag}_glue`,
        ),
        `${tag}_glue_result`,
      ),
    )
    return true
  }
  Emitter.callDirect(
    context.body,
    target.handle,
    NativeCall.argumentsFor(context.call.synchronous, target, [base]),
  )
  return true
}

/** Emits every requested helper body, including helpers requested by other helper bodies. */
export const emitPending = (self: NativeDropGlue, builder: Emitter.Module): boolean => {
  const helper = self.pending.shift()
  if (helper === undefined) return false
  emitBody(self, builder, helper)
  return true
}

const emitBody = (self: NativeDropGlue, builder: Emitter.Module, helper: Helper) => {
  const { program, i8, i32, pointer, usizeType, free, executionStorage, types, lanePointers } = self
  const declared = helper.declared
  Emitter.buildBody(builder, declared.handle, (body) => {
    Emitter.block(body, 'entry')
    const base = Emitter.argument(body, 0)
    const diagnostic =
      declared.diagnosticParameter === undefined
        ? undefined
        : NativeDiagnosticContext.make(
            builder,
            body,
            pointer,
            i8,
            usizeType ?? Emitter.integerType(builder, program.layout.target.pointerSize * 8),
            self.diagnosticDispatch,
            Emitter.argument(body, declared.diagnosticParameter),
            Emitter.argument(body, declared.diagnosticParameter + 1),
          )
    const storage: NativeStorage.Context = {
      builder,
      body,
      byteType: i8,
      offsetType: i32,
      fn: declared.fn,
      layout: program.layout,
      mutableRoots: new Set<number>(),
      blockRoots: new Set<number>(),
      mutableStorage: new Map<number, ReadonlyArray<Value.Input>>(),
      addressRoots: new Set<number>(),
      addressStorage: new Map<number, Value.Input>(),
      transientOutcomes: new Set<number>(),
      locals: new Map<number, NativeValue.NativeValue>(),
      types,
      lanePointers,
      sequences: { materialize: 0, reload: 0 },
    }
    const call: NativeCall.Context = {
      builder,
      body,
      program,
      i8,
      i32,
      pointer,
      entry: declared,
      resumeThunks: self.resumeThunks,
      lanePointers,
      types,
      storage,
      synchronous: { body, storage, ...(diagnostic === undefined ? {} : { diagnostic }) },
      returns: { builder, body, i32, pointer, entry: declared, types, lanePointers },
    }
    const cleanup: NativeAggregate.Context = {
      builder,
      body,
      program,
      i8,
      i32,
      pointer,
      ...(usizeType === undefined ? {} : { usizeType }),
      ...(free === undefined ? {} : { free }),
      ...(executionStorage === undefined ? {} : { executionStorage }),
      ...(self.executionRelease === undefined ? {} : { executionRelease: self.executionRelease }),
      resumeThunks: self.resumeThunks,
      declared: self.declared,
      types,
      lanePointers,
      call,
      arith: {
        body,
        pointerBits: program.layout.target.pointerSize === 4 ? 32 : 64,
        i32,
        integerTypes: types.integerTypes,
        types,
      },
      storage,
      dropGlue: self,
    }
    NativeAggregate.expand(
      cleanup,
      helper.plan,
      NativePayload.place(
        types,
        NativePlace.make(program.layout, helper.type, base, helper.representation),
      ),
      'glue',
    )
    Emitter.returnVoid(body)
  })
}
