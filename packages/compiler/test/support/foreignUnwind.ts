/** A real platform unwind must encounter a retained Silk guard frame. Without a guard,
 * _Unwind_RaiseException returns END_OF_STACK and the fixture returns normally instead. */
export const foreignUnwindFixture = `#include <stdint.h>
#include <string.h>
#include <unwind.h>

int32_t silk_test_raise_unwind(void) {
  struct _Unwind_Exception exception;
  memset(&exception, 0, sizeof(exception));
  exception.exception_class = UINT64_C(0x53494c4b54455354);
  _Unwind_RaiseException(&exception);
  return 0;
}

int32_t silk_test_invoke_callback(int32_t (*callback)(void)) {
  return callback();
}
`

export const foreignDirectUnwind = `unsafe extern "C" fn silk_test_raise_unwind() -> i32
pub fn main() -> i32 { return unsafe silk_test_raise_unwind() }
`

export const foreignCallbackUnwind = `unsafe extern "C" fn silk_test_raise_unwind() -> i32
unsafe extern "C" fn silk_test_invoke_callback(callback: extern "C" fn() -> i32) -> i32
  with Intrinsic.foreign(callbacks: ("callback",))
export "C" fn callback() -> i32 { return unsafe silk_test_raise_unwind() }
pub fn main() -> i32 { return unsafe silk_test_invoke_callback(callback) }
`

export const foreignIndirectUnwind = `unsafe extern "C" fn silk_test_raise_unwind() -> i32
export "C" fn callback() -> i32 { return unsafe silk_test_raise_unwind() }
fn invoke(callback: extern "C" fn() -> i32) -> i32 { return unsafe callback() }
pub fn main() -> i32 { return invoke(callback) }
`
