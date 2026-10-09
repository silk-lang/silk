# Single-threaded schedulers and Fibers

The `silk.scheduler`, `silk.fiber`, and `silk.local_scheduler` modules provide explicit local
structured concurrency in ordinary Silk source. An application selects a scheduler provider at its
entry point. The provider owns the root and every child as independently resumable Executions until
the root terminates.

These APIs build on [independently resumable Effect executions](independent-execution.md). The
compiler owns only the target-neutral Execution activation lifecycle. Wake readiness, scheduler
selection, ready order, task storage, Fiber observation, and structured cancellation remain
standard-library policy.

## Terms

- A **Scheduler provider** prepares child tasks and owns the policy that drives them.
- The **root** is the first scheduler-owned task created for one `execute` call.
- A **Fiber** is one affine authority to observe a child's success, typed failure, or cancellation.
- **Publication** is the atomic transfer of one fully prepared child into scheduler-owned storage.
- A **ready task** is stored and eligible for a later drive. Readiness does not run its body inline.
- **Structured cancellation** releases an unfinished task because its parent has terminated.

## Enter a local scheduler explicitly

`LocalScheduler.execute` receives the program before it starts, creates task zero, provides owned
`Scheduler` and `MonotonicClock` clients, and privately drives the ready queue until the root
terminates.

```silk
import silk.allocator { OutOfMemoryError }
import silk.effect { Effect }
import silk.fiber { Fiber, Cancelled, Outcome }
import silk.local_scheduler { LocalScheduler, StalledError }
import silk.monotonic_clock { MonotonicClock }
import silk.scheduler { Scheduler, TaskIdExhaustedError }
import silk.system_clock { SystemClock }
import silk.system_clock { Instant }

struct ParentClock {
  mark: Instant
}

effect fn parentNow(self: &mut ParentClock) -> Instant {
  return SystemClock.make(
    SystemClock.seconds(&self.mark),
    SystemClock.nanoseconds(&self.mark),
  )
}

effect fn parentResolution(self: &mut ParentClock) -> u64 { return 1 }

effect fn parentWaitUntil(self: &mut ParentClock, deadline: Instant) -> () {
  self.mark = move deadline
  return ()
}

effect fn parentWaitFor(self: &mut ParentClock, duration: u64) -> () {
  let deadline = MonotonicClock.deadlineAfter(&self.mark, duration)
  return run parentWaitUntil(move self, move deadline)
}

impl MonotonicClock for ParentClock {
  now: ParentClock.parentNow
  getResolution: ParentClock.parentResolution
  waitUntil: ParentClock.parentWaitUntil
  waitFor: ParentClock.parentWaitFor
}

effect fn work() -> i32 {
  return 42
}

effect fn program() -> i32
! OutOfMemoryError | TaskIdExhaustedError | Cancelled
? &mut Scheduler | &mut MonotonicClock {
  let child = run Fiber.forkChild<i32, never>(work())
  return run Fiber.join<i32, never>(move child)
}

effect fn recover(
  error: OutOfMemoryError
    | TaskIdExhaustedError
    | Cancelled
    | StalledError,
) -> i32 {
  drop error
  return -1
}

pub fn main() -> i32 {
  let mut scheduler = LocalScheduler.make()
  let mut clock = ParentClock { mark: SystemClock.make(0, 0) }
  let scheduled = Effect.catchAll(
    LocalScheduler.execute(&mut scheduler, program()),
    recover,
  ) |> Effect.provideMut<MonotonicClock>(&mut clock)
  return run move scheduled
}
```

Application code inside `program` uses Fiber operations. It does not call a public scheduler loop.
A different provider may expose its own explicit entry operation while implementing the same
ordinary `Scheduler` preparation service.

This reference example uses a deterministic parent clock so its outcome is independently testable. A
native application can instead provide `OsMonotonicClock` at this outer boundary.

### FIBER-001 — Applications select scheduler entry explicitly

**Status:** Confirmed

An application constructs its provider and calls that provider's entry operation. For
`LocalScheduler`, the operation is `execute`. The lazy root program does not begin before
`execute` stores it as task zero and reports its initial readiness.

The root has the same homogeneous `Execution<()>` task shape, mailbox, ready endpoint, and
structured-lifetime links as its children. Its generic success or typed failure is stored
separately and extracted only after scheduler shutdown.

