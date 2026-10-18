# `@silklang/llvm`

Effect-native LLVM IR construction and deterministic text and bitcode emission, ported from Zig's
standard-library LLVM builder.

The runtime has no dependency on Zig, native LLVM libraries, filesystem access, or external
executables. It returns LLVM assembly as a `string` and bitcode as a `Uint8Array`.

```typescript
import * as Effect from 'effect/Effect'
import * as Bitcode from '@silklang/llvm/Bitcode'
import * as Block from '@silklang/llvm/Block'
import * as Builder from '@silklang/llvm/Builder'
import * as FunctionActor from '@silklang/llvm/Function'
import * as FunctionBody from '@silklang/llvm/FunctionBody'
import * as IrText from '@silklang/llvm/IrText'
import * as Type from '@silklang/llvm/Type'
import * as Value from '@silklang/llvm/Value'

const program = Effect.gen(function* () {
  const builder = yield* Builder.make({ sourceFilename: 'add.ll' })

  // Declare add(i32, i32) -> i32.
  const i32 = yield* Type.integer(builder, 32)
  const signature = yield* Type.functionType(builder, i32, [i32, i32])
  const add = yield* FunctionActor.declare(builder, 'add', signature)

  yield* FunctionActor.buildBody(
    builder,
    add,
    Effect.fn('Readme.addBody')(function* (body) {
      // Read the parameters, add them, and return the instruction result.
      yield* Block.make(body, 'entry')
      const left = yield* Value.argument(body, 0)
      const right = yield* Value.argument(body, 1)
      const sum = yield* FunctionBody.binary(body, 'add', left, right, 'sum')
      yield* FunctionBody.returnValue(body, sum)
    }),
  )

  return {
    text: yield* IrText.render(builder),
    bytes: yield* Bitcode.encode(builder),
  }
})

const output = await Effect.runPromise(program)
console.log(output.text)
```

The example moves through the package's main lifecycle:

1. Create one module-owning `Builder`.
2. Build and intern the function's `i32 (i32, i32)` type.
3. Declare `add`, then construct its body inside the scoped `Function.buildBody` transaction.
4. Read the two arguments, emit an `add` instruction, and terminate the block with the result.
5. Render the committed module as text and encode the same state as bitcode bytes.

`Function.buildBody` is a scoped transaction. The callback's success, typed failure, defect, or
interruption is preserved; every non-success exit closes the draft and releases its reservation,
so failed construction never exposes a partial body and can be retried.

## Errors and immutable options

Public Effect operations fail with `LlvmError`. Its `reason` discriminates rejected input,
invalid state or ownership, and wrapped implementation failures, so callers can recover by tag and
then inspect the reason without treating expected validation as a defect.

Immutable option actors support both data-first and pipeable transformations:

```typescript
import * as Effect from 'effect/Effect'
import { pipe } from 'effect/Function'
import * as Builder from '@silklang/llvm/Builder'
import * as IntegerMath from '@silklang/llvm/IntegerMath'
import * as Type from '@silklang/llvm/Type'

declare const builder: Builder.Builder

const flags = pipe(
  IntegerMath.make(),
  IntegerMath.withNoSignedWrap(),
  IntegerMath.withNoUnsignedWrap(false),
)

const recovered = Type.integer(builder, 0).pipe(
  Effect.catchTag('LlvmError', (error) => Effect.succeed(error.reason._tag)),
)
```

## Documentation

The package documentation is ordinary Markdown kept alongside the code and shipped in the npm
package. Start from the track that matches what you need:

### Learn by building

- [Build Tiny, a compiled language](./docs/tutorials/tiny-language/01-meet-tiny.md) — a 13-lesson
  path from source text to a native executable.
- [Build a tiny expression compiler](./docs/tutorials/tiny-expression-compiler.md) — a shorter
  path for readers already familiar with compiler frontends.

### Solve a task

- [Declare globals, aliases, and functions](./docs/how-to/declarations.md)
- [Build branching control flow](./docs/how-to/control-flow.md)
- [Emit memory, atomic, and intrinsic operations](./docs/how-to/memory-atomics-intrinsics.md)
- [Add debug metadata](./docs/how-to/debug-metadata.md)
- [Emit and validate LLVM output](./docs/how-to/output.md)

### Look up behavior

- [Actor reference](./docs/reference/actors.md)
- [Behavior and guarantees](./docs/reference/behavior.md)

### Understand the design

- [Why the builder is Effect-native](./docs/explanation/effect-native-builder.md)
- [Why text and bitcode share one model](./docs/explanation/text-and-bitcode.md)

The [documentation index](./docs/README.md) provides the same paths from within the `docs`
directory.

The package is organized as actor modules with explicit subpath exports. Prefer imports such as
`@silklang/llvm/Builder` and `@silklang/llvm/FunctionBody` over a growing import from the root
barrel.

## Scope and compatibility

The package builds LLVM module state and emits `.ll` text or `.bc` bytes. It does not provide a
JIT, optimizer pipeline, object-code backend, linker, filesystem integration, or process runner.

The authoritative compatibility baseline is Zig `6db520a4cd1ce2391c79d0d55b2b2d5297e133a3`, LLVM
`22.1.8`, and Node.js `>=22.13.0`. See [UPSTREAM.md](./UPSTREAM.md) for provenance and pinned
sources, and [the parity report](./parity/REPORT.md) for the supported upstream surface.

## Development verification

```sh
pnpm --filter @silklang/llvm fixtures:verify
pnpm --filter @silklang/llvm parity:validate
```

Fixture generation uses pinned Zig and LLVM tools, but runtime APIs never invoke them.

Tests that return an Effect use `it.effect` from `@effect/vitest`; pure cases use ordinary `it`
and `assert`. Shared layers belong in `it.layer`, while application examples may run their final
program with `Effect.runPromise` at the edge.
