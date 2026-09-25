import { assert, it } from '@effect/vitest'
import * as Cause from 'effect/Cause'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Attribute from '../src/Attribute.js'
import * as Block from '../src/Block.js'
import * as Builder from '../src/Builder.js'
import * as Constant from '../src/Constant.js'
import * as Emitter from '../src/Emitter.js'
import * as FunctionActor from '../src/Function.js'
import * as FunctionBody from '../src/FunctionBody.js'
import * as IrText from '../src/IrText.js'
import * as BodyState from '../src/internal/FunctionBodyState/primitives.js'
import * as Handle from '../src/internal/Handle.js'
import { invalidInput, LlvmError } from '../src/LlvmError.js'
import * as Type from '../src/Type.js'
import * as Value from '../src/Value.js'
import { raise } from './support/raise.js'

const buildAdd = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  fn: FunctionActor.Function,
) {
  return yield* FunctionActor.buildBody(
    builder,
    fn,
    Effect.fnUntraced(function* (body) {
      yield* Block.make(body, 'entry')
      const left = yield* Value.argument(body, 0)
      const right = yield* Value.argument(body, 1)
      const sum = yield* FunctionBody.binary(body, 'add', left, right, 'sum')
      yield* FunctionBody.returnValue(body, sum)
      return body
    }),
  )
})

it.effect('commits a valid body once and closes its scoped draft', () =>
  Effect.gen(function* () {
    const builder = yield* Builder.make()
    const i32 = yield* Type.integer(builder, 32)
    const type = yield* Type.functionType(builder, i32, [i32, i32])
    const fn = yield* FunctionActor.declare(builder, 'add', type)
    const closed = yield* buildAdd(builder, fn)

    const reuse = yield* Effect.flip(Block.make(closed, 'late'))
    assert.instanceOf(reuse, LlvmError)
    const duplicate = yield* Effect.flip(buildAdd(builder, fn))
    assert.include(duplicate.message, 'already has a committed body')
  }),
)

it.effect('places fixed call storage in entry without moving the loop insertion point', () =>
  Effect.gen(function* () {
    const builder = yield* Builder.make()
    const i32 = yield* Type.integer(builder, 32)
    const fn = yield* FunctionActor.declare(
      builder,
      'entry_storage',
      yield* Type.functionType(builder, i32, [i32]),
    )
    yield* FunctionActor.buildBody(
      builder,
      fn,
      Effect.fnUntraced(function* (body) {
        yield* Block.make(body, 'entry')
        const loop = yield* Block.make(body, 'loop')
        yield* FunctionBody.branch(body, loop)
        yield* Block.setInsertionPoint(body, loop)
        const argument = yield* Value.argument(body, 0)
        const rejected = yield* Effect.flip(
          FunctionBody.alloca(body, i32, 'dynamic', { placement: 'entry', count: argument }),
        )
        assert.instanceOf(rejected, LlvmError)
        const slot = yield* FunctionBody.alloca(body, i32, 'result', { placement: 'entry' })
        yield* FunctionBody.store(body, argument, slot)
        yield* FunctionBody.returnValue(body, yield* FunctionBody.load(body, i32, slot, 'read'))
      }),
    )
    const ir = yield* IrText.render(builder)
    assert.match(ir, /entry:\n\s+%result = alloca i32[^]*?br label %loop/)
    assert.match(ir, /loop:\n\s+store i32 %v0, ptr %result/)
    assert.notMatch(ir, /loop:[^]*?alloca/)
  }),
)

it.effect('local handles retain an owner identity, not the function construction graph', () =>
  Effect.gen(function* () {
    const builder = yield* Builder.make()
    const i32 = yield* Type.integer(builder, 32)
    const type = yield* Type.functionType(builder, i32, [i32])
    const fn = yield* FunctionActor.declare(builder, 'local_ownership', type)
    yield* FunctionActor.buildBody(
      builder,
      fn,
      Effect.fnUntraced(function* (body) {
        const block = yield* Block.make(body, 'entry')
        const argument = yield* Value.argument(body, 0)
        const sum = yield* FunctionBody.binary(body, 'add', argument, argument)
        const instruction =
          (yield* Value.instruction(body, sum)) ?? raise('expected an instruction')
        const draft = BodyState.drafts.get(body) ?? raise('expected an active draft')
        // Structural lifetime contract: an escaped local retains only its owner identity and
        // index, never sibling handles, the mutable draft, or its builder.
        for (const [handle, index] of [
          [block, 0],
          [argument, 0],
          [sum, 1],
          [instruction, 0],
        ] as const) {
          assert.strictEqual(Handle.ownerOf(handle), draft.owner)
          assert.strictEqual(Handle.indexOf(handle), index)
        }
        yield* FunctionBody.returnValue(body, sum)
      }),
    )
  }),
)

