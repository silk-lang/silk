import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Block from '../src/Block.js'
import * as Builder from '../src/Builder.js'
import * as DIFlags from '../src/DIFlags.js'
import * as DISPFlags from '../src/DISPFlags.js'
import * as FunctionActor from '../src/Function.js'
import * as FunctionBody from '../src/FunctionBody.js'
import * as IrText from '../src/IrText.js'
import { LlvmError } from '../src/LlvmError.js'
import * as Metadata from '../src/Metadata.js'
import * as Type from '../src/Type.js'
import * as Value from '../src/Value.js'
import { raise } from './support/raise.js'

const required = <A>(value: A | undefined, message: string): A => value ?? raise(message)

it.effect(
  'preserves metadata string bytes, uniqued identity, distinct identity, and builder ownership',
  () =>
    Effect.gen(function* () {
      const builder = yield* Builder.make({ strip: false })
      const other = yield* Builder.make({ strip: false })
      const first = yield* Metadata.string(builder, new Uint8Array([0x61, 0, 0xff]))
      const second = yield* Metadata.string(builder, new Uint8Array([0x61, 0, 0xff]))
      assert.strictEqual(first, second)
      const tuple = yield* Metadata.tuple(builder, [first])
      assert.strictEqual(yield* Metadata.tuple(builder, [first]), tuple)
      assert.notStrictEqual(
        yield* Metadata.distinctTuple(builder, [first]),
        yield* Metadata.distinctTuple(builder, [first]),
      )
      assert.strictEqual(yield* Metadata.emptyTuple(builder), yield* Metadata.emptyTuple(builder))
      const inspected = yield* Metadata.inspect(builder, first)
      assert.strictEqual(inspected._tag, 'String')
      const inspectedString = inspected._tag === 'String' ? inspected : raise('expected a string')
      assert.deepEqual(inspectedString.value.bytes, Uint8Array.of(0x61, 0, 0xff))
      assert.instanceOf(yield* Effect.flip(Metadata.tuple(other, [first])), LlvmError)
      const diFlags = DIFlags.make({
        visibility: 'public',
        inheritance: 'virtual',
        forwardDeclaration: true,
        allCallsDescribed: true,
      })
      assert.strictEqual(DIFlags.toBitcode(diFlags), 3 | (1 << 2) | (3 << 16) | (1 << 29))
      assert.deepEqual(DIFlags.toText(diFlags), [
        'DIFlagPublic',
        'DIFlagFwdDecl',
        'DIFlagVirtualInheritance',
        'DIFlagAllCallsDescribed',
      ])
      const spFlags = DISPFlags.make({
        virtuality: 'pureVirtual',
        definition: true,
        optimized: true,
      })
      assert.strictEqual(DISPFlags.toBitcode(spFlags), 2 | (1 << 3) | (1 << 4))
      assert.deepEqual(DISPFlags.toText(spFlags), [
        'DISPFlagPureVirtual',
        'DISPFlagDefinition',
        'DISPFlagOptimized',
      ])
    }),
)

it.effect(
  'resolves recursive metadata graphs once and rejects reachable unresolved references',
  () =>
    Effect.gen(function* () {
      const builder = yield* Builder.make({ strip: false })
      const forward = required(yield* Metadata.forward(builder, 'node'), 'expected forward')
      const recursive = yield* Metadata.tuple(builder, [forward])
      yield* Metadata.resolveForward(builder, forward, recursive)
      yield* Metadata.named(builder, 'recursive', [recursive])
      assert.include(yield* IrText.render(builder), '!recursive = !{!0}')
      assert.instanceOf(
        yield* Effect.flip(Metadata.resolveForward(builder, forward, recursive)),
        LlvmError,
      )

      const unreachable = required(yield* Metadata.forward(builder), 'expected unreachable forward')
      assert.isDefined(unreachable)
      yield* IrText.render(builder)

      const leftForward = required(yield* Metadata.forward(builder), 'expected left forward')
      const rightForward = required(yield* Metadata.forward(builder), 'expected right forward')
      const left = yield* Metadata.tuple(builder, [rightForward])
      const right = yield* Metadata.tuple(builder, [leftForward])
      yield* Metadata.resolveForward(builder, leftForward, left)
      yield* Metadata.resolveForward(builder, rightForward, right)
      yield* Metadata.named(builder, 'mutual', [left])
      assert.include(yield* IrText.render(builder), '!mutual = !{')

      const unresolved = required(yield* Metadata.forward(builder), 'expected unresolved forward')
      yield* Metadata.named(builder, 'broken', [unresolved])
      const failure = yield* Effect.flip(IrText.render(builder))
      assert.include(failure.message, 'unresolved forward references')

      const typed = required(yield* Metadata.forward(builder, 'type'), 'expected typed forward')
      const filename = yield* Metadata.string(builder, 'source.c')
      const file = required(yield* Metadata.file(builder, filename), 'expected file')
      assert.instanceOf(
        yield* Effect.flip(Metadata.resolveForward(builder, typed, file)),
        LlvmError,
      )
    }),
)

