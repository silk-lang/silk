# SIMD vectors

A SIMD vector holds a fixed number of lanes of one numeric type and operates on all of them at
once. The compiler supplies the vector and mask types, their operators, and a small set of lane
operations; everything built on them is standard-library or user source.

## Terms

- A **vector** is a value of type `simd<T, N>`: `N` lanes of the numeric type `T`.
- A **mask** is a value of type `mask<N>`: `N` lanes that are each set or clear. Lane comparisons
  produce masks and `simdSelect` consumes them.
- A **lane** is one element of a vector or mask, numbered from `0`.

## SIMD-001 — `simd<T, N>` and `mask<N>` are Copy values of a fixed shape

**Status:** Confirmed

```silk,ignore
let bytes: simd<u8, 16> = Intrinsic.simdSplat<simd<u8, 16>>(0)
let flags: mask<16> = Intrinsic.simdLanesEqual<simd<u8, 16>>(bytes, bytes)
```

`T` is one of `u8`, `u16`, `u32`, `u64`, `usize`, `i8`, `i16`, `i32`, `i64`, `isize`, `f32`, or
`f64`. `N` is a static integer expression (STATIC-002) whose value is a power of two from 2 to 64,
and the vector's width, `N` times the lane width, is 16 to 512 bits. A mask takes any power of two
from 2 to 64 lanes. Two vector types are the same type when their lane types and lane counts are
equal, however the count is written.

Vectors and masks are Copy. They pass, return, and sit in fields and arrays by value. A vector is
its lanes in order, with lane `0` at the lowest address, aligned to its own size. A mask stores one
bit per lane, lane `0` in the lowest bit, rounded up to whole bytes.

`simd` and `mask` are type names only when `<` follows them in a type position; elsewhere they are
ordinary names.

**Boundary:** A mask is never written `simd<bool, N>`. A lane count is not a generic parameter: a
library writes one declaration per shape. A vector crosses a C boundary as SIMD-010 describes; a
mask does not.

**Diagnostics:** A lane type, lane count, or width outside these rules reports `SEM0239` at the
type. So does `simd<bool, N>`.

**Current compiler:** Aligned. A vector lowers to an LLVM `<N x T>` value and a mask to
`<N x i1>`. Without a target feature for the width, LLVM splits the operation into narrower or
scalar instructions.

**Evidence:** `corpus/native/simd-core`, `corpus/invalid/simd-invalid-shape`.

## SIMD-002 — Operators apply lane by lane, and `==` compares the whole vector

**Status:** Confirmed

Arithmetic (`+`, `-`, `*`, `/`, `%`) and negation take two vectors of one type and apply the scalar
operator to each pair of lanes. An integer lane traps exactly when the scalar operation traps: on
overflow, on division by zero, and on the minimum signed value divided by `-1`. A float lane follows
IEEE 754 as the scalar operator does. Wrapping and saturating lane arithmetic are explicit
operations, not operators.

Bitwise `&`, `|`, `^`, and `~` take integer vectors or masks. `!` takes a mask and inverts every
lane.

`==` is `true` when every lane is equal and `!=` is `true` when any lane differs, so `a != b` is
always `!(a == b)`. A float NaN lane is unequal to every lane, itself included. Lane-by-lane
comparisons that produce a mask are the operations of SIMD-003.

**Boundary:** Both operands have one exact type; a scalar operand is not broadcast, so a program
writes `simdSplat` for it. `<`, `<=`, `>`, and `>=` do not apply to vectors.

**Diagnostics:** An operator outside these rules reports `SEM0135`.

**Current compiler:** Aligned. A lane trap reduces the lane flags with `llvm.vector.reduce.or`
before one branch, and `==` reduces the lane comparison with `llvm.vector.reduce.and`.

**Evidence:** `corpus/native/simd-core`, `corpus/native/simd-lane-overflow-trap`.

## SIMD-003 — Lane operations build, read, compare, and select vectors

**Status:** Confirmed

