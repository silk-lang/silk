import * as Emitter from '@silklang/llvm/Emitter'
import * as NativePayload from './NativePayload.js'
import type * as LlvmBlock from '@silklang/llvm/Block'
import type * as LlvmType from '@silklang/llvm/Type'
import type * as Value from '@silklang/llvm/Value'
import * as CleanupPlan from './CleanupPlan.js'
import * as Match from './Match.js'
import * as Mir from './Mir.js'
import type { LinearTerminator } from './MirLinearization.js'
import * as NativeAggregate from './NativeAggregate.js'
import * as NativeArith from './NativeArith.js'
import * as NativeDebug from './NativeDebug.js'
import * as NativePlaceAddress from './NativePlaceAddress.js'
import type * as NativeLoweringContext from './NativeLoweringContext.js'
import type * as NativeSuspension from './NativeSuspension.js'
import * as NativeReturn from './NativeReturn.js'
import * as NativeTermination from './NativeTermination.js'
import * as NativeType from './NativeType.js'
import * as NativeStorage from './NativeStorage.js'
import * as NativePlace from './NativePlace.js'
import * as SilkType from './Type.js'

export interface Context {
  readonly builder: Emitter.Module
  readonly body: Emitter.Body
  readonly i32: LlvmType.Type
  readonly types: NativeType.LoweringContext
  readonly blocks: ReadonlyMap<number, LlvmBlock.Block>
  readonly storage: NativeStorage.Context
  readonly entry: NativeLoweringContext.DeclaredFunction
  readonly cleanup: NativeAggregate.Context
  readonly failure: NativeAggregate.FailureContext
  readonly suspension: NativeSuspension.ReturnContext
  readonly debug: NativeDebug.LocationContext
  readonly termination: NativeTermination.FunctionContext
}

const read = (context: Context, local: Mir.LocalId) =>
  NativeStorage.materialize(context.storage, local)

const discriminants = (
  context: Context,
  local: Mir.LocalId,
  selectors: ReadonlyArray<Mir.PlaceSelector>,
  count: number,
  tag: string,
) => {
  const type = context.entry.fn.localTypes.at(local.ordinal)
  if (
    selectors.length === 0 &&
    type !== undefined &&
    !SilkType.isReference(Mir.semanticType(type))
  ) {
    // Reading a tag must not expand the union's payload and dispatch over every variant.
    const values: Array<Value.Input> = []
    for (let ordinal = 0; ordinal < count; ordinal += 1)
      values.push(NativeStorage.readLane(context.storage, local, ordinal))
    return values
  }
  const resolved = NativePlaceAddress.resolve(
    {
      ...context.cleanup,
      debug: context.debug,
      termination: context.termination,
    },
    local,
    selectors,
    tag,
  )
  const storage = NativePlace.stored(
    context.cleanup.program.layout,
    resolved.type,
    resolved.address,
  )
  const values: Array<Value.Input> = []
  for (let ordinal = 0; ordinal < count; ordinal += 1)
    values.push(NativePlace.loadLane(storage, context.storage, ordinal, `${tag}_${ordinal}`))
  return values
}

/** Resolves one MIR control target to its declared LLVM block. */
export const targetBlock = (
  blocks: ReadonlyMap<number, LlvmBlock.Block>,
  target: Mir.RegionId,
  operation: string,
): LlvmBlock.Block => {
  const block = blocks.get(target.ordinal)
  if (block === undefined) throw new RangeError(`${operation} targets a missing block`)
  return block
}

export const jump = (
  context: Context,
  terminator: Extract<LinearTerminator, { readonly _tag: 'Jump' }>,
): void => {
  Emitter.branch(context.body, targetBlock(context.blocks, terminator.target, 'Backend jump'))
}

export const branch = (
  context: Context,
  terminator: Extract<LinearTerminator, { readonly _tag: 'Branch' }>,
  ordinal: number,
): void => {
  const zero = Emitter.integerSigned(context.builder, context.i32, 0n)
  const condition = Emitter.integerCompare(
    context.body,
    'ne',
    NativeStorage.readScalar(context.storage, terminator.condition),
    zero,
    `c${ordinal}`,
  )
  Emitter.conditionalBranch(
    context.body,
    condition,
    targetBlock(context.blocks, terminator.taken, 'Backend branch'),
    targetBlock(context.blocks, terminator.otherwise, 'Backend branch'),
  )
}

