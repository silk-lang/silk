import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import { dual } from 'effect/Function'
import type * as Alignment from './Alignment.js'
import { defaultAlignment } from './Alignment.js'
import { invalidInput, type LlvmError } from './LlvmError.js'

/**
 * Whether an LLVM memory operation is ordinary or volatile.
 *
 * @category memory access
 * @since 0.0.0
 */
export type Kind = 'normal' | 'volatile'
/**
 * The synchronization domain used by an atomic operation.
 *
 * @category memory access
 * @since 0.0.0
 */
export type SyncScope = 'singlethread' | 'system'
/**
 * LLVM's atomic ordering lattice, including `none` for non-atomic operations.
 *
 * @category memory access
 * @since 0.0.0
 */
export type AtomicOrdering =
  | 'none'
  | 'unordered'
  | 'monotonic'
  | 'acquire'
  | 'release'
  | 'acq_rel'
  | 'seq_cst'

/**
 * Operations supported by LLVM's `atomicrmw` instruction.
 *
 * @category memory access
 * @since 0.0.0
 */
export type AtomicOperation =
  | 'xchg'
  | 'add'
  | 'sub'
  | 'and'
  | 'nand'
  | 'or'
  | 'xor'
  | 'max'
  | 'min'
  | 'umax'
  | 'umin'
  | 'fadd'
  | 'fsub'
  | 'fmax'
  | 'fmin'

/**
 * Immutable settings shared by loads, stores, and atomic memory instructions.
 *
 * @category memory access
 * @since 0.0.0
 */
export interface MemoryAccess {
  readonly kind: Kind
  readonly alignment: Alignment.Alignment
  readonly syncScope: SyncScope
  readonly ordering: AtomicOrdering
}

/**
 * Optional fields accepted by {@link make}.
 *
 * @category memory access
 * @since 0.0.0
 */
export interface Input {
  readonly kind?: Kind
  readonly alignment?: Alignment.Alignment
  readonly syncScope?: SyncScope
  readonly ordering?: AtomicOrdering
}

/**
 * The non-volatile memory-access kind.
 *
 * @category memory access
 * @since 0.0.0
 */
export const normal: Kind = 'normal'
/**
 * The volatile memory-access kind.
 *
 * @category memory access
 * @since 0.0.0
 */
export const volatile: Kind = 'volatile'
/**
 * Synchronization visible to every thread in the process.
 *
 * @category memory access
 * @since 0.0.0
 */
export const system: SyncScope = 'system'
/**
 * Synchronization restricted to the current thread.
 *
 * @category memory access
 * @since 0.0.0
 */
export const singlethread: SyncScope = 'singlethread'

/**
 * Numeric bitcode codes for {@link AtomicOrdering}.
 *
 * @category memory access
 * @since 0.0.0
 */
export const orderingCode: Readonly<Record<AtomicOrdering, number>> = {
  none: 0,
  unordered: 1,
  monotonic: 2,
  acquire: 3,
  release: 4,
  acq_rel: 5,
  seq_cst: 6,
}

/**
 * Numeric bitcode codes for {@link AtomicOperation}.
 *
 * @category memory access
 * @since 0.0.0
 */
export const operationCode: Readonly<Record<AtomicOperation, number>> = {
  xchg: 0,
  add: 1,
  sub: 2,
  and: 3,
  nand: 4,
  or: 5,
  xor: 6,
  max: 7,
  min: 8,
  umax: 9,
  umin: 10,
  fadd: 11,
  fsub: 12,
  fmax: 13,
  fmin: 14,
}

/**
 * Normalizes memory settings with target alignment, system scope, and non-atomic defaults.
 *
 * **Details**
 *
 * Construction is intentionally permissive because legality depends on the consuming instruction.
 * Function-body operations call the corresponding validators before committing an instruction.
 *
 * **Example** (Configuring atomic access)
 *
 * ```ts
 * import { pipe } from 'effect/Function'
 * import * as MemoryAccess from '@silklang/llvm/MemoryAccess'
 *
 * const access = pipe(
 *   MemoryAccess.make({ kind: 'volatile' }),
 *   MemoryAccess.withAtomic('acquire'),
 * )
 * ```
 *
 * @category memory access
 * @since 0.0.0
 */