it.effect(
  'renders recursive debug nodes, flags, attachments, and changing instruction locations',
  () =>
    Effect.gen(function* () {
      const builder = yield* Builder.make({ strip: false, sourceFilename: 'source.c' })
      const voidType = yield* Type.voidType(builder)
      const i32 = yield* Type.integer(builder, 32)
      const filename = yield* Metadata.string(builder, 'source.c')
      const directory = yield* Metadata.string(builder, '/src')
      const producer = yield* Metadata.string(builder, 'silk-effect')
      const intName = yield* Metadata.string(builder, 'int')
      const functionName = yield* Metadata.string(builder, 'debugged')
      const file = required(yield* Metadata.file(builder, filename, directory), 'expected file')
      const intType = required(
        yield* Metadata.signedType(builder, intName, 32),
        'expected basic type',
      )
      const stringType = required(
        yield* Metadata.stringType(builder, {
          name: yield* Metadata.string(builder, 'string'),
          sizeInBits: 128,
          alignInBits: 64,
          encoding: 'utf',
        }),
        'expected string type',
      )
      const recursiveForward = required(
        yield* Metadata.forward(builder, 'type'),
        'expected type forward',
      )
      const pointer = required(
        yield* Metadata.pointerType(builder, {
          underlyingType: recursiveForward,
          sizeInBits: 64,
          alignInBits: 64,
        }),
        'expected pointer type',
      )
      const fields = yield* Metadata.tuple(builder, [pointer])
      const structure = required(
        yield* Metadata.structureType(builder, {
          name: yield* Metadata.string(builder, 'Node'),
          file,
          sizeInBits: 64,
          alignInBits: 64,
          fields,
        }),
        'expected structure type',
      )
      yield* Metadata.resolveForward(builder, recursiveForward, structure)
      const types = yield* Metadata.tuple(builder, [undefined, intType, structure, stringType])
      const signature = required(
        yield* Metadata.subroutineType(builder, types, DIFlags.make({ prototyped: true })),
        'expected debug signature',
      )
      const globals = yield* Metadata.tuple(builder)
      const unit = required(
        yield* Metadata.compileUnit(builder, file, producer, { globals }),
        'expected compile unit',
      )
      yield* Metadata.named(builder, 'llvm.dbg.cu', [unit])
      const subprogram = required(
        yield* Metadata.subprogram(builder, file, functionName, {
          line: 7,
          scopeLine: 7,
          type: signature,
          diFlags: DIFlags.make({ prototyped: true, allCallsDescribed: true }),
          spFlags: DISPFlags.make({ definition: true }),
          compileUnit: unit,
        }),
        'expected subprogram',
      )
      const location = required(
        yield* Metadata.location(builder, 8, 3, subprogram),
        'expected location',
      )
      const nextLocation = required(
        yield* Metadata.location(builder, 9, 1, subprogram),
        'expected next location',
      )
      const functionType = yield* Type.functionType(builder, voidType, [i32])
      const fn = yield* FunctionActor.declare(builder, 'debugged', functionType)
      yield* FunctionActor.setSubprogram(builder, fn, subprogram)
      yield* FunctionActor.buildBody(
        builder,
        fn,
        Effect.fnUntraced(function* (body) {
          yield* Block.make(body, 'entry')
          const local = yield* FunctionBody.alloca(body, i32, 'local')
          const alloca = required(yield* Value.instruction(body, local), 'expected alloca')
          const argument = yield* Value.argument(body, 0)
          const store = yield* FunctionBody.store(body, argument, local)
          const returned = yield* FunctionBody.returnVoid(body)
          yield* FunctionBody.setDebugLocation(body, alloca, location)
          yield* FunctionBody.setDebugLocation(body, store, location)
          yield* FunctionBody.setDebugLocation(body, returned, nextLocation)
        }),
      )

      const ir = yield* IrText.render(builder)
      assert.include(ir, '!DICompileUnit(')
      assert.include(ir, 'distinct !DISubprogram(')
      assert.include(ir, '!DICompositeType(tag: DW_TAG_structure_type')
      assert.include(
        ir,
        '!DIStringType(name: "string", size: 128, align: 64, encoding: DW_ATE_UTF)',
      )
      assert.strictEqual(ir.match(/!dbg !/g)?.length, 4)
      assert.include(ir, 'DIFlagAllCallsDescribed')
    }),
)