it.effect('emits the same body synchronously and rolls back an aborted session', () =>
  Effect.gen(function* () {
    const emit = (session: Emitter.Module, fn: FunctionActor.Function, i32: Type.Type) =>
      Emitter.buildBody(session, fn, (body) => {
        Emitter.block(body, 'entry')
        const sum = Emitter.binary(
          body,
          'add',
          Emitter.argument(body, 0),
          Emitter.integerUnsigned(body, i32, 1),
          'sum',
        )
        Emitter.returnValue(body, sum)
      })
    const renders: Array<string> = []
    for (const synchronous of [false, true]) {
      const builder = yield* Builder.make()
      const i32 = yield* Type.integer(builder, 32)
      const fn = yield* FunctionActor.declare(
        builder,
        'increment',
        yield* Type.functionType(builder, i32, [i32]),
      )
      if (synchronous) yield* Emitter.module(builder, (session) => emit(session, fn, i32))
      else
        yield* FunctionActor.buildBody(
          builder,
          fn,
          Effect.fnUntraced(function* (body) {
            yield* Block.make(body, 'entry')
            const argument = yield* Value.argument(body, 0)
            const one = yield* Constant.integerUnsigned(builder, i32, 1)
            yield* FunctionBody.returnValue(
              body,
              yield* FunctionBody.binary(body, 'add', argument, one, 'sum'),
            )
          }),
        )
      renders.push(yield* IrText.render(builder))
    }
    assert.strictEqual(renders[0], renders[1])

    const builder = yield* Builder.make()
    const i32 = yield* Type.integer(builder, 32)
    const fn = yield* FunctionActor.declare(
      builder,
      'retry',
      yield* Type.functionType(builder, i32, [i32]),
    )
    const aborted = yield* Effect.flip(
      Emitter.module(builder, (session) =>
        Emitter.buildBody(session, fn, (body) => {
          Emitter.block(body, 'entry')
          Emitter.returnValue(body, Emitter.integerSigned(body, i32, 1n << 40n))
        }),
      ),
    )
    assert.include(aborted.message, 'does not fit')
    yield* Emitter.module(builder, (session) => emit(session, fn, i32))
    assert.include(yield* IrText.render(builder), 'define i32 @retry(i32 %v0)')
  }),
)

it.effect('rolls back callback and validation failures without exposing partial bodies', () =>
  Effect.gen(function* () {
    const builder = yield* Builder.make()
    const voidType = yield* Type.voidType(builder)
    const type = yield* Type.functionType(builder, voidType, [])
    const fn = yield* FunctionActor.declare(builder, 'retry', type)

    const callbackFailure = yield* Effect.flip(
      FunctionActor.buildBody(
        builder,
        fn,
        Effect.fnUntraced(function* (body) {
          yield* Block.make(body, 'discarded')
          return yield* invalidInput({ operation: 'test', message: 'discard this body', input: fn })
        }),
      ),
    )
    assert.strictEqual(callbackFailure.message, 'discard this body')

    const validationFailure = yield* Effect.flip(
      FunctionActor.buildBody(
        builder,
        fn,
        Effect.fnUntraced(function* (body) {
          yield* Block.make(body, 'unterminated')
        }),
      ),
    )
    assert.include(validationFailure.message, 'terminator')

    const phiFailure = yield* Effect.flip(
      FunctionActor.buildBody(
        builder,
        fn,
        Effect.fnUntraced(function* (body) {
          const entry = yield* Block.make(body, 'entry')
          const merge = yield* Block.make(body, 'merge')
          yield* Block.setInsertionPoint(body, entry)
          yield* FunctionBody.branch(body, merge)
          yield* Block.setInsertionPoint(body, merge)
          const phi = yield* FunctionBody.phi(body, voidType, 'malformed')
          yield* FunctionBody.sealPhi(body, phi)
          yield* FunctionBody.returnVoid(body)
        }),
      ),
    )
    assert.include(phiFailure.message, 'cover every predecessor')

    yield* FunctionActor.buildBody(
      builder,
      fn,
      Effect.fnUntraced(function* (body) {
        yield* Block.make(body, 'entry')
        yield* FunctionBody.returnVoid(body)
      }),
    )
    assert.include(yield* IrText.render(builder), 'define void @retry()')
  }),
)