export const make = (input: Input = {}): MemoryAccess => ({
  kind: input.kind ?? 'normal',
  alignment: input.alignment ?? defaultAlignment,
  syncScope: input.syncScope ?? 'system',
  ordering: input.ordering ?? 'none',
})

/**
 * Returns a copy with volatile access enabled or disabled.
 *
 * @category memory access
 * @since 0.0.0
 */
export const withVolatile: {
  (): (self: MemoryAccess) => MemoryAccess
  (enabled: boolean): (self: MemoryAccess) => MemoryAccess
  (self: MemoryAccess, enabled?: boolean): MemoryAccess
} = dual(
  (args) => typeof args[0] === 'object',
  (self: MemoryAccess, enabled = true): MemoryAccess => ({
    ...self,
    kind: enabled ? 'volatile' : 'normal',
  }),
)

/**
 * Returns a copy configured as an atomic access with the requested ordering and scope.
 *
 * @category memory access
 * @since 0.0.0
 */
export const withAtomic: {
  (
    ordering: Exclude<AtomicOrdering, 'none'>,
    syncScope?: SyncScope,
  ): (self: MemoryAccess) => MemoryAccess
  (
    self: MemoryAccess,
    ordering: Exclude<AtomicOrdering, 'none'>,
    syncScope?: SyncScope,
  ): MemoryAccess
} = dual(
  (args) => typeof args[0] === 'object',
  (
    self: MemoryAccess,
    ordering: Exclude<AtomicOrdering, 'none'>,
    syncScope: SyncScope = 'system',
  ): MemoryAccess => ({ ...self, ordering, syncScope }),
)

/**
 * Compares orderings by LLVM's encoding order; instruction-specific legality still requires validation.
 *
 * @category memory access
 * @since 0.0.0
 */
export const compareOrdering = (left: AtomicOrdering, right: AtomicOrdering): number =>
  Math.sign(orderingCode[left] - orderingCode[right])

/**
 * Renders the optional textual `volatile` prefix.
 *
 * @category memory access
 * @since 0.0.0
 */
export const renderKind = (kind: Kind): string => (kind === 'volatile' ? 'volatile ' : '')

/**
 * Renders the optional `syncscope("singlethread")` clause.
 *
 * @category memory access
 * @since 0.0.0
 */
export const renderSyncScope = (scope: SyncScope): string =>
  scope === 'singlethread' ? 'syncscope("singlethread") ' : ''

/**
 * Renders an ordering token, or an empty string for non-atomic operations.
 *
 * @category memory access
 * @since 0.0.0
 */
export const renderOrdering = (ordering: AtomicOrdering): string =>
  ordering === 'none' ? '' : ordering

/**
 * Encodes an alignment as LLVM's exponent-plus-one instruction field.
 *
 * **Gotchas**
 *
 * Explicit alignments that do not fit the six-bit instruction field fail with {@link LlvmError}.
 *
 * @category memory access
 * @since 0.0.0
 */
/** @internal */
class AlignmentEncodingFailure extends Data.TaggedError('AlignmentEncodingFailure')<{
  readonly message: string
  readonly alignment: Alignment.Alignment
}> {
  constructor(alignment: Alignment.Alignment) {
    super({ message: 'LLVM instruction alignment exceeds the 6-bit bitcode encoding', alignment })
  }
}

/** @internal */
export const encodeAlignment = (alignment: Alignment.Alignment): number => {
  if (alignment.byteUnits === undefined) return 0
  let value = alignment.byteUnits
  let exponent = 0
  while (value > 1n) {
    value >>= 1n
    exponent += 1
  }
  if (exponent > 62) throw new AlignmentEncodingFailure(alignment)
  return exponent + 1
}

export const alignmentCode = Effect.fnUntraced(function* (
  alignment: Alignment.Alignment,
): Effect.fn.Return<number, LlvmError> {
  return yield* Effect.try({
    try: () => encodeAlignment(alignment),
    catch: () =>
      invalidInput({
        operation: 'MemoryAccess.alignmentCode',
        message: 'LLVM instruction alignment exceeds the 6-bit bitcode encoding',
        input: alignment,
      }),
  })
})

