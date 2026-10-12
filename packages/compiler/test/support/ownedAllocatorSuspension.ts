export const ownedAllocatorSuspensionSuccess = `import silk.allocator { Allocator }
import silk.allocator { OutOfMemoryError }
import silk.allocator { Allocator }
import silk.allocator { SystemAllocator }
import silk.effect { Effect }
import silk.layout { Layout }
import silk.result { Result }
struct OwnedAllocator { storage: Allocation }
effect fn allocate(self: &mut OwnedAllocator, layout: Layout) -> Allocation ! OutOfMemoryError {
  let mut inner = Allocator.systemAllocatorProvider()
  return run Allocator.allocate(move layout) |> Effect.provideMut(&mut inner)
}
impl Allocator for OwnedAllocator { allocate: OwnedAllocator.allocate }
effect fn open() -> OwnedAllocator ! OutOfMemoryError ? &mut Allocator {
  let layout = Layout.of<[i32; 2]>()
  let storage = run Allocator.allocate(move layout)
  return OwnedAllocator { storage: move storage }
}
effect fn protected() -> i32 ? &mut Allocator {
  return run Effect.suspend(effect { return 42 })
}
effect fn inspect(self: once Effect<i32 ? &mut Allocator>) -> Result<i32, never>
? &mut Allocator {
  return run Effect.result(move self)
}
effect fn program() -> i32 ! OutOfMemoryError ? &mut Allocator {
  let provider = run open()
  let inspected = inspect(protected())
  let completed = run Intrinsic.bindRequirementOwned<Allocator>(move inspected, move provider)
  return match move completed {
      Result<i32, never>.Success { value } => move value
      Result<i32, never>.Failure { error } => move error
  }
}
effect fn outerRecover(error: OutOfMemoryError) -> i32 { return 9 }
pub fn main() -> i32 {
  let mut allocator = Allocator.systemAllocatorProvider()
  return run Effect.catchAll(
    Effect.provideMut(program(), &mut allocator),
    outerRecover,
  )
}`

export const ownedAllocatorSuspensionFailure = `import silk.allocator { Allocator }
import silk.allocator { OutOfMemoryError }
import silk.allocator { Allocator }
import silk.allocator { SystemAllocator }
import silk.effect { Effect }
import silk.layout { Layout }
import silk.result { Result }
struct Problem { code: i32 }
struct OwnedAllocator { storage: Allocation }
effect fn allocate(self: &mut OwnedAllocator, layout: Layout) -> Allocation ! OutOfMemoryError {
  let mut inner = Allocator.systemAllocatorProvider()
  return run Allocator.allocate(move layout) |> Effect.provideMut(&mut inner)
}
impl Allocator for OwnedAllocator { allocate: OwnedAllocator.allocate }
effect fn open() -> OwnedAllocator ! OutOfMemoryError ? &mut Allocator {
  let layout = Layout.of<[i32; 2]>()
  let storage = run Allocator.allocate(move layout)
  return OwnedAllocator { storage: move storage }
}
effect fn protected() -> i32 ! Problem ? &mut Allocator {
  let code = run Effect.suspend(effect { return 42 })
  fail Problem { code: code }
}
effect fn recover(error: Problem) -> i32 { return 7 }
effect fn inspect(self: once Effect<i32 ? &mut Allocator>)
-> Result<i32, never>
? &mut Allocator {
  return run Effect.result(move self)
}
effect fn program() -> i32 ! OutOfMemoryError ? &mut Allocator {
  let provider = run open()
  let inspected = inspect(Intrinsic.catchFailure<Problem>(protected(), recover))
  let completed = run Intrinsic.bindRequirementOwned<Allocator>(move inspected, move provider)
  return match move completed {
      Result<i32, never>.Success { value } => move value
      Result<i32, never>.Failure { error } => move error
  }
}
effect fn outerRecover(error: OutOfMemoryError) -> i32 { return 9 }
pub fn main() -> i32 {
  let mut allocator = Allocator.systemAllocatorProvider()
  return run Effect.catchAll(
    Effect.provideMut(program(), &mut allocator),
    outerRecover,
  )
}`

/**
 * Both Audit providers conform to Allocator, and one is supplied with exclusive provider strength.
 * Suspension preserves those explicit requirements exactly but never selects either provider for
 * private coroutine storage. The Audit implementation always refuses, so accidental selection is
 * observable in the pinned native corpus.
 */
export const auditAllocatorSuspension = `import silk.allocator { Allocator }
import silk.allocator { OutOfMemoryError }
import silk.layout { Layout }
import silk.effect { Effect }
role SharedAudit
role ExclusiveAudit
struct AuditAllocator { tag: i32 }
effect fn allocate(self: &mut AuditAllocator, layout: Layout) -> Allocation ! OutOfMemoryError {
  fail OutOfMemoryError {}
}
impl Allocator for AuditAllocator { allocate: AuditAllocator.allocate }
effect fn protected() -> i32
? &Allocator at SharedAudit | &Allocator at ExclusiveAudit {
  return run Effect.suspend(effect { return 42 })
}
pub fn main() -> i32 {
  let sharedAudit = AuditAllocator { tag: 0 }
  let mut exclusiveAudit = AuditAllocator { tag: 0 }
  return run (protected()
    |> Effect.provide<Allocator at SharedAudit>(&sharedAudit)
    |> Effect.provideMut<Allocator at ExclusiveAudit>(&mut exclusiveAudit))
}`