it.effect('releases body reservations after defects and interruption while rejecting overlap', () =>
  Effect.gen(function* () {
    const builder = yield* Builder.make()
    const voidType = yield* Type.voidType(builder)
    const type = yield* Type.functionType(builder, voidType, [])
    const defectFunction = yield* FunctionActor.declare(builder, 'defect_retry', type)
    const interruptedFunction = yield* FunctionActor.declare(builder, 'interrupt_retry', type)

    const defectExit = yield* Effect.exit(
      FunctionActor.buildBody(
        builder,
        defectFunction,
        Effect.fnUntraced(function* (body) {
          yield* Block.make(body, 'discarded')
          return yield* Effect.die(new Error('body callback defect'))
        }),
      ),
    )
    assert.isTrue(Exit.isFailure(defectExit))
    if (Exit.isFailure(defectExit)) assert.isTrue(Cause.hasDies(defectExit.cause))

    yield* FunctionActor.buildBody(
      builder,
      defectFunction,
      Effect.fnUntraced(function* (body) {
        yield* Block.make(body, 'entry')
        yield* FunctionBody.returnVoid(body)
      }),
    )

    const started = yield* Deferred.make<void>()
    const active = yield* Effect.forkChild(
      FunctionActor.buildBody(
        builder,
        interruptedFunction,
        Effect.fnUntraced(function* (body) {
          yield* Block.make(body, 'discarded')
          yield* Deferred.succeed(started, undefined)
          return yield* Effect.never
        }),
      ),
    )
    yield* Deferred.await(started)

    const overlap = yield* Effect.flip(
      FunctionActor.buildBody(
        builder,
        interruptedFunction,
        Effect.fnUntraced(function* (body) {
          yield* Block.make(body, 'overlap')
          yield* FunctionBody.returnVoid(body)
        }),
      ),
    )
    assert.include(overlap.message, 'already in progress')

    yield* Fiber.interrupt(active)
    const interruptedExit = yield* Fiber.await(active)
    assert.isTrue(Exit.isFailure(interruptedExit))
    if (Exit.isFailure(interruptedExit)) {
      assert.isTrue(Cause.hasInterrupts(interruptedExit.cause))
    }

    yield* FunctionActor.buildBody(
      builder,
      interruptedFunction,
      Effect.fnUntraced(function* (body) {
        yield* Block.make(body, 'entry')
        yield* FunctionBody.returnVoid(body)
      }),
    )
    const text = yield* IrText.render(builder)
    assert.include(text, 'define void @defect_retry()')
    assert.include(text, 'define void @interrupt_retry()')
  }),
)

it.effect('rejects values and blocks owned by another function body', () =>
  Effect.gen(function* () {
    const builder = yield* Builder.make()
    const i32 = yield* Type.integer(builder, 32)
    const type = yield* Type.functionType(builder, i32, [i32])
    const first = yield* FunctionActor.declare(builder, 'first', type)
    const second = yield* FunctionActor.declare(builder, 'second', type)
    const foreign = yield* FunctionActor.buildBody(
      builder,
      first,
      Effect.fnUntraced(function* (body) {
        yield* Block.make(body, 'entry')
        const argument = yield* Value.argument(body, 0)
        yield* FunctionBody.returnValue(body, argument)
        return argument
      }),
    )

    const error = yield* Effect.flip(
      FunctionActor.buildBody(
        builder,
        second,
        Effect.fnUntraced(function* (body) {
          yield* Block.make(body, 'entry')
          yield* FunctionBody.returnValue(body, foreign)
        }),
      ),
    )
    assert.include(error.message, 'different function body')
  }),
)