```silk,ignore
fn simdSplat<V>(lane: L) -> V
fn simdExtract<V>(vector: V, index: usize) -> L
fn simdInsert<V>(vector: V, index: usize, lane: L) -> V
fn simdFromArray<V>(lanes: [L; N]) -> V
fn simdToArray<V>(vector: V) -> [L; N]
fn simdLanesEqual<V>(left: V, right: V) -> mask<N>
fn simdSelect<V>(mask: mask<N>, chosen: V, other: V) -> V
```

Each operation's one type argument `V` is a vector or mask type with lane type `L` and lane count
`N`. `simdSplat` sets every lane to one value. `simdExtract` and `simdInsert` read and replace one
lane; an index of `N` or more traps with `index out of bounds` after every argument is evaluated.
`simdFromArray` and `simdToArray` convert between a vector and an array of its lanes in lane
order.

`simdLanesEqual`, `simdLanesNotEqual`, `simdLanesLess`, `simdLanesLessOrEqual`,
`simdLanesGreater`, and `simdLanesGreaterOrEqual` compare each pair of lanes and set the mask lane
where the comparison holds. Integer lanes compare under their signedness. A float comparison with a
NaN lane holds only for `simdLanesNotEqual`. The ordering comparisons take numeric vectors only.
`simdSelect` takes lane `i` of `chosen` where mask lane `i` is set and of `other` elsewhere.

**Boundary:** These are compiler primitives in the sealed `Intrinsic` namespace (INTR-001). The
`silk.simd.simd` modules are the public API over them: one module per shape, such as `silk.simd.u8x16`
for `simd<u8, 16>` and `silk.simd.mask16` for `mask<16>`, for every lane type at 128 and 256 bits.

**Diagnostics:** A type argument that is not an admitted vector, or a mask for an ordering
comparison, reports `SEM0239` at the call.

**Current compiler:** Aligned.

**Evidence:** `corpus/native/simd-core`, `corpus/native/simd-lane-index-trap`,
`corpus/native/simd-stdlib`.

## SIMD-004 — Wrapping, saturating, shift, and math lane operations

**Status:** Confirmed

```silk,ignore
fn simdWrappingAdd<V>(left: V, right: V) -> V
fn simdSaturatingAdd<V>(left: V, right: V) -> V
fn simdShiftLeft<V>(vector: V, counts: V) -> V
fn simdRotateLeft<V>(vector: V, counts: V) -> V
fn simdMinimum<V>(left: V, right: V) -> V
fn simdSqrt<V>(vector: V) -> V
fn simdMulAdd<V>(left: V, right: V, addend: V) -> V
```

Each operation applies the scalar operation of the same name to each lane, or to each pair or
triple of lanes in order.

- `simdWrappingAdd`, `simdWrappingSubtract`, and `simdWrappingMultiply` take integer vectors and
  wrap modulo the lane width. `simdSaturatingAdd` and `simdSaturatingSubtract` take integer vectors
  and clamp to the lane type's range.
- `simdShiftLeft` and `simdShiftRight` take integer vectors and shift each lane by the matching lane
  of `counts`. A right shift is arithmetic for signed lanes and logical for unsigned lanes. Any count
  at or above the lane width traps with `invalid shift count`, as the scalar shift does.
  `simdRotateLeft` and `simdRotateRight` take the count modulo the lane width and never trap.
- `simdMinimum` and `simdMaximum` take numeric vectors. A float lane that is NaN in either input
  gives NaN, and `-0.0` orders below `0.0`.
- `simdSqrt` and `simdMulAdd` take float vectors. `simdMulAdd` computes `left * right + addend`
  with one rounding.

A NaN that one of these operations produces is the canonical quiet NaN.

**Boundary:** There is no saturating multiply or negate on vectors yet. Shift counts are per
lane; a program shifts every lane by one amount with `simdSplat`.

**Diagnostics:** A vector whose lane type the operation does not take reports `SEM0239` at the
call.

