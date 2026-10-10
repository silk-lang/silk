/** One ordinary-source stream exercises all four JUL-151 spelling and storage gaps. */
export const borrowedTemporaryStream = `import silk.option { Option }
import silk.effect { Effect }
import silk.monotonic_clock { MonotonicClock }
import silk.os_monotonic_clock { OsMonotonicClock }
interface Stream<A, E, ?R> { effect fn take(self: &mut Self) -> Option<A> ! E ? R }
pub struct SliceStream<A> { slice: &[A] index: usize }
impl<A> SliceStream<A> {
  pub fn make(slice: &[A]) -> SliceStream<A> { return SliceStream<A> { slice: slice, index: 0 } }
}
impl<A: Copy> Stream<A, never ? never> for SliceStream<A> {
  effect fn take(self: &mut Self) -> Option<A> {
    if self.index >= self.slice.length { return Option.none<A>() }
    let i = self.index
    self.index = self.index + 1
    return Option.some(self.slice[i])
  }
}
effect fn consume() -> i32 ? &mut MonotonicClock {
  let mut stream = SliceStream.make(&[10, 20, 12])
  let mut result = 0
  let mut count = 0
  while true {
    run Effect.sleep(1ns)
    let taken = run stream.take()
    if let Option.Some { value } = move taken {
      result = result + value
      count = count + 1
    } else { break }
  }
  if count != 3 { return 0 }
  return result
}
pub fn main() -> i32 {
  let mut clock = OsMonotonicClock.make()
  return run consume() |> Effect.provideMut(&mut clock)
}`

/** Backing owners share ordinary local evaluation, cleanup, and cancellation paths. */
export const borrowedTemporaryLifecycle = `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.execution { Execution, Wake }
unsafe extern "C" fn silk_record_event(value: i32) -> ()
unsafe extern "C" fn silk_finish_events() -> i32
struct Token { value: i32 }
impl Drop for Token {
  fn drop(self: &mut Token) -> () { unsafe { silk_record_event(self.value) } return () }
}
fn make(value: i32) -> Token { unsafe { silk_record_event(value + 10) } return Token { value: value } }
fn before() -> i32 { unsafe { silk_record_event(90) } return 0 }
pub struct Holder<A> { slice: &[A] }
impl<A> Holder<A> {
  pub fn make(prefix: i32, slice: &[A]) -> Holder<A> { return Holder<A> { slice: slice } }
}
fn branch(flag: bool) -> () {
  if flag {
    let holder = Holder.make(before(), &[make(1), make(2)])
    let slice = holder.slice
    unsafe { silk_record_event(slice[0].value + 20) }
    return ()
  } else {
    let holder = Holder.make(before(), &[make(7)])
    let slice = holder.slice
    unsafe { silk_record_event(slice[0].value + 20) }
  }
  return ()
}
fn repeated() -> () {
  let mut i = 3
  while i < 5 {
    let holder = Holder.make(before(), &[make(i)])
    let slice = holder.slice
    unsafe { silk_record_event(slice[0].value + 20) }
    i = i + 1
  }
  return ()
}
struct ObservingHolder<'a> { slice: &'a [Token] }
impl<'a> Drop for ObservingHolder<'a> {
  fn drop(self: &mut ObservingHolder<'a>) -> () {
    let slice = self.slice
    unsafe { silk_record_event(slice[0].value + 40) }
    return ()
  }
}
fn watching(prefix: i32, slice: &[Token]) -> ObservingHolder {
  return ObservingHolder { slice: slice }
}
fn loopNormal(limit: i32) -> () {
  let older = make(10)
  let holder = watching(before(), &[make(7)])
  let mut i = 0
  while i < limit {
    let slice = holder.slice
    unsafe { silk_record_event(slice[0].value + 20) }
    i = i + 1
    if i == 1 { continue }
    break
  }
  return ()
}
fn loopReturn(entered: bool) -> () {
  return run effect {
    let holder = watching(before(), &[make(8)])
    while entered {
      let slice = holder.slice
      unsafe { silk_record_event(slice[0].value + 20) }
      return ()
    }
    return ()
  }
}
struct Failed {}
effect fn failure() -> () ! Failed { fail Failed {} }
effect fn loopFailure() -> () ! Failed {
  let holder = watching(before(), &[make(9)])
  while true {
    let slice = holder.slice
    unsafe { silk_record_event(slice[0].value + 20) }
    run failure()
  }
  return ()
}
effect fn recoverLoop(error: Failed) -> () { return () }
struct Endpoint {}
fn ready(endpoint: &Endpoint) -> () { return () }
struct Guard { wake: Wake }
fn register(wake: Wake) -> Guard { return Guard { wake: move wake } }
effect fn parked() -> i32 {
  let holder = Holder.make(before(), &[make(5)])
  run Execution.park(register)
  let slice = holder.slice
  return slice[0].value
}
struct Empty {}
struct Stored { execution: Intrinsic.Execution<i32> }
struct Owner { slot: Empty | Stored }
fn complete(owner: &mut Owner, value: i32) -> () { return () }
fn suspend(owner: &mut Owner, execution: Intrinsic.Execution<i32>) -> () {
  let previous = Intrinsic.replace(owner.slot, Stored { execution: move execution })
  drop previous
  return ()
}
effect fn cancel() -> () ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let execution = run Execution.make(parked(), Endpoint {}, ready) |> Effect.provideMut(&mut allocator)
  let mut owner = Owner { slot: Empty {} }
  run Execution.drive(move execution, &mut owner, complete, suspend)
  unsafe { silk_record_event(95) }
  drop owner
  return ()
}
effect fn delayed() -> () { return run Intrinsic.suspendEffect(effect { return () }) }
effect fn resumed() -> i32 {
  let holder = Holder.make(before(), &[make(6)])
  run delayed()
  let slice = holder.slice
  unsafe { silk_record_event(slice[0].value + 20) }
  return 42
}
effect fn program() -> i32 ! OutOfMemoryError {
  branch(true)
  repeated()
  loopNormal(2)
  loopNormal(0)
  loopReturn(true)
  loopReturn(false)
  run Effect.catchAll(loopFailure(), recoverLoop)
  run cancel()
  let result = run resumed()
  if result != 42 { return 0 }
  unsafe { return silk_finish_events() }
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(program(), recover) }`
