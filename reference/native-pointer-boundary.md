---
title: Native pointer boundary
description: Qualified raw addresses and explicit initialization states for native output.
---

# Native pointer boundary

This is the prescriptive JUL-123 contract. The implementation and independent conformance evidence
are tracked by `add-native-pointer-boundary` in OpenSpec.

## Qualified addresses

| Form                       | Nullability           | Extent                       |
| -------------------------- | --------------------- | ---------------------------- |
| `*const T`, `*mut T`       | Non-null              | One object                   |
| `[*]const T`, `[*]mut T`   | Non-null              | Many objects; no length lane |
| `?*const T`, `?*mut T`     | Explicit foreign null | One object when present      |
| `?[*]const T`, `?[*]mut T` | Explicit foreign null | Many objects when present    |

Every pointer retains its invariant pointee and independent access, nullability, extent, minimum
alignment and address space. Nested pointers preserve these distinctions at every level. The nullable
form uses address zero in ordinary address space zero, without adding a tag lane. These forms are
Copy raw addresses; they own nothing and retain no borrow.

Optional `align(N)` and `addrspace(0)` follow `const` or `mut`, before the pointee. Alignment is a
positive power of two through 536870912 bytes. Without `align`, the pointer guarantees its pointee's
natural alignment from the selected semantic target layout. Only address space zero is admitted.

```silk
unsafe extern "C" fn fill(buffer: ?[*]mut u8, length: usize) -> isize
unsafe extern "C" fn errorSlot() -> ?*mut i32
unsafe extern "C" fn entries() -> ?[*]const ?[*]const u8
unsafe extern "C" fn packedWord() -> *const align(1) addrspace(0) u32
```

## Conversions and access

Implicit conversions preserve pointee identity and extent. They may remove mutation capability,
add nullability, or weaken an established alignment. They never silently strengthen access,
nullability or alignment, change single/many extent, or convert a slice into a bare pointer.
Natural alignment can always weaken to one. Strengthening a guarantee that cannot be established
statically requires an explicit unsafe qualifier conversion.

Ordinary source null checking returns an Option of a non-null pointer. Dereference remains unsafe:
null checking does not prove live, initialized storage. Many-pointer indexing requires an unsafe
bounds/liveness proof, uses the semantic element stride and returns a single-object pointer.
Explicit unaligned access uses a byte-alignment promise; it never invents natural alignment for LLVM.

Reference and raw-slot formation produce single addresses. Slice formation produces many addresses
and discards no length implicitly: the caller passes the slice length separately to the foreign API.
A possibly empty slice uses an explicitly nullable many pointer at that boundary. Forming a pointer
never proves pinning, ownership transfer, foreign retention permission or liveness after moving or
destroying its owner.

Raw address observation is `Intrinsic.pointerAddress<P>(pointer: P) -> usize`. It accepts only data pointers and returns their unsigned target-width address, with zero for null. It does not access the pointee, retain storage or provide integer-to-pointer reconstruction. `Pointer.address` and `Pointer.addressMany` expose the single-element and many-element forms. Address observation is a runtime operation.

`Intrinsic.pointerReinterpret<From, To>(pointer)` is an unsafe data-pointer
reinterpretation for allocator-owned storage and foreign records. It preserves
the numeric address, address space, mutation capability, nullability and
single/many extent while changing the pointee. The caller must prove the result's
alignment before typed access and prove initialization before any read. The
operation does not read memory, initialize a value, acquire ownership or create a
loan. It does not reconstruct pointers from integers. Qualifier changes remain
separate explicit operations; reinterpretation cannot also grant write access or
remove nullability.

`Intrinsic.pointerTake<T>(pointer: *mut T) -> T` is the unsafe move out of naturally aligned
storage, and `Intrinsic.pointerWrite<T>` is the matching move in; neither requires `T: Copy`.
`Pointer.take` and `Pointer.put` expose them (`Pointer.read` and `Pointer.write` keep the `Copy`
bound). Taking leaves the storage logically uninitialized: the caller must refill it or never read
or drop it again, and putting over an initialized value does not drop that value. Together they
move one owned value through storage that C code carries, such as a thread start argument.