**Current compiler:** Aligned. The operations lower to LLVM vector instructions and the LLVM
`sadd.sat`, `uadd.sat`, `fshl`, `fshr`, `smin`, `minimum`, `sqrt`, and `fma` intrinsics. A shift
reduces its per-lane count check with `llvm.vector.reduce.or` before one branch.

**Evidence:** `corpus/native/simd-ops`, `corpus/native/simd-shift-count-trap`,
`corpus/invalid/simd-invalid-operation`.

## SIMD-005 — Reductions, mask queries, memory, and conversions

**Status:** Confirmed

```silk,ignore
fn simdReduceAdd<V>(vector: V) -> L
fn simdMaskFirstSet<M>(mask: M) -> usize
fn simdMaskToBits<M>(mask: M) -> u64
fn simdLoad<V>(lanes: &[L], offset: usize) -> V
fn simdStore<V>(lanes: &mut [L], offset: usize, vector: V)
unsafe fn simdPointerLoad<V>(pointer: [*]const L) -> V
fn simdConvert<From, To>(vector: From) -> To
fn simdBitcast<From, To>(vector: From) -> To
```

Reductions combine every lane of a vector into one lane value:

- `simdReduceAdd` adds the lanes of a numeric vector. An integer sum traps with
  `arithmetic overflow` when the exact total does not fit the lane type. A float sum adds in lane
  order from lane `0`, so it gives the same result on every target.
- `simdReduceWrappingAdd` adds integer lanes modulo the lane width. `simdReduceAddUnordered` adds
  float lanes in any order the target prefers, so its rounding may differ between targets.
- `simdReduceMinimum` and `simdReduceMaximum` take numeric vectors, with the NaN rule of
  `simdMinimum`. `simdReduceBitAnd`, `simdReduceBitOr`, and `simdReduceBitXor` take integer
  vectors.

Mask queries read a `mask<N>`: `simdMaskAny` and `simdMaskAll` test for some and for every set lane,
`simdMaskCount` counts the set lanes, and `simdMaskFirstSet` gives the index of the lowest set lane
or `N` when no lane is set. `simdMaskToBits` puts lane `i` in bit `i` of a `u64`, and
`simdMaskFromBits` builds a mask from the low `N` bits and ignores the rest.

`simdLoad` reads `N` lanes of a slice starting at `offset`, and `simdStore` writes them. Both trap
with `slice range out of bounds` unless `offset + N` is at most the slice length; neither needs any
alignment beyond the lane type's. `simdPointerLoad` and `simdPointerStore` are the unchecked forms:
the pointer must address `N` valid lanes aligned to the lane type.

`simdConvert` converts each lane to the lane type of `To` by the scalar numeric conversion, so it
traps exactly where the scalar conversion traps: on an integer lane that does not fit and on a NaN
or out-of-range float lane converted to an integer. Both vectors have the same lane count.
`simdBitcast` reinterprets the bits of a vector as another vector type of the same total width, in
lane order with lane `0` at the lowest address.

**Boundary:** Memory operations, conversions, and bit casts take numeric vectors, not masks. A
mask reaches memory through `simdToArray` or `simdMaskToBits`.

**Diagnostics:** A vector or mask whose lane type the operation does not take, a conversion between
different lane counts, or a bit cast between different widths reports `SEM0239` at the call.

**Current compiler:** Aligned. Reductions lower to `llvm.vector.reduce.*`; only
`simdReduceAddUnordered` carries the `reassoc` flag. An integer `simdReduceAdd` sums in lanes of
twice the width, where no overflow is possible, and checks the total once.

**Evidence:** `corpus/native/simd-ops`, `corpus/native/simd-reduce-overflow-trap`,
`corpus/native/simd-load-range-trap`, `corpus/native/simd-convert-range-trap`,
`corpus/invalid/simd-invalid-operation`.

## SIMD-006 — Static shuffles pick lanes by constant indices

**Status:** Confirmed

