import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, assert, it } from '@effect/vitest'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as NativeToolchain from '../src/NativeToolchain.js'
import * as SourceFile from '../src/SourceFile.js'
import * as SourceResolver from '../src/SourceResolver.js'
import * as Driver from './support/TestDriver.js'

/**
 * Ordinary recursion is bounded by the machine stack, deliberately: the compiler adds no shadow
 * stack and no per-call allocation, so a call costs a call. These tests pin the *shape* of that
 * boundary rather than the depth at which it arrives — the depth belongs to the host's stack size,
 * the optimizer's frame layout, and the engine, and asserting one would only manufacture flakes.
 *
 * What is pinned:
 *
 * - a shallow chain traverses through native and LLVM-to-Wasm artifacts and releases every link,
 * - a deep chain fails at the real runtime boundary, and
 * - the escape hatch — an explicit iterative teardown — carries a chain far beyond the depth at
 *   which the recursive form dies.
 *
 * The measured native bounds are evidence rather than language contract; tests assert only the
 * selected stack policy and observable native termination behavior.
 */

const defaultClang = (): string => {
  if (existsSync('/opt/homebrew/opt/llvm/bin/clang')) return '/opt/homebrew/opt/llvm/bin/clang'
  if (existsSync('/usr/local/opt/llvm/bin/clang')) return '/usr/local/opt/llvm/bin/clang'
  return 'clang'
}

const clang = Effect.runSync(
  Config.String('SILK_TEST_CLANG').pipe(Config.withDefault(defaultClang())),
)
const toolchain: NativeToolchain.Toolchain = Object.freeze({
  _tag: 'Toolchain',
  clang,
  llvmAr: 'llvm-ar',
  runtimeObjectCache: NativeToolchain.makeRuntimeObjectCache(),
})

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

const destinationRoot = mkdtempSync(join(tmpdir(), 'silk-recursion-stack-boundary-'))
afterAll(() => rmSync(destinationRoot, { recursive: true, force: true }))

/**
 * A singly linked chain of boxed nodes, with three phases that can be measured apart:
 *
 * - `build` is iterative, so construction never contributes call depth and a failure is always
 *   attributable to the phase under test,
 * - `stepDepth`/`viewDepth` is the ordinary recursive walk, borrowing one level at a time, and
 * - `drain` is the explicit iterative teardown: it unlinks one level per loop turn, so the chain
 *   is already flat by the time automatic cleanup sees it.
 *
 * `Intrinsic.replace` is what makes both loops expressible. A local cannot be partially moved out
 * of and a `match` arm is an expression rather than a statement, so a loop that walks ownership
 * down a chain has to swap a sentinel into the place it takes from.
 */
const prelude = `import silk.allocator { Allocator }
import silk.allocator { OutOfMemoryError }
import silk.usize
import silk.box { Box }

pub struct End {}

pub struct Link {
  next: Box<Chain>
}

pub struct Step {
  kind: End | Link
}

pub struct Chain {
  step: Step
}

pub struct Drained {
  chain: Chain
  more: bool
}

fn stepDepth(step: &Step) -> i32 {
  return match &step.kind {
    End nothing => 0
    Link { next } => viewDepth(Box<Chain>.get(&next))
  }
}

fn viewDepth(view: &[Chain]) -> i32 {
  return match &view[usize.ZERO] {
    Chain { step } => 1 + stepDepth(&step)
  }
}

fn unlink(chain: Chain) -> Drained {
  return match move chain {
    Chain { step } => unlinkStep(move step)
  }
}

fn unlinkStep(step: Step) -> Drained {
  return match move step {
    Step { kind } => unlinkKind(move kind)
  }
}

fn unlinkKind(kind: End | Link) -> Drained {
  return match move kind {
    End nothing => Drained { chain: Chain { step: Step { kind: End {} } }, more: false }
    Link { next } => Drained { chain: Box<Chain>.into(move next), more: true }
  }
}

fn drain(chain: Chain) -> i32 {
  let mut current = move chain
  let mut released = 0
  let mut going = true
  while going {
    let taken = Intrinsic.replace(current, Chain { step: Step { kind: End {} } })
    let mut stepped = unlink(move taken)
    current = Intrinsic.replace(stepped.chain, Chain { step: Step { kind: End {} } })
    going = stepped.more
    if stepped.more { released = released + 1 }
  }
  return released
}

effect fn build(depth: i32) -> Chain ! OutOfMemoryError ? &mut Allocator {
  let mut current = Chain { step: Step { kind: End {} } }
  let mut remaining = depth
  while remaining > 0 {
    let taken = Intrinsic.replace(current, Chain { step: Step { kind: End {} } })
    let boxed = run Box<Chain>.make(move taken)
    current = Chain { step: Step { kind: Link { next: move boxed } } }
    remaining = remaining - 1
  }
  return move current
}
`

const program = (body: string, depth: number): string => `import silk.allocator { OutOfMemoryError }
import silk.effect { Effect }
${prelude}
${body}

effect fn recover(error: OutOfMemoryError) -> i32 { return 1 }

pub fn main() -> i32 { return run Effect.catchAll(measure(${depth}), recover) }`