`Intrinsic.pointerBorrow<A, T>(anchor: &'a A, pointer: *const T) -> &'a T` and
`Intrinsic.pointerBorrowMut<A, T>(anchor: &'a mut A, pointer: *mut T) -> &'a mut T` are the unsafe
anchored borrows. The result is a reference to the pointer's referent with the anchor's lifetime,
so ordinary borrow checking keeps the anchor borrowed, with the same access, exactly as long as the
reference lives. The anchor names the loan and is not otherwise read. `Pointer.borrow` and
`Pointer.borrowMut` expose them. The caller proves the referent is initialized and stays valid for
the anchor's loan, and that the access is exclusive for the mutable form, or free of non-atomic
writes for the shared one. A handle that owns storage through a raw pointer passes itself as the
anchor, so `Arc.get` and `MutexGuard.getMut` return references that cannot outlive the handle or
the lock.

`Intrinsic.pointerBorrowMany<A, T>(anchor: &'a A, pointer: [*]const T, length: usize) -> &'a [T]`
and `Intrinsic.pointerBorrowManyMut<A, T>(anchor: &'a mut A, pointer: [*]mut T, length: usize) ->
&'a mut [T]` are the many-element forms. The result is a slice of `length` elements that starts at
the pointer, with the anchor's lifetime and access, and lowers to the plain pointer and length pair
with no check. The anchor may also be a slice of `A`, `&'a [A]` or `&'a mut [A]`, so a view of a
slice's own storage, such as `Slice.asBytes`, borrows that slice even when it is empty.
`Pointer.borrowMany` and `Pointer.borrowManyMut` expose the reference forms. The caller proves that
the pointer addresses `length` initialized, contiguous elements in one allocation, that
`length * size_of(T)` fits in `isize`, and the same validity and access rules as the single-element
forms for the anchor's loan. A zero length still needs a non-null pointer aligned for `T`.

## Stack frames and stack storage

`Intrinsic.frameAddress() -> [*]const u8` is the safe runtime observation of the running function's
stack frame. On native targets it is the machine frame address; on `wasm32` it is the frame in the
linear-memory stack, and a function that keeps nothing in linear memory shares its caller's address.
Every supported stack grows down, so each frame of a still-running caller is at the same or a
higher address. The result is valid for comparison and for unsafe reads only while that frame is
live. Inlining can place the call in its caller's frame. `Stack.frameAddress` exposes it.

`Intrinsic.stackAllocate<T>(count: usize) -> [*]mut T` is the unsafe dynamic stack allocation. The
storage holds `count` uninitialized elements of `T` at its natural alignment and stays valid until
the running function returns. A frame-based instance releases it at a suspension too, so it must not
be used across one. A byte count that does not fit `usize` traps with `arithmetic overflow`. The
caller proves that the storage fits the stack that the running thread has left; storage past the
end of the stack is undefined behavior, not a stack-overflow trap. Values written to the storage
are never dropped. Repeated calls in one function keep growing its frame, so a loop should allocate
through a callee that returns. `Stack.withStorage` is that callee: it passes the storage to a
callback and releases it when the callback returns.

Both are runtime operations; a static body cannot call them.

## Native output storage

Ordinary source owns `Uninitialized<T>` and `Initialized<T>` output states for Copy values. Private
storage fields prevent safe construction of an initialized owner without a state transition. The
underlying allocation and RawBuffer owner reuse existing cleanup and ownership rules.

Taking an uninitialized output address neither reads T nor forms a readable T reference. Passing
that address to C leaves the source state unchanged. Safe initialization writes a supplied T and
consumes the uninitialized owner into the initialized state. Asserting that arbitrary C wrote a valid
T requires an explicit unsafe assumption. Extraction consumes the initialized owner once; ordinary
ownership rejects another extraction. The compiler does not claim to prove what arbitrary C wrote.

## Layout and verification

The audited target description supplies primitive size, alignment, pointer facts and endianness.
Existing external structs and arrays derive layout from those facts before LLVM lowering. Missing
or inconsistent facts fail before use; there is no ambient-host layout fallback. C classification carries the required sign/zero-extension attributes for narrow integers on
Darwin ARM64 and System V x86-64; GNU AAPCS64 and Microsoft x86-64 leave those attributes absent. LLVM consumes these
verified facts on foreign declarations, call sites and exported thunks.

