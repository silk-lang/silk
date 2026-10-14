# B8 library and object artifacts: WIP checkpoint (never merge)

Branch `wip/selfhost-native-artifacts-object-checkpoint` holds two commits on top of
`origin/selfhost` 4f8adda92 (#1678):

1. **"Build native relocatable objects without an entry point"**: the finished `--emit object`
   change (PR1). It is ready for review apart from the pending checks below. Its commit message
   is the intended PR title and body.
2. **"WIP checkpoint (never merge)"**: the unfinished `--emit static-library` work (PR2), stacked
   on PR1, plus this file. None of it has been compiled yet.

To publish PR1, branch from commit 1 (`git checkout -b selfhost-native-artifacts-object <sha of
commit 1>`), rebase it onto the latest `origin/selfhost`, finish the checks and open the PR.
PR2 continues from commit 2 once PR1 has merged. Delete `WIP-PROGRESS.md` from that branch first.

## PR1: `--emit object` (commit 1)

What it does:

- `silkc build --emit object` sets the profile artifact to `object` and compiles a relocatable
  object. The host restriction applies only to `executable`, so cross-target objects are allowed.
- `ModuleSources.make` takes a new `executable: bool`. Only an executable takes the catalog
  runtime and catalog storage component, which matches TS `ArtifactComposition.defaults`.
- A `[build].composition` with an absent or empty `defaults` selects no runtime for a
  non-executable form. An executable still refuses it with `InvalidBuildComposition`.
  `ModuleSources.runtime()` now returns `Option<&ModuleId>`.
- `Semantic.buildRuntime` is renamed `Semantic.buildArtifact` and takes `runtime:
  Option<&ModuleId>`.
  - With no runtime, the application's C exports are the only roots, and there may be none,
    which gives an empty artifact (ARTIFACT-003).
  - If there is neither a runtime nor an application, it calls `CompilerBug.panic`.
- `compileIr(kind, relocation, …)` handles the object form:
  - Clang gets `--target=<triple>`, because the native IR names no triple, plus `-fPIC`, or
    `-fno-pic` when the profile relocation is `static`.
  - With no declared inputs, it compiles with `-c`, so no linker is needed.
  - With inputs, it uses `-r -nostdlib` to merge declared `object` and `static-archive` inputs.
    Any other input fails `InvalidNativeLinkInput` before Clang runs.
  - The object form adds no `-lc`/`-lm`.
  - New helper: `NativeLinkInput.relocatable`.
- Cases in `compiler/src/semantic/SemanticLoweringCases.silk`:
  - `runtimeRootClaims` covers runtime-less roots and the empty artifact.
  - `compositionClaims` covers the empty or absent default selecting no runtime for a library, the
    executable refusal, and no catalog runtime for a library.
  - New helpers `selectedRuntime` and `runtimeless`.
- `compiler/scripts/test-native-build.ts` now runs these checks, in addition to the existing ones:
  - an object build;
  - `llvm-readobj` and `llvm-nm` claims: relocatable, `silk_answer` defined, no `main`;
  - linking with a separately compiled C caller and running it;
  - merging a declared object input;
  - refusing a library input;
  - a cross-target object.
- The `.github/workflows/selfhost.yml` native-n1 job gets a new step that runs
  `test-native-build.ts` on N1.
- Docs:
  - The `COMPILER_COMPATIBILITY.md` entry "Selfhost selects runtimes from defaults only" is
    updated, along with the selector paragraph near line 50.
  - The `compiler/README.md` build-invocation paragraph and the catalog-runtime sentence are
    updated.
  - `PAPERCUTS.md` gets one entry.

### Bootstrap-input (main-first) check: done

`.github/scripts/check-selfhost-bootstrap.mjs` guards these paths:

- `packages/`;
- top-level `scripts/` and `config/`;
- `.github/actions/setup-linux-llvm/` and `.github/actions/download-bootstrap/`;
- two `.github/scripts` bundle scripts;
- four named `compiler/scripts` files (`CorpusVerification.ts`, `FormatterVerification.ts`,
  `runSelfhostCorpus.ts`, `runSelfhostCorpus.test.ts`);
- the root package and lock files.

Neither `.github/workflows/selfhost.yml` nor `compiler/scripts/test-native-build.ts` is guarded,
so both stay in the selfhost PR. No main PR is needed.

### Doc edits that belong to B8

- `compiler/docs/native-borrow-checking.md`, `compiler/docs/loaded-declaration-checking.md` and
  `compiler/docs/incremental-architecture-v2.md` change only `buildRuntime` to `buildArtifact`.
  The function was renamed, so keep these edits.
- `COMPILER_COMPATIBILITY.md` and `compiler/README.md`, as described above.
- The `PAPERCUTS.md` entry (session restarts kill background jobs).

### Checks

Already passed on the pre-rebase tree, before #1672 to #1678. All runs were on aarch64 Linux with
a native compiler self-built from this tree by the prebuilt `silkc-2d109766`:

- the self-build itself;
- `node compiler/scripts/test-native-build.ts <silkc> <clang>`;
- `SemanticLoweringCases` with `--filter Runtime`: 5/5 pass, including
  `selectedRuntimeExportsAreTheBuildRoots` and `buildsSelectExactlyOneRuntime`.

Still pending on the rebased commit:

1. A native self-build of `compiler/src/main.silk`.
2. `SemanticLoweringCases --filter Runtime` (rerun).
3. `SemanticConformanceCases --filter ependenc`, which matches the three tests whose
   `buildArtifact` call changed.
4. `StrictInventoryCases`, unfiltered.
5. A native build of `compiler/src/diagnostic_main.silk`.
6. `test-native-build.ts` again. Upstream #1672 added a `silkc run` section, and the conflict was
   resolved by keeping both sections.
7. **The TS bootstrap check**. The bootstrap DDC rejects source it cannot compile, and
   OWN0012/OWN0019 have bitten another agent:
   `pnpm --filter @silklang/cli... run build`, then `(cd compiler && NODE_OPTIONS=--max-old-space-size=12288 node ../packages/cli/dist/bin.js check --manifest-path silk.toml --target x86_64-unknown-linux-gnu)`.
   This check has never completed: it was killed twice by session restarts or memory pressure.
8. Then:
   - push and open the PR, with the attribution footer;
   - run `gh workflow run selfhost.yml --ref <branch>` and wait for the run to pass;
   - rebase if needed;
   - merge with `gh pr merge --merge`.

   The guard rules out a main PR.

## PR2: `--emit static-library` (commit 2, uncompiled)

- `BuildOutput.StaticLibrary` maps to profile `static-archive`, with `--emit static-library`
  (the TS manifest spelling). Cross-target builds are allowed.
- `compileIr` steps for a static library:
  1. Compile with `-c --target -fPIC` into `<output>.silkc.o`.
  2. Remove any stale `<output>`.
  3. Run `<archiver> rcsD <output> <output>.silkc.o <declared object inputs>`. Any other declared
     input, including `static-archive`, fails `InvalidNativeLinkInput`, as in TS
     `ToolchainPlan.nativeCommand`.
  4. The release step removes both the `.silkc.ll` and `.silkc.o` intermediates.
- New helper `submitted(process)` runs one tool and forwards its stderr.
- `NativeToolchain.archiver()` uses `SILKC_AR`, or else `llvm-ar` beside the configured Clang
  (`SILKC_CLANG`, defaulting to `/usr/bin/clang`). The request carries no environment.
  `clangPath()` was factored out of `request()`.
- Case `nativeArchiverRequestsFollowTheConfiguredToolchain` in
  `compiler/src/driver/NativeToolchainCases.silk`.
- `test-native-build.ts` static-library section:
  - the archive member list;
  - a C consumer;
  - stale-member removal on rebuild;
  - nested archive refusal;
  - a failing archiver leaves no archive or intermediate;
  - a cross-target archive.
- The README and COMPILER_COMPATIBILITY text is updated, which leaves "the shared library form is
  not yet native".
- Next: compile it, run `NativeToolchainCases` and `test-native-build.ts`, run the TS bootstrap
  check, then open the PR.

## PR3: `--emit shared-library` (not started)

- Profile `loadable-module`, host target only.
- Linux: `clang -shared -fPIC`.
- Darwin: `-dynamiclib -Wl,-install_name,@rpath/<basename>`.
- Inputs as for an executable, plus `-lc -lm`.
- Emit non-exported definitions as `define hidden`, so the shared object exports only the C
  exports, matching TS `NativeDeclare` visibility. The only IR assertion this affects is the new
  one in `runtimeRootClaims`, which looks for `define i32 @silk_`.

## Conformance evidence

The PR1 build compiled each fixture with `--emit object` on aarch64 Linux and linked it with its C
receiver. Each package was `src/Main.silk` plus a minimal `silk.toml`; layout-dependent receivers
had `layout.c` prepended, as in their `run.mjs`.

- **Build, link and return 42:** standard-streams, native-clocks, native-entropy,
  native-filesystem, native-filesystem/trust-fixture, native-host-input, native-process
  fixture/fault/child-fault, native-report fixture and observer-cancel.
  - The standard-streams object's undefined symbols are exactly `__errno_location`, `read` and
    `write`, as the TS harness expects.
  - native-filesystem, native-report/context and observer-cancel need
    `[build].composition = { components = [execution-storage bindings to silk/execution_storage] }`
    with no runtime, as their `run.mjs` declares.
- **native-boundary:** builds; the receiver returns 0.
- **artifact-roots/application:** builds an empty object. That harness needs composition
  `retention`, which is not native.
- **native-report/context:** builds and links, but exits 80. This is a naming finding, not an
  artifact defect: native renders the module as `root` (the last path segment), while the receiver
  expects `report-conformance/root.Secondary`.
- **Blocked by other tickets:**
  - foreign-contracts: `c-abi-aggregate`/ForeignAggregate gap (B6).
  - native-assembly/arm64: `foreign-contract` gap.
  - native-report observer and observer-suspended: `observer-callback` gap (B9).

## Recreating the local scripts (they were in /tmp/b8/build)

Use the LLVM 22.1.8 `bin` directory on `PATH`, `SILKC_CLANG` pointing at its `clang`, and the
seed `silkc-2d109766` or the pinned seed as N0. Run one self-build at a time; each takes about
8 to 20 minutes and 10.5 GB.

- `selfbuild.sh <worktree> <out>`:

  ```sh
  cd "$1" && "$N0" build "$1/compiler/src/main.silk" -o "$2" \
    --stdlib "$1/packages/compiler/stdlib" --optimization speed
  ```

- `cases.sh <worktree> <silkc> <root> <filter> <out>`:

  ```sh
  "$silkc" test "$root" -o "$out" --stdlib "$worktree/packages/compiler/stdlib" \
    --no-cache --filter "$filter"
  ```

  Per PAPERCUTS, run it from the repository root with root paths like
  `compiler/src/semantic/SemanticLoweringCases.silk`.
- Conformance probe: copy `packages/compiler/conformance/<x>/<fixture>.silk` to
  `src/Main.silk`, add `silk.toml` (`[package] name = "conf"`, `root = "src/Main.silk"`), then:

  ```sh
  silkc build src/Main.silk -o fixture.o --emit object --stdlib <stdlib>
  clang -O0 -g [layout.c +] receiver.c fixture.o -o run
  ```

  Run `./run` in an empty directory.

## Open questions for Julia

- `--emit` mixes forms with one stage (`llvm-ir` always shows the executable form's IR). The
  reference (ARTIFACT-001) separates form and stage. Should native grow a separate stage selector
  so that, for example, an object's LLVM IR can be inspected, or read `[build].artifact` and
  `[build].stage` from the manifest as the TS project workflow does? The current `--emit`
  spellings match the TS manifest spellings.
- Profile `runtime = none` / named runtime requests and composition `retention` are still
  bootstrap-only (B7 territory). The artifact-roots conformance needs retention.
