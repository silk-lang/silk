# Region-erased identity

Lifetimes never decide which code runs (IMPL-007). The selfhost compiler therefore gives every
region pattern of one application one backend instance: one lowered body, one emitted definition
and one symbol. This note states why that is sound.

## Terms

- A **region pattern** of an application is its exact semantic key: the canonical numbering of
  the caller regions it was given, including which of them coincide and which are `'static`.
  Patterns of one application differ only in regions.
- A head **depends on a region** when its provider names `'static`, names one region at two
  positions, or its bounds constrain a region (`'a: 'b`, `T: 'a`). Sealed `Drop` and `Copy` heads
  may not depend on a region (`RegionDependentSealedHead`, SEM0220 in the bootstrap). Conformance
  heads may, because typing proves them at the call site.

## Soundness

Take an application `f` reached from a well-typed caller, and two of its region patterns `P` and
`Q`. Lowering `P` makes a sequence of specialization-time decisions: which witness proves each
goal, which `Drop` or `Copy` applies to each type, whether each bound holds, and which keys the
body references. Lowering `Q` makes the same decisions modulo regions, so `P`'s body is `Q`'s
body.

1. **Selection.** Coherence erases lifetimes (IMPL-004), so the heads a goal's bucket offers, and
   the head that matches, are a function of the goal with its regions erased. `P` and `Q` pose
   the same goals modulo regions.
2. **Conformance bounds.** Every bound of `f`'s header holds for both patterns, because the
   caller's typing proved it before selecting the call. The body was type-checked against those
   bounds as premises, so every goal it poses is proven for any region pattern that satisfies
   them, by the same head.
3. **Cleanup and copies.** A sealed `Drop` or `Copy` head has a distinct binder at every region
   position, no `'static` and no region bound. It matches every region pattern of a type alike,
   so `P` and `Q` select the same hooks and copies.
4. **Callees.** Each reference of `f` is either the same key for `P` and `Q`, or differs only in
   the regions `f` lends it. By 1 to 3 applied to the callee, the callee has one body for all of
   its patterns, so `P` and `Q` reach the same callee body.

Generic function bounds such as `'b: 'a` are premises inside the callee's body. The obligations
they create at the calls a body makes are checked when that body is type-checked against its own
parameters, not per caller pattern, so they never differ between `P` and `Q`.

The first pattern a build reaches publishes the instance's body, and every later pattern resolves
to the same text. Semantic identity (`InstanceKey.sameApplication`) still keeps every region as
validity evidence; only code identity (`InstanceKey.sameInstance`, `RuntimeEncoding.codeCoordinates`)
erases them.

## N1 investigation (2026-10-10)

A local N0 rebuilt with the published main bootstrap inputs at `4c269934` compiled the authored
compiler at `49a7cac7472952e6bad9eeee7970dcb7c0ac8832` into N1 LLVM text in approximately 207 seconds.
The observed kernel high-water RSS was 4,622,812 KiB (4.41 GiB). LLVM 22.1.8 linked a fresh optimized
N1 executable. This is diagnostic evidence for that generation, not an exact-head CI receipt for
the later bootstrap sync.

The previously reported SIGABRT on every example did not reproduce with these rebuilt inputs.
GDB ran N1 on the smallest example, CRC-32, and the compiler exited normally; the generated program
returned its expected `7`. An independent O0 AddressSanitizer diagnostic build, with unwind tables
and frame pointers added to the retained LLVM text, compiled CRC-32 without a sanitizer finding.
No feature implementation change was needed to obtain these results; the earlier crash's precise
cause was not isolated.

All eleven examples were attempted with the optimized N1:

| Example | Result |
| --- | --- |
| breadth-first-search | Compiled; expected exit `0` |
| crc-32 | Compiled; expected exit `7` |
| fft | Compiled; expected exit `208` |
| game-of-life | Compiled; expected exit `7` |
| matrix-multiplication | Compiled; expected exit `137` |
| quicksort | Compiled; expected exit `50` |
| sieve | Compiled; expected exit `77` |
| language-pressure/lexer | Compiled; expected exit `0` |
| language-pressure/local-shared-slp1 | Compiled; expected exit `42` |
| file-system | `TypeArity`, `main.silk` bytes 3510–3538, at omitted `Intrinsic.bindRequirementMut` selector arguments |
| language-pressure/stack-vm | `core-type`, `silk/format.silk` bytes 23721–23751, at a phase-only field |

The two refusals also occur, with identical codes and spans, using the fresh baseline N0 at
`fed79ee8e` before the region-sensitivity change, which this rule later removed. The omitted-argument frontend work is owned by
the stage1 coordinator; the formatting field refusal is owned by `selfhost-phase-only-fields`.
None of the eleven compiler runs or nine executable runs terminated by signal.
