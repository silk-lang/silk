/** Conditional cancellation and restoration use the same ownership flags across suspension. */
export const partialSuspension = `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.execution { Execution, Wake }
unsafe extern "C" fn silk_record_drop(value: i32) -> ()
unsafe extern "C" fn silk_verify_drops() -> i32
struct Token { value: i32 }
impl Drop for Token {
  fn drop(self: &mut Token) -> () { unsafe { silk_record_drop(self.value) } return () }
}
struct Pair { left: Token right: Token }
struct Endpoint {}
fn ready(endpoint: &Endpoint) -> () { return () }
struct Guard { wake: Wake }
fn register(wake: Wake) -> Guard { return Guard { wake: move wake } }
effect fn parked(flag: bool) -> i32 {
  let mut pair = Pair { left: Token { value: 1 }, right: Token { value: 2 } }
  if flag { let extracted = move pair.left drop extracted }
  run Execution.park(register)
  pair.left = Token { value: 3 }
  return pair.left.value + pair.right.value
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
effect fn cancel(flag: bool) -> () ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let execution = run Execution.make(parked(flag), Endpoint {}, ready)
    |> Effect.provideMut(&mut allocator)
  let mut owner = Owner { slot: Empty {} }
  run Execution.drive(move execution, &mut owner, complete, suspend)
  drop owner
  return ()
}
effect fn delayed(value: i32) -> i32 { return run Intrinsic.suspendEffect(effect { return value }) }
effect fn resumed(flag: bool) -> i32 {
  let mut pair = Pair { left: Token { value: 4 }, right: Token { value: 5 } }
  if flag { let extracted = move pair.left drop extracted }
  let next = run delayed(6)
  pair.left = Token { value: next }
  drop pair
  return next
}
effect fn program() -> i32 ! OutOfMemoryError {
  run cancel(true)
  run cancel(false)
  let first = run resumed(true)
  let second = run resumed(false)
  if first + second != 12 { return 0 }
  unsafe { return silk_verify_drops() }
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(program(), recover) }`
