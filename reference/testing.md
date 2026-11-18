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
- A **runner record** lists every file the build of the bundled runner read, so a later run can
  tell whether the runner it built is still current.
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

**Evidence:** test declaration requirements.

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

**Evidence:** ordinary-build test behavior.

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

**Evidence:** test discovery requirements,
[module static selection](module-static-selection.md).

### TEST-004 — Discovery exposes sealed static descriptors and exact callables

**Status:** Confirmed

`Intrinsic.tests()` produces a finite heterogeneous static catalog. Each
`Intrinsic.Test<F>` descriptor represents one discovered declaration and retains that test's exact
callable type `F`. `Intrinsic.testInfo(descriptor)` produces immutable identity, name, module, and
logical project-relative path metadata.
`Intrinsic.testFunction(descriptor)` crosses the static boundary once and produces the exact
ordinary runtime callable.

Descriptors and their metadata carry no source line or column and nothing of a test's body. Moving
a test, or editing text around it or inside it, therefore leaves the catalog and every runner
specialization over it unchanged (TEST-005). A tool that shows where a test is declared resolves the
test's identity against the current source.

The descriptor authorizes callable extraction for its marked test, including a private test. It
does not authorize ordinary access to that declaration or another private declaration. Static
iteration specializes runner source separately for each callable type; no descriptor or test
registry remains in the runtime program.

**Boundary:** Descriptors cannot be forged, stored in runtime data, serialized, or passed through a
runtime parameter. Test operations are unavailable while module selection is deciding the import
graph that would define their own catalog.

**Diagnostics:** Invalid descriptors, runtime retention, unavailable discovery context, and use in
module selection report static-phase diagnostics and publish no partial executable expansion.

**Evidence:** test catalog and callable requirements,
[static evaluation](static-evaluation.md).

### TEST-005 — A descriptor names its test by declaration

**Status:** Confirmed

A descriptor is determined by its test's declaration alone: its exact callable type `F` names the
declaration, and `Intrinsic.testInfo` reads nothing else. The catalog is determined by which tests
the discovered modules declare, in catalog order. Discovery reads each module's imports and the
headers of its tests, never a body.

So editing a test's body, or any function it calls, changes no descriptor and no catalog. Adding,
removing or renaming a test changes the catalog, and so the runner's loops over it, but leaves the
descriptor of every other test, and the runner specialization for it, unchanged.

**Boundary:** A descriptor is not a test result. Whether a test runs again is decided from what it
executed and read (TEST-008), not from its descriptor.

**Diagnostics:** None.

**Evidence:** test discovery requirements.

## Running tests

The `silk.testing.testing` module provides a source-defined boolean expectation. It returns unit when the
condition is true and fails with `AssertionError` carrying the supplied message when it is false.
The helper has no service requirement and uses the same typed failure channel as other Effects.

```silk
import silk.testing.testing { AssertionError, Testing }

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

**Evidence:** runner filter requirements,
test CLI requirements.

### TEST-007 — The bundled runner executes tests sequentially with ordinary outcomes

**Status:** Confirmed

The bundled runner identifies each selected test before invoking it, waits for that invocation and
its structured cleanup, and then starts the next test. An ordinary unit return or a successful
unit Effect passes. A typed failure fails that test and permits the runner to continue without
requiring the failure payload to implement a reporting interface. A fatal trap still ends the
runner process without cleanup, but it does not end the run: the host reports the trapping test as
failed and starts a new runner process that continues with the next selected test.

Each test has a time limit, 60 seconds unless `--timeout <seconds>` sets another; `--timeout 0`
removes it. A test that outlives its limit ends the runner process like a trap: `silk test` reports
that the test did not finish within the limit, fails it, and continues with the next selected test.
The limit needs a native target with a C library; elsewhere tests have none.

Tests must close their service requirements and provide any scheduler or execution owner they need.
The bundled runner supplies no hidden provider or scheduler. This can require a test to wrap its
body in local provision or a nested Effect. Exact callable requirement rows remain available so a
future source-written host can provide services explicitly.

```silk
import silk.core.effect { Effect }

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