For `x86_64-pc-windows-msvc`, signed and unsigned 8-bit and 16-bit scalar arguments and results
use bare LLVM integer lanes. The caller does not promise sign or zero extension of their upper
register bits. C default argument promotions still apply to unnamed variadic arguments.
The independent [Clang fixture](../compiler/fixtures/windows-abi/README.md) records the declaration,
direct-call, callback and export signatures. Windows foreign guards use the four-argument x64
exception routine ABI: exception-record pointer, 64-bit establisher frame, context pointer and
dispatcher-context pointer, with an `i32` disposition result. The handler terminates through
Windows fast fail with reason `FAST_FAIL_FATAL_APP_EXIT`, without dispatching another exception.
ELF and Mach-O keep their five-argument trap personality. All targets use a hidden coalesced
definition. A reduced native SEH fixture verifies the Windows handler boundary.
Full Silk executable interoperability still requires the Windows runtime and linker.
By-value C structs and vectors on Windows remain unsupported and must not use the ARM64 classifier.

An `extern "C" struct` can pass or return by value in direct calls, native function-pointer
calls and exported functions. Its fields retain the C object restrictions: C scalars, raw
pointers, admitted function pointers and vectors, fixed arrays, represented scalar enums and
nested C-layout structs. Ordinary Silk records, slices and tagged unions are not C values.
Passing a struct by value gives the callee its own value; writes to its parameter do not change
the caller's object, including when the machine ABI passes an address of a caller copy.

| Target | Struct arguments and results |
| --- | --- |
| System V x86-64 | Up to two eightbytes use INTEGER and SSE registers. An argument that needs more registers than remain passes entirely in memory. Larger records use `byval` arguments and `sret` results. A record containing only one admitted SIMD vector retains that vector's register convention and feature requirement. |
| GNU and Apple ARM64 | Homogeneous aggregates of one through four floats or short vectors use vector registers. Other records up to 16 bytes use general registers. Larger arguments pass a pointer to a caller copy; indirect results use `sret` in x8. GNU homogeneous arguments retain the AAPCS64 stack alignment; Apple uses its own stack placement. |
| wasm32 | A record containing a single scalar uses that scalar's lane. Other records use indirect arguments and results. |

Classification follows nested field offsets and array elements from the audited target layout.
Padding is not a source value, and register coercion does not read or write beyond an object's size.
Structs are fixed parameters only; variadic tails admit only integers, floats and raw pointers.

Conformance uses separately compiled C and Silk objects with pinned compiler, linker and
SDK/libc/header supplies. Debug and optimized Darwin ARM64 and GNU x86-64 cases execute; GNU ARM64
also compiles, links, undergoes object inspection and executes on the available runner. Designated
lanes fail on absent supplies or skipped cases. LTO is unsupported unless a dedicated tested boundary
admits it. These fixtures establish admitted ABI behavior, not arbitrary foreign initialization or
retained-address safety.

The executable conformance fixture and runner
record exact supply checks, object inspection, and execution evidence for each requested lane.

## Direct C calls in LLVM-to-Wasm storage components

The LLVM-to-Wasm path admits C functions with scalar lanes, address-space-zero data pointers,
C-layout structs and void results. Direct calls, native function-pointer calls and exported
functions use the same classification. Narrow scalar integers extend to 32 bits as the WebAssembly
C ABI requires; single-scalar struct coercions retain the C aggregate rule without scalar extension
attributes. A data address converts exactly to and from the 32-bit `usize`. Variadics, foreign
borrowed arguments and foreign data remain outside this target's boundary.
This does not select an OS API or a JavaScript host import. Final linkage must
resolve the declared symbols. Pointer reinterpretation has the same explicit
alignment, initialization and lifetime obligations as on native targets.

The `foreign-struct-values` and `foreign-struct-vectors` native corpus fixtures compile their C
translation units separately and run debug and optimized Silk builds on all three native lanes.
`compiler/scripts/test-c-aggregates.ts` separately compiles and executes the shared value fixture
on wasm32 in both profiles, including callbacks, exported thunks and caller-copy checks.
