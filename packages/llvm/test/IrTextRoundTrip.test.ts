import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, assert, it } from '@effect/vitest'
import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import { llvmToolchain } from '../../../test/support/llvmToolchain.js'
import * as Bitcode from '../src/Bitcode.js'
import * as Block from '../src/Block.js'
import * as Builder from '../src/Builder.js'
import * as Constant from '../src/Constant.js'
import * as FunctionActor from '../src/Function.js'
import * as FunctionBody from '../src/FunctionBody.js'
import * as IrText from '../src/IrText.js'
import * as Metadata from '../src/Metadata.js'
import * as Type from '../src/Type.js'
import * as Value from '../src/Value.js'
import * as Verify from '../src/Verify.js'
import { raise } from './support/raise.js'

const directory = mkdtempSync(join(tmpdir(), 'silk-effect-llvm-roundtrip-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

const toolchain = llvmToolchain(
  ['llvm-as', 'llvm-dis', 'opt'],
  'the IR round-trip check',
  (message) => Effect.runSync(Console.log(message)),
)

const required = <A>(value: A | undefined, message: string): A => value ?? raise(message)

interface Canonical {
  /**
   * The module with locals renumbered. `Bitcode.encode` writes no function-level value symbol
   * table, so local names survive only along the textual path and the two can be compared on
   * instructions and constants only once both sides are numbered.
   */
  readonly body: string
  /**
   * The module's metadata definitions, which the renumbering pass discards along with the rest of
   * the debug graph and which therefore have to be compared before it runs.
   */
  readonly metadata: string
}

const write = (name: string, contents: Uint8Array | string): string => {
  const path = join(directory, name)
  writeFileSync(path, contents)
  return path
}

const llvmAs = (name: string, source: string): Uint8Array => {
  const assembled = join(directory, name)
  execFileSync(toolchain.command('llvm-as'), [source, '-o', assembled])
  return readFileSync(assembled)
}

const llvmDis = (name: string, bitcode: Uint8Array): string => {
  const output = join(directory, name)
  execFileSync(toolchain.command('llvm-dis'), [write(`${name}.bc`, bitcode), '-o', output])
  // `llvm-dis` names the module after whichever file it read.
  return readFileSync(output, 'utf8')
    .split('\n')
    .filter((line) => !line.startsWith('; ModuleID ='))
    .join('\n')
}

/**
 * Reduces a module to the form the two emission paths can be compared in.
 *
 * Both sides go through `llvm-as` first. The textual parser resolves an omitted `align` against the
 * module's data layout as it reads, while bitcode leaves the operand unspecified for its consumer
 * to resolve, so only modules that entered through the same door are comparable.
 */
const canonical = (name: string, bitcode: Uint8Array): Canonical => {
  const materialized = llvmAs(
    `${name}.materialized.bc`,
    write(`${name}.dis.ll`, llvmDis(`${name}.dis`, bitcode)),
  )
  const stripped = join(directory, `${name}.stripped.bc`)
  execFileSync(toolchain.command('opt'), [
    '-passes=strip',
    write(`${name}.materialized.input.bc`, materialized),
    '-o',
    stripped,
  ])
  return {
    body: llvmDis(`${name}.stripped.ll`, readFileSync(stripped)),
    metadata: llvmDis(`${name}.whole.ll`, materialized)
      .split('\n')
      .filter((line) => line.startsWith('!'))
      .join('\n'),
  }
}

/**
 * Assembles rendered text and reduces it the same way.
 *
 * `llvm-as` is the arbiter the golden tests cannot be: goldens compare rendered text against
 * stored rendered text, so a systematic renderer flaw compares equal to itself forever.
 */
const assemble = (name: string, text: string): Canonical => {
  const assembled = llvmAs(`${name}.assembled.bc`, write(`${name}.source.ll`, text))
  execFileSync(toolchain.command('opt'), [
    '-passes=verify',
    write(`${name}.verify.bc`, assembled),
    '-disable-output',
  ])
  return canonical(`${name}-text`, assembled)
}

it.effect(
  'round-trips typed and signature-typed references to later-listed dominating blocks',
  () =>
    Effect.gen(function* () {
      const builder = yield* Builder.make({ sourceFilename: 'forward-block.ll' })
      const i32 = yield* Type.integer(builder, 32)
      const i64 = yield* Type.integer(builder, 64)
      const fixed = yield* FunctionActor.declare(
        builder,
        'fixed',
        yield* Type.functionType(builder, i32, [i32]),
      )
      const variadic = yield* FunctionActor.declare(
        builder,
        'variadic',
        yield* Type.functionType(builder, i32, [i32], { variadic: true }),
      )
      const fn = yield* FunctionActor.declare(
        builder,
        'forward_block',
        yield* Type.functionType(builder, i32, [i32, i64]),
      )
      yield* FunctionActor.buildBody(
        builder,
        fn,
        Effect.fnUntraced(function* (body) {
          const entry = yield* Block.make(body, 'entry')
          const uses = yield* Block.make(body, 'uses')
          const definitions = yield* Block.make(body, 'definitions')
          yield* Block.setInsertionPoint(body, entry)
          yield* FunctionBody.branch(body, definitions)
          yield* Block.setInsertionPoint(body, definitions)
          const value = yield* FunctionBody.binary(
            body,
            'add',
            yield* Value.argument(body, 0),
            yield* Constant.integerSigned(builder, i32, 1),
            'value',
          )
          const wide = yield* FunctionBody.binary(
            body,
            'add',
            yield* Value.argument(body, 1),
            yield* Constant.integerSigned(builder, i64, 5),
            'wide',
          )
          const storage = yield* FunctionBody.alloca(body, i32, 'storage')
          yield* FunctionBody.branch(body, uses)
          yield* Block.setInsertionPoint(body, uses)
          yield* FunctionBody.callDirect(body, fixed, [value], 'fixed_result')
          yield* FunctionBody.callDirect(body, variadic, [value, wide], 'variadic_result')
          yield* FunctionBody.binary(body, 'add', value, value, 'sum')
          yield* FunctionBody.store(body, value, storage)
          yield* FunctionBody.load(body, i32, storage, 'loaded')
          yield* FunctionBody.returnValue(body, value)
        }),
      )
      assert.deepEqual(yield* Verify.verify(builder), [])
      assert.deepEqual(
        assemble('forward-block', yield* IrText.render(builder)),
        canonical('forward-block-bitcode', yield* Bitcode.encode(builder)),
      )
    }),
)

/**
 * A module built from the shapes that made rendered text unassemblable.
 *
 * Two values and a block all request the same name — values and blocks share one symbol table per
 * function, so all three collide — and every scalar and aggregate lane is zeroed through
 * `Constant.nullValue`, which is how a front end spells a zero it does not know to be a pointer.
 */
const collidingModule = Effect.fnUntraced(function* (options: { readonly named: boolean }) {
  const builder = yield* Builder.make({
    moduleName: 'roundtrip',
    sourceFilename: 'roundtrip.ll',
    targetTriple: 'aarch64-apple-darwin',
    strip: false,
  })
  const voidType = yield* Type.voidType(builder)
  const i32 = yield* Type.integer(builder, 32)
  const pointer = yield* Type.pointer(builder)
  const float = yield* Type.float(builder)
  const double = yield* Type.double(builder)
  const half = yield* Type.half(builder)
  const fp128 = yield* Type.fp128(builder)
  const x86Fp80 = yield* Type.x86Fp80(builder)
  const ppcFp128 = yield* Type.ppcFp128(builder)
  const vector = yield* Type.vector(builder, i32, 4)
  const array = yield* Type.array(builder, i32, 2)
  const structure = yield* Type.structure(builder, [i32, pointer])

  const signature = yield* Type.functionType(builder, voidType, [pointer])
  const fn = yield* FunctionActor.declare(builder, 'zeroes', signature)
  yield* FunctionActor.buildBody(
    builder,
    fn,
    Effect.fnUntraced(function* (body) {
      // The entry block takes the name two of the instructions below also ask for.
      yield* Block.make(body, 'same')
      const destination = yield* Value.argument(body, 0)
      for (const type of [
        pointer,
        i32,
        half,
        float,
        double,
        x86Fp80,
        fp128,
        ppcFp128,
        vector,
        array,
        structure,
      ]) {
        yield* FunctionBody.store(body, yield* Constant.nullValue(builder, type), destination)
      }
      // A lone NUL is the one byte string whose C-string record would be empty.
      yield* FunctionBody.store(
        body,
        yield* Constant.string(builder, Uint8Array.of(0)),
        destination,
      )
      // Both loads request `same`, which the entry block already holds.
      yield* FunctionBody.load(body, i32, destination, 'same')
      yield* FunctionBody.load(body, i32, destination, 'same')
      yield* FunctionBody.returnVoid(body)
      return body
    }),
  )

  const file = options.named
    ? yield* Metadata.file(
        builder,
        yield* Metadata.string(builder, 'roundtrip.silk'),
        yield* Metadata.string(builder, '/src'),
      )
    : yield* Metadata.file(builder)
  const unit = required(
    yield* Metadata.compileUnit(builder, file, yield* Metadata.string(builder, 'silk')),
    'expected a compile unit',
  )
  yield* Metadata.named(builder, 'llvm.dbg.cu', [unit])
  // Without the version flag LLVM drops debug info on load, and the verifier never sees it.
  const two = yield* Metadata.constant(builder, yield* Constant.integerUnsigned(builder, i32, 2))
  const three = yield* Metadata.constant(builder, yield* Constant.integerUnsigned(builder, i32, 3))
  yield* Metadata.named(builder, 'llvm.module.flags', [
    yield* Metadata.tuple(builder, [
      two,
      yield* Metadata.string(builder, 'Debug Info Version'),
      three,
    ]),
  ])

  return builder
})

it.effect('assembles a name-colliding, zero-constant module into the bitcode module', () =>
  Effect.gen(function* () {
    if (toolchain.unavailable()) return
    const builder = yield* collidingModule({ named: true })
    const text = yield* IrText.render(builder)

    assert.notInclude(text, 'i32 null')
    // Each of the three requests for `same` gets a distinct name in the one symbol table.
    assert.include(text, '%same = load')
    assert.include(text, '%same.1 = load')
    assert.include(text, 'same.2:')

    // The text is not merely well-formed: assembled, it is the module the bitcode path emits.
    assert.deepEqual(
      assemble('colliding-text', text),
      canonical('colliding-bitcode', yield* Bitcode.encode(builder)),
    )
  }),
)

it.effect('renders both required DIFile fields when neither operand is present', () =>
  Effect.gen(function* () {
    if (toolchain.unavailable()) return
    const builder = yield* collidingModule({ named: false })
    const text = yield* IrText.render(builder)

    assert.include(text, '!DIFile(filename: "", directory: "")')
    assert.deepEqual(
      assemble('anonymous-file-text', text),
      canonical('anonymous-file-bitcode', yield* Bitcode.encode(builder)),
    )
  }),
)

it.effect(
  'round-trips variadic invoke, a cleanup landing pad, and a personality through both serializers',
  () =>
    Effect.gen(function* () {
      const builder = yield* Builder.make({ sourceFilename: 'unwind.ll' })
      const i32 = yield* Type.integer(builder, 32)
      const signature = yield* Type.functionType(builder, i32, [])
      const personality = yield* FunctionActor.declare(builder, 'personality', signature)
      const variadic = yield* Type.functionType(builder, i32, [i32], { variadic: true })
      const callee = yield* FunctionActor.declare(builder, 'foreign', variadic)
      const fn = yield* FunctionActor.declare(builder, 'guard', signature, {
        personality: yield* Constant.fromGlobal(
          builder,
          yield* FunctionActor.global(builder, personality),
        ),
      })
      yield* FunctionActor.buildBody(
        builder,
        fn,
        Effect.fnUntraced(function* (body) {
          const entry = yield* Block.make(body, 'entry')
          const normal = yield* Block.make(body, 'normal')
          const unwind = yield* Block.make(body, 'unwind')
          yield* Block.setInsertionPoint(body, entry)
          const result = required(
            yield* FunctionBody.invoke(
              body,
              variadic,
              yield* Constant.fromGlobal(builder, yield* FunctionActor.global(builder, callee)),
              [
                yield* Constant.integerSigned(builder, i32, 1),
                yield* Constant.integerSigned(builder, i32, 65535),
                yield* Constant.integerSigned(
                  builder,
                  yield* Type.integer(builder, 64),
                  4294967296n,
                ),
              ],
              normal,
              unwind,
              'result',
            ),
            'invoke result',
          )
          yield* Block.setInsertionPoint(body, normal)
          yield* FunctionBody.returnValue(body, result)
          yield* Block.setInsertionPoint(body, unwind)
          yield* FunctionBody.cleanupLandingPad(body)
          yield* FunctionBody.unreachable(body)
        }),
      )
      assert.deepEqual(
        assemble('unwind', yield* IrText.render(builder)),
        canonical('unwind-bitcode', yield* Bitcode.encode(builder)),
      )
    }),
)
