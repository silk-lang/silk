# Tests and the source runner

Silk marks tests in source and exposes their discovery data to an ordinary Silk runner. The
compiler identifies eligible declarations and preserves their exact callable types. The bundled
runner owns filtering, invocation, reporting, and exit policy.

## Terminology

- A **test declaration** is a module-level `test fn` or `test effect fn` with the test entry
  contract.
- The **discovery root** is the project source file whose active import graph defines the candidate
  test modules.
- A **test descriptor** is a sealed static value issued by the compiler for one discovered test.
- An **authored fingerprint** identifies the canonical authored header and body of one test. It is
  content metadata, not a reusable test result.
- An **execution identity** is a compiler-issued cache key for one test's complete known execution
  closure and normalized compiler-controlled environment.
- The **bundled runner** is ordinary Silk source used as the executable entry for `silk test`.

## Test declarations

### TEST-001 — `test` marks a parameterless unit function

**Status:** Confirmed

A test is a named, safe module-level runtime function with a body, no value, generic, or lifetime
parameters, and unit success. `test` is independent from `effect`: `test fn` is an ordinary eager
function, and `test effect fn` constructs an Effect with its declared failure and requirement
channels.

```silk
test fn emptyInputIsValid() {
}

test effect fn invalidInputFails() ! string {
  fail "invalid input"
}
```

Tests may be private or public. A private test retains normal lexical access to private helpers in
its module. The qualifier does not make the function or its helpers publicly nameable.

**Boundary:** `test` cannot qualify a static, unsafe, foreign, exported, anonymous, associated, or
parameterized function. A test cannot declare a non-unit success type. An ordinary test cannot
propagate a typed failure merely because it is marked `test`.

**Diagnostics:** An invalid test entry reports a declaration diagnostic at the conflicting
qualifier, parameter, binder, or success type. Ordinary name, body, Effect-channel, and visibility
diagnostics still apply.

**Evidence:** [test declaration requirements](../../../../openspec/changes/add-basic-test-runner/specs/silk-test-declarations/spec.md).

### TEST-002 — Ordinary builds do not execute or retain tests

**Status:** Confirmed

An ordinary build analyzes active test declarations like other active functions. The qualifier
does not call the function, retain an otherwise unreachable body, activate an import, or install a
runner. A test remains ordinarily callable wherever its visibility permits.

**Boundary:** A test in an inactive module-level static branch is not an active declaration. A file
used only for tests stays outside an ordinary build when the application's active imports do not
reach it.

**Diagnostics:** No diagnostic applies to an unused valid test declaration. Invalid active tests
receive their ordinary declaration and body diagnostics.

