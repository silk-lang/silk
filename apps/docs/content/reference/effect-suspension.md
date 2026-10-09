# Effect suspension and stack-safe recursion

`Effect.suspend` is an explicit stack-safety boundary for Effect execution. It transfers one
deferred child through private execution machinery so a covered recursive Effect cycle can use
bounded native and WebAssembly machine stack.

Suspension is not async execution. It does not park a task, let another task run, wait for a wakeup,
or introduce a scheduler. It also does not make ordinary recursion stack safe automatically.

Explicit owner-controlled parking and later resumption are defined separately by
[independently resumable Effect executions](independent-execution.md). Allocation-backed dynamic
local state shared by those owners is defined by [local shared ownership](local-shared-ownership.md).
The current source-level scheduler and Fiber policy built over that substrate is defined by
[single-threaded schedulers and Fibers](single-threaded-fibers.md).

The intended public contract is:

```silk,ignore
effect fn suspend<A, E, ?R>(
  deferred: once Effect<A ! E ? R>
) -> A ! E ? R
```

The compiler and standard library preserve that contract exactly. Coroutine frames use private
execution-stack storage supplied by the artifact-selected source component. Suspension never
selects the lexical `Allocator` service or adds `OutOfMemoryError` to an Effect.
The component owns allocation, capacity and accounting in an explicit state instance;
the compiler owns frame representation, transfer and semantic cleanup.

Rule numbers follow the accepted proposal. SUSP-009, SUSP-010, SUSP-012, and SUSP-014 constrain
private lowering rather than programmer-observable Silk, so their details remain in the proposal
instead of appearing as standalone language-reference rules.

## Terms

- **Deferred child** — the owned Effect passed to `Effect.suspend`. Constructing the suspension does
  not execute the child body.
- **Suspension origin** — the explicit `Effect.suspend` boundary that transfers execution.
- **Suspendable caller** — a concrete Effect execution path that can reach a suspension origin. It
  may still complete along another branch without suspending.
- **Resume** — continue the logical caller with the child's success or typed failure. It does not
  imply a thread, task, or scheduler.
- **Execution stack** — finite source-component storage for logically active suspended calls. It is
  distinct from the source-selected `Allocator` service and from the physical machine stack.
- **Parking** — leave execution dormant until an external wakeup condition occurs. `Effect.suspend`
  does not provide parking.
- **Independent Execution** — an affine lazy Effect package with an owner outside its body. The
  owner selects each legal activation.
- **Wake** — one affine authority for one parked generation. Signaling or dropping it consumes that
  authority.

## Static execution facts

Semantic inspection records one normalized suspension summary for every reachable exact executable.
Direct execution has no mode bit. `NestedTransfer` means the selected call graph can reach
`Effect.suspend`; `ExternalPark` is reserved for the sealed external-wake primitive. Complete
specializations include ordinary helper calls and selected provider implementations. An unresolved
generic executable conservatively retains the modes permitted by its declared exact bound, while an
unavailable executable remains unavailable rather than being reported as direct.

This is a target-neutral semantic substrate. The ordinary `silk.execution` module supplies safe
construction, drive, and park operations over sealed compiler identities. An explicit `Execution`
construction is the propagation delimiter. Its erased body keeps its complete summary. An ordinary
owner-side drive caller does not inherit the body's `ExternalPark` mode.

Two compiler-owned properties may refine one exact Effect or callable representation bound:

- `Intrinsic.Detached` proves that the executable retains no external lexical or provider loan.
  It is independent of the success and failure payload spellings and of execution affinity; an
  owned local shared handle may be detached while remaining local.
- `Intrinsic.NonParking` proves that the specialized transitive graph cannot reach external
  parking. Nested transfer remains allowed.

These properties are static, witness-free obligations rather than interfaces or services. A failed
concrete application reports the property obligation at the application and retains its stable
capture/provider or reachability path.

