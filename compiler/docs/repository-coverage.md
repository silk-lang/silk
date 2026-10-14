# Native repository program coverage

The `repository-coverage` job in `selfhost.yml` measures programs outside the native acceptance
corpus on selfhost pushes and pull requests. It downloads the existing `native-n1` job's N1,
verifies its SHA-256, and compiles one program at a time with `--emit llvm-ir`. It neither builds
another compiler nor links or executes the programs. The aggregate Linux gate and seed publication
require this job; the existing same-tree green-run reuse also covers it.

## Discovery

`compiler/scripts/RepositoryCoverage.ts` starts with `git ls-files -z -- '*.silk'`. Its rules are:

- Materialize `nativeCorpus` from the consuming checkout with esbuild, without building or running
  the TypeScript compiler. Exclude sources whose SHA-256 matches a corpus source after trimming
  outer whitespace. This also discovers dynamically loaded corpus fixtures and example manifests.
- Include every remaining `packages/compiler/conformance/**/*.silk`, including library fixtures
  without `main`. Their rejection is useful coverage evidence for missing artifact output modes.
- Include other tracked sources with an exported top-level `pub fn main` or `pub effect fn main`.
  Recognition masks comments and quoted literals and tracks declaration brace depth. Support
  modules and analysis/parser fixtures without such an entry are excluded with a reason.
- Extract each active flat `silk` code fence from `///` and `//!` comments in
  `packages/compiler/stdlib/**/*.silk`. Backtick and tilde delimiters are supported. `silk ignore`
  opts out; unknown attributes, broken fences, and nested Markdown fences fail discovery rather
  than silently losing coverage. Compile the complete authored fence body, without a wrapper.
  IDs use the source path and active-example ordinal (`#doc-1`, etc.), so moving an example's line
  does not remove its pin.

Explicit non-program exclusions are retained in the receipt with a reason:

- `packages/compiler/test/goldens/canonical.silk`: virtual `Core.*` canonicalization input.
- `packages/compiler/test/fixtures/complete-interface-contracts/provider-equality.silk`:
  analysis-only fixture with a private `main`.
- `openspec/**`, including `captured-resource.silk`: archived evidence.
- `compiler/src/**`: compiler implementation and source cases, covered by the self-build and
  native-cases jobs.
- `compiler/fixtures/**`: lexer/parser input and the separately gated stdlib-root fixture.
- `compiler/docs/**`: compiler design probes.
- Stdlib modules themselves: library source reached through builds; their doc programs are
  measured separately.

Each entry builds as a synthetic package in a scoped temporary copy of tracked Silk sources.
Sibling modules keep their paths, and `--stdlib` selects this checkout's standard library. The
manifest supplies only the package name and entry. This measures the native CLI's default hosted
Linux build profile, not each fixture's TypeScript conformance harness: raw Linux requires the
unavailable `libc = none` / `raw_start` profile selection, library-only fixtures require object or
library output, and ARM64 assembly may be rejected under the x86-64 host target. These outcomes
remain observations, not failures of their separate conformance contracts.

## Outcomes and pins

Every discovered program has one outcome:

- `PASS`: exit 0, emitted IR, and no failure receipts.
- `UNSUPPORTED`: exit 2 and nonempty `SILK_UNSUPPORTED_JSON` gap codes on stderr.
- `REJECTED`: exit 1 and `SILK_BUILD_ERROR` diagnostic codes on stderr. Multiple diagnostics are
  deduplicated; any accompanying unsupported gaps are retained too.

Missing or malformed receipts, contradictory exit statuses, missing successful output, signals,
and per-program timeouts fail the job. Non-passing programs with valid receipts are recorded.
`compiler/scripts/repository-coverage-track.json` pins passing IDs. A pinned entry that stops
passing or disappears fails the job. New programs are discovered automatically; review and pin
new passes when updating the baseline.

The `selfhost-repository-coverage` artifact contains `receipt.json` (source commit, compiler hash,
outcomes, exclusions, regressions, and totals), `baseline.md`, and indexed stdout/stderr logs in
the same order as the outcomes. The complete table is also written to the job summary.

Run a sweep with:

```sh
node compiler/scripts/RepositoryCoverage.ts /absolute/path/to/N1 .scratch/repository-coverage
```

To measure a proposed baseline, append `--baseline`. This writes a candidate `track.json` in the
output directory and leaves the committed pins unchanged. Review the complete receipt before
updating pins; preserve existing passing promises.

The initial baseline measured with the green N1 from run `38503532693` (identical compiler and
stdlib sources to selfhost `3b9756af1d3ba4413ebf5cdd781dffa06ae10a43`) has 118 programs: 95 PASS,
3 UNSUPPORTED, and 20 REJECTED. All 74 active stdlib documentation examples pass. The complete
table and formatter parity findings are recorded in the introducing PR.