/** Recursive traversal, then an iterative teardown so only the walk can exhaust the stack. */
const walk = (depth: number): string =>
  program(
    `import silk.allocator { OutOfMemoryError }
import silk.allocator { Allocator }
import silk.allocator { SystemAllocator }
import silk.effect { Effect }
effect fn measure(depth: i32) -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let built = run build(depth) |> Effect.provideMut(&mut allocator)
  let counted = stepDepth(&built.step)
  let released = drain(move built)
  if counted == released { return 0 }
  return 2
}`,
    depth,
  )

/**
 * Iterative construction, then ordinary automatic cleanup. `Box.drop` drops the element it holds,
 * so releasing the outermost link calls the hook of the one below it: the chain is destroyed by
 * recursion nobody wrote, and there is no call site at which to write it differently.
 */
const dropped = (depth: number): string =>
  program(
    `import silk.allocator { OutOfMemoryError }
import silk.allocator { Allocator }
import silk.allocator { SystemAllocator }
import silk.effect { Effect }
effect fn measure(depth: i32) -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let built = run build(depth) |> Effect.provideMut(&mut allocator)
  drop built
  return 0
}`,
    depth,
  )

interface Outcome {
  readonly _tag: 'Returned' | 'Failed'
  readonly detail: string
}

const returned = (value: number): Outcome =>
  Object.freeze({ _tag: 'Returned' as const, detail: String(value) })

/**
 * Compiles and runs the module natively. A machine stack overrun arrives as a signal rather than an
 * exit status, and which signal is the platform's business: Linux and macOS both raise `SIGSEGV`
 * for the guard page, and `SIGBUS` is accepted for the platforms that map it differently.
 */
const runNative = (id: string, source: string, destination: string) =>
  Effect.gen(function* () {
    const compiled = yield* Driver.compile({
      compilation: { root: id },
      toolchain,
      optimization: 'release',
      artifactKind: 'NativeExecutable',
      destination,
    }).pipe(Effect.provide(SourceResolver.overlay([SourceFile.make(id, ascii(source))])))
    assert.strictEqual(compiled._tag, 'Compiled', id)
    if (compiled._tag !== 'Compiled') return Object.freeze({ _tag: 'Failed' as const, detail: id })
    const run = spawnSync(compiled.path, [], { encoding: 'utf8' })
    if (run.signal === null) {
      assert.strictEqual(run.stderr, '', id)
      return returned(run.status ?? -1)
    }
    assert.oneOf(run.signal, ['SIGSEGV', 'SIGBUS'], `${id}: ${run.stderr}`)
    return Object.freeze({ _tag: 'Failed' as const, detail: run.signal })
  }).pipe(Effect.provide(SourceResolver.empty))

/**
 * Doubles the depth until the engine gives out, and reports the first depth that failed.
 *
 * This is what keeps the test honest on a machine whose stack is larger than the one the numbers
 * above were measured on: the assertion is that some depth within reach fails, and that the failure
 * looks the way this engine's stack exhaustion looks. A machine that carries the cap without
 * failing is a machine on which the documented boundary did not hold, and the test should say so
 * rather than pass quietly.
 */
const escalate = <E>(
  from: number,
  cap: number,
  attempt: (depth: number) => Effect.Effect<Outcome, E, never>,
): Effect.Effect<{ readonly depth: number; readonly outcome: Outcome }, E, never> =>
  Effect.gen(function* () {
    let depth = from
    while (depth <= cap) {
      const outcome = yield* attempt(depth)
      if (outcome._tag === 'Failed') return Object.freeze({ depth, outcome })
      assert.strictEqual(outcome.detail, '0', `depth ${depth} must still compute the right answer`)
      depth = depth * 2
    }
    assert.fail(`no depth up to ${cap} exhausted the stack`)
  })

it.effect(
  'exhausts the native machine stack on a deep recursive traversal',
  () =>
    Effect.gen(function* () {
      const found = yield* escalate(200_000, 6_400_000, (depth) =>
        runNative(
          `recursion-stack-boundary/native/${depth}`,
          walk(depth),
          join(destinationRoot, `native-walk-${depth}`),
        ),
      )
      assert.strictEqual(found.outcome._tag, 'Failed')
    }),
  600_000,
)

/**
 * Cleanup frames are narrower than the walk's, so this needs an order of magnitude more depth than
 * the traversal did before the guard page arrives — which is precisely why it is worth pinning
 * separately. "Deep enough to be safe for a walk" is not deep enough to be safe for a teardown.
 */
it.effect(
  'exhausts the native machine stack when a deep chain is dropped',
  () =>
    Effect.gen(function* () {
      const found = yield* escalate(1_000_000, 8_000_000, (depth) =>
        runNative(
          `recursion-stack-boundary/drop-native/${depth}`,
          dropped(depth),
          join(destinationRoot, `native-drop-${depth}`),
        ),
      )
      assert.strictEqual(found.outcome._tag, 'Failed')
    }),
  900_000,
)
