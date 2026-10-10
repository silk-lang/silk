# Compiler compatibility

## Nominal qualification requires an inherent member

CALL-003 and STYLE-002 require a nominal-qualified function to be published in that type's
inherent `impl`. A top-level function whose first parameter is that type is not an inherent
member. Operator mappings follow the same ordinary lookup rule (OP-009).

The TypeScript bootstrap currently accepts the old `operator-interface-contract` fixture's
`Vector.scale` and `Vector.dot` mappings even though those functions were top-level declarations.
The native acceptance job in [run 36627847695](https://github.com/julia-script/silk/actions/runs/36627847695)
confirmed that acceptance. The self-hosted frontend correctly rejects those unpublished members.
The fixture now declares both functions in `impl Vector`, retaining its expected result of 42.
The bootstrap is frozen during backend development; retire this entry when it enforces the
same owner lookup rule.

## Explicit synchronous source startup

The bootstrap can select `silk/native_start_sync` through ordinary runtime composition for an i32
Effect requiring shared or mutable `HostInput`. It captures an owned argument/environment snapshot, lends a
lexical provider, returns successful status unchanged, and drops typed initialization or application
failures before returning one. It installs no Execution or diagnostic observer. The default
`silk/native_start` and its broader application signatures retain their existing behavior.

This source addition does not remove the self-hosted compiler's generated plain-i32 entry or claim
native source-runtime support. Ordinary plain-i32 adaptation belongs to
[#931](https://github.com/julia-script/silk/issues/931); native routing and adapter removal follow
main-first integration of both contracts. See
[the source startup contract](compiler/docs/source-synchronous-startup.md) for selection, ownership,
and validation details. Fatal traps retain their existing behavior and do not promise cleanup.

### Invocation-scoped callable inputs and recovery

- **Definition:** LIFE-004 now distinguishes marked `for<use 'call>` invocation extents from independently quantified data lifetimes and retained capture environments. Input validity covers returned-computation execution, suspension, cancellation and cleanup; retained computations cannot escape those loans. `Effect.result` gains no retained-error bound.
- **Bootstrap:** implementation active. `Effect.result` retains its unrestricted error contract. The two selected borrowed-recovery native corpus cases pass their exact synchronous cleanup and park/resume/cancel traces (`7231` and `75842175421`, both returning `42`). Source-owned executable input views preserve the actual closure and independently authenticate the original caller domain and complete invocation inputs. Immutable stored Identifier and ordinary staged adaptation still have unresolved gaps; these focused runtime passes do not establish the complete feature or N1.
- **Native:** not implemented yet. Bootstrap changes land on main with required exact-head CI before sync and native implementation. The pinned standalone bootstrap predates this syntax and must not be used to claim it accepts the new contract.

### Bootstrap static control inside ordinary loops

- **Status:** known bootstrap evaluation gap, reproduced on 2026-10-10; repair remains open.
- **Rule:** STATIC-005 and STATIC-006 admit evaluator-local mutation. A static condition must observe the local values at its execution point, including each iteration of an ordinary `while` in a static function.
- **Compilers:** checked-prefix replay now updates a static condition after preceding assignments, ordinary branches and complete loops, including nested static arms and finite static iterations. Static control contained inside ordinary control still selects its arm while analyzing the deferred body, before that execution's local replacements occur. Evaluation retains the checked selection and rejects a condition that changes at execution; it does not elaborate the inactive arm. This entry does not claim native static-control coverage.
- **Evidence:** a static function starts `count = 0`, `total = 0`, repeats twice, increments `count`, and uses `static if count == 1` to add 20, otherwise 22. Its required result is 42; the earlier bootstrap returned 44. The selection-consistency check now rejects this form with SEM0176 at the changed condition. Invariant loop selections remain accepted. The checked-prefix repair's separate positive controls and bounded-evaluation negative remain passing.
- **Source migration:** none; the bootstrap compiler must repair per-iteration static selection. The bootstrap static-control task owns complete per-iteration selection.