`Intrinsic.Execution<A>` is an opaque affine, non-copyable, initially non-thread-transferable local
identity. Its compiler-owned activation lifecycle is `Unstarted`, `Running`, `Relinquished`,
`Completed`, and `Destroyed`; these are semantic states, not a promised backend tag layout. The
source readiness phases `Initial`, `InitialReady`, `Dormant`, and `Eligible` are ordinary
`silk.execution` policy over two package control words. The owner may drive only `Initial`,
`InitialReady`, or `Eligible`, and driving a dormant or notifying execution is a fatal state
trap. Execution-internal stable loans may cross
parking, but construction cannot retain caller loans and completion cannot return a loan into
package-owned storage.

## Independent execution and external parking

This section summarizes the relationship to suspension. The complete public lifecycle, Wake,
cancellation, ownership, and scheduling-policy rules are in
[independently resumable Effect executions](independent-execution.md).

`Execution.make` allocates one combined package through the caller-selected `Allocator`. The
package owns the lazy body and its fixed readiness endpoint. Construction returns an `Initial`
Execution and does not start the body. Package allocation refusal is a typed construction failure.
Later growth of the private execution stack is a fatal trap outside the typed failure channel.

The owner may call `Execution.notifyInitial` after storing an `Initial` Execution. This changes it
to `InitialReady` and invokes the fixed readiness endpoint without starting the body. The owner
calls `Execution.drive` for an `Initial`, `InitialReady`, or `Eligible` activation. A nested
`Effect.suspend` transfers directly to a child and can return during the same drive.
`Execution.park` instead relinquishes the running Execution. Its registration callback receives
one affine Wake for that parked generation. Signaling the Wake makes the Execution eligible and
invokes its fixed readiness endpoint at most one time.

Dropping a dormant Execution cancels its Wake and cleans the suspended values exactly once. If an
external owner still retains that Wake, the Wake keeps the complete inert package allocation alive.
Signaling or dropping the cancelled Wake releases the final package authority and cannot publish
readiness.

Schedulers, deferred values, timers, coroutine ports, ready queues, and cancellation policies are
ordinary source actors built over this narrow seam. The shipped `silk.scheduler`, `silk.fiber`, and
`silk.local_scheduler` modules follow this rule: the language does not select those actors, and the
compiler does not recognize their source names.

## Public contract and recursion

### SUSP-001 — Suspension is an explicit boundary

**Status:** Confirmed

Silk makes an Effect execution path stack safe only where source explicitly calls
`Effect.suspend`. The compiler does not insert suspension boundaries automatically.

```silk,ignore
effect fn count(value: i32) -> i32 {
  if value == 0 {
    return 0
  }
  let inner = run Effect.suspend(count(value - 1))
  return inner + 1
}
```

**Boundary:** Merely declaring `effect fn` or calling a recursive Effect does not request the
bounded-machine-stack path.

**Diagnostics:** A valid explicit boundary produces no diagnostic. Missing boundaries remain valid
under SUSP-019 rather than becoming a compiler error.