/**
 * Validates that a load does not use the store-only `release` or `acq_rel` orderings.
 *
 * @category memory access
 * @since 0.0.0
 */
export const validateLoadOrdering = Effect.fnUntraced(function* (
  ordering: AtomicOrdering,
): Effect.fn.Return<void, LlvmError> {
  if (ordering === 'release' || ordering === 'acq_rel') {
    return yield* invalidInput({
      operation: 'MemoryAccess.validateLoadOrdering',
      message: 'Atomic loads cannot use release or acq_rel ordering',
      input: ordering,
    })
  }
})

/**
 * Validates that a store does not use the load-only `acquire` or `acq_rel` orderings.
 *
 * @category memory access
 * @since 0.0.0
 */
export const validateStoreOrdering = Effect.fnUntraced(function* (
  ordering: AtomicOrdering,
): Effect.fn.Return<void, LlvmError> {
  if (ordering === 'acquire' || ordering === 'acq_rel') {
    return yield* invalidInput({
      operation: 'MemoryAccess.validateStoreOrdering',
      message: 'Atomic stores require monotonic, release, or seq_cst ordering',
      input: ordering,
    })
  }
})

/**
 * Validates that a fence uses at least acquire or release semantics.
 *
 * @category memory access
 * @since 0.0.0
 */
export const validateFenceOrdering = Effect.fnUntraced(function* (
  ordering: AtomicOrdering,
): Effect.fn.Return<void, LlvmError> {
  if (
    ordering !== 'acquire' &&
    ordering !== 'release' &&
    ordering !== 'acq_rel' &&
    ordering !== 'seq_cst'
  ) {
    return yield* invalidInput({
      operation: 'MemoryAccess.validateFenceOrdering',
      message: 'A fence requires acquire, release, acq_rel, or seq_cst ordering',
      input: ordering,
    })
  }
})

/**
 * Validates that an atomic read-modify-write uses at least monotonic ordering.
 *
 * @category memory access
 * @since 0.0.0
 */
export const validateRmwOrdering = Effect.fnUntraced(function* (
  ordering: AtomicOrdering,
): Effect.fn.Return<void, LlvmError> {
  if (ordering === 'none' || ordering === 'unordered') {
    return yield* invalidInput({
      operation: 'MemoryAccess.validateRmwOrdering',
      message: 'Atomic RMW operations require at least monotonic ordering',
      input: ordering,
    })
  }
})

/**
 * Validates LLVM's success/failure ordering relationship for compare-exchange.
 *
 * **Gotchas**
 *
 * Forbidden failure orderings and failure orderings stronger than the success ordering fail with
 * {@link LlvmError}.
 *
 * @category memory access
 * @since 0.0.0
 */
export const validateCompareExchange = Effect.fnUntraced(function* (
  success: AtomicOrdering,
  failure: AtomicOrdering,
): Effect.fn.Return<void, LlvmError> {
  yield* validateRmwOrdering(success)
  if (
    failure === 'none' ||
    failure === 'unordered' ||
    failure === 'release' ||
    failure === 'acq_rel'
  ) {
    return yield* invalidInput({
      operation: 'MemoryAccess.validateCompareExchange',
      message: 'Compare-exchange failure ordering is not permitted by LLVM',
      input: failure,
    })
  }
  const allowedFailure: Readonly<
    Record<Exclude<AtomicOrdering, 'none' | 'unordered' | 'release' | 'acq_rel'>, number>
  > = {
    monotonic: 0,
    acquire: 1,
    seq_cst: 2,
  }
  let successLimit = 0
  if (success === 'seq_cst') successLimit = 2
  else if (success === 'acquire' || success === 'acq_rel') successLimit = 1
  if (allowedFailure[failure] > successLimit) {
    return yield* invalidInput({
      operation: 'MemoryAccess.validateCompareExchange',
      message: 'Compare-exchange failure ordering cannot be stronger than success ordering',
      input: { success, failure },
    })
  }
})