it.effect('strip mode omits debug allocation, attachments, and named metadata', () =>
  Effect.gen(function* () {
    const builder = yield* Builder.make({ strip: true })
    const filename = yield* Metadata.string(builder, 'stripped.c')
    assert.isUndefined(yield* Metadata.file(builder, filename))
    assert.isUndefined(yield* Metadata.forward(builder, 'type'))
    yield* Metadata.named(builder, 'llvm.dbg.cu', [])
    assert.notInclude(yield* IrText.render(builder), '!llvm.dbg.cu')

    const build = Effect.fnUntraced(function* (strip: boolean) {
      const current = yield* Builder.make({ strip })
      const voidType = yield* Type.voidType(current)
      const signature = yield* Type.functionType(current, voidType, [])
      const fn = yield* FunctionActor.declare(current, 'same_program', signature)
      const name = yield* Metadata.string(current, 'same_program')
      const source = required(
        (yield* Metadata.file(current, yield* Metadata.string(current, 'same.c'))) ?? name,
        'expected debug source',
      )
      const subprogram = yield* Metadata.subprogram(current, source, name, {
        spFlags: DISPFlags.make({ definition: true }),
      })
      yield* FunctionActor.setSubprogram(current, fn, subprogram)
      yield* FunctionActor.buildBody(
        current,
        fn,
        Effect.fnUntraced(function* (body) {
          yield* Block.make(body, 'entry')
          const returned = yield* FunctionBody.returnVoid(body)
          if (subprogram !== undefined) {
            yield* FunctionBody.setDebugLocation(
              body,
              returned,
              yield* Metadata.location(current, 1, 1, subprogram),
            )
          }
        }),
      )
      return yield* IrText.render(current)
    })
    const stripped = yield* build(true)
    const preserving = yield* build(false)
    const executable = (ir: string): string =>
      ir
        .split('\n')
        .filter((line) => !line.startsWith('!'))
        .join('\n')
        .replaceAll(/, !dbg !\d+/g, '')
        .replaceAll(/ !dbg !\d+/g, '')
        .trimEnd()
    assert.strictEqual(executable(stripped), executable(preserving))
  }),
)

it.effect('validates integer-valued debug fields before bigint conversion', () =>
  Effect.gen(function* () {
    const builder = yield* Builder.make({ strip: false })
    const name = yield* Metadata.string(builder, 'bad')
    for (const sizeInBits of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.instanceOf(
        yield* Effect.flip(Metadata.basicType(builder, 'signed', name, sizeInBits)),
        LlvmError,
      )
    }
    assert.instanceOf(
      yield* Effect.flip(Metadata.structureType(builder, { sizeInBits: -1 })),
      LlvmError,
    )
    assert.instanceOf(
      yield* Effect.flip(Metadata.stringType(builder, { alignInBits: -1 })),
      LlvmError,
    )
    assert.instanceOf(
      yield* Effect.flip(
        Metadata.memberType(builder, { offsetInBits: Number.MAX_SAFE_INTEGER + 1 }),
      ),
      LlvmError,
    )
  }),
)
