/** Source application forms exercised through the installed standalone startup. */
export const all = [
  { name: 'integer', expected: 42, source: 'pub fn main() -> i32 { return 42 }' },
  { name: 'unit', expected: 0, source: 'pub fn main() -> () {}' },
  { name: 'effect-unit', expected: 0, source: 'pub effect fn main() {}' },
  {
    name: 'captured-effect',
    expected: 0,
    source: `import silk.effect { Effect }
fn capturedInput() -> i32 { return 42 }
pub fn main() -> Effect<'static; ()> {
  let captured = capturedInput()
  return effect {
    let value = run Intrinsic.suspendEffect(effect { return captured })
    if value != 42 { let invalid = value / (value - value) }
    return ()
  }
}`,
  },
  {
    name: 'typed-failure',
    expected: 1,
    source: `pub struct Problem {}
pub effect fn main() ! Problem {
  let value = run Intrinsic.suspendEffect(effect { return 42 })
  fail Problem {}
}`,
  },
  {
    name: 'failure-payload-cleanup',
    expected: 'Trap',
    source: `import silk.ownership {Drop}
pub struct Problem { divisor: i32 }
impl Drop for Problem {
  fn drop(self: &mut Problem) -> () { let checked = 1 / self.divisor return () }
}
pub effect fn main() ! Problem { fail Problem { divisor: 0 } }`,
  },
  {
    name: 'bare-trap',
    expected: 'Trap',
    source: `fn divide(divisor: i32) -> i32 { return 1 / divisor }
pub fn main() -> i32 { return divide(0) }`,
  },
]
