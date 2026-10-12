import * as Layer from 'effect/Layer'
import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import type * as CleanupPlan from '../src/CleanupPlan.js'
import * as Layout from '../src/Layout.js'
import * as ModuleClosure from '../src/ModuleClosure.js'
import * as MirVerification from '../src/MirVerification.js'
import * as NameResolution from '../src/NameResolution.js'
import * as SourceFile from '../src/SourceFile.js'
import * as SourceResolver from '../src/SourceResolver.js'
import * as Type from '../src/Type.js'
import * as Projections from './support/projections.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

/**
 * A binary tree three levels deep: seven nodes, six of them held behind a box. This is the shape
 * the whole change exists to make expressible, and the shape whose release is invisible to every
 * other check the compiler has.
 */
const tree = `import silk.allocator { Allocator }
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

// The held value is reached through the one-element view the box hands back, which is how a
// recursive walk descends a level without unsafe code.
fn boxTotal(view: &[Tree]) -> i32 {
  return match &view[usize.ZERO] {
    Tree { shape, value } => value + shapeTotal(&shape)
  }
}

effect fn build() -> Tree ! OutOfMemoryError ? &mut Allocator {
  let leftLeft = run leaf(1)
  let leftRight = run leaf(2)
  let left = run branch(move leftLeft, move leftRight, 4)
  let rightLeft = run leaf(8)
  let rightRight = run leaf(16)
  let right = run branch(move rightLeft, move rightRight, 32)
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

/**
 * The value a box holds is reachable three ways without unsafe code at the call site: shared
 * borrow, exclusive borrow, and a consuming move. `into` empties the box before handing the value
 * out, so the hook that still runs on the emptied box drops nothing and the storage releases once.
 */
const accessors = `import silk.allocator { OutOfMemoryError }
import silk.allocator { Allocator }
import silk.allocator { SystemAllocator }
import silk.effect { Effect }
import silk.usize
import silk.box { Box }

effect fn build() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut boxed = run Box<i32>.make(20) |> Effect.provideMut(&mut allocator)

  let borrowed = Box<i32>.get(&boxed)
  if borrowed[usize.ZERO] == 20 {} else { return 1 }

  let mut exclusive = Box<i32>.getMut(&mut boxed)
  exclusive[usize.ZERO] = 22

  let confirmed = Box<i32>.get(&boxed)
  if confirmed[usize.ZERO] == 22 {} else { return 2 }

  let taken = Box<i32>.into(move boxed)
  return taken + 20
}

effect fn recover(error: OutOfMemoryError) -> i32 { return 3 }

