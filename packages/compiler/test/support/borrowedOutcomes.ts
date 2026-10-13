export const borrowedBox = `import silk.allocator { Allocator, OutOfMemoryError }
import silk.box { Box }
import silk.effect { Effect }
effect fn boxed<'data>(value: &'data i32) -> Box<&'data i32> ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  return run Box.make(value) |> Effect.provideMut(&mut allocator)
}
effect fn useBox() -> i32 ! OutOfMemoryError {
  let value = 42
  let box = run boxed(&value)
  let result = Box.into(move box)
  return result.*
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(useBox(), recover) }`

export const borrowedStream = `import silk.option { Option }
service Unused { effect fn unused() -> () ? &Unused }
interface Stream<Item, E, ?R> {
  effect fn take<'call>(self: &'call mut Self) -> Option<Item> ! E ? R
}
struct SliceStream<'data, A> { items: &'data [A] index: usize }
impl<'data, A> Stream<&'data A, never ? Without<&Unused, Unused>> for SliceStream<'data, A> {
  effect fn take<'call>(self: &'call mut SliceStream<'data, A>) -> Option<&'data A> {
    if self.index >= self.items.length { return Option<&'data A>.none() }
    let result = &self.items[self.index]
    self.index = self.index + 1
    return Option.some(result)
  }
}
fn item<'data>(option: Option<&'data i32>) -> i32 {
  return match move option {
    Option<&'data i32>.Some { value } => value.*
    Option<&'data i32>.None => 0
  }
}
pub fn main() -> i32 {
  let values = [20, 22]
  let mut stream = SliceStream { items: &values, index: 0 }
  let first = run Stream.take(&mut stream)
  let second = run Stream.take(&mut stream)
  drop stream
  return item(move first) + item(move second)
}`

export const borrowedFailure = `import silk.effect { Effect }
struct Problem<'a> { value: &'a i32 }
effect fn failWith<'a>(value: &'a i32) -> never ! Problem<'a> {
  fail Problem { value: value }
}
effect fn forward<'a>(value: &'a i32) -> never ! Problem<'a> {
  return run failWith(value)
}
effect fn recover<'a>(error: Problem<'a>) -> &'a i32 { return error.value }
effect fn cleanup() -> () { return () }
fn identity<'a>(value: &'a i32) -> &'a i32 { return value }
effect fn continueWith<'a>(value: &'a i32) -> &'a i32 { return value }
pub fn main() -> i32 {
  let value = 42
  let recovered = Effect.catchAll(Effect.ensuring(Effect.retry(forward(&value), 2), cleanup()), recover)
  let mapped = Effect.map(recovered, identity)
  let result: &i32 = run Effect.flatMap(mapped, continueWith)
  return result.*
}`

export const affineBorrowedStream = `import silk.option { Option }
import silk.ownership { Drop }
interface Stream<Item> { effect fn take<'call>(self: &'call mut Self) -> Option<Item> }
struct Item<'data> { value: &'data mut i32 }
impl<'data> Drop for Item<'data> { fn drop(self: &mut Item<'data>) -> () { self.value.* = 42 return () } }
struct OnceStream<'data> { pending: Option<Item<'data>> }
impl<'data> Stream<Item<'data>> for OnceStream<'data> {
  effect fn take<'call>(self: &'call mut OnceStream<'data>) -> Option<Item<'data>> {
    return Intrinsic.replace(self.pending, Option<Item<'data>>.none())
  }
}
pub fn main() -> i32 {
  let mut value = 0
  let mut stream = OnceStream { pending: Option.some(Item { value: &mut value }) }
  let item = run Stream.take(&mut stream)
  drop stream
  drop item
  return value
}`
