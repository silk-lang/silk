import * as AnalysisFixture from './support/AnalysisFixture.js'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, assert, it } from '@effect/vitest'
import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import { llvmToolchain } from '../../../test/support/llvmToolchain.js'
import * as Analysis from '../src/Analysis.js'
import type * as Backend from '../src/Backend.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

const directory = mkdtempSync(join(tmpdir(), 'silk-llvm-ir-round-trip-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

const toolchain = llvmToolchain(
  ['llvm-as', 'llvm-dis', 'opt'],
  'the compiler IR round-trip check',
  (message) => Effect.runSync(Console.log(message)),
)

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
 * to resolve, so only modules that entered through the same door are comparable. `strip` then
 * renumbers locals, because `Bitcode.encode` writes no function-level value symbol table and names
 * therefore survive only along the textual path.
 */
const canonical = (name: string, bitcode: Uint8Array): string => {
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
  return llvmDis(`${name}.stripped.ll`, readFileSync(stripped))
}

/**
 * Assembles rendered IR and reduces it the same way.
 *
 * The golden tests compare rendered text against stored rendered text, so a systematic renderer
 * flaw compares equal to itself and passes forever. `llvm-as` is the check that cannot: either the
 * text the backend prints is the assembly language, or it is not.
 */
const assemble = (name: string, ir: string): string => {
  const assembled = llvmAs(`${name}.assembled.bc`, write(`${name}.source.ll`, ir))
  execFileSync(toolchain.command('opt'), [
    '-passes=verify',
    write(`${name}.verify.bc`, assembled),
    '-disable-output',
  ])
  return canonical(`${name}-text`, assembled)
}

const emit = Effect.fnUntraced(function* (
  name: string,
  text: string,
  request: Backend.CodegenRequest,
  target: string,
) {
  const snapshot = yield* AnalysisFixture.retainingMain(name, ascii(text), target)
  assert.deepEqual(Analysis.diagnostics(snapshot), [])
  return yield* Analysis.codegen(snapshot, request)
})

/** A guard whose `Drop` hook runs before its owned `Allocation` field releases. */
const dropHook = `import silk.allocator { Allocator }
import silk.allocator { OutOfMemoryError }
import silk.allocator { Allocator }
import silk.allocator { SystemAllocator }
import silk.effect { Effect }
import silk.layout { Layout }
struct Guard {
  tag: i32
  storage: Intrinsic.Allocation
}

impl Drop for Guard {
  fn drop(self: &mut Guard) -> () { return () }
}

effect fn build() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let layout = Layout.of<[i32; 2]>()
  let recipe = Allocator.allocate(move layout) |> Effect.provideMut(&mut allocator)
  let allocation = run recipe
  let guard = Guard { tag: 5, storage: move allocation }
  return 42
}

effect fn recover(error: OutOfMemoryError) -> i32 { return 7 }

pub fn main() -> i32 { return run Effect.catchAll(build(), recover) }`

/**
 * A boxed tree whose nodes hold a `Leaf | Branch` union.
 *
 * Releasing one costs a conditional union cleanup around `impl<T> Drop for Box<T>`, which is the
 * shape the duplicate names in #130 appeared in: many reclaim contexts in one function, several
 * of them asking for the same name.
 */
const unionCleanup = `import silk.allocator { Allocator }
import silk.allocator { OutOfMemoryError }
import silk.allocator { Allocator }
import silk.allocator { SystemAllocator }
import silk.effect { Effect }
import silk.usize
import silk.box { Box }

pub struct Leaf {}

pub struct Branch {
  left: Box<Tree>
  right: Box<Tree>
}

pub struct Shape {
  kind: Leaf | Branch
}

pub struct Tree {
  shape: Shape
  value: i32
}

effect fn leaf(value: i32) -> Tree ! OutOfMemoryError ? &mut Allocator {
  return Tree { shape: Shape { kind: Leaf {} }, value: value }
}

effect fn branch(left: Tree, right: Tree, value: i32) -> Tree ! OutOfMemoryError ? &mut Allocator {
  let boxedLeft = run Box<Tree>.make(move left)
  let boxedRight = run Box<Tree>.make(move right)
  return Tree {
    shape: Shape { kind: Branch { left: move boxedLeft, right: move boxedRight } },
    value: value
  }
}

fn total(self: &Tree) -> i32 {
  return self.value + shapeTotal(&self.shape)
}

fn shapeTotal(self: &Shape) -> i32 {
  return match &self.kind {
    Leaf nothing => 0
    Branch { left, right } => boxTotal(Box<Tree>.get(&left)) + boxTotal(Box<Tree>.get(&right))
  }
}

fn boxTotal(view: &[Tree]) -> i32 {
  return match &view[usize.ZERO] {
    Tree { shape, value } => value + shapeTotal(&shape)
  }
}

effect fn build() -> Tree ! OutOfMemoryError ? &mut Allocator {
  let left = run branch(run leaf(1), run leaf(2), 4)
  let right = run branch(run leaf(8), run leaf(16), 32)
  return run branch(move left, move right, 64)
}

effect fn sum() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let built = run build() |> Effect.provideMut(&mut allocator)
  let answer = total(&built)
  drop built
  return answer
}

effect fn recover(error: OutOfMemoryError) -> i32 { return 1 }

pub fn main() -> i32 { return run Effect.catchAll(sum(), recover) }`

const programs: ReadonlyArray<readonly [string, string]> = [
  ['drop-hook', dropHook],
  ['union-cleanup', unionCleanup],
]

/**
 * Debug mode carries the `DIFile` and location metadata that release mode omits, so both profiles
 * have to assemble for the rendered view to be trustworthy while debugging.
 */
for (const mode of ['debug', 'release'] as const) {
  for (const [name, source] of programs) {
    it.effect(
      `renders assemblable LLVM IR for the ${name} program in ${mode}`,
      () =>
        Effect.gen(function* () {
          if (toolchain.unavailable()) return
          const artifact = yield* emit(
            `round-trip/${name}`,
            source,
            { mode },
            'aarch64-apple-darwin',
          )
          assert.strictEqual(artifact.backend, 'llvm')
          if (artifact.backend !== 'llvm') return

          // Assembling the text has to produce the module the compile path actually emits, or the
          // readable view and the compiled artifact can drift apart again.
          assert.strictEqual(
            assemble(`${name}-${mode}`, artifact.ir),
            canonical(`${name}-${mode}-bitcode`, artifact.bitcode),
          )
        }),
      120_000,
    )
  }
}