pub fn main() -> i32 { return run Effect.catchAll(build(), recover) }`

/**
 * The plan that releases the tree is finite because the box contributes one hook call, not the
 * held tree's own cleanup. Depth is spent by the call stack at runtime instead, which is why the
 * plan's recursion guard is never reached and no owner in the cycle is planned as having no
 * cleanup at all.
 */
it.effect('plans one hook call per box rather than inlining the held value', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'box-heap-indirection/plan',
      ascii(tree),
      'wasm32-unknown-unknown',
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])

    const named = (plan: CleanupPlan.CleanupPlan): string =>
      plan._tag === 'NoCleanup' || plan._tag === 'ParameterCleanup'
        ? plan._tag
        : `${plan._tag}(${Type.encode(plan.type)})`

    const plans = Projections.cleanupExitsOf(snapshot, 'box-heap-indirection/plan').flatMap(
      (exit) => exit.releases.map((release) => release.cleanup),
    )

    // A box released on its own is one hook call. Nothing recursive appears in the plan.
    const boxed = plans.find(
      (plan) => plan._tag === 'HookCleanup' && plan.type.module === 'silk/box',
    )
    assert.isDefined(boxed)
    if (boxed?._tag !== 'HookCleanup') return
    assert.strictEqual(boxed.hook.module, 'silk/box')
    assert.strictEqual(named(boxed), 'HookCleanup(silk/box.Box<box-heap-indirection/plan.Tree>)')

    // The hook's own field cleanup releases the storage and nothing below it, which is exactly
    // why the hook has to drop the element itself.
    assert.deepEqual(
      boxed.inner._tag === 'StructCleanup'
        ? boxed.inner.fields.map((field) => field.cleanup._tag)
        : [boxed.inner._tag],
      ['RawBufferCleanup', 'UnionCleanup'],
    )
    // The storage cleanup is a leaf: it carries the allocation and no element plan at all, so
    // nothing in the box's own plan mentions the type it holds.
    const storage =
      boxed.inner._tag === 'StructCleanup' ? boxed.inner.fields.at(0)?.cleanup : undefined
    assert.deepEqual(storage?._tag === 'RawBufferCleanup' ? Object.keys(storage).sort() : [], [
      '_tag',
      'allocation',
      'type',
    ])

    // Tree -> Shape -> (Leaf | Branch) -> Branch -> Box<Tree>: the tree's own plan reaches the
    // same single hook call, and no owner along the way is planned as having no cleanup.
    const treePlan = plans.find(
      (plan) => plan._tag === 'StructCleanup' && plan.type.name === 'Tree',
    )
    assert.isDefined(treePlan)
    const shape = treePlan?._tag === 'StructCleanup' ? treePlan.fields.at(0)?.cleanup : undefined
    const kind = shape?._tag === 'StructCleanup' ? shape.fields.at(0)?.cleanup : undefined
    const branch =
      kind?._tag === 'UnionCleanup'
        ? kind.cases.find((entry) => Type.isNominal(entry.member) && entry.member.name === 'Branch')
            ?.cleanup
        : undefined
    const left = branch?._tag === 'StructCleanup' ? branch.fields.at(0)?.cleanup : undefined
    assert.strictEqual(left?._tag, 'HookCleanup')
  }),
)

it.effect('releases Box.into storage exactly once after transferring the element', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'box-heap-indirection/into-cleanup',
      ascii(accessors),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const into = Analysis.loweredMir(snapshot).functions.find(
      (fn) => fn.id.module === 'silk/box' && fn.id.name === 'Box.into',
    )
    if (into === undefined) return assert.fail('expected Box.into MIR')

    const countRawBufferReleases = (plan: CleanupPlan.CleanupPlan): number => {
      switch (plan._tag) {
        case 'RawBufferCleanup':
          return 1
        case 'HookCleanup':
          return countRawBufferReleases(plan.inner)
        case 'StructCleanup':
          return plan.fields.reduce(
            (count, field) => count + countRawBufferReleases(field.cleanup),
            0,
          )
        case 'NominalUnionCleanup':
          return plan.variants.reduce(
            (count, variant) =>
              count +
              variant.fields.reduce(
                (fieldCount, field) => fieldCount + countRawBufferReleases(field.cleanup),
                0,
              ),
            0,
          )
        case 'ArrayCleanup':
          return countRawBufferReleases(plan.element)
        case 'UnionCleanup':
          return plan.cases.reduce(
            (count, entry) => count + countRawBufferReleases(entry.cleanup),
            0,
          )
        case 'CallableCleanup':
        case 'EffectCleanup':
          return plan.slots.reduce((count, slot) => count + countRawBufferReleases(slot.cleanup), 0)
        case 'EffectCompositeCleanup':
          return plan.alternatives.reduce(
            (count, alternative) => count + countRawBufferReleases(alternative),
            0,
          )
        default:
          return 0
      }
    }

    const releases = MirVerification.operations(into).filter(
      (operation) => operation._tag === 'Drop',
    )
    assert.strictEqual(
      releases.reduce((count, release) => count + countRawBufferReleases(release.cleanup), 0),
      1,
    )
  }),
)

/**
 * The self-hosting gate itself: the smallest recursive syntax node a compiler needs, and the same
 * cycle spread across two modules so it travels through the component walk rather than the
 * self-edge test.
 */
it.effect('accepts a recursive declaration through Box, within and across modules', () =>
  Effect.gen(function* () {
    const expr = `import silk.box { Box }

pub struct Expr {
  left: Box<Expr>
  right: Box<Expr>
  value: i32
}