```silk,ignore
fn simdShuffle<V, R>(left: V, right: V, static indices: [usize; M]) -> R

let reversed = Intrinsic.simdShuffle<simd<u32, 4>, simd<u32, 4>>(value, value, [3, 2, 1, 0])
```

`V` and `R` are vector or mask types with one lane type; `V` has `N` lanes and `R` has `M`. Lane `i`
of the result is lane `indices[i]` of `left` when the index is below `N`, and lane
`indices[i] - N` of `right` otherwise. A shuffle can widen, narrow, reverse, interleave, or
broadcast lanes.

`indices` is a static argument (STATIC-002): its value is known at compile time, so every
shuffle lowers to one fixed lane permutation. A function forwards indices it takes as a `static`
parameter.

**Boundary:** There is no runtime-index shuffle (a table lookup); that belongs to the
architecture intrinsics.

**Diagnostics:** An index of `2N` or more, or vectors with different lane types, report `SEM0239`.
An index array whose length is not `M` reports `SEM0031`, and a runtime value in `indices` reports
`SEM0176`.

**Current compiler:** Aligned. The call lowers to one LLVM `shufflevector` with a constant mask.

**Evidence:** `corpus/native/simd-shuffle`, `corpus/invalid/simd-invalid-shuffle`,
`corpus/invalid/simd-shuffle-runtime-index`.

## SIMD-007 — Architecture operations are typed, target-checked intrinsics

**Status:** Confirmed

```silk,ignore
fn x86ShuffleBytes<V>(left: V, right: V) -> R

let digits = Intrinsic.x86ShuffleBytes<simd<u8, 16>>(table, nibbles)
```

An architecture operation stands for one instruction that the portable operations do not
express. Its type argument `V` is its first operand's vector type and selects one row of a closed
catalog. The row fixes the other operand types, the result type `R`, the target architecture, the
CPU feature (PROFILE-006), and the LLVM intrinsic the call lowers to:

| Operation                   | First operand → result                                                  | Target and feature                  |
| --------------------------- | ----------------------------------------------------------------------- | ----------------------------------- |
| `x86ShuffleBytes`           | `u8x16` → `u8x16`; `u8x32` → `u8x32`                                    | x86-64 `ssse3`; `avx2`              |
| `x86MultiplyAddBytes`       | `u8x16`, `i8x16` → `i16x8`; `u8x32`, `i8x32` → `i16x16`                 | x86-64 `ssse3`; `avx2`              |
| `x86MultiplyAddWords`       | `i16x8` → `i32x4`; `i16x16` → `i32x8`                                   | x86-64 `sse2`; `avx2`               |
| `x86PackUnsignedSaturate`   | `i16x8` → `u8x16`; `i16x16` → `u8x32`; `i32x4` → `u16x8`                | x86-64 `sse2`; `avx2`; `sse4.1`     |
| `x86PackSignedSaturate`     | `i16x8` → `i8x16`; `i32x4` → `i16x8`                                    | x86-64 `sse2`                       |
| `x86SumAbsoluteDifferences` | `u8x16` → `u64x2`; `u8x32` → `u64x4`                                    | x86-64 `sse2`; `avx2`               |
| `aarch64TableLookup`        | `u8x16` → `u8x16`                                                       | AArch64 `neon`                      |
| `aarch64DotProduct`         | `u32x4`, `u8x16`, `u8x16` → `u32x4`; `i32x4`, `i8x16`, `i8x16` → `i32x4` | AArch64 `dotprod`                   |
| `aarch64PairwiseAdd`        | `u8x16`, `u16x8` or `u32x4` → the same                                  | AArch64 `neon`                      |
| `wasmSwizzle`               | `u8x16` → `u8x16`                                                       | wasm32 `simd128`                    |
| `wasmRelaxedSwizzle`        | `u8x16` → `u8x16`                                                       | wasm32 `relaxed-simd`               |
| `wasmDot`                   | `i16x8` → `i32x4`                                                       | wasm32 `simd128`                    |
| `wasmNarrowUnsigned`        | `i16x8` → `u8x16`                                                       | wasm32 `simd128`                    |
| `wasmNarrowSigned`          | `i16x8` → `i8x16`                                                       | wasm32 `simd128`                    |

