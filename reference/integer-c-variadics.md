---
title: Scalar C variadics
---

A native foreign declaration may end its fixed parameter list with `, ...`:

```silk
unsafe extern "C" fn receive(tag: i32, ...) -> i32
```

The declaration must have at least one fixed parameter. Ellipsis is last and creates no named
parameter. Calls supply all fixed arguments and then zero or more admitted scalar or raw-pointer values, under
the usual unsafe acknowledgement. Ellipsis is not admitted on ordinary definitions, generic
exports or C function-pointer types.

Fixed arguments retain their declared contextual types and the existing scalar/pointer boundary.
Tail expressions retain ordinary expression typing without a declared parameter type. The admitted
tail types are i8, u8, i16, u16, i32, u32, i64, u64, isize, usize, f32, f64 and raw pointers.
Signed and unsigned 8/16-bit integers promote to signed i32 because C int is 32-bit on the admitted
platforms. Values of 32/64-bit or pointer-width integer types retain their width and signedness.
An ordinary unannotated integer literal has its usual i32 type; use a typed binding or conversion
when a different width is needed. An f32 tail promotes to f64; f64 tails remain unchanged.
Raw pointers retain their exact pointee, access, nullability, multiplicity and alignment.
References, aggregates, bool, char, native functions, C callback values and vectors diagnose.

Darwin mode_t is unsigned 16-bit and promotes to signed int; GNU mode_t is unsigned 32-bit and
remains unsigned int. Ordinary selected source owns platform types, flags and whether a mode is
required. The compiler does not recognize the names open, openat or fcntl. The filesystem provider
can declare open/openat with their real fixed boundary and choose zero or one mode operand itself.

Variadic status and fixed types belong to the native symbol's declaration identity. Promoted tail
types belong to each call, so zero-tail and multiple-tail calls share one declaration. A fixed and
a variadic declaration of the same reachable symbol conflict even when their fixed types agree.
Inactive selected variants contribute no symbols.

LLVM receives a true variadic declaration and the promoted operands. Darwin ARM64 passes unnamed
scalar and pointer arguments in its prescribed stack slots; GNU ARM64 and System V x86-64 use their C ABI's
register and stack rules. Conservative foreign memory/retention contracts and fatal-unwind behavior
remain in force. No fake fixed signature, function-pointer cast or generated C adapter substitutes
for the variadic call. ABI manifests expose declaration status and MIR inspection exposes call
shapes and promotions.

The admitted matrix is Darwin ARM64 and GNU/Linux x86-64 and ARM64. Required pinned conformance
uses independently compiled C receivers and direct platform calls in debug and optimized builds;
missing supplies or skipped designated cases fail. LTO remains unadmitted.

## Variadic exports

An `export "C"` function may also end its parameters with `, ...`, so that a C caller can pass it
extra arguments:

```silk
import silk.mem.va_list { VaList }

pub unsafe export "C" fn configure(target: *mut u8, option: i32, ...) -> i32 as "uv_loop_configure" {
  if option != 0 {
    return 0
  }
  unsafe {
    let mut arguments = VaList.of(Intrinsic.variadicArguments())
    return arguments.next<i32>()
  }
}
```

The export's C entry is a true variadic LLVM function. It runs `va_start` on entry and `va_end`
before it returns, and hands the `va_list` address to the body. In that body only,
`Intrinsic.variadicArguments()` answers the address as `*mut u64`; anywhere else it diagnoses
SEM0188. `silk.mem.va_list` reads the arguments in order under the target's C ABI: System V
x86-64 and GNU ARM64 read the register save area and then the stack, while Darwin ARM64, Windows
and WebAssembly read consecutive stack slots. Read a promoted `char` or `short` as `i32` and a
`float` as `f64`. Nothing checks the caller's arguments against the reads. A Silk call to a
variadic export is an ordinary variadic C call with the tail rules above. The direct WebAssembly
backend does not lower variadic exports yet.