pub fn main() -> i32 { return 0 }`
    const single = yield* AnalysisFixture.retainingMain(
      'box-heap-indirection/expr',
      ascii(expr),
      'wasm32-unknown-unknown',
    )
    assert.deepEqual(Analysis.diagnostics(single), [])

    const index = yield* ModuleClosure.load({
      root: 'ast/expression',
    }).pipe(
      Effect.provide(
        SourceResolver.overlay([
          SourceFile.make(
            'ast/expression',
            ascii(
              'import silk.box { Box }\nimport ast.statement\n' +
                'import silk.box { Box }\npub struct Expression { body: Box<statement.Statement> value: i32 }\n' +
                'pub fn main() -> i32 { return 0 }',
            ),
          ),
        ]).pipe(
          Layer.provideMerge(
            SourceResolver.memory(
              new Map([
                [
                  'ast/statement',
                  ascii(
                    'import silk.box { Box }\nimport ast.expression\n' +
                      'import silk.box { Box }\npub struct Statement { head: Box<expression.Expression> }',
                  ),
                ],
              ]),
            ),
          ),
        ),
      ),
      Effect.map((closure) => NameResolution.analyze(closure).index),
    )
    assert.deepEqual(
      index.diagnostics.map((diagnostic) => diagnostic.code),
      [],
    )
    const facts = index.modules.flatMap((module) => module.structs)
    assert.deepEqual(
      facts
        .filter((struct) => struct.canonical._tag === 'Canonical')
        .filter(
          (struct) =>
            struct.canonical._tag === 'Canonical' && struct.canonical.id.module.startsWith('ast/'),
        )
        .map((struct) => struct.dependency._tag),
      ['Available', 'Available'],
    )
  }),
)

/**
 * A shape that would demand an infinite tower of drop instances is rejected by the finite cleanup
 * specialization guard rather than diverging.
 */
it.effect('rejects a polymorphically recursive box shape', () =>
  Effect.gen(function* () {
    const polymorphic = `import silk.box { Box }
import silk.vector { Vector }

pub struct Bad<T> {
  value: T
  next: Box<Bad<Box<T>>>
}

pub fn main() -> i32 {
  let held = Vector<Bad<i32>>.make()
  return 0
}`
    const snapshot = yield* AnalysisFixture.retainingMain(
      'box-heap-indirection/polymorphic',
      ascii(polymorphic),
      'wasm32-unknown-unknown',
    )
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
      ['SEM0053'],
    )
  }),
)

/**
 * Box is ordinary standard-library source. No compiler phase knows it: it is not an intrinsic
 * nominal, it has no layout branch of its own, and its cleanup is the same hook-plus-fields plan
 * any other struct with a `Drop` conformance gets.
 */
it.effect('gives Box no compiler privilege', () =>
  Effect.gen(function* () {
    assert.isUndefined(Type.intrinsicNominals.get('Box'))
    assert.isFalse(Type.isIntrinsicNominal(Type.nominal('silk/box', 'Box', ['i32'])))

    const snapshot = yield* AnalysisFixture.retainingMain(
      'box-heap-indirection/privilege',
      ascii(accessors),
      'wasm32-unknown-unknown',
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])

    // The concrete specialization is an ordinary reached runtime aggregate computed from its
    // declared fields; it does not pollute the pre-reachability type catalog.
    const plan = Analysis.layoutOf(snapshot)
    assert.strictEqual(plan._tag, 'Available')
    if (plan._tag !== 'Available') return
    const layout = Layout.entry(plan.value, Type.nominal('silk/box', 'Box', ['i32']))
    assert.strictEqual(layout?._tag, 'LayoutEntry')
    if (layout?._tag !== 'LayoutEntry') return
    assert.strictEqual(layout.representation._tag, 'Aggregate')

    // Its drop path is a source declaration in the standard library, lowered like any other.
    const mir = Analysis.loweredMir(snapshot)
    assert.include(
      mir.functions.filter((fn) => fn.id.module === 'silk/box').map((fn) => fn.id.name),
      'drop@impl#0',
    )
  }),
)