**Boundary:** Silk does not select a scheduler at `main`, create an implicit root owner, or infer a
Scheduler requirement merely because code can park. A park-capable entry without an explicit
Execution owner remains invalid.

**Diagnostics:** A park-capable Effect with no explicit owner reports `SEM0140`. Scheduler choice
and construction have no compiler diagnostic because they are ordinary source calls.

**Evidence:** [LocalScheduler source](../../../../packages/compiler/stdlib/silk/local_scheduler.silk),
[scheduler and Fiber tests](../../../../packages/compiler/test/SchedulerFiber.test.ts).

### FIBER-002 — Child creation is atomic and initially deferred

**Status:** Confirmed

`Fiber.forkChild` accepts a consuming lazy Effect whose remaining runtime requirements are at most
the child's owned Scheduler and MonotonicClock providers. Closed work is therefore valid. The selected provider funds
the completion cells, child client, mailbox, ready endpoint, identity, and Execution before the
child can become observable.

The parent parks while the driver inserts the prepared task. On success, the driver publishes the
response and notifies the parent first. It then reports the stored child's initial readiness.
Deterministic FIFO order lets `forkChild` return the Fiber before the child's first body activation.

**Boundary:** Preparation failure or task-store insertion refusal returns no Fiber and leaves no
runnable child. Task identity exhaustion raises `TaskIdExhaustedError`; allocation refusal
raises `Allocator.OutOfMemoryError`. Neither failure is converted to a child outcome.

**Diagnostics:** A child Effect with additional unresolved runtime requirements fails ordinary
Effect-contract compatibility. No declaration receives special behavior from the spelling
`Scheduler`, `Fiber`, or `forkChild`.

**Evidence:** [Scheduler preparation protocol](../../../../packages/compiler/stdlib/silk/scheduler.silk),
[atomic fork fixture](../../../../packages/compiler/test/fixtures/scheduler-fiber/fork-child.silk).

### FIBER-003 — Fiber observation is affine and non-polling

**Status:** Confirmed

`Fiber.await` consumes one `Fiber<A, E>` and returns `Outcome<A, E>` containing success,
typed failure, or cancellation. `Fiber.join` consumes the same authority, returns `A` on success,
and raises either the original `E` or `Cancelled`.

Observation of a terminal Fiber completes immediately. Observation of an incomplete Fiber parks
the current Execution and installs at most one Wake. Completion and resumption allocate no storage,
and the affine handle makes a second observation unavailable.

**Boundary:** Dropping the Fiber abandons observation only. It neither detaches nor immediately
cancels the child. The task remains attached to its parent until either one terminates.

**Diagnostics:** Reusing a Fiber consumed by `await` or `join` reports the ordinary affine
`OWN0001` diagnostic.

**Evidence:** [Fiber source](../../../../packages/compiler/stdlib/silk/fiber.silk),
[observation fixture](../../../../packages/compiler/test/fixtures/scheduler-fiber/observation.silk).

### FIBER-004 — Child lifetime is structured by the parent task

**Status:** Confirmed

Every child remains linked to the task that created it. Parent success, typed failure,
cancellation, or stalled shutdown cancels and releases every unfinished descendant before the
driver dispatches another task that can observe the parent's terminal outcome.

Cancellation publishes `Cancelled` through the type-erased completion signal and destroys
the child's Execution. A Fiber returned through its terminating parent's result remains a valid
observer, but it observes cancellation when the child was unfinished.

**Boundary:** The initial API has no detached task, daemon task, reparenting, or public interrupt
operation. Returning or dropping a handle does not change the task tree.

**Diagnostics:** Structured cancellation is a scheduler transition, not a source diagnostic and
not a fabricated child failure value.

**Evidence:** [LocalScheduler shutdown fixture](../../../../packages/compiler/test/fixtures/scheduler-fiber/local-scheduler-shutdown.silk),
[structured shutdown tests](../../../../packages/compiler/test/SchedulerFiber.test.ts).

### FIBER-005 — Local ready order is deterministic FIFO

**Status:** Confirmed

`LocalScheduler` appends each readiness notification to one FIFO queue. A task owns one
preallocated intrusive ready node, so Wake notification and `Fiber.yieldNow` do not allocate.
Duplicate readiness is suppressed until the selected node leaves the queue.

`Fiber.yieldNow` parks and immediately consumes its Wake. Tasks already ready remain ahead of the
yielding task. With no competitor, the same task becomes the next eligible selection.

