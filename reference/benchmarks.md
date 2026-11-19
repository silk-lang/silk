# Benchmarks in source

Silk marks benchmarks in source the way it marks tests, and exposes their discovery data to an
ordinary Silk program. The compiler identifies eligible declarations and preserves their exact
callable types. `silk.bench.bencher` owns iteration, timing and reporting.

## Terminology

- A **benchmark declaration** is a module-level `bench fn` or `bench effect fn` with the benchmark
  entry contract.
- The **benchmark root** is the source file whose active import graph defines the candidate
  benchmark modules.
- A **benchmark descriptor** is a sealed static value issued by the compiler for one discovered
  benchmark. It is the test descriptor of [Tests and the source runner](testing.md).

## Benchmark declarations

### BENCH-001 — `bench` marks a unit function of one parameter

**Status:** Candidate

A benchmark is a named, safe module-level runtime function with a body, exactly one value
parameter, no generic or lifetime parameters, and unit success. `bench` is independent from
`effect`: `bench fn` is an ordinary eager function, and `bench effect fn` constructs an Effect with
its declared failure channel. `bench` is an identifier everywhere else.

```silk,ignore
import silk.bench.bencher { Bencher }

bench fn emptyLoop(b: Bencher) {
  while b.next() {
  }
}
```

A benchmark may be private or public, and an ordinary build treats it as TEST-002 treats a test: it
is analyzed like any other active function, is not called, and does not retain an otherwise
unreachable body.

**Boundary:** `bench` cannot qualify a static, unsafe, foreign, exported, anonymous, associated or
generic function. A benchmark cannot declare a non-unit success type or a requirement row. The
compiler does not name the parameter's type: the program that calls the benchmark decides what it
passes, and `silk.bench.bencher` passes a `Bencher`. A parameter type that needs a lifetime, such
as a borrow, has no exact callable type and is rejected when the catalog is built.

**Diagnostics:** An invalid benchmark entry reports the test declaration diagnostic at the
conflicting qualifier, parameter, binder or success type, with a detail that names the benchmark
rule.

**Evidence:** `corpus/native/stdlib-bench-fn`.

## Discovery

### BENCH-002 — `Intrinsic.benchmarks()` catalogs the benchmarks of one root

**Status:** Candidate

`Intrinsic.benchmarks()` produces the finite heterogeneous static catalog of the benchmark
declarations in the transitive active import graph of the benchmark root, restricted to the root's
package, in the form TEST-004 gives the test catalog: each `Intrinsic.Test<F>` descriptor retains
its benchmark's exact callable type `F`, `Intrinsic.testInfo` reads its identity, name, module and
path, and `Intrinsic.testFunction` produces the exact runtime callable. A test is never in the
benchmark catalog and a benchmark is never in the test catalog.

The benchmark root is the discovery root of a test build, and otherwise the application of the
build. An ordinary program whose entry file imports the modules that hold its benchmarks can
therefore run them, with no separate command and no bundled entry.

Discovery reads each module's imports and the headers of its benchmarks, never a body (TEST-005).
Editing a benchmark's body changes no descriptor and no catalog.

**Boundary:** Modules of other packages and toolchain modules contribute no benchmarks. A build
with neither a discovery root nor an application has no benchmark catalog.

**Diagnostics:** A catalog query without a root reports a static-phase diagnostic.

**Evidence:** `corpus/native/stdlib-bench-fn`.
