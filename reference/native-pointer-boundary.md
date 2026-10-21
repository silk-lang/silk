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
Darwin ARM64 and System V x86-64; GNU AAPCS64 leaves those attributes absent. LLVM consumes these
verified facts on foreign declarations, call sites and exported thunks. The
scalar/pointer/void C ABI is retained, and slices and aggregate-by-value signatures remain outside
this initial boundary.

Conformance uses separately compiled C and Silk objects with pinned compiler, linker and
SDK/libc/header supplies. Debug and optimized Darwin ARM64 and GNU x86-64 cases execute; GNU ARM64
also compiles, links, undergoes object inspection and executes on the available runner. Designated
lanes fail on absent supplies or skipped cases. LTO is unsupported unless a dedicated tested boundary
admits it. These fixtures establish admitted ABI behavior, not arbitrary foreign initialization or
retained-address safety.

The executable conformance fixture and runner
record exact supply checks, object inspection, and execution evidence for each requested lane.

## Direct C calls in LLVM-to-Wasm storage components

The retained LLVM-to-Wasm path admits direct C functions with address-space-zero
data pointers, 32-bit integers, and void results for explicitly linked source
runtime components. Other scalar classes, variadics, callbacks, foreign borrowed
arguments, indirect C calls and foreign data are not admitted on this target.
This does not select an OS API or a JavaScript host import. Final linkage must
resolve the declared symbols. Pointer reinterpretation has the same explicit
alignment, initialization and lifetime obligations as on native targets.
