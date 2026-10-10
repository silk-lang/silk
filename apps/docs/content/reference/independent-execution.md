# Independently resumable Effect executions

The `silk.execution` module packages one lazy Effect so an ordinary source owner can select its
first activation, receive it back when it relinquishes control, and drive it again after external
readiness. This is explicit local execution ownership. It does not create a scheduler, fiber,
thread, queue, timer, or implicit program-entry owner.

These rules extend the nested-transfer model in [Effect suspension](effect-suspension.md);
`Effect.suspend` remains stack-safe composition inside one activation, while `Execution.park`
returns control to an owner outside the body.

## Terms

- An **Execution** is one affine package containing a lazy body, private continuation state, and a
  fixed readiness endpoint.
- An **activation** is one legal call to `Execution.drive`.
- The **branch state** is owner data transferred to exactly one drive-outcome callback.
- A **Wake** is the affine readiness authority for one parked generation. It is the ordinary
  source struct `Wake` exported by `silk.execution`.
- The **registration guard** is the value returned by `Execution.park`'s registration callback and
  retained until that generation resumes or is destroyed.

## Park and resume one task

The body calls `Execution.park` when an event is not ready. `registerWake` stores the supplied Wake
in the event source and returns a registration guard. The body continues only after the owner
drives the Execution again.

```silk,ignore
// This statement is inside the task body.
run Execution.park(registerWake)
// Execution continues here after the Wake is signaled and the owner drives it again.
```

The owner uses the following statements inside its effect function. `suspend` stores the returned
Execution in `owner.slot`. `ready` runs when signaling the Wake makes that Execution eligible.

```silk,ignore
// make allocates a lazy task package. body has not started yet.
let execution = run Execution.make(body(), (), ready)
  |> Effect.provideMut<Allocator>(&mut allocator)

// The first drive runs body until completion or park.
run Execution.drive(move execution, &mut owner, complete, suspend)

// After ready reports eligibility, take the stored Execution and drive it again.
let selected = Intrinsic.replace(owner.slot, Empty {})
run driveStored(move selected, &mut owner)
```

`Execution.make` returns `Intrinsic.Execution<A>`. `Execution.drive` consumes that value and
returns continued ownership only through `onSuspend`. `Execution.park` is called inside the running
body.

### EXEC-001 — Construction is lazy, explicit, and caller-funded

**Status:** Confirmed

`Execution.make` transfers the body and fixed readiness endpoint into one combined package obtained
through the selected `Allocator`. It returns the package in the `Initial` state without
starting the body.

Construction failure is `Allocator.OutOfMemoryError`. It publishes no Execution and leaves every input
under ordinary Effect cleanup. Later refusal by the selected execution-storage component is a fatal trap,
not an allocator requirement or typed failure.

**Boundary:** Importing `silk.execution` and constructing ordinary Effects allocate no execution
package. Only `Execution.make` selects this storage boundary.

**Diagnostics:** An endpoint that is not detached and non-parking reports `SEM0139` at the failed
property application. A package layout mismatch at the unsafe intrinsic boundary reports
`SEM0142`.

**Evidence:** [ordinary source implementation](../../../../packages/compiler/stdlib/silk/execution.silk),
[package tests](../../../../packages/compiler/test/ExecutionPackage.test.ts).

### EXEC-002 — The owner drives only Initial, InitialReady, or Eligible executions

**Status:** Confirmed

`Execution.drive` consumes an `Initial`, `InitialReady`, or `Eligible` Execution and transfers the
supplied branch state to exactly one take-once outcome callback:

- completion invokes `onComplete(branchState, result)`;
- relinquishment invokes `onSuspend(branchState, execution)`.

Nested `Effect.suspend` transfer may finish within the same activation. External parking
relinquishes the Execution instead.

**Boundary:** `Running`, registering, `Dormant`, notifying, `Completed`, and `Destroyed`
executions are not driveable. Attempting to drive one is a fatal state trap before either outcome
callback runs. There is no recoverable “not ready” result.