export const enumMatchBranch = (
  context: Context,
  terminator: Extract<LinearTerminator, { readonly _tag: 'EnumMatchBranch' }>,
  blockOrdinal: number,
): void => {
  const value = discriminants(
    context,
    terminator.scrutinee,
    terminator.selectors ?? [],
    1,
    `enum_match${blockOrdinal}`,
  ).at(0)
  if (value === undefined) throw new RangeError('LLVM enum match lost its discriminant')
  const lane = NativeType.lanesFor(context.types, terminator.type).at(0)
  if (lane === undefined) throw new RangeError('LLVM enum match lost its scalar lane')
  const type = NativeType.laneType(context.types, lane)
  const expected =
    terminator.representation.signedness === 'Signed'
      ? Emitter.integerSigned(context.builder, type, terminator.discriminant)
      : Emitter.integerUnsigned(context.builder, type, terminator.discriminant)
  const condition = Emitter.integerCompare(
    context.body,
    'eq',
    value,
    expected,
    `enum_match${blockOrdinal}_member`,
  )
  Emitter.conditionalBranch(
    context.body,
    condition,
    targetBlock(context.blocks, terminator.taken, 'LLVM enum match branch'),
    targetBlock(context.blocks, terminator.otherwise, 'LLVM enum match branch'),
  )
}

export const matchBranch = (
  context: Context,
  terminator: Extract<LinearTerminator, { readonly _tag: 'MatchBranch' }>,
  blockOrdinal: number,
): void => {
  const count =
    terminator.member._tag === 'NominalUnionVariant' && terminator.shape.tree._tag === 'SumShape'
      ? 2
      : 1
  const values = discriminants(
    context,
    terminator.scrutinee,
    terminator.selectors ?? [],
    count,
    `match${blockOrdinal}`,
  )
  const tag = values.at(0)
  if (tag === undefined) throw new RangeError('LLVM match has no tag lane')
  let condition: Value.Value
  if (terminator.member._tag === 'NominalUnionVariant') {
    const member = terminator.member
    const nested = terminator.shape.tree._tag === 'SumShape'
    const variantTag = values.at(nested ? 1 : 0)
    const carrierLane = terminator.shape.lanes.at(nested ? 1 : 0)
    const tagLane = terminator.shape.lanes.at(0)
    if (variantTag === undefined || carrierLane === undefined || tagLane === undefined)
      throw new RangeError('LLVM nominal union match has no tag lane')
    // A structural union shares payload carriers across members. Recover the nominal i32
    // tag from that carrier, which another member may have widened or made floating-point.
    const discriminant = NativeArith.coerceLane(
      context.cleanup.arith,
      variantTag,
      carrierLane,
      tagLane,
      `match${blockOrdinal}_variant_tag`,
    )
    const variantMatches = Emitter.integerCompare(
      context.body,
      'eq',
      discriminant,
      Emitter.integerSigned(context.builder, context.i32, BigInt(member.variantOrdinal)),
      `match${blockOrdinal}_variant`,
    )
    if (!nested) {
      condition = variantMatches
    } else {
      const outer =
        terminator.shape.tree._tag === 'SumShape'
          ? terminator.shape.tree.members.find((candidate) =>
              SilkType.equals(candidate.member, member.root),
            )
          : undefined
      if (outer === undefined)
        throw new RangeError('LLVM nominal union match lost its structural member')
      const rootMatches = Emitter.integerCompare(
        context.body,
        'eq',
        tag,
        Emitter.integerSigned(context.builder, context.i32, BigInt(outer.ordinal)),
        `match${blockOrdinal}_root`,
      )
      condition = Emitter.binary(
        context.body,
        'and',
        rootMatches,
        variantMatches,
        `match${blockOrdinal}_member`,
      )
    }
  } else {
    const outer =
      terminator.shape.tree._tag === 'SumShape'
        ? terminator.shape.tree.members.find((candidate) =>
            SilkType.equals(candidate.member, Match.sourceType(terminator.member)),
          )
        : undefined
    if (outer === undefined) throw new RangeError('LLVM union match lost its structural member')
    condition = Emitter.integerCompare(
      context.body,
      'eq',
      tag,
      Emitter.integerSigned(context.builder, context.i32, BigInt(outer.ordinal)),
      `match${blockOrdinal}_member`,
    )
  }
  Emitter.conditionalBranch(
    context.body,
    condition,
    targetBlock(context.blocks, terminator.taken, 'LLVM match branch'),
    targetBlock(context.blocks, terminator.otherwise, 'LLVM match branch'),
  )
}