it.effect('rejects use of a draft from a child fiber', () =>
  Effect.gen(function* () {
    const builder = yield* Builder.make()
    const voidType = yield* Type.voidType(builder)
    const type = yield* Type.functionType(builder, voidType, [])
    const fn = yield* FunctionActor.declare(builder, 'fiber_owned', type)

    yield* FunctionActor.buildBody(
      builder,
      fn,
      Effect.fnUntraced(function* (body) {
        yield* Block.make(body, 'entry')
        const child = yield* Effect.forkChild(Block.make(body, 'foreign'))
        const error = yield* Effect.flip(Fiber.join(child))
        assert.include(error.message, 'another fiber')
        yield* FunctionBody.returnVoid(body)
      }),
    )
  }),
)

it.effect('builds arithmetic, comparisons, casts, selects, and aggregate operations', () =>
  Effect.gen(function* () {
    const builder = yield* Builder.make()
    const i1 = yield* Type.integer(builder, 1)
    const i32 = yield* Type.integer(builder, 32)
    const i64 = yield* Type.integer(builder, 64)
    const pair = yield* Type.structure(builder, [i32, i64])
    const type = yield* Type.functionType(builder, i64, [i32, i32, i1])
    const fn = yield* FunctionActor.declare(builder, 'core_ops', type)

    yield* FunctionActor.buildBody(
      builder,
      fn,
      Effect.fnUntraced(function* (body) {
        yield* Block.make(body, 'entry')
        const left = yield* Value.argument(body, 0)
        const right = yield* Value.argument(body, 1)
        const condition = yield* Value.argument(body, 2)
        const sum = yield* FunctionBody.binary(body, 'add', left, right, 'sum', {
          noSignedWrap: true,
        })
        const different = yield* FunctionBody.integerCompare(body, 'ne', left, right, 'different')
        const chosen = yield* FunctionBody.select(body, different, sum, left, 'chosen')
        const widened = yield* FunctionBody.cast(body, 'zext', chosen, i64, 'widened')
        const empty = yield* Constant.poison(builder, pair)
        const withLeft = yield* FunctionBody.insertValue(body, empty, chosen, [0], 'with_left')
        const withBoth = yield* FunctionBody.insertValue(body, withLeft, widened, [1], 'with_both')
        const extracted = yield* FunctionBody.extractValue(body, withBoth, [1], 'extracted')
        const selected = yield* FunctionBody.select(body, condition, extracted, widened, 'selected')
        yield* FunctionBody.returnValue(body, selected)
      }),
    )

    const text = yield* IrText.render(builder)
    assert.include(text, '%sum = add nsw i32 %v0, %v1')
    assert.include(text, '%different = icmp ne i32 %v0, %v1')
    assert.include(text, '%widened = zext i32 %chosen to i64')
    assert.include(text, 'insertvalue')
    assert.include(text, 'extractvalue')
  }),
)

it.effect('builds a diamond with branches, a forward-aware phi, and a direct call', () =>
  Effect.gen(function* () {
    const builder = yield* Builder.make({ sourceFilename: 'core.ll' })
    const i32 = yield* Type.integer(builder, 32)
    const binaryType = yield* Type.functionType(builder, i32, [i32, i32])
    const callee = yield* FunctionActor.declare(builder, 'callee', binaryType)
    yield* buildAdd(builder, callee)
    const fn = yield* FunctionActor.declare(builder, 'diamond', binaryType)

    yield* FunctionActor.buildBody(
      builder,
      fn,
      Effect.fnUntraced(function* (body) {
        const entry = yield* Block.make(body, 'entry')
        const onTrue = yield* Block.make(body, 'on_true')
        const onFalse = yield* Block.make(body, 'on_false')
        const merge = yield* Block.make(body, 'merge')
        yield* Block.setInsertionPoint(body, entry)
        const left = yield* Value.argument(body, 0)
        const right = yield* Value.argument(body, 1)
        const condition = yield* FunctionBody.integerCompare(body, 'sgt', left, right, 'condition')
        yield* FunctionBody.conditionalBranch(body, condition, onTrue, onFalse, 'true-likely')

        yield* Block.setInsertionPoint(body, onTrue)
        const added = yield* FunctionBody.callDirect(body, callee, [left, right], 'added')
        if (added === undefined) {
          return yield* invalidInput({
            operation: 'test',
            message: 'expected call result',
            input: callee,
          })
        }
        yield* FunctionBody.branch(body, merge)

        yield* Block.setInsertionPoint(body, onFalse)
        const subtracted = yield* FunctionBody.binary(body, 'sub', left, right, 'subtracted')
        yield* FunctionBody.branch(body, merge)

        yield* Block.setInsertionPoint(body, merge)
        const phi = yield* FunctionBody.phi(body, i32, 'result')
        yield* FunctionBody.addPhiIncoming(body, phi, added, onTrue)
        const duplicate = yield* Effect.flip(
          FunctionBody.addPhiIncoming(body, phi, subtracted, onTrue),
        )
        assert.strictEqual(duplicate.reason._tag, 'InvalidState')
        yield* FunctionBody.addPhiIncoming(body, phi, subtracted, onFalse)
        const result = yield* FunctionBody.sealPhi(body, phi)
        const sealed = yield* Effect.flip(
          FunctionBody.addPhiIncoming(body, phi, subtracted, onFalse),
        )
        assert.strictEqual(sealed.reason._tag, 'InvalidState')
        yield* FunctionBody.returnValue(body, result)
      }),
    )

    const text = yield* IrText.render(builder)
    assert.include(text, 'define i32 @diamond(i32 %v0, i32 %v1)')
    assert.include(text, 'br i1 %condition, label %on_true, label %on_false')
    assert.include(text, '%added = call i32 @callee(i32 %v0, i32 %v1)')
    assert.include(text, '%result = phi i32 [ %added, %on_true ], [ %subtracted, %on_false ]')
  }),
)

