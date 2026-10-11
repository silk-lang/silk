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
silkc test <root.silk> [--stdlib <dir>] [--filter <text>] [--file <path>] \
  [--optimization none|speed] [--debug true|false] --no-cache
```

- `<root.silk>` is the discovery root (TEST-003). Its package is found the way `build` finds it:
  the nearest `silk.toml` above the file selects the module directory, its runtime composition and
  its native link inputs. For the compiler, `compiler/src/semantic/TargetCases.silk` is a root of
  package `compiler/silk.toml`, module directory `compiler/src`.
- The executable entry is the bundled runner `silk/test_runner`, an ordinary standard-library module
  (TEST-007). The discovery root is a second root of the same compilation. It need not have `main`.
- `--filter` and `--file` are passed to the runner unchanged (TEST-006). `--file` is normalized to
  the package-relative logical path first, as the bootstrap does.
- `--no-cache` is required for now. Result reuse (TEST-008) needs execution identities that the
  native compiler does not publish yet; without the flag the command reports
  `SILK_GAP test-result-cache` and exits 2 before compiling. When execution identities land, the
  default becomes per-test reuse and the flag keeps its reference meaning.

The command compiles the runner, writes an Uncached plan, runs the executable, admits the receipt
and exits with the runner's status:

1. Build the test application exactly like `build` builds an application, with two differences:
   the semantic request's application module is `silk/test_runner` and it carries the discovery
   root. The executable goes to `<module dir>/../build/test/<target>/<root logical path>`, so a
   shard's roots never overwrite each other.
2. Read the published test catalog from the same semantic store (the discovery answer below) and
   compute the catalog digest: SHA-256 over `u64le ordinal ‖ u64le length ‖ identity bytes` for
   every test in catalog order, the framing `silk/test_exchange` checks.
3. Write the 256-byte Uncached plan (`SLKTPLN1`, version 1, mode 2, a 32-byte nonce read from
   `/dev/urandom`, the digest, the discovered count, zero padding) into a fresh exchange
   directory beside the executable.
4. Run the executable through `silk.child_process` with
   `[--file F] [--filter T] --silk-test-plan <dir>/plan.bin --silk-test-result <dir>/receipt.bin`.
   Its stdout and stderr are copied to the command's stdout and stderr when it exits.
5. Admit the receipt like the bootstrap's `TestExchange.admitReceipt` for an Uncached plan: exactly
   256 bytes, `SLKTRCP1`, version, mode, the plan's nonce, SHA-256 of the plan bytes, the plan's
   discovered count, consistent counts (`cached = 0`, `executed = selected`,
   `passed + failed = selected`), the status that matches `failed`, and zero padding.
6. Remove the exchange directory and exit with the process status: 0 or 1 from an admitted
   receipt; 2 for an operational failure (spawn failure, invalid or missing receipt); the raw
   status for an abnormal exit (a trap or signal). Compile refusals keep `build`'s statuses and
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

### Request and discovery

`Semantic.Request.forTests(application, discoveryRoot)` names the runner as the application and
records the discovery root. The root becomes a request root, so its module and its imports are
loaded and published like the application's, and it can be an import-only file.

A new query family, `Tests`, keyed by the discovery root module, answers the catalog:

1. Walk the root's active imports breadth first, in module logical-path order, visiting each module
   once. Only imports of the selected static arms count (TEST-002, TEST-003).
2. Keep project-owned modules (logical path outside `silk/`; standard-library modules are
   toolchain-owned).
3. In each kept module, take every module-level function whose header has the `test` marker and
   that is a valid test entry (below).
4. Sort by module logical path, name, identity.

Each entry records the declaration identity, the module logical path, the name, the source line
and byte column of the declaration (1-based), the authored fingerprint, and the callable type the
signature query already produces for the function. The catalog's dependency edges are the module
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

New `StaticValue` forms carry the authority: `Test {ty, declaration, authorization}` where the
authorization is the catalog identity, minted only by the catalog provider, like `Field`.

The primitives:

- `tests() -> Tests` is static-only. Static execution asks the `StaticPort` for the catalog of the
  request's discovery root. Without a discovery root it is a static-phase rejection (TEST-004);
  there is no empty default.
- `testInfo<F>(descriptor: Test<F>) -> TestInfo` is static-only and returns an aggregate value.
  Reading `.identity`, `.name` and the other fields in a runtime body embeds the text, the same way
  a reflected field label is embedded today.
- `testFunction<F>(static descriptor: Test<F>) -> F` is mixed-phase, checked like `borrowField`:
  the descriptor is a static slot, authenticated against the catalog, and the result is the test
  function's ordinary callable value (a `CallableValue` with no captures). Calling it is an
  ordinary call of that function. A descriptor from another catalog, or for a declaration that is
  no longer a test, is a static-phase rejection.

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
   (`StaticStepLimit` in `silk/format.silk` template validation). The native limit is 10,000 steps
   per demand graph against the bootstrap's 100,000. Thresholds are compiler policy (reference,
   static evaluation); the native limit moves to the bootstrap's value so a program inside the
   bootstrap's limits is inside the native ones.
3. The discovery intrinsics above.

The test bodies of the compiler's Cases roots are compiler source the native compiler already
builds. As a check, `semantic/TargetCases.silk` with its
`test` markers turned into `pub` and a hand-written `main` calling all 17 tests compiles with N0
in 7 min 19 s at `--optimization none` (almost all of it the front end over the reached compiler
source) and runs. So the shards need the discovery work and the two fixes above, not further
front-end coverage. The native shard's cost is close to a self-build per root; it removes the
TypeScript compiler and its 8 to 12 GiB heap from the job, not the front-end time.

## Tests

Per AGENTS.md, claims are proven at the cheapest tier:

- TEST-001 spans and codes, discovery order and membership, `tests()` without a root, foreign
  descriptors, and the `TestInfo` values: structured analysis assertions in a semantic Cases file,
  with in-memory sources and a discovery root on the request. No process runs.
- The plan encoding and the receipt admission: pure-function cases over bytes in a driver Cases
  file.
- The end-to-end command is exercised by CI itself: a native shard is a complete run whose names,
  results and timings the existing log check reads. No test spawns the compiler.

## CI

The `cases` matrix gains a `native` flag per shard. A native shard needs the N1 executable from the
`native-self-build` job's `selfhost-native-build` artifact and runs:

```sh
"$SILKC" test "$PWD/compiler/src/<root>" --stdlib "$PWD/packages/compiler/stdlib" \
  --optimization speed --no-cache | tee "$log"
node .github/scripts/check-selfhost-test-times.mjs "$log"
```

Paths are absolute because the native CLI refuses non-normalized paths. Bootstrap shards keep the
existing step. The timing guard runs on both.

The switch goes shard by shard, cheapest first: `format-m1-hir` (about 3 minutes on the bootstrap),
then `target`, `callable`, and the six semantic shards. For each switched shard the PR shows the
bootstrap and native logs side by side: the same names in the same order, the same PASS/FAIL per
test, the same summary counts. The shard's first native run executes on the PR as well as on the
push, so the comparison is on the PR's own head. Once every shard is native, the bootstrap step and
the `download-bootstrap` step leave the `cases` job.

The CI change is kept to the `cases` job so it rebases cleanly onto the seed-chain work that
replaces N0 with a pinned native seed: only the artifact name the job downloads would change.