**Evidence:** [ordinary-build test behavior](../../../../openspec/changes/add-basic-test-runner/specs/silk-test-declarations/spec.md#requirement-ordinary-builds-do-not-implicitly-execute-or-retain-tests).

## Discovery and metadata

### TEST-003 — One explicit root and its active imports define discovery

**Status:** Confirmed

`silk test` discovers tests owned by the current project in the transitive active import graph of
one discovery root. It does not scan the source directory. A separate test file participates by
being imported directly or transitively from that root.

```silk,ignore
// src/tests.silk
import app.parser_tests
import app.encoder_tests
```

The default root is the package root. `--root` selects one alternate project source file. The root
may be import-only and does not need a `main`; the runner has its own executable entry.

**Boundary:** Unimported project files, toolchain modules, other source owners, inactive imports,
and modules imported only by runner or runtime composition do not contribute tests. Multiple paths
to the same module do not duplicate a test.

**Diagnostics:** A missing or invalid required root reports the ordinary required-root diagnostic.
A catalog query without a valid discovery context reports a static-phase diagnostic instead of
assuming a root or returning an empty catalog.

**Evidence:** [test discovery requirements](../../../../openspec/changes/add-basic-test-runner/specs/silk-test-discovery/spec.md#requirement-discovery-uses-an-explicit-root-and-project-ownership),
[module static selection](module-static-selection.md).

### TEST-004 — Discovery exposes sealed static descriptors and exact callables

**Status:** Confirmed

`Intrinsic.tests()` produces a finite heterogeneous static catalog. Each
`Intrinsic.Test<F>` descriptor represents one discovered declaration and retains that test's exact
callable type `F`. `Intrinsic.testInfo(descriptor)` produces immutable identity, name, module,
logical project-relative path, and fingerprint metadata.
`Intrinsic.testFunction(descriptor)` crosses the static boundary once and produces the exact
ordinary runtime callable.

Descriptors and their metadata carry no source line or column. Moving a test, or editing text
around it, therefore leaves the catalog and every runner specialization over it unchanged; only an
edit to the test's own declaration changes its fingerprint (TEST-005). A tool that shows where a
test is declared resolves the test's identity against the current source.

The descriptor authorizes callable extraction for its marked test, including a private test. It
does not authorize ordinary access to that declaration or another private declaration. Static
iteration specializes runner source separately for each callable type; no descriptor or test
registry remains in the runtime program.

**Boundary:** Descriptors cannot be forged, stored in runtime data, serialized, or passed through a
runtime parameter. Test operations are unavailable while module selection is deciding the import
graph that would define their own catalog.

**Diagnostics:** Invalid descriptors, runtime retention, unavailable discovery context, and use in
module selection report static-phase diagnostics and publish no partial executable expansion.

**Evidence:** [test catalog and callable requirements](../../../../openspec/changes/add-basic-test-runner/specs/silk-test-discovery/spec.md),
[static evaluation](static-evaluation.md).

### TEST-005 — A fingerprint covers only the test's authored declaration

**Status:** Confirmed

Each descriptor reports a versioned SHA-256 fingerprint over the canonical authored header and
body of that test. Comments, whitespace, source offsets, physical paths, unrelated pool numbering,
and moving unchanged source do not affect it. Editing the test's contract or body does.

The fingerprint excludes called function implementations, resolved external meanings, providers,
targets, profiles, compiler and runner versions, files, environment, time, and network state. If a
test calls `parse`, editing only `parse` may change the test result while leaving the test's
fingerprint unchanged.

**Boundary:** The authored fingerprint is never cache authority. Result reuse uses the separate
execution identity, which also covers the test's known transitive dependencies and normalized
compiler-controlled environment.

**Diagnostics:** No diagnostic applies to observing a fingerprint. Treating it as cache authority
has no language support.

**Evidence:** [authored fingerprint requirements](../../../../openspec/changes/add-basic-test-runner/specs/silk-test-discovery/spec.md#requirement-fingerprints-describe-local-authored-content-only).

## Running tests

The `silk.testing` module provides a source-defined boolean expectation. It returns unit when the
condition is true and fails with `AssertionError` carrying the supplied message when it is false.
The helper has no service requirement and uses the same typed failure channel as other Effects.

```silk
import silk.testing { AssertionError, Testing }

test effect fn additionWorks() -> () ! AssertionError<'static> {
  return run Testing.expect(1 + 1 == 2, "expected two")
}
```

### TEST-006 — Filters select execution without pruning compilation

**Status:** Confirmed

`silk test --file PATH` selects the exact normalized, case-preserving project-relative logical
path. `silk test --filter TEXT` selects declared test names containing `TEXT` after
locale-independent ASCII case folding. The name excludes module and path decoration. When both
options are present, both predicates must match.

```sh
silk test --file src/parser_tests.silk --filter invalid
```

The name filter is a literal substring. It is not a regular expression or glob; `*` and `.` have
no special meaning. An empty name filter matches every name. The file option does not scan or load
the named path, so an unreachable path selects no tests.

**Boundary:** Filtering occurs in the source runner after discovery. Every discovered test is still
analyzed and compiled, so an invalid filtered-out test prevents execution.

**Diagnostics:** Invalid option or root paths report CLI configuration diagnostics before launch.
Source errors in any discovered test retain their ordinary source diagnostics.

**Evidence:** [runner filter requirements](../../../../openspec/changes/add-basic-test-runner/specs/silk-test-runner/spec.md#requirement-runtime-filters-use-literal-name-and-exact-file-predicates),
[test CLI requirements](../../../../openspec/changes/add-basic-test-runner/specs/silk-cli-workflows/spec.md).

### TEST-007 — The bundled runner executes tests sequentially with ordinary outcomes

**Status:** Confirmed

The bundled runner identifies each selected test before invoking it, waits for that invocation and
its structured cleanup, and then starts the next test. An ordinary unit return or a successful
unit Effect passes. A typed failure fails that test and permits the runner to continue without
requiring the failure payload to implement a reporting interface. A fatal trap remains fatal.

Tests must close their service requirements and provide any scheduler or execution owner they need.
The bundled runner supplies no hidden provider or scheduler. This can require a test to wrap its
body in local provision or a nested Effect. Exact callable requirement rows remain available so a
future source-written host can provide services explicitly.

```silk
import silk.effect { Effect }

service Clock { effect fn value() -> i32 ? &Clock }
struct FixedClock { value: i32 }
effect fn value(self: &FixedClock) -> i32 { return self.value }
impl Clock for FixedClock { value: FixedClock.value }
effect fn read() -> i32 ? &Clock { return run Clock.value() }

effect fn readWithFixedClock() -> () {
  let clock = FixedClock { value: 42 }
  let observed = run read() |> Effect.provide<Clock>(&clock)
  drop observed
  return ()
}

test fn readsFixedClock() -> () { return run readWithFixedClock() }
```

The runner identifies each selected test, prints elapsed time for each executed result, identifies
cached passes without invoking them, and reports discovered, selected, cached, executed, passed,
and failed counts plus total run time. A cached pass contributes to `cached` and `passed`, but not
`executed`. Completed runs return 0 when all selected tests pass, including zero selected tests;
they return 1 when a typed test failure occurs. Runner or cache-exchange operational failures
return 2. Abnormal termination remains abnormal.

**Boundary:** The runner has no parallelism, retries, sharding, isolation, watch mode, shared
fixtures, or configurable hosts.

**Diagnostics:** Unsatisfied service requirements or a parking Effect at the complete invocation
boundary are compile-time errors even when runtime filters would exclude that test.

**Evidence:** [source runner requirements](../../../../openspec/changes/add-basic-test-runner/specs/silk-test-runner/spec.md),
[typed failures](typed-failures.md), [requirements and services](requirements-and-services.md),
[program termination](program-termination-and-reporting.md).

### TEST-008 — Completed passes are reused by execution identity

**Status:** Confirmed

`silk test` reuses a prior completed pass by default. The compiler publishes one execution identity
for each eligible discovered test. That identity includes the test's authored declaration, its
known transitive execution closure, and normalized compiler, profile, runtime, target, native-input,
and bundled-runner facts. Editing a dependency invalidates only tests whose closures include it;
editing a shared dependency invalidates all affected tests. Runtime filters do not enter the key,
so selecting the same test by a different `--file` or `--filter` combination can reuse the same
pass.

Only a test executed by the current admitted run and reported as passed is published. Failed tests
run again, and cached tests are never republished. Incomplete compiler attribution makes that test
ineligible rather than guessing. Result records use the `test-results-v1` namespace beneath
`<build.output-dir>/.silk-cache`.

```sh
silk test                    # reads and publishes completed-pass results
silk test --no-cache         # bypasses test-result reads and writes for this invocation
silk test --filter parser    # filters in the runner; eligible hits may still be reused
```

`--no-cache` controls only test-result reuse. It does not disable compiler or native-artifact
caches. If the complete per-test plan or receipt would exceed the bounded exchange, the invocation
selects compact uncached mode before any result lookup and executes the selected tests normally.
Expected optional result-store read or publication failures are reported and degrade to execution
or skipped publication; they do not replace the test outcome.

**Boundary:** Execution identities do not track arbitrary files read at runtime, ambient process
environment, network responses, wall-clock time, randomness, or other external state. A skipped
passing test does not replay its stdout, stderr, file writes, service mutations, or effects on later
tests. `--no-cache` is the execution mode for tests whose correctness depends on those facts unless
the dependency is made an explicit compiler-controlled input.

**Diagnostics:** Every discovered test is still compiled before runtime selection or cache lookup,
so a cached hit cannot hide source diagnostics. Invalid or incomplete plan/receipt exchange data is
an operational status 2 and publishes no results.

**Evidence:** [test-result cache requirements](../../../../openspec/changes/cache-test-results/specs/silk-test-result-caching/spec.md),
[cached CLI workflow](../../../../openspec/changes/cache-test-results/specs/silk-cli-workflows/spec.md).
