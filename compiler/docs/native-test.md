# Native `silkc test`

The compiler's own Cases tests run on the TypeScript bootstrap today. Every Cases shard in
`.github/workflows/selfhost.yml` runs `node "$SILK_BOOTSTRAP" test --manifest-path
compiler/silk.toml --root <root> --no-cache`, which compiles the test root with the TypeScript
compiler (7 to 12 minutes and up to 12 GiB of heap per shard). This note describes the native
`test` mode that replaces it: what the CLI does, what the front end needs, how the output keeps
the existing CI checks working, and how CI moves over one shard at a time.

The language contract is the reference chapter [Tests and the source runner](../../apps/docs/content/reference/testing.md)
(TEST-001 to TEST-008). It is prescriptive over both compilers.

## Command

```sh
silkc test <root.silk> -o <executable> [--stdlib <dir>] [--filter <text>] [--file <path>] \
  [--optimization none|speed] [--debug true|false] --no-cache
```

- `<root.silk>` is the discovery root (TEST-003). Its package is found the way `build` finds it:
  the nearest `silk.toml` above the file selects the module directory, its runtime composition and
  its native link inputs. For the compiler, `compiler/src/semantic/TargetCases.silk` is a root of
  package `compiler/silk.toml`, module directory `compiler/src`.
- The executable entry is the bundled runner `silk/test_runner`, an ordinary standard-library module
  (TEST-007). The discovery root is a second root of the same compilation. It need not have `main`.
- `-o` names the runner executable, as for `build`. The plan and receipt are written beside it as
  `<executable>.plan` and `<executable>.receipt` and removed after the run.
- `--filter` and `--file` are passed to the runner unchanged (TEST-006). `--file` takes the
  package-relative logical path the catalog reports, such as `src/semantic/TargetCases.silk`.
- `--no-cache` is required for now. Result reuse (TEST-008) needs execution identities that the
  native compiler does not publish yet; without the flag the command reports
  `SILK_GAP test-result-cache` and exits 2 before compiling. When execution identities land, the
  default becomes per-test reuse and the flag keeps its reference meaning.

The command compiles the runner, writes an Uncached plan, runs the executable, admits the receipt
and exits with the runner's status:

1. Build the test application exactly like `build` builds an application, with two differences:
   the semantic request's application module is `silk/test_runner`, and the store selects the
   source file as its discovery root.
2. Read the published test catalog from the same semantic store (the discovery answer below) and
   compute the catalog digest: SHA-256 over `u64le ordinal ‖ u64le length ‖ identity bytes` for
   every test in catalog order, the framing `silk/test_exchange` checks.
3. Write the 256-byte Uncached plan (`SLKTPLN1`, version 1, mode 2, a 32-byte nonce, the digest,
   the discovered count, zero padding). The nonce only has to differ between runs, so that a stale
   receipt never binds a new plan: it is the SHA-256 of the system clock, the executable path and
   the catalog digest.
4. Run the executable through `silk.child_process` with
   `[--file F] [--filter T] --silk-test-plan <dir>/plan.bin --silk-test-result <dir>/receipt.bin`.
   Its stdout and stderr are copied to the command's stdout and stderr when it exits.
5. Admit the receipt like the bootstrap's `TestExchange.admitReceipt` for an Uncached plan: exactly
   256 bytes, `SLKTRCP1`, version, mode, the plan's nonce, SHA-256 of the plan bytes, the plan's
   discovered count, consistent counts (`cached = 0`, `executed = selected`,
   `passed + failed = selected`), the status that matches `failed`, and zero padding.
