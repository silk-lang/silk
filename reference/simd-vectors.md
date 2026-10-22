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
