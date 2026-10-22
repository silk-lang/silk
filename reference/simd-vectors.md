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
library writes one declaration per shape. A vector does not cross a C boundary yet.

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
`silk.simd` module will be the public API over them.

**Diagnostics:** A type argument that is not an admitted vector, or a mask for an ordering
comparison, reports `SEM0239` at the call.

**Current compiler:** Aligned.

**Evidence:** `corpus/native/simd-core`, `corpus/native/simd-lane-index-trap`.

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