it.effect('builds and finalizes switches with unique cases', () =>
  Effect.gen(function* () {
    const builder = yield* Builder.make()
    const i32 = yield* Type.integer(builder, 32)
    const type = yield* Type.functionType(builder, i32, [i32])
    const fn = yield* FunctionActor.declare(builder, 'choose', type)
    const zero = yield* Constant.integerUnsigned(builder, i32, 0)
    const one = yield* Constant.integerUnsigned(builder, i32, 1)

    yield* FunctionActor.buildBody(
      builder,
      fn,
      Effect.fnUntraced(function* (body) {
        const entry = yield* Block.make(body, 'entry')
        const fallback = yield* Block.make(body, 'fallback')
        const selected = yield* Block.make(body, 'selected')
        yield* Block.setInsertionPoint(body, entry)
        const argument = yield* Value.argument(body, 0)
        const switchHandle = yield* FunctionBody.switchTerminator(body, argument, fallback)
        // Cases may be added after the insertion point has moved away from the switch.
        yield* Block.setInsertionPoint(body, selected)
        yield* FunctionBody.addSwitchCase(body, switchHandle, zero, selected)
        const duplicate = yield* Effect.flip(
          FunctionBody.addSwitchCase(body, switchHandle, zero, fallback),
        )
        assert.include(duplicate.message, 'unique')
        yield* FunctionBody.sealSwitch(body, switchHandle)
        yield* Block.setInsertionPoint(body, fallback)
        yield* FunctionBody.returnValue(body, one)
        yield* Block.setInsertionPoint(body, selected)
        const phi = yield* FunctionBody.phi(body, i32, 'selected_value')
        yield* FunctionBody.addPhiIncoming(body, phi, zero, entry)
        yield* FunctionBody.returnValue(body, yield* FunctionBody.sealPhi(body, phi))
      }),
    )

    assert.include(yield* IrText.render(builder), 'switch i32 %v0, label %fallback')
  }),
)

it.effect('resolves a loop-carried forward value and validates complete phi coverage', () =>
  Effect.gen(function* () {
    const builder = yield* Builder.make()
    const i32 = yield* Type.integer(builder, 32)
    const type = yield* Type.functionType(builder, i32, [i32])
    const fn = yield* FunctionActor.declare(builder, 'loop', type)
    const one = yield* Constant.integerUnsigned(builder, i32, 1)
    const ten = yield* Constant.integerUnsigned(builder, i32, 10)

    yield* FunctionActor.buildBody(
      builder,
      fn,
      Effect.fnUntraced(function* (body) {
        const entry = yield* Block.make(body, 'entry')
        const loop = yield* Block.make(body, 'loop')
        const exit = yield* Block.make(body, 'exit')
        yield* Block.setInsertionPoint(body, entry)
        const initial = yield* Value.argument(body, 0)
        yield* FunctionBody.branch(body, loop)

        yield* Block.setInsertionPoint(body, loop)
        const nextForward = yield* Value.forward(body, i32, 'next_forward')
        const phi = yield* FunctionBody.phi(body, i32, 'current')
        yield* FunctionBody.addPhiIncoming(body, phi, initial, entry)
        yield* FunctionBody.addPhiIncoming(body, phi, nextForward, loop)
        const current = yield* FunctionBody.phiValue(body, phi)
        const next = yield* FunctionBody.binary(body, 'add', current, one, 'next')
        yield* Value.resolveForward(body, nextForward, next)
        const keepGoing = yield* FunctionBody.integerCompare(body, 'slt', next, ten, 'keep_going')
        yield* FunctionBody.conditionalBranch(body, keepGoing, loop, exit)
        yield* FunctionBody.sealPhi(body, phi)

        yield* Block.setInsertionPoint(body, exit)
        yield* FunctionBody.returnValue(body, next)
      }),
    )

    const text = yield* IrText.render(builder)
    assert.include(text, '%current = phi i32 [ %v0, %entry ], [ %next, %loop ]')
  }),
)

