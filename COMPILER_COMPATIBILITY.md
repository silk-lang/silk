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

## Owner type-argument placement

GEN-008 writes a generic owner's arguments on the owner and a member's own arguments on the member:
`Option<i32>.map<String>(f)`, not `Option.map<i32, String>(f)`. An owner application may omit the
owner's lifetimes, which the call infers; it is otherwise a complete type.

- **Bootstrap:** binds an owner application to the impl's or service's binders by position and
  reports an incomplete one (SEM0051). A member list after an unwritten owner whose parameters the
  member names reports SEM0221.
- **Native:** accepts complete owner applications on inherent members and services, and infers the
  lifetimes an inherent owner application omits. A service application cannot omit a lifetime yet.
  It still accepts the member-prefix spelling.
- **Source migration:** complete. The stdlib, tests, documentation and `compiler/` write owner
  arguments on the owner, and the migration codemod is deleted.
- Retire this entry when both compilers reject the member-prefix spelling with a diagnostic.

## Generic type aliases

TYPE-004 now admits `type Name<Parameters> = Target`, with type and lifetime parameters that each
occur in the target, every argument written at the use, no inference, no bounds, and union
re-normalization after substitution (`Fallible<IoError>` is `IoError`).

- **Bootstrap:** implemented. Each distinct instantiation is expanded once per alias.
- **Native:** not implemented yet. It still rejects alias parameters.
- **Source migration:** none. No standard-library module or corpus program uses a generic alias
  until the native half lands.
- Retire this entry when the native compiler accepts the same rules with the same conformance cases.

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

## Bootstrap loop invalidation of pattern-derived views

VIEW-002 ends a loan at its last use. A view derived from a borrowed match binding that leaves its
arm, such as `let edges = match &owner { Some {value} => asSlice(&value) None => fallback }`, is
dead before a later iteration reassigns `owner`.

- **Bootstrap:** conservative. Inside a `while`, a write to the borrowed owner that the loan's
  creation reaches over the back-edge invalidates every point reachable from the write without
  passing the creation again. That includes uses on the path where the arm did not create the
  loan, so the reassignment reports OWN0019. The same code without the loop, or with a direct
  view instead of a pattern-derived one, is accepted.
- **Native:** accepts it, with loans ending at last use.
- **Source migration:** `proveAppliedBounds` in `compiler/` derives its outlives edges into a
  plain vector once and views it directly, a form both compilers accept. No other site is known.
- The bootstrap is an oracle scheduled for retirement and is not loosened for this. Retire this
  entry with the bootstrap, or when its invalidation follows loans in scope at the write.

## Bootstrap borrows through a view-valued temporary

BORROW-005 makes an element or field reached through a view a place in the view's referent, and
BORROW-006 keeps a temporary alive for as long as a borrow of it, so
`kind(&Vector<Entry>.asSlice(&entries)[i].identity)` is valid.

- **Bootstrap:** rejects it with OWN0002. A borrow whose place starts at a call result
  materializes the whole projected place as an owned temporary instead of rooting the borrow at the
  view the call returns. Accepting it also needs MIR loan ends for the loans that temporary
  retains, so the rejection currently prevents a miscompile.
- **Native:** accepts it.
- **Source migration:** `ModuleIndex.fingerprint` in `compiler/` binds the slice to a local before
  indexing it, which both compilers accept and compile identically. No other site is known.
- The bootstrap is not extended for this. Retire this entry with the bootstrap.