`silk.simd.x86`, `silk.simd.aarch64` and `silk.simd.wasm` wrap each row in a function named for
its instruction. A wrapper calls the operation inside `static if` and otherwise computes the same
lanes with portable code, so it is correct on every target.

**Boundary:** A call is checked when its body is checked, like `compileError`, so code that can
build for other profiles guards it with `static if Target.hasCpuFeature(...)`, or sits in a
function compiled for the feature (SIMD-009). AES rounds and carry-less multiplication are
SIMD-011, and the SHA-256 instructions SIMD-012. There is no open escape hatch that names an arbitrary LLVM intrinsic.

**Diagnostics:** A first operand outside the catalog reports `SEM0239`. A call whose target or
CPU feature the profile does not select reports `SEM0241`.

**Current compiler:** Aligned. Each call lowers to one call of its LLVM target intrinsic.

**Evidence:** `corpus/native/simd-arch`, `corpus/invalid/simd-arch-unavailable`.


## SIMD-008 — Runtime CPU detection reports a feature set

**Status:** Confirmed

```silk,ignore
import silk.simd.cpu { CpuFeatures }

let machine = CpuFeatures.detect()
if CpuFeatures.has(&machine, "avx2") { ... }
```

`silk.simd.cpu` names a set of CPU features of the target architecture, spelled as in PROFILE-006.
`CpuFeatures.selected()` is the set the profile selects. `CpuFeatures.detect()` asks the running
machine and always contains the selected set: x86-64 Linux reads `cpuid` through ASSEMBLY-001
and counts AVX and AVX-512 features only when `xgetbv` shows the operating system saves their
registers; AArch64 Linux with GNU libc reads `getauxval(AT_HWCAP)` and `AT_HWCAP2`; AArch64 Darwin
reads `sysctlbyname("hw.optional.*")`. wasm32 and profiles without those interfaces report the
selected set. A name outside the target's catalog is never present.

**Boundary:** Detection is a value, not a cached global, because Silk has no mutable global
storage; a program detects once and keeps the result. A detected feature does not change
`Target.hasCpuFeature` or admit SIMD-007 operations, so it selects between kernels that were
each compiled for their features.

**Diagnostics:** None. Detection cannot fail; an interface that is missing reports the selected set.

**Current compiler:** Aligned.

**Evidence:** `corpus/native/cpu-detect`; `silk.simd.cpu` doctest.

## SIMD-009 — A function can be compiled for more CPU features than its profile

**Status:** Confirmed

```silk,ignore
unsafe fn sumAvx2(values: &[u8]) -> u64 with Intrinsic.machine(features: ("avx2",)) {
  // Intrinsic.x86ShuffleBytes<simd<u8, 32>> is admitted here.
}

let machine = CpuFeatures.detect()
if CpuFeatures.has(&machine, "avx2") { total = unsafe sumAvx2(values) }
```

`with Intrinsic.machine(features: ("a", "b"))` on an ordinary runtime function compiles that
function for the listed CPU features of the target (PROFILE-006), their implications, and the
profile's own features. Its body may use SIMD-007 operations those features admit. Running it on a
CPU without them is undefined, so the function is `unsafe fn` and each caller proves the machine
has them, usually with `silk.simd.cpu` (SIMD-008).

Callees keep the profile's features. LLVM inlines a callee into a function with more features,
never the reverse, so portable `silk.simd.simd` helpers called from the function are compiled with its
features once inlined. To make that boundary safe, a vector wider than 128 bits or a mask of more
than 16 lanes crosses every Silk function boundary through memory: LLVM passes such values in
different registers with and without AVX and AVX-512.