**Boundary:** FIFO describes readiness selection, not parallel fairness or preemption. A task runs
until it completes, parks, or yields. A stale ready node for a removed task is discarded and cannot
name a task from a later `execute` call.

**Diagnostics:** Ready order and stale-node discard do not add typed failures or source diagnostics.

**Evidence:** [LocalScheduler ready queue](../../../../packages/compiler/stdlib/silk/local_scheduler.silk),
[FIFO, yield, and stale-readiness tests](../../../../packages/compiler/test/SchedulerFiber.test.ts).

### FIBER-006 — Typed shutdown preserves the root outcome and provider reuse

**Status:** Confirmed

`LocalScheduler.execute` returns the root's exact success value or raises its exact typed failure.
If no task is ready and no event registration remains while the root is incomplete, it cancels the
remaining task tree and raises `StalledError`. An active timer keeps the scheduler
waiting for progress. Setup or task-store allocation refusal raises `Allocator.OutOfMemoryError`.
Fatal traps remain outside typed recovery.

Before any typed return or failure, shutdown removes every task, drains prepared submissions,
releases scheduler-owned handles, and drops the per-run ready queue. The same `LocalScheduler`
value can then execute another program with fresh task identities and readiness state.

**Boundary:** A retained cancelled Wake may delay release of its old compiler-owned package
allocation. It is inert and cannot enqueue into a later run.

**Diagnostics:** Root typed failures and scheduler failures use their declared Effect channels.
Fatal lifecycle or intrinsic-state errors remain fatal traps.

**Evidence:** [generic root and reuse tests](../../../../packages/compiler/test/SchedulerFiber.test.ts),
[timer-aware scheduler specification](../../../../openspec/changes/add-scheduler-timer-reactor/specs/scheduler-timers/spec.md).

### FIBER-008 — Scheduler timers suspend tasks without blocking siblings

**Status:** Confirmed

Every `LocalScheduler.execute` requires an outer `MonotonicClock` for driver reads and idle waits.
The root and each child instead receive a complete owned clock replacement. `now` and
`getResolution` read per-run cached state; a future `waitFor` or `waitUntil` parks only the calling
task and transfers its Wake to the scheduler's private timer source. Zero-duration and reached
deadlines return without parking.

The driver refreshes time, collects all due timers, and then selects at most one ready task per
turn. Timers are ordered by deadline and registration order, and their Wakes join the same FIFO
ready queue as every other event. If no task is ready, the driver calls the outer clock's
`waitUntil` for the earliest timer. It reports `StalledError` only when neither ready work nor an
active timer remains.

**Boundary:** The outer provider may block the host thread while the scheduler has no ready work.
Calling `OsMonotonicClock.waitFor` directly still blocks. A nested local scheduler can park through
its outer task-clock provider, but a continuously ready inner scheduler remains a synchronous
cooperative scope and does not promise fairness to outer siblings.

**Evidence:** [scripted timer fixture](../../../../packages/compiler/test/fixtures/scheduler-fiber/local-scheduler-timers.silk),
[scheduler and Fiber tests](../../../../packages/compiler/test/SchedulerFiber.test.ts).

### FIBER-007 — Scheduler policy remains ordinary source

**Status:** Confirmed

`Scheduler`, `Fiber`, `LocalScheduler`, task storage, completion, FIFO readiness, and structured
cancellation are navigable Silk declarations. A renamed provider implementing the same service
contract receives the same analysis, ownership, lowering, and execution behavior.

The compiler recognizes only the sealed target-neutral Execution primitives listed in
[EXEC-006](independent-execution.md#exec-006--scheduling-policy-remains-ordinary-source).
`Execution.notifyInitial` is ordinary source: it changes a stored `Initial` Execution to
`InitialReady` and invokes its fixed endpoint, without knowing which queue or scheduling policy
that endpoint implements.

**Boundary:** Importing no Fiber or scheduler module adds no service, task store, queue, Execution,
or Wake machinery to a trivial program.

**Diagnostics:** No diagnostic applies to a legal renamed provider. Unsupported Execution behavior
is reported through the existing target-availability and lifecycle boundaries rather than a
Scheduler-specific compiler branch.

**Evidence:** [independent-execution boundary](independent-execution.md#exec-006--scheduling-policy-remains-ordinary-source),
[renamed provider fixture](../../../../packages/compiler/test/fixtures/scheduler-fiber/renamed-provider.silk).