it.effect('validates vararg calls and preserves call settings', () =>
  Effect.gen(function* () {
    const builder = yield* Builder.make()
    const i32 = yield* Type.integer(builder, 32)
    const calleeType = yield* Type.functionType(builder, i32, [i32], { variadic: true })
    const nounwind = yield* Attribute.flag(builder, 'nounwind')
    const attributes = yield* Attribute.functionSet(builder, {
      functionAttributes: yield* Attribute.set(builder, [nounwind]),
    })
    const callee = yield* FunctionActor.declare(builder, 'variadic', calleeType, { attributes })
    const callerType = yield* Type.functionType(builder, i32, [i32])
    const caller = yield* FunctionActor.declare(builder, 'call_variadic', callerType)
    const one = yield* Constant.integerUnsigned(builder, i32, 1)

    yield* FunctionActor.buildBody(
      builder,
      caller,
      Effect.fnUntraced(function* (body) {
        yield* Block.make(body, 'entry')
        const argument = yield* Value.argument(body, 0)
        const invalid = yield* Effect.flip(FunctionBody.callDirect(body, callee, []))
        assert.include(invalid.message, 'argument count')
        const invalidConvention = yield* Effect.flip(
          FunctionBody.callDirect(body, callee, [argument], undefined, {
            callingConvention: -1,
          }),
        )
        assert.include(invalidConvention.message, 'unsigned 10-bit')
        const result = yield* FunctionBody.callDirect(body, callee, [argument, one], 'result', {
          tail: 'tail',
        })
        if (result === undefined) {
          return yield* invalidInput({
            operation: 'test',
            message: 'expected call result',
            input: callee,
          })
        }
        yield* FunctionBody.returnValue(body, result)
      }),
    )

    assert.include(
      yield* IrText.render(builder),
      '%result = tail call i32 (i32, ...) @variadic(i32 %v0, i32 1) nounwind',
    )
  }),
)

it.effect('rejects unresolved and cyclic forward chains and releases the body reservation', () =>
  Effect.gen(function* () {
    const builder = yield* Builder.make()
    const i32 = yield* Type.integer(builder, 32)
    const signature = yield* Type.functionType(builder, i32, [])
    const zero = yield* Constant.integerUnsigned(builder, i32, 0)
    for (const cyclic of [false, true]) {
      const fn = yield* FunctionActor.declare(builder, cyclic ? 'cyclic' : 'unresolved', signature)
      const failure = yield* Effect.flip(
        FunctionActor.buildBody(
          builder,
          fn,
          Effect.fnUntraced(function* (body) {
            yield* Block.make(body, 'entry')
            const first = yield* Value.forward(body, i32)
            const second = yield* Value.forward(body, i32)
            yield* Value.resolveForward(body, first, second)
            if (cyclic) yield* Value.resolveForward(body, second, first)
            // An unused reservation must also be checked by the commit sweep.
            yield* FunctionBody.returnValue(body, zero)
          }),
        ),
      )
      assert.strictEqual(failure._tag, 'LlvmError')
      assert.strictEqual(failure.operation, 'FunctionBody.validate')
      assert.strictEqual(failure.reason._tag, 'InvalidInput')
      yield* FunctionActor.buildBody(
        builder,
        fn,
        Effect.fnUntraced(function* (body) {
          yield* Block.make(body, 'retry')
          yield* FunctionBody.returnValue(body, zero)
        }),
      )
    }
  }),
)