The runner identifies each selected test, prints elapsed time for each executed result, and reports
discovered, selected, cached, executed, passed, and failed counts plus total run time. A test the
runner skips because it passed before with the same code and inputs (TEST-008) is reported as
`CACHED` and counted in `cached` and `passed`, but not `executed`. Completed runs return 0 when all selected
tests pass, including zero selected tests; they return 1 when a typed test failure or a trapping
test occurs. Runner or cache-exchange operational failures return 2. Abnormal termination outside a
test body remains abnormal.

**Boundary:** The runner has no parallelism, retries, sharding, isolation, watch mode, shared
fixtures, or configurable hosts.

**Diagnostics:** Unsatisfied service requirements or a parking Effect at the complete invocation
boundary are compile-time errors even when runtime filters would exclude that test.

**Evidence:** source runner requirements,
[typed failures](typed-failures.md), [requirements and services](requirements-and-services.md),
[program termination](program-termination-and-reporting.md).

### TEST-008 — A test that passed is not repeated while its code and inputs are unchanged

**Status:** Confirmed

A runner that `silk test` builds for an ELF or Mach-O target keeps a table of its functions: each
one has a flag its entry sets and the digest of everything the compiler read to make it. Before a
test runs, the runner clears the flags and watches what the test reads through the native
providers: files and their entries, directory listings and environment variables, the files and
directories it writes, makes or removes, and whether it reads the clock, takes random numbers from
the host, opens a socket or resolves a name, starts a child process, lists the environment, or
reads the host's system information, standard input, signals or the program's arguments. After a
test that passed, the runner records, beside itself, the digests of the functions the test
executed and a digest of each input it read, taken after the test. What a test reads or writes in
a directory it made with `createTemporaryDirectory` is its own and is not an input.

A later run from the same working directory skips a selected test when every function it
executed is in the new runner with the same digest and every input it read reads the same. It
reports the test as `CACHED` and counts it in `cached` and `passed`, but not `executed`. A test is
always run again when it failed, changed a file or directory outside its own temporary
directories, used the clock, randomness, the network, a child process, the list of the
environment or the host, read more than the watch holds, or executed a function without a digest,
as in a build without a cache. The record is kept only while the runner's build key (TEST-009),
which names the compiler, Clang and the build's options, the time limit, and the files besides
Silk sources that the build read, such as the C sources and archives declared by package plans, the manifest
and embedded files, stay the same. `--no-cache` builds the runner again and runs every selected
test.

```sh
silk test             # reuses an unchanged runner; runs only the tests whose code or inputs changed
silk test --no-cache  # builds the runner again, then runs every selected test
```

**Boundary:** A test that reads the host other than through the native providers, such as a C
call or a dynamic library it loads, reads unseen. A system library the runner links is not part of
the key. Work a process does once, such as filling a cache
on first use, is recorded only for the test that did it, so a later test that relies on it can be
skipped after an edit to that work. Windows and WASI runners have no table, so every selected
test runs.

**Diagnostics:** Every discovered test is compiled, or its build reused, before runtime selection,
so source diagnostics are never hidden. Invalid or incomplete plan or receipt exchange data is an
operational status 2.

**Evidence:** source runner requirements, test CLI requirements.

### TEST-009 — An unchanged project reuses its built runner

**Status:** Confirmed

`silk test` records, beside the runner it builds, every file the build read with a digest of its
contents, every file or directory it looked for, and every directory it listed. The next run
compares that record with the files on disk. When nothing in it changed, and the compiler, profile,
discovery root, and toolchain settings (`--clang`, `SILK_CLANG`, `SILK_LLVM_AR`, `PATH`,
`SDKROOT`, `DEVELOPER_DIR`) are the same, the run reuses the runner without building. `--file` and
`--filter` select tests in the runner, so a filtered rerun reuses it too.

```sh
silk test                  # builds the runner and runs every test
silk test --filter parser  # reuses the runner when no source changed
```

**Boundary:** A run with profile bindings never reuses a runner, because bindings may hold secrets
that are not written to disk. Files that only the native toolchain reads, such as system libraries
and headers, are not part of the record. Adding a file to a directory the build listed counts as a
change even when no import names it. `--no-cache` builds the runner again (TEST-008).

**Diagnostics:** None. A record that is missing, unreadable, or written by another compiler only
means the runner is built again.

**Evidence:** test runner reuse requirements, cached CLI workflow.