**Evidence:** [sealed intrinsic boundary](unsafe-intrinsics-and-targets.md#intr-001--intrinsic-is-sealed-compiler-identity-available-to-every-source-module),
[suspension implementation contract](../../../../openspec/changes/archive/2026-08-19-align-effect-suspension-coroutine-storage/proposal.md).

### SUSP-002 — Running a suspended Effect produces the child's ordinary outcome

**Status:** Confirmed

Running `Effect.suspend(child)` eventually produces the child's one success value or typed failure.
It does not expose a nested Effect, pending result, continuation, or resume token.

```silk,ignore
let value = run Effect.suspend(effect { return 42 })
```

`value` is `i32`, not `Effect<i32>` or a continuation handle.

**Boundary:** Suspension does not flatten an Effect returned as the child's declared success value.
If the child succeeds with `Effect<i32>`, one `run` still produces that nested Effect value under the
ordinary one-layer rule.

**Diagnostics:** Incompatible use of the child's success or failure receives the ordinary Effect,
return, or type diagnostic.

**Evidence:** [one-layer execution](effects-and-execution.md#eff-003--run-executes-exactly-one-effect-layer).

### SUSP-003 — Every recursive cycle must cross suspension for bounded machine stack

**Status:** Confirmed

A terminating self-recursive or mutually recursive Effect graph uses bounded native and Wasm
machine stack when every possible recursive cycle crosses an explicit suspension origin.

```silk,ignore
effect fn even(value: i32) -> bool {
  if value == 0 {
    return true
  }
  return run odd(value - 1)
}

effect fn odd(value: i32) -> bool {
  if value == 0 {
    return false
  }
  return run Effect.suspend(even(value - 1))
}
```

The mutual cycle crosses the boundary in `odd`; every individual call edge need not suspend.

**Boundary:** A suspension on an unrelated branch does not cover a recursive cycle that can avoid
that branch.

**Diagnostics:** The compiler does not reject an uncovered cycle. The language service may explain
which cycle lacks a boundary under SUSP-019.

**Evidence:** [suspendability analysis](../../../../packages/compiler/test/Suspendability.test.ts).

### SUSP-004 — Suspension does not cover unrelated recursion

**Status:** Confirmed

`Effect.suspend` gives no stack-safety guarantee to ordinary function recursion, Effect recursion
whose cycle does not cross the boundary, recursive `Drop`, or arbitrary recursive data traversal.

```silk,ignore
effect fn count(value: i32) -> i32 {
  if value == 0 {
    return 0
  }
  return 1 + run count(value - 1)
}
```

**Boundary:** A target may happen to optimize a particular recursive call. That optimization does
not become a Silk guarantee and cannot be relied on for correctness.

**Diagnostics:** These recursive programs remain valid and receive no mandatory compiler
diagnostic solely because their depth is unbounded.

**Evidence:** [suspendability analysis](../../../../packages/compiler/test/Suspendability.test.ts).

### SUSP-005 — Suspension preserves success, failure, and requirement channels exactly

**Status:** Confirmed

For `Effect.suspend<A, E, ?R>`, the result keeps exactly `A`, `E`, and `R`. Suspension adds no
allocation error or allocator service to the public contract.

```silk,ignore
effect fn protected() -> i32 ! ProblemError ? &Clock {
  return run Effect.suspend(work())
}
```

If `work()` has `i32 ! ProblemError ? &Clock`, `protected` has the same three channels.

**Boundary:** Exhausting private execution storage is a fatal trap under SUSP-006, not a hidden
member of `E`.

**Diagnostics:** `Effect.suspend` adds no allocator requirement or typed storage failure.
An artifact with reachable private-frame demand must select a complete, compatible
`execution-storage` component; missing or invalid bindings produce a configuration
diagnostic before object emission. Existing child-channel mismatches retain their ordinary codes.

**Evidence:** [Effect channels](effect-contracts.md),
[suspension composition tests](../../../../packages/compiler/test/EffectSuspensionComposition.test.ts).

### SUSP-006 — Execution-stack exhaustion is a fatal trap

**Status:** Confirmed

Exhausting the finite execution stack supplied by the selected source component terminates with a fatal trap outside the typed
failure channel, like exhausting the ordinary machine stack.

**Boundary:** `Effect.catch`, `catchAll`, `result`, or another typed-failure combinator cannot recover
execution-stack exhaustion. `Execution.make` and the source-level Fiber scheduler have their own
declared allocation and publication failures while constructing owned execution packages, but
later growth of the compiler-private execution stack remains fatal and does not change
`Effect.suspend`.

**Diagnostics:** No failure member or requirement is inferred. A reached exhaustion reports a fatal
runtime trap according to the program-termination rules.

**Evidence:** [fatal traps](typed-failures.md#fail-007--a-trap-is-fatal-and-remains-outside-effect-outcomes),
[execution-storage requirements](independent-execution.md#exec-001--construction-is-lazy-explicit-and-caller-funded).

The selected component binds `create`, `acquire`, `release` and `destroy` to ordinary
source C exports. Bindings are demand-driven: an unused catalog entry does not load
its provider. Each transient driver or owned Execution has an independent state.
State is acquired lazily on first frame allocation, preserved across parking and
consumed after frame cleanup on completion or cancellation. An unstarted Execution
acquires no state. A retained Wake cannot keep canceled frame storage alive.

The hosted default owns an explicitly unlimited per-instance policy in
`silk/execution_storage`; there is no environment-variable limit or thread-local
accounting. A custom provider chooses its own finite capacity and returns null on
state or frame refusal. The compiler translates that refusal to the existing fatal
exhaustion path. This contract is shared by native and LLVM-to-Wasm lowering.

## Execution and composition

### SUSP-007 — The child starts only after a complete transfer

**Status:** Confirmed

Constructing `Effect.suspend(child)` does not execute the child. When the suspended Effect is run,
the current invocation first completes the state and ownership transition required to resume later;
only then may the child begin.

```silk,ignore
let deferred = Effect.suspend(effect {
  return observe()
})
```

`observe()` does not run until `deferred` is run.

**Boundary:** The child cannot observe a half-moved parent state or begin before live parent values
have one valid owner for later resumption.

**Diagnostics:** Premature construction causes no runtime work. Invalid captures or transfers
receive their ordinary ownership diagnostic.

**Evidence:** [Effect construction](effects-and-execution.md#eff-001--calling-an-effect-function-constructs-an-effect),
[Effect suspension standard-library tests](../../../../packages/compiler/test/EffectSuspendStdlib.test.ts).

### SUSP-008 — Ordinary combinators are suspension-transparent

**Status:** Confirmed

Ordinary source-defined Effect combinators compose with suspendable children without inspecting a
pending state or changing their public signatures.

```silk,ignore
fn increment(value: i32) -> i32 {
  return value + 1
}

let deferred = Effect.suspend(effect { return 41 })
let answer = run (move deferred |> Effect.map(increment))
```

`answer` is `42`; `Effect.map` need not expose continuation machinery.

**Boundary:** A combinator still obeys its ordinary ownership, failure, and requirement contract.
Suspension transparency does not authorize it to duplicate or retain a take-once child.

**Diagnostics:** Invalid composition receives ordinary callable, Effect-channel, or ownership
diagnostics rather than a suspension-specific error.

**Evidence:** [Effect composition](effects-and-execution.md),
[suspension composition tests](../../../../packages/compiler/test/EffectSuspensionComposition.test.ts).

## Ownership and lifecycle

### SUSP-011 — Ordinary ownership and loans continue across suspension

**Status:** Confirmed

Copy values may copy, affine values move into one later-execution owner, and shared or exclusive loans
retain their ordinary access and lifetime rules while the logical caller is suspended. A referent
borrowed across suspension keeps a stable logical location for the loan's lifetime.

```silk,ignore
effect fn inspect(value: &Record) -> i32 {
  return run Effect.suspend(effect { return value.count })
}
```

The shared loan remains a shared loan for the complete suspended call; suspension neither consumes
the referent nor permits overlapping mutation.

**Boundary:** Suspension introduces no public `Pin` type or permission to move a borrowed referent.
The compiler's private representation must adapt to source-valid borrows, not invalidate them.
A suspended partial owner retains definite, missing and conditional component state. Conditional
cleanup flags remain in the frame through resumption and cancellation. A moved child belongs to
its destination; cancellation cleans only the former owner’s initialized remainder. Reinitialization
commits installation and ownership state without an intervening suspension. Outcome lifetimes
remain independent of the temporary receiver and environment, and every borrowed referent must
survive its uses and cleanup.

**Diagnostics:** Invalid duplication, movement, overlapping access, or escaping loans report the
ordinary ownership and borrowing diagnostics at the responsible source operation.

**Evidence:** [ownership rules](ownership-and-borrowing.md),
[suspension ownership tests](../../../../packages/compiler/test/SuspensionOwnership.test.ts).

### SUSP-013 — Suspension preserves exact structured cleanup

**Status:** Confirmed

On success or typed failure, every value retained across suspension is moved onward or cleaned
exactly once. A fatal trap retains Silk's general no-unwind and no-cleanup guarantee.

```silk,ignore
effect fn useOwned(resource: Resource) -> () ! UseError {
  run Effect.suspend(effect { consume(move resource) })
}
```

`resource` has one owner throughout the transfer and is consumed or cleaned exactly once.

**Boundary:** Suspension does not cause `Drop`, `ensuring`, or other cleanup to run after a trap. It
also cannot skip ordinary structured cleanup merely because execution resumed through a driver.

**Diagnostics:** Invalid source cleanup ownership receives its ordinary diagnostic. No additional
cleanup operation appears in source merely because a function is suspendable.

**Evidence:** [Effect lifecycle](ownership-and-borrowing.md#effect-life-001--effect-execution-cleans-per-run-state-and-preserves-reusable-captures),
[trap cleanup](ownership-and-borrowing.md#trap-001--a-trap-has-no-cleanup-guarantee).

### SUSP-015 — Suspension creates no special allocator implementation rule

**Status:** Confirmed

Because `Effect.suspend` does not select or call a source allocator, it imposes no special
recursion, bootstrap, or self-hosting restriction on ordinary `Allocator` implementations.

```silk,ignore
struct SuspendingAllocator {}

effect fn allocate(
  self: &mut SuspendingAllocator,
  layout: Layout
) -> Allocation ! OutOfMemoryError {
  return run Effect.suspend(effect {
    return run Intrinsic.systemAllocationAcquire(move layout)
  })
}

impl Allocator for SuspendingAllocator {
  allocate: SuspendingAllocator.allocate
}
```

If this implementation satisfies the ordinary `Allocator` contract, its use of suspension adds no
extra conformance rule.

**Boundary:** An allocator operation may independently be recursive or effectful and follows its
own declared contract. `Execution.make` and Fiber task preparation define their fallible allocation
contracts separately; those failures belong to owned execution construction, not to
`Effect.suspend`.

At the native `Intrinsic.systemAllocationAcquire` boundary, alignment must be a nonzero power of
two, and adding the alignment padding to the byte count must fit target `usize`. Invalid requests
return the canonical `Intrinsic.StorageFailure` before calling the platform allocator or creating
allocation ownership. The ordinary system allocator maps that refusal to `OutOfMemoryError` through
`Intrinsic.catchFailure`. A valid zero-byte request still acquires and releases one allocation;
its logical byte count remains zero. A null platform result follows the existing storage-refusal
path and creates no allocation ticket.

**Diagnostics:** No allocator-specific conformance or recursion diagnostic applies merely because
an allocator is reachable from suspendable code.

**Evidence:** [service rules](requirements-and-services.md),
[allocator-independence requirements](../../../../openspec/changes/archive/2026-08-19-align-effect-suspension-coroutine-storage/specs/bootstrap-owned-allocation/spec.md).

## Runtime targets and tooling

### SUSP-016 — Native and WebAssembly artifacts preserve the same source semantics

**Status:** Confirmed

Native execution and LLVM-generated WebAssembly produce the same typed outcome, retained ownership,
and cleanup order for a suspended program. Both targets additionally guarantee bounded machine
stack for cycles covered by SUSP-003.

For the `count` example in SUSP-001, every supported target must produce the same integer or typed failure;
target-specific execution machinery cannot become part of that result.

**Boundary:** LLVM targets may use different private execution representations or storage growth
policies. Those differences cannot change source-visible results or cleanup.

**Diagnostics:** A valid program receives no target-support diagnostic. A target that cannot
honor the suspension contract is unavailable for that reachable executable closure.

**Evidence:** [target availability](unsafe-intrinsics-and-targets.md#target-003--target-unavailability-is-a-compile-time-compatibility-error),
[native suspension depth corpus row `suspension-native-depth-and-unit-retry`](../../../../packages/compiler/test/support/corpus.ts),
[coroutine-frame lowering tests](../../../../packages/compiler/test/EffectSuspensionNative.test.ts).

### SUSP-018 — Non-suspending call graphs pay no coroutine cost

**Status:** Confirmed

A closed executable call graph that cannot reach the suspension intrinsic contains no coroutine
frame transformation, private suspension driver, pending branch, scheduler, or widened Effect
channels merely because another program can suspend.

```silk
pub fn main() -> i32 {
  return 42
}
```

This program acquires no suspension machinery.

**Boundary:** A graph that can reach suspension may need a suspendable private path even when one
runtime branch completes before reaching the boundary.

**Diagnostics:** No source diagnostic applies. Artifact inspection and pay-for-use tests verify the
absence of unreachable machinery.

**Evidence:** [pay-for-use runtime rule](runtime-and-standard-library.md#runtime-002--source-closure-and-executable-closure-control-separate-costs),
[suspension MIR tests](../../../../packages/compiler/test/SuspensionMir.test.ts).

### SUSP-019 — Uncovered recursive Effects remain valid

**Status:** Confirmed

A recursive Effect cycle without `Effect.suspend` is valid Silk. The compiler does not reject it
merely because sufficiently deep execution may exhaust the target machine stack.

```silk,ignore
effect fn count(value: i32) -> i32 {
  if value == 0 { return 0 }
  return 1 + run count(value - 1)
}
```

**Boundary:** The language service may warn when it finds an uncovered cycle and offer to insert an
explicit suspension boundary. That assistance cannot silently edit source or claim every execution
will overflow.

**Diagnostics:** No mandatory compiler diagnostic applies. Any LSP warning is non-blocking and must
identify the uncovered cycle and the explicit nature of the suggested change.

**Evidence:** [suspendability analysis](../../../../packages/compiler/test/Suspendability.test.ts).

### SUSP-020 — Suspension promises no async or scheduler behavior

**Status:** Confirmed

`Effect.suspend` provides no parking, wakeup, fairness, parallelism, interruption, cancellation, or
scheduler semantics. It remains deterministic single-execution Effect composition.

```silk,ignore
let value = run Effect.suspend(readNext())
```

This transfers stack-safe execution of `readNext`; it does not wait for another task to publish a
value unless `readNext` already has some separately defined synchronous way to complete.

**Boundary:** Runtime parking and owner-controlled resumption use the separate `Execution`
lifecycle and the source `Wake` policy. The shipped single-threaded scheduler and Fiber APIs add ready queues, child
tasks, observation, and structured cancellation as ordinary source policy over that lifecycle.
Those facilities still do not turn suspension into parking or establish a general async-I/O model.

**Diagnostics:** Suspension alone adds no Scheduler, Executor, or concurrency service requirement.
An unowned park-capable executable, an invalid Execution lifecycle transition, or an unresolved
Scheduler requirement receives that facility's own diagnostic or trap rather than changing
`Effect.suspend`.

**Evidence:** [no ambient runtime facilities](runtime-and-standard-library.md#runtime-004--silk-has-no-ambient-runtime-facilities),
[independent execution lifecycle](independent-execution.md),
[single-threaded scheduler and Fiber policy](single-threaded-fibers.md),
[suspension implementation scope](../../../../openspec/changes/archive/2026-08-19-align-effect-suspension-coroutine-storage/proposal.md).

## Private lowering model

These are compiler architecture rules, not additional source obligations:

- One concrete suspendable invocation owns one reusable coroutine frame. Repeated suspension by
  that invocation changes its resume state; it does not allocate another continuation record.
- Every resume state names only the values needed after that transfer. One statically known maximum
  layout covers all mutually exclusive states, including compiler-generated temporaries.
- A suspendable specialization's frame identity includes its complete specialization key,
  including the normalized provider contract row. Two otherwise identical specializations that
  bind different provider rows cannot share or select each other's frame layout.
- The parent completes its ownership and state transition before the deferred child begins. A live
  value therefore has one owner throughout transfer, execution, resumption, and cleanup.
- Native artifacts use non-moving segmented private storage. LLVM-generated WebAssembly uses a
  private, non-overlapping linear-memory region. Growth failure follows SUSP-006 on both targets.

The complete-key frame invariant is exercised by the
[coroutine-frame lookup](../../../../packages/compiler/src/CoroutineFrame.ts) and the
[contract-row suspension parity corpus](../../../../packages/compiler/test/support/corpus.ts).

The complete architecture contract remains in the archived
[suspension implementation design](../../../../openspec/changes/archive/2026-08-19-align-effect-suspension-coroutine-storage/design.md).