**Diagnostics:** Ordinary use after `drive` consumes an affine Execution reports `OWN0001`.
Lifecycle admission failure occurs at runtime as a fatal trap outside Effect failure channels.

**Evidence:** [external parking tests](../../../../packages/compiler/test/ExternalWakeParking.test.ts),
[lifecycle model](effect-suspension.md#independent-execution-and-external-parking).

### EXEC-003 — Parking creates one generation-scoped Wake

**Status:** Confirmed

`Execution.park(register)` transfers one source `Wake` to `register`. If the Wake is signaled before
registration returns, readiness is latched until the registration handoff is complete. Otherwise
the Execution becomes `Dormant`. A successful signal makes that generation `Eligible` and invokes
the fixed readiness endpoint at most once.

The registration callback's return value is retained as the generation guard. The guard is cleaned
immediately before the body continues after `park`, or during destruction if the generation never
continues.

**Boundary:** `Execution.wake` publishes readiness; it never drives the Execution inline.
Signaling or dropping a Wake consumes it. A stale or duplicate Wake cannot publish a second
readiness event.

The readiness phase and the park generation are ordinary source policy in `silk.execution`. They
live in two package control words that the compiler zeroes and never reads. A Wake carries its
generation; signaling a Wake whose Execution was dropped, completed, or parked again publishes
nothing. A cancelled generation's Wake is therefore inert: it can only release its package
authority.

**Diagnostics:** Reusing a consumed Wake reports the ordinary affine `OWN0001` diagnostic. Parking
while an incompatible local-shared access loan is live reports `OWN0016` before lowering.

**Evidence:** [ordinary source policy](../../../../packages/compiler/stdlib/silk/execution.silk),
[external parking tests](../../../../packages/compiler/test/ExternalWakeParking.test.ts).

### EXEC-004 — Executions are local affine owners

**Status:** Confirmed

`Intrinsic.Execution<A>` and `Intrinsic.ExecutionRef` are affine and `LocalExecution`, and so is
every aggregate that contains one, including the source `Wake`. They may move among
ordinary values, Effects, callbacks, and independently resumable frames in one local execution
domain. They are not Copy and have no thread-transfer operation.

Construction accepts only a detached body and detached endpoint state. A detached executable owns
its captured values but retains no caller lexical or provider loan. Stable package-internal loans
may cross parking; a result cannot return a view into package-owned storage.

**Boundary:** `LocalExecution` permits same-thread suspension, parking, and owner transfer. It does
not imply thread safety, atomics, locking, parallel execution, or eligibility for a future thread
transfer operation.

**Diagnostics:** Unsatisfied `Intrinsic.Detached` or `Intrinsic.NonParking` properties report
`SEM0139` with the retained capture, provider, or parking path. Missing explicit ownership of a
park-capable Effect reports `SEM0140`.

**Evidence:** [ownership reference](ownership-and-borrowing.md),
[execution affinity tests](../../../../packages/compiler/test/LocalSharedPressure.test.ts).

### EXEC-005 — Cancellation and completion clean exactly once

**Status:** Confirmed

Completion cleans the consumed outcome callback, fixed endpoint, body or continuation-owned values,
and package allocation in their canonical ownership order. Dropping a parked Execution cancels it
whether its generation is registering, latched, or dormant. Cancellation releases the parked frames
from the innermost outward. Each frame drops every owner live at its suspension point, including
the registration guard and borrowed-temporary holders, then releases its storage. A zero-sized
owner with a drop hook is retained in its frame like any other, so its hook runs exactly once. The
readiness endpoint is not invoked.

If external source still owns the cancelled Wake, that Wake retains only the complete inert package
allocation through its `Intrinsic.ExecutionRef`. Signaling or dropping it performs no notification
or redrive and releases the final authority.

**Boundary:** A retained cancelled Wake can extend allocation lifetime. It cannot keep the body,
guard, endpoint, or suspended payload logically active, and it cannot resurrect the Execution.

**Diagnostics:** Cleanup does not add a typed failure. Fatal traps use Silk's non-unwinding trap
contract and do not promise post-trap cleanup.

**Evidence:** [cleanup ownership model](../../../../packages/compiler/src/SuspensionOwnership.ts),
[separation pressure tests](../../../../packages/compiler/test/LocalSharedPressure.test.ts),
[native corpus](../../../../packages/compiler/test/support/corpus.ts)
(`independent-execution-zero-sized-guard-cancel`, `effect-borrowed-recovery-park-resume-cancel`).

### EXEC-006 — Scheduling policy remains ordinary source

**Status:** Confirmed

The compiler recognizes only these sealed target-neutral Execution primitives:

- `Intrinsic.Execution<A>`, `Intrinsic.executionLayout`, and `Intrinsic.executionFromAllocation`
  construct a package.
- `Intrinsic.executionDrive` starts an unstarted body or resumes a relinquished frame chain.
- `Intrinsic.relinquish` saves the running frame chain and returns the drive through `onSuspend`.
- `Intrinsic.ExecutionRef` is counted authority over one package allocation. It is obtained with
  `Intrinsic.executionCurrent` or `Intrinsic.executionRefOf`.
- `Intrinsic.executionLoad` and `Intrinsic.executionStore` access the two source control words.
- `Intrinsic.executionNotify` invokes the fixed readiness endpoint.
- `Intrinsic.executionLive` reports whether the Execution handle still exists.

`Wake`, `Execution.park`, `Execution.wake`, `Execution.notifyInitial`, and the drive admission
check are ordinary source in `silk.execution`.
Schedulers, fibers, deferred values, timers, reactors, ready queues, fairness, cancellation policy,
and structured concurrency are ordinary source concepts built over those primitives and
[`Shared`](local-shared-ownership.md).

**Boundary:** The explicit Execution API does not make a park-capable `main` implicitly owned;
application entry still requires an explicit owner such as `LocalScheduler.execute`.

**Diagnostics:** No Scheduler, Fiber, Deferred, Timer, or concurrency service requirement is
inferred by `Execution.make`, `drive`, or `park`.

**Evidence:** [minimal compiler privilege](runtime-and-standard-library.md#stdlib-001--public-standard-library-declarations-receive-no-compiler-privilege),
[intrinsic catalog tests](../../../../packages/compiler/test/IntrinsicCatalog.test.ts),
[actor-neutrality pressure tests](../../../../packages/compiler/test/LocalSharedPressure.test.ts).

### EXEC-007 — Initial readiness can be notified after owner publication

**Status:** Confirmed

`Execution.notifyInitial(&mut execution)` changes one `Initial` Execution to `InitialReady`, then
synchronously invokes its fixed non-parking readiness endpoint. It does not start the body. A
later `Execution.drive` starts the body through the same fresh path as a direct first drive.

This operation lets an owner store an Execution before making it visible to its ready policy. The
exclusive borrow keeps ownership in the store slot. Notification does not allocate, choose a
queue, or create a Wake generation.

**Boundary:** Initial notification succeeds exactly once. Calling `notifyInitial` on
`InitialReady`, `Running`, `Dormant`, `Eligible`, or a terminal Execution is a fatal state trap.
Dropping `InitialReady` performs the same unstarted-body cleanup as dropping `Initial`.

**Diagnostics:** Ordinary borrow and ownership rules apply to the exclusive Execution reference.
Lifecycle admission failure occurs at runtime as a fatal trap outside Effect failure channels.

**Evidence:** [Execution package tests](../../../../packages/compiler/test/ExecutionPackage.test.ts),
[lifecycle transition actor](../../../../packages/compiler/src/ExecutionTransition.ts).