/** Emits one complete MIR terminator, including propagation cleanup and suspension return ABI. */
export const emit = (
  context: Context,
  terminator: LinearTerminator,
  blockOrdinal: number,
  blockId: Mir.RegionId,
): void => {
  const { builder, body, i32 } = context
  const readLocal = (local: Mir.LocalId) => read(context, local)
  const block = { id: blockId }
  switch (terminator._tag) {
    case 'PropagateEffectFailure': {
      NativeTermination.storePropagated(
        context.termination,
        terminator.outcome,
        terminator.provenance.span,
      )
      const source = readLocal(terminator.source)
      const sourceTag = terminator.sourceType._tag === 'Union' ? source.at(0) : undefined
      let mappedTag: Value.Input
      if (terminator.sourceType._tag === 'Nominal') {
        mappedTag = Emitter.integerSigned(
          builder,
          i32,
          BigInt(terminator.tagMappings.at(0)?.target ?? -1),
        )
      } else if (sourceTag === undefined) {
        throw new RangeError('Effect failure propagation lost its tag lane')
      } else {
        mappedTag = Emitter.integerSigned(builder, i32, -1n)
        for (const [ordinal, mapping] of terminator.tagMappings.entries()) {
          const matches = Emitter.integerCompare(
            body,
            'eq',
            sourceTag,
            Emitter.integerSigned(builder, i32, BigInt(mapping.source)),
            `effect_failure_propagation${terminator.source.ordinal}_${ordinal}`,
          )
          mappedTag = Emitter.select(
            body,
            matches,
            Emitter.integerSigned(builder, i32, BigInt(mapping.target)),
            mappedTag,
            `effect_failure_propagation${terminator.source.ordinal}_${ordinal}_tag`,
          )
        }
      }
      for (const release of terminator.releases ?? []) {
        if (!CleanupPlan.hasEffect(release.cleanup)) continue
        NativeAggregate.dropThroughPlan(
          context.cleanup,
          release.cleanup,
          NativePayload.local(context.storage, release.local),
          `propagation_release${release.local.ordinal}`,
        )
      }
      const returned: Array<Value.Input> = [
        mappedTag,
        ...NativeAggregate.failurePayload(
          context.failure,
          source,
          Mir.semanticType(terminator.sourceType),
          sourceTag,
          terminator.propagationType.type,
          terminator.tagMappings,
          `effect_failure_propagation${terminator.source.ordinal}_payload`,
        ),
      ]
      NativeReturn.complete(
        context.suspension,
        returned.slice(0, terminator.propagationLaneCount),
        'propagated_selective_failure',
        terminator.outcome,
      )
      break
    }
    case 'Return': {
      const instruction = NativeReturn.completeLocal(
        context.suspension,
        context.storage,
        terminator.value,
        `return_value_b${block.id.ordinal}`,
      )
      NativeDebug.locate(context.debug, terminator.provenance.span, instruction)
      break
    }
    case 'Jump': {
      jump(context, terminator)
      break
    }
    case 'Branch': {
      branch(context, terminator, blockOrdinal)
      break
    }
    case 'MatchBranch': {
      matchBranch(context, terminator, block.id.ordinal)
      break
    }
    case 'EnumMatchBranch': {
      enumMatchBranch(context, terminator, block.id.ordinal)
      break
    }
    case 'Trap': {
      const instruction = NativeTermination.emitTrap(
        context.termination,
        terminator.reason,
        terminator.provenance.span,
      )
      NativeDebug.locate(context.debug, terminator.provenance.span, instruction)
      break
    }
  }
}