**Boundary:** `Target.hasCpuFeature` keeps answering for the profile inside the function, so a
`static if` there, and a `silk.arch` wrapper it calls, still sees the profile. `static fn`,
`extern` and interface operations take no `features`. Callees are not compiled again for the
function's features.

**Diagnostics:** An entry that is not a text literal naming a CPU feature of the target reports
`SEM0242`. A function with `features` that is not `unsafe` reports `SEM0243`. The clause on a
`static`, `extern` or `export` function reports `SEM0236`.

**Current compiler:** Aligned. The function's LLVM definition carries a `"target-features"`
attribute.

**Evidence:** `corpus/native/simd-function-features`, `corpus/invalid/simd-function-features-invalid`.

## SIMD-010 — A vector crosses the C boundary in one vector register

**Status:** Confirmed

```silk,ignore
unsafe extern "C" fn scale(values: simd<f32, 4>, factor: f32) -> simd<f32, 4>
export "C" fn add(a: simd<i32, 4>, b: simd<i32, 4>) -> simd<i32, 4> { return a + b }
```

A `simd<T, N>` with integer or floating-point lanes of a fixed width (not `isize` or `usize`) may
be a parameter or result of an `extern "C"` or `export "C"` function. It crosses the boundary the
way the target's C compilers pass the vector type of the same lanes, such as `__m128`,
`float32x4_t`, `v128_t` or a GNU `vector_size` type: in one vector register.

| Target | Widths | CPU feature the profile selects |
| --- | --- | --- |
| x86-64 | 128 bits | `sse2` (always) |
| x86-64 | 256 bits | `avx` |
| x86-64 | 512 bits | `avx512f` |
| AArch64 | 64 and 128 bits | `neon` (always) |
| wasm32 | 128 bits | `simd128` |

**Boundary:** A mask has no C type and does not cross. A callback pointer type takes no vector. The
profile decides the register, not the function: a function compiled with `features` (SIMD-009) passes
vectors to C like the rest of the program. A C static may hold a vector.

**Diagnostics:** A vector in an imported C signature whose width the target's C ABI does not pass
in a vector register, or that needs a CPU feature the profile does not select, reports `SEM0244`
at the call. The same vector in an exported signature reports the `c-abi-vector` gap.

**Current compiler:** Aligned.

**Evidence:** `corpus/native/simd-c-vectors`, `corpus/invalid/simd-c-vectors-invalid`.

## SIMD-011 — AES rounds and carry-less multiplication are architecture operations

**Status:** Confirmed

```silk,ignore
unsafe fn encrypt(block: simd<u64, 2>, key: simd<u64, 2>) -> simd<u64, 2> with Intrinsic.machine(features: ("aes",)) {
  return Intrinsic.x86AesEncrypt<simd<u64, 2>>(block, key)
}
```

The SIMD-007 catalog also holds the AES and carry-less multiplication instructions:

| Operation                     | Operands → result      | Target and feature | Instruction                       |
| ----------------------------- | ---------------------- | ------------------ | --------------------------------- |
| `x86AesEncrypt`               | `u64x2`, `u64x2` → `u64x2` | x86-64 `aes`    | `aesenc`                          |
| `x86AesEncryptLast`           | `u64x2`, `u64x2` → `u64x2` | x86-64 `aes`    | `aesenclast`                      |
| `x86AesDecrypt`               | `u64x2`, `u64x2` → `u64x2` | x86-64 `aes`    | `aesdec`                          |
| `x86AesDecryptLast`           | `u64x2`, `u64x2` → `u64x2` | x86-64 `aes`    | `aesdeclast`                      |
| `x86AesInverseMixColumns`     | `u64x2` → `u64x2`      | x86-64 `aes`       | `aesimc`                          |
| `x86CarrylessMultiply`        | `u64x2`, `u64x2` → `u64x2` | x86-64 `pclmul` | `pclmulqdq` with selector 0       |
| `aarch64AesEncrypt`           | `u8x16`, `u8x16` → `u8x16` | AArch64 `aes`   | `aese`                            |
| `aarch64AesDecrypt`           | `u8x16`, `u8x16` → `u8x16` | AArch64 `aes`   | `aesd`                            |
| `aarch64AesMixColumns`        | `u8x16` → `u8x16`      | AArch64 `aes`      | `aesmc`                           |
| `aarch64AesInverseMixColumns` | `u8x16` → `u8x16`      | AArch64 `aes`      | `aesimc`                          |