export const ownedProviderSuspendedSuccess = `import silk.allocator { Allocator }
import silk.allocator { OutOfMemoryError }
import silk.allocator { Allocator }
import silk.allocator { SystemAllocator }
import silk.layout { Layout }
import silk.effect { Effect }
import silk.shared { Shared }
service Counter {
  effect fn increment() -> i32 ? &mut Counter
}
struct Drops { value: i32 }
struct Cell { value: i32 storage: Allocation drops: Shared<Drops> }
fn countDrop(drops: &mut Drops) -> i32 {
  drops.value = drops.value + 1
  return drops.value
}
fn readDrops(drops: &Drops) -> i32 { return drops.value }
impl Drop for Cell {
  fn drop(self: &mut Cell) -> () {
    let changed = Shared<Drops>.withMut<i32>(&self.drops, countDrop)
    return ()
  }
}
effect fn increment(self: &mut Cell) -> i32 {
  let value = self.value
  return run Effect.suspend(effect { return value + 1 })
}
impl Counter for Cell { increment: Cell.increment }
effect fn read() -> i32 ? &mut Counter {
  return run Counter.increment()
}
effect fn program(drops: &Shared<Drops>) -> i32 ! OutOfMemoryError ? &mut Allocator {
  let layout = Layout.of<[i32; 2]>()
  let storage = run Allocator.allocate(move layout)
  let cell = Cell {
    value: 41,
    storage: move storage,
    drops: Shared<Drops>.clone(drops),
  }
  let bound = Intrinsic.bindRequirementOwned<Counter>(read(), move cell)
  return run move bound
}
effect fn recover(error: OutOfMemoryError) -> i32 { return -1 }
effect fn build() -> i32 ! OutOfMemoryError ? &mut Allocator {
  let drops = run Shared<Drops>.make(Drops { value: 0 })
  let result = run program(&drops)
  let count = Shared<Drops>.with<i32>(&drops, readDrops)
  drop drops
  if result != 42 || count != 1 { return 1 }
  return 42
}
pub fn main() -> i32 {
  let mut allocator = Allocator.systemAllocatorProvider()
  return run Effect.catchAll(
    Effect.provideMut<Allocator>(build(), &mut allocator),
    recover,
  )
}`

export const ownedProviderSuspendedFailure = `import silk.allocator { Allocator }
import silk.allocator { OutOfMemoryError }
import silk.allocator { Allocator }
import silk.allocator { SystemAllocator }
import silk.layout { Layout }
import silk.effect { Effect }
import silk.shared { Shared }
struct Problem { code: i32 }
struct Drops { value: i32 }
service Value {
  effect fn read() -> i32 ! Problem ? &mut Value
}
struct Provider { code: i32 storage: Allocation drops: Shared<Drops> }
fn countDrop(drops: &mut Drops) -> i32 {
  drops.value = drops.value + 1
  return drops.value
}
fn readDrops(drops: &Drops) -> i32 { return drops.value }
impl Drop for Provider {
  fn drop(self: &mut Provider) -> () {
    let changed = Shared<Drops>.withMut<i32>(&self.drops, countDrop)
    return ()
  }
}
effect fn read(self: &mut Provider) -> i32 ! Problem {
  let providerCode = self.code
  let code = run Effect.suspend(effect { return providerCode })
  fail Problem { code: code }
}
impl Value for Provider { read: Provider.read }
effect fn open(drops: &Shared<Drops>) -> Provider ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let layout = Layout.of<[i32; 2]>()
  let storage = run Allocator.allocate(move layout) |> Effect.provideMut(&mut allocator)
  return Provider {
    code: 42,
    storage: move storage,
    drops: Shared<Drops>.clone(drops),
  }
}
effect fn use() -> i32 ! Problem ? &mut Value {
  return run Value.read()
}
effect fn program(drops: &Shared<Drops>) -> i32 ! Problem | OutOfMemoryError ? &mut Allocator {
  let provider = run open(drops)
  return run Intrinsic.bindRequirementOwned<Value>(use(), move provider)
}
effect fn recover(error: Problem | OutOfMemoryError) -> i32 { return 7 }
effect fn build() -> i32 ! OutOfMemoryError ? &mut Allocator {
  let drops = run Shared<Drops>.make(Drops { value: 0 })
  let result = run Effect.catchAll(program(&drops), recover)
  let count = Shared<Drops>.with<i32>(&drops, readDrops)
  drop drops
  if result != 7 || count != 1 { return 1 }
  return 7
}
effect fn recoverAllocation(error: OutOfMemoryError) -> i32 { return -1 }
pub fn main() -> i32 {
  let mut allocator = Allocator.systemAllocatorProvider()
  return run Effect.catchAll(
    Effect.provideMut(build(), &mut allocator),
    recoverAllocation,
  )
}`

export const mixedServiceProviderSuspension = `import silk.effect { Effect }
service Value {
  effect fn read() -> i32 ? &mut Value
}
struct Immediate { value: i32 }
effect fn readImmediate(self: &mut Immediate) -> i32 {
  return self.value
}
impl Value for Immediate { read: Immediate.readImmediate }
struct Delayed { value: i32 }
effect fn readDelayed(self: &mut Delayed) -> i32 {
  let value = self.value
  return run Effect.suspend(effect { return value })
}
impl Value for Delayed { read: Delayed.readDelayed }
effect fn use() -> i32 ? &mut Value {
  return run Value.read()
}
effect fn immediate() -> i32 {
  let mut provider = Immediate { value: 20 }
  return run Intrinsic.bindRequirementMut<Value>(use(), &mut provider)
}
effect fn delayed() -> i32 {
  let mut provider = Delayed { value: 22 }
  return run Intrinsic.bindRequirementMut<Value>(use(), &mut provider)
}
effect fn program() -> i32 {
  return (run immediate()) + (run delayed())
}
pub fn main() -> i32 {
  return run program()
}`
