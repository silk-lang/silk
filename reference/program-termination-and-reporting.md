# Program termination and reporting

Silk distinguishes normal completion, unhandled typed failure, and fatal trap. These rules describe
the installed source startup compositions. A custom runtime selects its own source policy through
ordinary calls, Effect recovery, lexical observation, and foreign exports. None of these operations
adds a formatting requirement to error values.

TERM-001–012 are confirmed stabilization rules.

## TERM-001 — An ordinary entry explicitly returns unit or one status value

**Status:** Confirmed

`pub fn main() -> ()` completes normally with machine status `0`. `pub fn main() -> i32` completes
normally with that exact `i32`. Neither form automatically reports an error, even when the integer
is nonzero.

```silk
pub fn main() -> () {
}
```

```silk
pub fn main() -> i32 {
  return 7
}
```

**Boundary:** The result annotation is required. `pub fn main() {}` remains invalid until Silk
adopts a general return-omission rule. A native host may expose only a target-defined subset of the
`i32`; an embedded WebAssembly host observes the exact machine-entry result.

**Diagnostics:** An unsupported application result fails the selected source runtime’s ordinary
interface conformance. A missing annotation receives the ordinary missing-result diagnostic.

**Evidence:** [source application selection](program-entry.md#entry-001--runtime-source-chooses-a-visible-application-function).

## TERM-002 — A successful effect entry returns zero

**Status:** Confirmed

`pub effect fn main()` is constructed and executed exactly once. When it succeeds with `()`, the
source startup export returns status `0` and prints nothing automatically.

```silk
pub effect fn main() {
}
```

**Boundary:** Effect-entry success must be unit. Returning an integer success value does not turn it
into an ordinary entry or choose a process status.

**Diagnostics:** A non-unit Effect success type fails the selected source runtime’s ordinary
interface conformance before backend emission.

**Evidence:** [effect entry execution](program-entry.md#entry-002--source-startup-owns-execution),
[effect entry failure boundary](program-entry.md#entry-003--source-policy-handles-unhandled-outcomes).

## TERM-003 — Every unhandled typed failure uses status one

**Status:** Confirmed

Any valid concrete error reaching the effect-entry boundary produces machine status `1`. The actual error identity belongs to the structured outcome and
report, not to a numeric status ordinal.

```silk
pub struct NotFoundError {}
pub struct OfflineError {}

pub effect fn main() ! NotFoundError | OfflineError {
  fail OfflineError {}
}
```

This terminates with status `1` whether the active error is `NotFoundError` or `OfflineError`.

**Boundary:** Adding, removing, or reordering structural-union members cannot change the public
status. Application-specific statuses require handling the error explicitly before entry.

**Diagnostics:** A valid unhandled entry error receives no compile-time diagnostic. The runtime
outcome is an unhandled error, not a source diagnostic.

**Implementation:** Both installed startup modules use ordinary generic recovery handlers to drop
the active owned error and select status `1`, independently of union member order. Hosted startup
observes the retained diagnostic context; standalone WebAssembly startup performs no report.

**Evidence:** [entry failure rule](program-entry.md#entry-003--source-policy-handles-unhandled-outcomes),
current backend contract.

## TERM-004 — A failure report has one stable minimum

**Status:** Confirmed

When diagnostic capacity and output permit, the hosted source reporter presents, in order:

1. an explicit `unhandled error` classification;
2. the canonical fully qualified type identity of the active error;
3. the source origin where the failure was created, when valid provenance exists; and
4. the logical named function and Effect path from that origin outward to `main`.

```text
unhandled error: app.NotFoundError
  at app.load (src/app.silk:12)
  at app.main (src/app.silk:27)
```

The exact wording is illustrative; the information and order are the contract.

**Boundary:** Reporting is bounded and best effort. The installed hosted composition permits 64
diagnostic nodes, 4096 output bytes, and 32 frames. Capacity refusal retains the primary identity
and available context and may truncate presentation. Output failure preserves status one. Colors,
source excerpts, absolute path spelling, and target information are optional decoration.

**Diagnostics:** No compile-time diagnostic applies. Missing provenance caused by a compiler defect
must not be disguised as an empty successful report.

**Evidence:** [failure diagnostic context](typed-failures.md#fail-006--typed-failure-applies-ordinary-cleanup-and-preserves-diagnostic-context).

## TERM-005 — Automatic reporting does not inspect error payload fields

**Status:** Confirmed

The source reporter presents canonical error identity and retained diagnostic context. It does not
reflect over, serialize, or generically format the payload's fields.

```silk
pub struct NotFoundError {
  resourceId: i32
}
```

An automatic report identifies `NotFoundError`; it does not automatically print `resourceId`.

**Boundary:** The reporter cannot expose private fields accidentally, require a display operation,
or fail because one payload field has no formatter. Source recovery code may inspect and report the
payload explicitly before it reaches entry. A future opt-in error-formatting interface may customize
the report, but implementing it must never be required for a value to participate in the typed-error
channel or reach the automatic entry boundary.

**Diagnostics:** No marker interface or formatting diagnostic applies to a valid error type.

**Evidence:** [ordinary error values](typed-failures.md#fail-001--any-concrete-lifetime-valid-value-may-be-a-typed-failure),
[removal of Report ceremony](program-entry.md#entry-003--source-policy-handles-unhandled-outcomes).

## TERM-006 — Recovery history becomes causal report context

**Status:** Confirmed

If a recovery handler fails while handling an earlier error, the new error is primary. Its report
retains the earlier identity and logical trace under an explicit `while handling` cause. Ordinary
propagation does not duplicate the same cause, and a successful handler removes the handled context
from the final outcome.

```text
unhandled error: app.OfflineError
  at app.recover (...)
while handling: app.NotFoundError
  at app.load (...)
```

**Boundary:** Causal context remains hidden runtime metadata. It does not change `E`, enter pattern
matching, or wrap the handler's ordinary error parameter.

**Diagnostics:** No compile-time diagnostic applies. Causal presentation must not reorder the
primary and handled errors.

**Evidence:** [failure recovery context](typed-failures.md#fail-006--typed-failure-applies-ordinary-cleanup-and-preserves-diagnostic-context).

## TERM-007 — Logical traces survive optimization and explicit suspension

**Status:** Confirmed

The stable trace contains source-declared function and Effect boundaries. It excludes compiler
helpers, physical machine frames, and private coroutine transitions. Optimization cannot erase a
logical frame required by the report, and `Effect.suspend` preserves the suspended invocation's
place in the logical path.

**Boundary:** Debug builds may add internal detail. Release builds still retain the stable minimum
for fallible entry paths. This rule does not promise future async task or scheduler traces.

**Diagnostics:** No compile-time diagnostic applies. A runner must not present a physical helper
frame as if the programmer declared it.

**Evidence:** [Effect suspension rules](effect-suspension.md),
[failure diagnostic context](typed-failures.md#fail-006--typed-failure-applies-ordinary-cleanup-and-preserves-diagnostic-context).

## TERM-008 — Fatal traps use a distinct best-effort report

**Status:** Confirmed

A trap terminates abnormally outside the typed-error outcome. When runtime state remains
trustworthy, the host report contains an explicit `fatal trap` classification, the reason, source
origin, and available logical path.

```text
fatal trap: division by zero
  at app.calculate (src/app.silk:8)
  at app.main (src/app.silk:14)
```

A trap inside a task that an Execution runs, such as a Fiber child, reports the same way to the
observer of the code driving it.

A stack overflow on the main thread of a hosted native program is a trap too. Its report is
`fatal trap: stack overflow` without frames, written from a separate signal stack; another invalid
memory access reports `fatal trap: segmentation fault`. The process then ends with the signal.

**Boundary:** Corrupted memory or a violated unsafe contract may prevent a complete report. Silk
guarantees neither a portable numeric trap status nor structured cleanup after the trap. A stack
overflow on a thread other than the main thread has no signal stack and may end without a report.

**Diagnostics:** A compile-time trap in required constant evaluation is a source diagnostic. A
runtime trap is abnormal termination and must not be reported as an unhandled typed error.

**Evidence:** [fatal trap rule](typed-failures.md#fail-007--a-trap-is-fatal-and-remains-outside-effect-outcomes),
[trap cleanup boundary](ownership-and-borrowing.md#trap-001--a-trap-has-no-cleanup-guarantee).

## TERM-009 — Automatic entry reporting is not an ambient service

**Status:** Confirmed

Terminal reporting belongs to the selected source runtime. Hosted startup creates and scopes its
NativeDiagnostics owner and NativeReport writer explicitly. The compiler transports diagnostic
metadata through the lexical observer and owned outcomes. It defines neither a process-global
report store nor the formatting, output, capacity, or termination policy.

**Boundary:** Failure while writing a best-effort report cannot become a new typed error or replace
the original termination. Ordinary program logging still requires its explicit service.

**Diagnostics:** No requirement-row entry is added for automatic reporting. A source log operation
with an unresolved service remains an ordinary open-requirement error.

**Evidence:** [source startup boundary](runtime-and-standard-library.md#runtime-005--source-compositions-own-application-startup-and-termination),
[no ambient facilities](runtime-and-standard-library.md#runtime-004--silk-has-no-ambient-runtime-facilities).

## TERM-010 — Embedded reporting is explicit source composition

**Status:** Confirmed

The default hosted executable writes best-effort diagnostics to standard error. The default
standalone WebAssembly runtime exports `main() -> i32`: integer results pass through, unit and
Effect-unit success return zero, and typed failure returns one after payload cleanup. It installs
no diagnostic observer, console, or hidden reporting import. Fatal traps remain bare machine traps.

A custom embedding runtime may install a lexical observer and expose its chosen presentation or
structured data through ordinary foreign exports. That source composition defines its ABI and
capacity contract; the compiler does not synthesize an embedded report object.

**Boundary:** Numeric status alone does not encode a typed error's identity or trace. An embedding
that needs those details must select a source reporting composition.

**Diagnostics:** Source compositions obey ordinary target, ownership, Effect, and foreign-ABI
checks. No implicit runner capability repairs an unsupported source composition.

**Evidence:** [runtime layers](runtime-and-standard-library.md#runtime-001--language-public-source-target-providers-and-toolchain-runtime-support-are-distinct-layers),
[program entry](program-entry.md).

## TERM-011 — Typed-failure reporting follows completed cleanup

**Status:** Confirmed

On unhandled typed failure, every exited owner except the failure payload is cleaned during
propagation. The source recovery handler then drops the payload exactly once while retaining its hidden
diagnostic context for reporting.

**Boundary:** Reporting does not keep arbitrary user payload storage alive. Fatal traps retain their
separate no-cleanup guarantee.

**Diagnostics:** Invalid cleanup ownership receives its ordinary compile-time diagnostic. A valid
terminal failure adds no cleanup diagnostic.

**Evidence:** [typed-failure cleanup](typed-failures.md#fail-006--typed-failure-applies-ordinary-cleanup-and-preserves-diagnostic-context),
[cleanup follows ownership](ownership-and-borrowing.md#cleanup-001--cleanup-follows-ownership).

## TERM-012 — Custom presentation and statuses are explicit source policy

**Status:** Confirmed

A program wanting a custom message, payload rendering, telemetry event, or application-specific
status handles the typed error in application source or selects a custom source runtime. It closes every
Effect error and requirement and returns an ordinary `i32` entry result when it wants to select a
status.

**Boundary:** No error naming convention, marker interface, or automatically discovered operation
changes entry behavior. Future standard-library helpers remain ordinary source APIs.

**Diagnostics:** An ordinary entry that attempts to `run` an Effect with unhandled errors or
requirements receives the existing boundary diagnostic before backend emission.

**Evidence:** [ordinary execution boundary](effects-and-execution.md),
[explicit entry requirements](program-entry.md#entry-004--source-composition-resolves-application-requirements),
[style guide](style-guide.md).

## Future direction: custom error formatting

Silk may later define an ordinary opt-in interface for customizing how an unhandled error payload
is presented. Such an interface must remain separate from error eligibility: every valid detached
owned value can still be an error without implementing it. The future design must also define how
formatting obtains allocation or output capabilities, what happens if formatting cannot complete,
and how embedded targets request structured rather than textual output.