The x86 rounds take the operand order of the instructions: the state, then the round key.
`x86CarrylessMultiply` multiplies lane 0 of each operand into a 128-bit product, low half in lane
0; a program picks other halves with `simdShuffle` first.

`silk.crypto.aes_round` computes SubBytes, ShiftRows, MixColumns and their inverses with portable code,
without tables. `silk.simd.x86` and `silk.simd.aarch64` wrap each operation on `u8x16` states and
fall back to `silk.crypto.aes_round` when the profile lacks the feature, like the SIMD-007 wrappers.

**Boundary:** Key-generation assist is not in the catalog yet. SIMD-012 adds the SHA-256
instructions. The
portable fallbacks run in constant time but are much slower than the instructions, so a program
that encrypts much data selects a kernel at run time with `silk.simd.cpu` (SIMD-008) and a function
compiled for `aes` (SIMD-009).

**Diagnostics:** As SIMD-007: `SEM0239` for a first operand outside the catalog and `SEM0241`
when the profile and function do not select the feature.

**Current compiler:** Aligned.

**Evidence:** `corpus/native/simd-crypto` (the FIPS 197 example block through every wrapper, the
instructions themselves when the machine has them, and carry-less products).

## SIMD-012 — SHA-256 instructions are architecture operations

**Status:** Confirmed

```silk,ignore
unsafe fn rounds(cdgh: simd<u32, 4>, abef: simd<u32, 4>, wk: simd<u32, 4>) -> simd<u32, 4> with Intrinsic.machine(features: ("sha",)) {
  return Intrinsic.x86Sha256Rounds2<simd<u32, 4>>(cdgh, abef, wk)
}
```

The SIMD-007 catalog also holds the SHA-256 instructions, all on `u32x4`:

| Operation                      | Operands | Target and feature | Instruction   |
| ------------------------------ | -------- | ------------------ | ------------- |
| `x86Sha256Rounds2`             | 3        | x86-64 `sha`       | `sha256rnds2` |
| `x86Sha256Message1`            | 2        | x86-64 `sha`       | `sha256msg1`  |
| `x86Sha256Message2`            | 2        | x86-64 `sha`       | `sha256msg2`  |
| `aarch64Sha256Hash`            | 3        | AArch64 `sha2`     | `sha256h`     |
| `aarch64Sha256Hash2`           | 3        | AArch64 `sha2`     | `sha256h2`    |
| `aarch64Sha256ScheduleUpdate0` | 2        | AArch64 `sha2`     | `sha256su0`   |
| `aarch64Sha256ScheduleUpdate1` | 3        | AArch64 `sha2`     | `sha256su1`   |

The operands follow the instructions. `x86Sha256Rounds2` takes C, D, G and H, then A, B, E and F
(each in lanes 3 to 0), then two message words plus round constants in lanes 0 and 1, which
`sha256rnds2` reads from `xmm0`. `x86-64` gains the `sha` feature, which implies `sse2`, and
`silk.simd.cpu` detects it.

`silk.simd.x86` and `silk.simd.aarch64` wrap each operation and fall back to portable code when
the profile lacks the feature, like the SIMD-007 wrappers.

**Boundary:** SHA-1 and SHA-512 instructions are not in the catalog yet.

**Diagnostics:** As SIMD-007: `SEM0239` for a first operand outside the catalog and `SEM0241`
when the profile and function do not select the feature.

**Current compiler:** Aligned.

**Evidence:** `corpus/native/simd-sha` (one SHA-256 block through both instruction flows, and the
x86 instructions themselves when the machine has them).