6. Remove the plan and receipt and exit with the process status: 0 or 1 from an admitted
   receipt; 2 for an operational failure (an invalid or missing receipt, or the runner's own 2);
   the raw status of any other exit, and 128 plus the signal for a signal. Compile refusals keep `build`'s statuses and
   output: `SILK_BUILD_ERROR=` lines and status 1 for a rejection, `SILK_UNSUPPORTED_JSON=` and
   status 2 for a gap.

The plan and receipt formats are the bootstrap's (`packages/cli/src/TestExchange.ts`); the runner
validates them the same way, so this is a second producer of an existing exchange, not a new one.
The plan is built and the receipt admitted in compiler source (`driver/TestRun.silk`), not by a
script.

## Output and exit-code parity

The runner prints everything the CI log checks read, so parity follows from compiling the same
runner. For each selected test in catalog order:

```text
  semantic/TargetCases::frozenTargetRequiresExplicitSelection
    PASS  412 us
```

then a blank line, `Tests  P passed, F failed (C cached, E executed, S selected, D discovered)` and
`Time   <duration>`. `.github/scripts/check-selfhost-test-times.mjs` matches the name lines and the
`PASS`/`FAIL` timing lines, so it runs unchanged on the native log.

What must match the bootstrap for the same root:

- **Test names.** `{module}::{name}` uses the module's logical path inside the module directory
  without `.silk` (`semantic/TargetCases`), and the declared name.
- **Order.** Catalog order is the bootstrap's: by module logical path, then name, then identity,
  comparing bytes. All three are ASCII in this repository, so byte order and the bootstrap's
  UTF-16 order agree.
- **Discovered set.** Project-owned test declarations in the transitive import closure of the
  root, each once (TEST-003). Standard-library modules are toolchain-owned and never contribute,
  so `silk/test_runner` and `silk/testing` add nothing.
- **Pass/fail and exit status.** Decided by the runner from each test's outcome.

The bootstrap prints one extra line before the runner, `Compiled src/<root> -> build/... (llvm,
<target>, N symbols)`. The native command prints `silkc test: compiled <root> -> <executable>` in
its place. No check reads it.

## Front end

Test discovery is a semantic query, not a driver scan, so the catalog that the driver digests and
the catalog the runner iterates are the same answer.

### Discovery root

`Semantic.selectDiscovery(root, directory)` selects the discovery root of a test build, like
`selectExecutionStorage` selects a composition component: a fixed input of the store. `directory`
is the module directory's path relative to the package manifest (`src`), which prefixes each
test's logical path. The root is the build's entry source, so it and its imports are read and
published like any demanded module, and it can be an import-only file. `Semantic.demandTests`
returns the catalog to the driver.

A new query family, `Tests`, keyed by the discovery root module, answers the catalog:

1. Walk the root's active imports breadth first, in module logical-path order, visiting each module
   once. Only imports of the selected static arms count (TEST-002, TEST-003).
2. Keep project-owned modules (logical path outside `silk/`; standard-library modules are
   toolchain-owned).
3. In each kept module, take every module-level function whose header has the `test` marker and
   that is a valid test entry (below).
4. Sort by module logical path, name, identity.

Each entry records the declaration identity (`project:<module>` and the declaration's owner steps,
such as `project:semantic/TargetCases/function=frozenTargetRequiresExplicitSelection#0`, the
bootstrap's spelling), the module, the name, the package-relative path, the 1-based line and byte
column of the declaration, the authored fingerprint, and the exact callable type of naming the
function as a value. The catalog's identity is a SHA-256 over its entries; descriptors carry it. The catalog's dependency edges are the module
imports and headers it read, so editing a test body leaves the catalog answer valid while editing a
header or an import revalidates it.

### TEST-001

A `test` header is checked in the Signature query, where the qualifiers, binders, parameters and
result are already resolved. An invalid entry is a rejection, `InvalidTestDeclaration`, at the span
the reference names:

| Conflict | Span |
| --- | --- |
| declared in an `impl`, `interface` or `service` (associated) | the `test` qualifier |
| `static` | the `static` qualifier |
| `unsafe` | the `unsafe` qualifier |
| `extern` or `export` linkage | the linkage qualifier |
| generic or lifetime binder | the first binder |
| parameter | the first parameter |
| non-unit success type | the written success type |

The checks run in that order and the first conflict is reported. Anonymous callables cannot carry
the marker; the parser already rejects it there. Today the native compiler marks such a header
unsupported (a gap); the rejection replaces that path. The bootstrap reports SEM0218 at the `test`
qualifier for every case; the reference's spans are the contract, so this is a bootstrap
divergence recorded in `COMPILER_COMPATIBILITY.md`, not something to copy.

A valid test is an ordinary function in an ordinary build (TEST-002): nothing about it changes
when no discovery root is present.

### Intrinsic catalog types and values

The three catalog families `Intrinsic.Tests`, `Intrinsic.Test<F>` and `Intrinsic.TestInfo` are
already listed as known names and currently refused with `CoreTypeUnavailable`. They become
checked intrinsic types next to `Fields` and `Field`:

- `Type.TestCatalog` for `Tests` and `Type.TestDescriptor {callable}` for `Test<F>`, both phase-only
  with no runtime representation.
- `TestInfo` is a compiler-generated struct with the bootstrap's fields in order: `identity`,
  `name`, `module`, `path` (all `string<'static>`), `line`, `column` (`usize`), and `fingerprint`
  (`string<'static>`).

A descriptor is a phase-only aggregate of the sealed `Test<F>` type holding the catalog identity
and the test's ordinal, like the existing `Intrinsic.Type<Owner>` descriptor; a `TestInfo` is an
aggregate of the seven fields. Source cannot construct a sealed family, and `StaticValue` mints
these values only through the discovery constructors, so a descriptor cannot be forged. The
catalog is a `Sequence` at the `Tests` type.

The primitives:

- `tests() -> Tests` is static-only. Static execution asks the `StaticPort` for the catalog of the
  request's discovery root. Without a discovery root it is a static-phase rejection (TEST-004);
  there is no empty default.
- `testInfo<F>(descriptor: Test<F>) -> TestInfo` is static-only and returns an aggregate value.
  Reading `.identity`, `.name` and the other fields in a runtime body embeds the text, the same way
  a reflected field label is embedded today.
- `testFunction<F>(static descriptor: Test<F>) -> F` is mixed-phase, checked like `borrowField`:
  the descriptor is a static slot, authenticated against the catalog, and the result is the test
  function's ordinary callable value: its application, no captures, and a shared contract that
  takes nothing and returns the call's result (the constructed Effect of a `test effect fn`). One
  helper computes this type for both the catalog and the checker, so `Test<F>` and the checked
  value always agree. A descriptor from another catalog is a static-phase rejection.
- A projection rooted at a static-phase call, `Intrinsic.testInfo(descriptor).identity`, is
  evaluated as a whole in a runtime body, as a projection of a static binding already is; only
  the text or position reaches the runtime program.

`static for descriptor in Intrinsic.tests()` uses the existing mixed-body `static for`: the
catalog is a sequence value, each iteration binds one descriptor, and the body is selected once per
test with that test's exact callable type. Nothing else in `static for` changes.

### Other gaps found by building the runner

Building `silk/test_runner.silk` with N0 at `3bad1f1` stops at three places. With the discovery
intrinsics stubbed out and the first two worked around in a copy, the rest of the runner (argument
parsing, the plan and receipt exchange with SHA-256, `OsFileSystem`, the monotonic clock,
`Format.format` with anonymous records, the `CompleteTest` interface over test results) compiles
natively and the stub executable writes a valid receipt for a hand-written plan.

1. `Intrinsic.stringEqualsExact` is an `intrinsic-member` gap. It is a listed catalog member that
   the runner's argument parser uses; it lowers to the existing string equality.
2. `Format.format` with the summary template exhausts the native static step limit
   (`StaticStepLimit` in `silk/format.silk` template validation). The retry that supplies a needed
   constant still stopped at a stale fixed budget of 10,000 steps, while the evaluation it retries
   runs under the 100,000-step limit it shares with the bootstrap. The retry now reads the
   machine's own limit.
3. The discovery intrinsics above.

The stub hid two more limits, because it replaced each `static for` with `if false`. Inside a
`static for` over the catalog the runner borrows its own per-test locals (`&identity`, `&value`,
`&entry`) and outside state (`&mut plan`) in plain calls, and `validatePlan` returns from inside the
loop. The native checker refused both:

4. A loan of storage an occurrence generates was refused outright, because its region is keyed by
   the borrow's syntax, which every occurrence shares. Sharing the key is sound while the loan
   stays inside its occurrence: an occurrence's nodes are checked together, regions select no code,
   and a place declared outside the iteration keeps the region its declaration gave it. The check
   now refuses only a write of such a loan to an outside local or through a dereference.
5. An authored `return` or `fail` inside an occurrence was refused. Both leave the function as they
   do anywhere else; the expansion completes only when every occurrence can. `break` and
   `continue` stay refused: a `static for` is not a runtime loop.

The test bodies of the compiler's Cases roots are compiler source the native compiler already
builds. As a check, `semantic/TargetCases.silk` with its
`test` markers turned into `pub` and a hand-written `main` calling all 17 tests compiles with N0
in 7 min 19 s at `--optimization none` (almost all of it the front end over the reached compiler
source) and runs. So the shards need the discovery work and the fixes above, not further
front-end coverage. The native shard's cost is close to a self-build per root; it removes the
TypeScript compiler and its 8 to 12 GiB heap from the job, not the front-end time.

## Tests

Per AGENTS.md, claims are proven at the cheapest tier:

- TEST-001 spans and codes: the existing contract fixture in `SemanticSignatureCases.silk`.
- Discovery order, membership, entry metadata, refusals, and a body that iterates the catalog,
  reads `TestInfo` and binds each `testFunction`: `TestDiscoveryCases.silk`, imported by the
  static root. In-memory sources, no process runs.
- The end-to-end command is exercised by CI itself: a native shard is a complete run whose names,
  results and timings the existing log check reads. No test spawns the compiler.

## CI

Native shards live in their own `native-cases` matrix. A native shard installs the verified N1
from the `native-n1` job's `selfhost-native-n1` artifact, the compiler the pinned seed builds from
the checkout, and runs:

```sh
"$SILKC" test "$PWD/compiler/src/<root>" -o "$RUNNER_TEMP/<name>-tests" \
  --stdlib "$PWD/packages/compiler/stdlib" --optimization speed --no-cache | tee "$log"
node .github/scripts/check-selfhost-test-times.mjs "$log"
```

Paths are absolute because the native CLI refuses non-normalized paths. Bootstrap shards keep the
existing `cases` step. The timing guard runs on both. `Focused Linux Silk` and the seed candidate
publication both require `native-cases`.

The switch goes shard by shard, cheapest first: `format-m1-hir` (about 3 minutes on the bootstrap),
then `target`, `callable`, and the six semantic shards. A shard moves by leaving the `cases` matrix
for the `native-cases` matrix. For each switched shard the PR shows the bootstrap and native logs
side by side: the same names in the same order, the same PASS/FAIL per test, the same summary
counts. Native shards run on pull requests as well as pushes, so the comparison is on the PR's own
head. Once every shard is native, the `cases` job and its `download-bootstrap` step are deleted.
