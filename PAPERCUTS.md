# Papercuts

Format: date · symptom · fix · project. Check here first when tooling is slow or fails mysteriously.

- 2026-09-28 · The shared checkout's CLI dependency links pointed into another unit's worktree and became dangling during parallel setup · Run frontend checks with the intact main checkout's CLI, then build and test from an isolated worktree after acquiring the shared build slot · self-hosted compiler
- 2026-09-28 · Importing the large semantic test root for a few target assertions exhausted a 6 GiB frontend heap before diagnostics · Keep these independent target assertions in a small focused root and run that root directly · self-hosted compiler
- 2026-09-28 · Codebase-memory indexing failed with "a pre-coordination or unverified CBM generation is active" in both the shared checkout and an isolated worktree · Read the worker log, then use scoped `rg` until the index service can coordinate · self-hosted compiler

- 2026-09-28 · `silk format --check` reported only PAR0001/PAR0002 for a damaged large source file, without a location; a one-line `match` in an added test hid the actual parse failure · Slice the new test into temporary complete source prefixes and format-check each to locate the first invalid statement; write match arms on separate lines · self-hosted compiler

- 2026-09-26 · The combined M1 native test root reached JavaScript heap OOM in focused CI before any case ran, and `--filter` could not reduce compilation because it selects only at runtime · Run the query/source-index root and semantic root sequentially in the same job; all 27 cases pass uncached within the existing heap limit · self-hosted compiler

- 2026-09-26 · A focused `Shared.with` assertion over optional generic-kind details passed source
  checking but failed during LLVM emission · Store the diagnostic's kind fields directly and inspect
  them with a named predicate; the focused native case then passed · self-hosted compiler

- 2026-09-25 · Concurrent `pnpm exec` typechecks each triggered dependency auto-repair and raced
  on a hoisted `node_modules` symlink · Invoke the prepared `node_modules/.bin` binaries directly
  for focused checks and avoid parallel pnpm entry points · compiler
- 2026-09-25 · A cached native acceptance object kept failing after an ownership fix because it
  reused a stale binary · Disable the artifact cache for the focused compiler-lowering regression
  so it compiles the current compiler code · compiler
- 2026-09-25 · `silk format` rewrote hundreds of unrelated lines in touched HIR files, and even
  the unchanged HEAD copy of Hir.silk failed its check · Keep the scoped source diff, verify
  temporary formatted copies against the tested build, and use Oxfmt for CI-covered files · compiler
- 2026-09-25 · Two `silk test --filter` calls for the same source-written HIR root each rebuilt its
  native test executable for several minutes · Select related cases in one run when the filter
  permits, then build the normal compiler once for corpus checks · self-hosted compiler
- 2026-09-25 · A focused source-written query test used `--file`, but the CLI still compiled the
  manifest root and its full import graph for over two minutes · Use `--root src/semantic/QueryCases.silk`
  to compile only the test module's import graph · self-hosted compiler
- 2026-09-25 · A generic scoped query answer passed `silk check` but native build failed with
  `SEM0138` for shared allocation provenance, then tried to emit cleanup for a generic payload ·
  Trace the recorded execution edges through the bracket callback and generate shared cleanup
  only for concrete runtime payloads · compiler bootstrap

- 2026-09-23 · A fresh task checkout had no `node_modules`; offline pnpm install missed cached
  tarballs and sandboxed registry requests failed DNS resolution, then focused Vitest could not
  import `ToolchainIntegrity.generated.js` · Run the lockfile install with approved network access
  and `pnpm --filter @silklang/compiler toolchain:generate` before focused checks · compiler

- 2026-09-23 · A delegated worktree had only a partial `node_modules`; `pnpm exec` automatically
  attempted a full install and stalled on unavailable npm registry DNS · Stop the retry, use the
  prepared main checkout's dependency links and binaries for focused checks, and pass Vitest
  `--configLoader runner` to avoid writes through a read-only dependency link · compiler

- 2026-09-19 · Ran the whole `packages/compiler` vitest suite (about 230 files, 25–40 min locally;
  each `ModuleVerification` shard alone is about 10 min) after every change and as the harness for
  a temporary probe, which cost hours · Typecheck, then run only the test files that exercise the
  change (`CI=true ../../node_modules/.bin/vitest run test/A.test.ts test/B.test.ts`); to learn
  which files matter, grep the tests or run a probe once and keep the list of files it flagged. Run
  the full suite once per milestone and on CI, which shards it four ways and is faster than a
  laptop · compiler
- 2026-09-19 · A full run left going in the background while editing mixed old and new code,
  because each worker loads whatever is on disk when its file starts, so the result proved nothing
  · Never edit under a running suite; stop it first · compiler
- 2026-09-19 · `pkill -f "vitest run"` left worker processes alive that kept writing output ·
  `pkill -f vitest`, then check `ps aux | grep -c "[v]itest"` is 0 · compiler
- 2026-09-19 · `ScannerDeterminism`, `ConditionalConformanceDeterminism` and the `StdlibResolution`
  byte-identity test fail with `ERR_MODULE_NOT_FOUND` for `dist/*.js`; `lsp`/`docgen`/`cli` tests
  fail to resolve `@silklang/*` · Build first:
  `CI=true node scripts/turbo.mjs run build --filter=@silklang/lsp...` · compiler, lsp
- 2026-09-19 · Three `ModuleVerification` cases fail locally with "Missing planned place" ·
  Identical on `main` locally and green on CI; not a regression, do not chase · compiler
- 2026-09-20 · `pnpm --filter @silklang/compiler exec tsx -e` could not load compiler sources
  because the workspace LLVM package did not expose `@silklang/llvm/ByteString` · Use focused
  Vitest fixtures, which build workspace dependencies correctly, for runtime inspection · silk
- 2026-09-20 · Documentation checking hit Node's 4 GB heap after the first target profile because
  the async loop retained the previous whole-project analysis frame · Isolate each profile analysis
  in a helper so only its detached documentation model survives the iteration · compiler
- 2026-09-20 · Running `pnpm --filter` in a detached comparison worktree with symlinked
  `node_modules` tried to replace the modules directory and aborted without a TTY · Invoke the
  primary worktree's `node_modules/.bin/vitest` directly from the comparison package directory ·
  compiler
- 2026-09-21 · The `silk-work` workflow's `superset mcp` transport was unavailable on PATH while
  claiming JUL-209 · Use the connected Linear MCP tools directly and preserve the same admission,
  evidence and reread gates · silk
- 2026-09-21 · Compiler typecheck produced hundreds of misleading missing `@silklang/llvm/*`
  errors in a fresh worktree · Build `@silklang/llvm` once before the focused compiler typecheck ·
  compiler
- 2026-09-21 · Native CLI tests failed with `Unknown attribute kind (102)` because `/usr/bin/clang`
  17 could not read LLVM 22 bitcode · Run native CLI checks with
  `PATH=/opt/homebrew/opt/llvm/bin:$PATH` so the compiler and Clang use the same LLVM generation ·
  cli
- 2026-09-21 · An effect test that locally provided a service failed native emission with an
  unresolved downstream `completeTest` continuation, matching the open generic bracket-runner
  defect · Exercise the closed Effect from a normal test until that separate compiler change lands
  · compiler
- 2026-09-21 · Local `pnpm release:candidate` could not install offline consumers because the pnpm
  metadata mirror lacked unrelated package records · Use exact CI for the full release-candidate
  gate; locally verify that changed export assertions advance past manifest validation · repository
- 2026-09-21 · A zsh test wrapper assigned to the readonly `status` parameter after the test had
  already run · Use a task-specific exit variable or avoid capturing the status when inspecting a
  redirected log · repository
- 2026-09-21 · A temporary comparison-worktree command was rejected because it began with
  `rm -rf` cleanup · Use a unique temporary path and add the worktree directly · repository
- 2026-09-22 · Indexing the current Superset workspace with codebase-memory failed because a
  pre-coordination or unverified generation was active · Inspect the worker log to confirm the
  guard, leave the unrelated indexer alone, and use direct read-only source inspection · silk
- 2026-09-22 · Vitest tried to bundle a temporary config beneath a read-only dependency symlink and
  failed with `EPERM` in `node_modules/.vite-temp` · Pass `--configLoader runner` when using a
  workspace-local temporary Vitest config · cli
- 2026-09-22 · The compiler documentation check could not start in a focused workspace because
  `@silklang/docgen` had neither its workspace dependencies nor a complete build · Run the check in
  a prepared checkout with the docgen dependency graph built first · compiler, docs
- 2026-09-22 · A fresh codebase-memory index for the task worktree refused to start because a
  pre-coordination or unverified CBM generation was active · Reuse the indexed main Silk checkout
  for structural discovery and use targeted filesystem inspection only for uncovered task-local or
  ignored files · repository
- 2026-09-22 · A `cd` into a temporary probe project reset the shell cwd, and every following
  `pnpm exec silk` call failed with `MODULE_NOT_FOUND` before running · Keep the shell in the
  repository root and address probe projects only through `--manifest-path` · repository
- 2026-09-22 · A large union failed to parse with a misleading `Expected }` at an unrelated later
  variant because one field was named after the contextual keyword `role`; keyword fields such as
  `type` and `unsafe` reported clearly, but `role` did not · Check a new field name against the
  `TokenKind` keyword list before debugging the enclosing declaration · compiler
- 2026-09-22 · A lowering test asserted zero generic parameters because its fixture source named the
  function `run`, a keyword; the parser recovered the whole signature into a flat run of `Error`
  nodes, so the failure surfaced as a wrong count far from the cause rather than as a syntax error ·
  Dump a new fixture with `silk-compiler <file>` before asserting against it, and check fixture
  identifiers against the `TokenKind` keyword list · compiler
- 2026-09-23 · Starting an authorized merge in a linked worktree failed because the sandbox could
  not create the shared Git worktree's `ORIG_HEAD.lock` · Retry the exact scoped merge with approved
  Git metadata access instead of changing branches or bypassing the worktree · repository
- 2026-09-23 · A focused formatter/linter command used repository-root paths after changing its cwd
  to `packages/compiler`, so formatting matched no files and the package-local binary path was
  wrong · Keep the repository root as cwd for root-relative file lists and tool binaries · compiler
- 2026-09-23 · `pnpm exec silk` in a worktree ran the _main checkout's_ CLI: the globally installed
  `silk` shim execs a hard-coded `/Users/.../Documents/dev.nosync/silk/packages/cli/dist/bin.js`, so
  a compiler fix committed only in the worktree was invisible and `silk test` reproduced a bootstrap
  blowup the worktree had already fixed; every self-hosted figure taken this way is a measurement of
  the wrong compiler · Build locally with
  `CI=true node scripts/turbo.mjs run build --filter=@silklang/cli --filter=@silklang/compiler`, then
  run `node packages/cli/dist/bin.js <check|test|build> --manifest-path compiler/silk.toml`, and
  state which binary produced any self-hosted figure · repository
- 2026-09-23 · A bare `{ ... }` block inside a function body is not a nested block: the grammar reads
  the brace as a nominal record literal, so a shadowing fixture silently became a
  `StructLiteralExpression` with a missing type · Use a construct that owns its block (`if true { }`,
  `while`, `unsafe`) when a fixture needs a nested scope · compiler
- 2026-09-23 · `silk format --manifest-path compiler/silk.toml` reformatted every reachable source
  file, not just the ones the task touched, so a task diff suddenly contained unrelated parser and
  HIR churn; reverting it with `git checkout --` then also discarded the task's own edits to the
  same files · Do not run the project formatter on a task branch; if it is run, restore the
  unrelated files individually and re-apply the task edits from the change set · repository
- 2026-09-23 · `match value { true => ..., false => ... }` on a `bool` is `SEM0044 Match does not
cover bool` plus a parse error on each arm: `true` and `false` are not patterns, so the arms read
  as binding identifiers · Use an `if` with a `mut` local; `match` is for unions and enums only ·
  compiler
- 2026-09-23 · A Codex model that works from the shell fails through Intent delegation with
  `invalid params: Could not apply Codex model 'gpt-6-sol': JSON-RPC error -32602`, because two
  different Codex clients are involved: the shell CLI is `codex-cli 0.156.1` at
  `/opt/homebrew/bin/codex`, while Intent routes through the ChatGPT desktop app's embedded
  `Codex Framework.framework` (`client_version: 0.153.4` in `~/.codex/models_cache.json`), and the
  backend serves that older client a model list omitting newly released slugs, so Intent rejects the
  model before it reaches the API; delegation also returns `ok: true` and fails only after the agent
  starts, so an unsupported slug looks like a successful delegation · Update the ChatGPT desktop app
  (`npm install -g @openai/codex@latest` upgrades a binary Intent never invokes), and pass effort as
  the separate `reasoningEffort` argument (`sol-high` is not a model name) · repository
- 2026-09-23 · `pnpm --filter ... exec vitest` tried to reinstall and purge the existing dependency
  tree in a non-TTY session, aborting before a focused test could run · Invoke the already-installed
  `node_modules/.bin/vitest` directly for focused compiler checks · compiler
- 2026-09-23 · Native acceptance reached `ArtifactCache.set` but failed with `EPERM` because its
  default cache writes under `~/.cache`, outside this worktree's writable sandbox · Set
  `SILK_NATIVE_CACHE_DIR` to a dedicated directory under `/private/tmp` for local tests · compiler
- 2026-09-23 · A focused native test reported an ownership error at a source offset that did not
  match the current `format.silk`; the compiler loaded an older embedded copy from
  `Stdlib.generated.ts` · Run `node scripts/generate-stdlib.mjs` in `packages/compiler` after
  editing stdlib Silk before interpreting diagnostic offsets or runtime results · compiler
- 2026-09-23 · Documentation generation passed policy checks but silently omitted newly registered
  stdlib pages because `generate-documentation.mjs` read the built compiler's older manifest · Run
  `node_modules/.bin/tsc -p packages/compiler/tsconfig.json` after changing the manifest, then
  regenerate documentation and check that the new pages exist · compiler
- 2026-09-23 · A fresh silk worktree has no `node_modules`, and after `pnpm install` the compiler
  test files still fail to import: first `Cannot find module './ToolchainIntegrity.generated.js'`,
  then `Cannot find package '@silklang/llvm/ByteString'` · Run `CI=true pnpm install` with
  `--frozen-lockfile`, then run all three generator scripts from `packages/compiler`
  (`generate-unicode-tables.mjs`, `generate-stdlib.mjs`, `generate-toolchain-integrity.mjs`), then
  build the LLVM package with `turbo run build --filter @silklang/llvm` · compiler
- 2026-09-23 · `MirVerification` emits the same `InvalidCallableOperation` rule tag for both the
  `MakeCallable` and the `ApplyCallable` blocks, so a violation report alone does not say which
  operation failed and sends debugging to the wrong code · Read the violation's `detail` string,
  not the `rule`: "callable construction disagrees ..." is `MakeCallable`, "callable application
  disagrees ..." is `ApplyCallable` · compiler
- 2026-09-23 · Focused Vitest matched an untracked `.pnpm-store/v11/projects` duplicate of the
  compiler suite and failed after the intended JSON case passed · Exclude `.pnpm-store/**` from
  focused Vitest runs until the store is outside test discovery · compiler
- 2026-09-23 · `pnpm lint` aborted before reading any source with "The `options.denyWarnings` option
  is only supported in the root config", failing `validate` CI and the docs preview; the culprit was
  a generated `.oxlintrc.json` under the git-tracked `.pnpm-store/` cache, not the root config ·
  Gitignore and untrack `/.pnpm-store/` (`275516ad`); on any oxlint _configuration_ error, search for
  stray `.oxlintrc.json` under cache or vendored directories first · repository
- 2026-09-23 · `ws.git.commit` silently restaged an ignored cache file that had just been removed
  from the index, so the commit still contained it · Use `git rm --cached` plus `git commit --amend`,
  and verify with `git status` after any commit that removes a path from the index · repository
- 2026-09-23 · The fresh-snapshot determinism canary timed out at 30s after stdlib growth, with no
  indication whether cost or output changed · A focused run passed all assertions in 86.4s with a
  120s limit; its three full snapshots scale with the stdlib's 167 modules · compiler
- 2026-09-23 · In a shared checkout, a peer's `ws.git.commit({files: [...]})` naming `corpus.ts`
  staged the WHOLE file, sweeping ~180 lines of my uncommitted work in that same file into their
  task-scoped commit; separately my `format.silk` was reverted to base in the working tree and had
  to be recovered · An explicit `files` allowlist stages whole files, never just your own hunks, so
  two agents with uncommitted edits in one file cannot both commit cleanly. Keep an out-of-tree
  copy (`cp x /tmp/x.mine`) before running anything that touches shared state, and commit your own
  scope the moment it passes instead of batching it behind further verification · compiler
- 2026-09-23 · A fresh `intent` worktree had no `node_modules`, so both the workspace and the
  primary checkout's `vitest` failed to resolve `effect` · Run `pnpm install --frozen-lockfile` in
  the worktree once; the symlink trick from the older papercut does not resolve workspace packages
  · repository
- 2026-09-23 · Blamed a failing `StdlibResolution` closure assertion on a peer's concurrent edit by
  reverting only my own file and seeing it still fail; the real cause was a list already stale at
  the base commit, and reverting one of two concurrent changes never tests a clean base · To
  attribute a failure in a shared checkout, check out the BASE commit's inputs, `rm -rf
packages/compiler/dist`, and rebuild with `turbo run build --force` (a plain build hits the
  cache); and verify the causal chain you are claiming rather than concluding by elimination —
  `option.silk` has no imports, so the chain I asserted could not have existed · compiler
- 2026-09-23 · Reported a branch as "pushed at HEAD" after a co-agent committed to the same shared
  checkout; their commit was local only, so the reported head did not contain the fix it was
  credited with, and a conflicted PR meant no CI existed to expose the gap · In a shared checkout
  never infer push state from your own last push: check `git rev-list --left-right --count
HEAD...@{u}` before reporting a head, and confirm each claimed deliverable against `origin/<branch>`
  with `git show origin/<branch>:<path>` rather than the working tree · repository
- 2026-09-23 · Checking `.git/MERGE_HEAD` in a worktree falsely suggested that merge state had
  disappeared, because `.git` is a pointer file there · Resolve the Git directory with
  `git rev-parse --git-dir`, or check the state directly with `git rev-parse --verify MERGE_HEAD`
  · repository
- 2026-09-23 · `pnpm --filter @silklang/compiler exec vitest` tried to purge `node_modules`
  during a dependency-status check and aborted without a TTY before the focused test began · Run
  `../../node_modules/.bin/vitest` from `packages/compiler` when dependencies are already present
  · compiler
- 2026-09-23 · Compiler test shards 3 and 4 each carried 57 files, yet ran 10m21s and 20m46s;
  shard 4 timed out eight tests · File count is a poor cost proxy: keep per-test timing artifacts
  and rebalance the shards using measured work · compiler
- 2026-09-23 · The delegated worktree had no `node_modules`; offline pnpm install lacked cached Changesets packages and online install retried unreachable npm DNS · Reuse the prepared main checkout's dependency links for focused local compiler checks · compiler
- 2026-09-23 · Codebase memory refused to index this Intent worktree because an unverified generation held its coordination lock · Use the existing indexed Silk checkout to locate symbols, then verify source in the active worktree · compiler
- 2026-09-23 · A Turbo compiler build invoked pnpm's dependency repair, retried unreachable registry URLs, and recreated `node_modules` after a successful install · Restore dependencies with `CI=true pnpm install --frozen-lockfile`, then run the needed generator, focused Vitest files, and direct `tsc` checks · compiler
- 2026-09-23 · `git restore` could not create this Intent worktree's Git index lock under the read-only linked Git directory · For a generated file changed only by this session, restore its exact committed bytes with `git show HEAD:<path> > <path>` · repository
- 2026-09-23 · The focused native JSON corpus case failed at `NativeToolchain.ArtifactCache.set` using the default in-memory cache, before program execution · Set `SILK_NATIVE_CACHE_DIR` to a writable `/tmp` directory for that focused run; the same case passed · compiler
- 2026-09-23 · A filtered `pnpm exec vitest list` probe unexpectedly started recreating root
  `node_modules`, then registry DNS failures left `.bin` missing · Stop the install, move the
  incomplete directory aside, link the prepared main checkout's `node_modules`, and invoke its
  binaries directly for focused local checks · compiler CI
- 2026-09-23 · The codebase-memory index worker refused this worktree because another generation
  was active, so graph discovery could not start · Inspect its log, then use targeted source reads
  for the workflow and report script until indexing is available · compiler CI
- 2026-09-23 · Focused Oxlint on script paths passed, but CI's full type-aware lint found floating
  Node test promises and direct process environment reads · Await Node test registrations, pass
  the GitHub summary path as an argument, and verify against full-root lint when dependencies are
  complete · compiler CI
- 2026-09-23 · After the interrupted install was cleaned up, worktree Oxlint could not resolve its
  preset, while main-checkout Oxlint treated the worktree config as a nested root config · Confirm
  both lockfiles and Oxlint configs match, then lint the changed absolute paths from the prepared
  checkout with `--disable-nested-config` · compiler CI
- 2026-09-24 · `rtk vitest --version` produced no output and stalled during a focused merge check ·
  Stop that probe and invoke the prepared `node_modules/.bin/vitest` directly · compiler
- 2026-09-24 · Focused TOML tests appeared to ignore recent Silk source edits because the compiler reads generated embedded stdlib text · Run `node packages/compiler/scripts/generate-stdlib.mjs` after each stdlib edit before testing · compiler
- 2026-09-24 · `pnpm exec vitest` in the TOML task worktree retried unreachable registry downloads and left only a partial `node_modules` · Stop the repair, link the prepared main checkout dependencies, and invoke its Vitest binary directly · compiler
- 2026-09-24 · Linked dependencies in a TOML task checkout changed while focused checks ran, leaving `effect` and `typescript` links broken; an offline install lacked a cached tarball · Run a lockfile-frozen install with network access in the task checkout before documentation and Vitest checks · compiler
- 2026-09-25 · PR #510 CI stopped in the docs font build before compiler checks, leaving the compiler head unverified · Keep focused native evidence separate while the coordinator diagnoses and retries the docs gate · compiler CI
- 2026-09-25 · A native `Query<Word, Vector<Option<Bytes>>, NoRejection>` fixture failed LLVM cleanup before tests, while either container alone passed · The scoped bootstrap repair at 4087d5e restored nested Drop resolution and independently passed the unchanged repro · compiler
- 2026-09-25 · A recursive semantic Query provider calling the Query-backed SourceIndex failed with `SEM0053` during native emission, although direct recursive source demands passed · The scoped bootstrap repair at c4f09312 separated finite callable provider targets in specialization ancestry · compiler
- 2026-09-25 · A borrowed `Shared.with` callback returning `false` from a union match reached LLVM as an `EnvironmentBorrow<bool>` pointer literal · The scoped bootstrap repair at f846dfc5 made non-consuming reads supply scalar builtin values while retaining the borrow · compiler
- 2026-09-25 · `silk doc` for the compiler project stops at unchanged `src/main.silk:1:1` with `SEM0176 ModuleSelection.profile` during static evaluation · Use focused source check and formatter evidence for the new semantic API, and report the documentation-generation limit · compiler docs
- 2026-09-25 · `rtk oxlint` was unavailable during the nested cleanup seed repair · Invoke the prepared `node_modules/.bin/oxlint` for scoped lint · compiler
- 2026-09-25 · Full `SemanticCases` native emission spent about six minutes restarting finite instance discovery after a cleanup-path repair · Validate small structural cases first, then run the full consumer once after source checks · compiler
- 2026-09-25 · A parked allocator in a nested semantic cancellation fixture kept the bootstrap frontend busy for more than six minutes without reaching one native test · Isolate the fixture and use a bounded compiler sample before deciding whether the test shape is practical · compiler
- 2026-09-25 · Importing the full HIR case module into the combined M1 semantic test root exhausted Node's default heap before any test ran · Keep semantic cases in one native entry and run the existing integer HIR cases as a separate filtered root · self-hosted compiler

- 2026-09-25 · Cached CLI output failed before source checking with `Flag.string is not a function` · Force the checkout-local CLI dependency build with `CI=true node scripts/turbo.mjs run build --filter=@silklang/cli... --force` · self-hosted compiler
- 2026-09-25 · Replacing `Type.Primitive {name: Bytes}` with an enum-backed `{kind: Primitive}` made the unchanged M1 runner fail with `Backend error: LLVM emission failed for silk/test_runner` at base `d2b6d3ac8e9ce7b9dba5324fe51b8b9f7b17b03a` (bootstrap `NativePlace.ts` last changed at `079be1100f0a6293c2bc7eedc4add7b40f04a10d`); command: `NODE_OPTIONS=--max-old-space-size=6144 node packages/cli/dist/bin.js test --manifest-path compiler/silk.toml --root src/M1Cases.silk --filter reusesUnrelatedRevisionAndInvalidatesImportedHeader --no-cache`. This is the smallest recorded failing change, not a reduced minimal repro · Restore validated byte-backed primitive identity and compare exact contents; the same command passes 1/1. Coordinate a separate current-main emitter repair if an enum layout becomes necessary · self-hosted compiler
- 2026-09-25 · A traced `silk test` on `compiler/silk.toml` reported "Cannot run compiled test program" because a concurrent benchmark ran `rm -rf compiler/build`, deleting `compiler/build/test` mid-run · Serialize heavy builds with `lockf` on one lock file and delete only `compiler/build/llvm` between plain-build benchmarks · compiler perf
- 2026-09-25 · Wall-clock timings of the self-hosted build swung 62s–115s while other agents and apps loaded the machine · Compare `instructions retired` from `/usr/bin/time -l` and CPU-profile shares instead of wall time · compiler perf
- 2026-09-25 · A focused M2 body test spent about ten minutes compiling before one assertion ran; the parser's zero-width generated unit return then looked like an explicit return to the checker · Inspect the retained HIR with the existing native inspector, handle the generated return as fallthrough, and run the full discovery-root body filter once for final evidence · self-hosted compiler
- 2026-09-25 · The codebase-memory index for this Intent checkout refused to start while another generation was active · Read the worker log, then inspect only the current branch's relevant source and reference files · self-hosted compiler
- 2026-09-26 · A large chained native body assertion crashed during answer cleanup even though each condition passed separately · Evaluate the source, event, and request claims as named values before the assertion · self-hosted compiler
- 2026-09-26 · Failed body-reuse validation left observations in the running frame, so fallback re-demanded the same shared observation and hit the shared-access trap · Replace the validation frame before normal body checking · self-hosted compiler
- 2026-09-26 · The combined M2 body cases trap in native `Vector<SignatureDependency>` cleanup although each edited-source case passes alone; temporary stage writes make the pair pass, while explicit handle drops shift the trap to the first case · Keep the two-case repro and diagnose generated ownership from fresh main before accepting the PR head · self-hosted compiler
- 2026-09-26 · A compiled Silk test binary run directly with a captured `--silk-test-plan` exited 2 silently because `/tmp` paths are symlinks the runner's `OsFileSystem` rejects · Pass `/private/tmp/...` plan and result paths; direct runs then give a seconds-long loop for flaky native traps · compiler
- 2026-09-26 · lldb address breakpoints (`-a`) on the large debug test binary stayed unresolved and batch `-C` command output was silent · Break by full symbol name from `nm` and log with a `breakpoint command add -F` Python callback writing to a file · compiler
- 2026-09-26 · `silk check --manifest-path compiler/silk.toml` passed while the test root rejected a borrow from a temporary `Vector.asSlice(...)[at]` place in a test-reachable helper · Bind the slice before borrowing its element, then run the focused native test root as the ownership check · self-hosted compiler
- 2026-09-26 · Direct `==` comparison of HIR `Access`/`Multiplicity` enums in the expanded `Type.equals` made native emission fail with `Backend cannot resolve call target Type.equals` before a focused semantic test ran · Compare the enum variants with explicit matches; a minimal Type actor probe and the semantic root then emit successfully · self-hosted compiler
- 2026-09-26 · A nested borrowed-union match in nominal generic argument validation emitted LLVM instructions that did not dominate their uses · Split binder-kind and argument-kind inspection into separate simple matches before native compilation · self-hosted compiler
- 2026-09-26 · A signature naming the same imported type twice (`fn t(a: &Clock, b: &Clock)` with `import services { Clock }`) trapped in `silk/shared.conflict`; a local type repeated the same way passed · `appendObservation` borrowed the incoming `Shared<Observation>` while comparing it with the frame's copy of that same handle from the first merge; compare handles by address first (as `Type.sameShared` does). Found by staging one probe demand per test so the runner's printed test name located the trap · self-hosted compiler
- 2026-09-26 · Native test helpers with a closure inside another closure fail with `SEM0199 Anonymous callable bodies cannot be nested`, and `service`/`role` are keywords that cannot be field names · Use one closure level and pass captured values to named helper functions; name fields `capability`/`roleType` · self-hosted compiler
- 2026-09-26 · Adding a `Vector<Shared<Lifetime>>` reachable from `Type` (an environment intersection) failed the semantic root with `SEM0053 Recursive specialization changes type arguments from drop@impl#0<Shared<Lifetime>> to releaseFull<Shared<Lifetime>>` at `silk/vector.silk:558`, with no pointer to the user code; `Type` already drops `Vector<Shared<Type>>` in the same recursion · Wrap the element in a struct (`Intersection.members: Vector<Member>`); moving the vector behind `Shared` did not help. Bisect by frontend-only runs (`timeout 90`), about 40 s each · self-hosted compiler
- 2026-09-27 · A native semantic test trapped with "fatal trap: division by zero" although no index was out of range; lldb (`lldb -b -o "process attach --name silk-compiler --waitfor" -o continue -k "thread backtrace -c 60"` while the CLI runs the cached test) showed `silk/shared.conflict`: `Shared.with` is an exclusive runtime borrow, and two type handles compared by nested `Shared.with` were the same cached identity allocation · Compare handle addresses first and only nest `Shared.with` on distinct allocations · self-hosted compiler
- 2026-09-27 · `impl Copy for SealedProperty {}` on a scalar enum failed with `SEM0083`, and `property == found` on an enum inside an `effect fn` failed bootstrap lowering with `GeneratedEffectRunnerLoweringError ... EnumEquality` · A scalar enum is already Copy, so delete the impl; compare enums with an explicit `match` in a plain helper function · self-hosted compiler
- 2026-09-27 · The codebase-memory index refused the new M2 inference worktree while another unverified generation was active · Read its worker log, then use targeted source reads until indexing becomes available · self-hosted compiler
- 2026-09-27 · Generic-call source changes compiled only after CI exposed nested pattern names colliding with outer bindings and a borrowed Vector slice held across Vector.set · Give nested bindings distinct names and clone a slot through a helper before mutating the vector · self-hosted compiler
- 2026-09-27 · The bootstrap parser treated `let filled = ordinal < count` as a generic actor path and reported a cascade of unrelated type errors · Initialize the flag, then set it inside `if ordinal < count` until comparison expressions in initializers are supported · self-hosted compiler
- 2026-09-27 · `silk test` chose Apple clang for LLVM 22 bitcode and failed with unknown attribute kind 102 after a long compile · Prefix PATH with `/opt/homebrew/opt/llvm/bin` for the CLI run · compiler
- 2026-09-27 · `/usr/bin/time -l` stripped `DYLD_INSERT_LIBRARIES`, so a purported Guard Malloc pass lacked the GuardMalloc banner · Run the native binary directly with the Guard Malloc environment and verify its banner · compiler
- 2026-09-27 · A fresh isolated self-hosted worktree had neither dependencies nor the built CLI, so its first focused check could not start · Install from the lockfile with Node 24 and build `@silklang/cli...` in that worktree before checking · self-hosted compiler
- 2026-09-27 · Two focused `SemanticCases` compilations overlapped because a queued build-slot message had not reached the other agent before its run began · Stop the later local run and pass the slot explicitly before retrying · self-hosted compiler
- 2026-09-27 · `silk check` passed the compiler manifest while a new `SemanticCases`-only proof query still had ownership and parser errors · Treat the focused semantic test root (locally or in CI) as the compile gate for test-only code · self-hosted compiler
- 2026-09-27 · Resolving a written implementation header directly from a public proof call underflowed `demandChild` because no query owner was active · Resolve substituted bounds in a goal-keyed semantic query so source dependencies have an active parent · self-hosted compiler
- 2026-09-27 · Redirecting `rtk git diff` saved a compressed display rather than an applicable patch when temporarily clearing a witness fixture · Save a source copy before clearing temporary work · self-hosted compiler
- 2026-09-27 · A witness lent-lifetime escape check silently missed the lifetime because `Type.occurrences` counts type and row parameters only · Use `Type.collectOwned` when checking owned lifetime use inside a type · self-hosted compiler
- 2026-09-27 · A build-slot command ran cleanup after `mkdir` failed and could remove another agent's lock, allowing heavy native compiles to overlap · Put build and cleanup inside the successful `if mkdir` branch; a busy branch only reads the owner and exits · self-hosted compiler
- 2026-09-27 · `silk check --root` failed immediately because `check` has no root selector · Use `silk test --root` for a focused source module compile · self-hosted compiler
- 2026-09-27 · The shared build-slot directory disappeared and was reacquired while earlier native compilations were still running, allowing three memory-heavy roots to overlap · Stop only the later process without running its stale lock cleanup, inspect live compiler processes as well as the lock owner, and coordinate retries after the slot is truly idle · self-hosted compiler
- 2026-09-27 · The build-slot owner changed while a focused compiler process was still alive, so heavy runs overlapped · Kill only the orphaned run and verify lock ownership before releasing a slot · self-hosted compiler
- 2026-09-27 · Passing a mutable semantic Resolver into body checking failed OWN0010/OWN0011 because the HIR view was borrowed from Resolver.source · Prepare owned declaration facts, then read HIR through an authenticated zero-copy cursor during mutable semantic demands · self-hosted compiler
- 2026-09-28 · An interrupted focused compile killed its shell before the acquired build-slot cleanup, leaving an owner file with a dead PID · Verify the owner and all compiler children have exited before removing only that stale lock · self-hosted compiler
- 2026-09-28 · Homebrew's `node@24` path resolved to Node 26 during a fixed-heap native run and it exhausted 6144 MiB before useful results · Prepend mise Node `/Users/juliaortiz/.local/share/mise/installs/node/24.18.1/bin` and LLVM 22, then print both versions inside the acquired build-slot wrapper · self-hosted compiler
- 2026-09-28 · A focused native check exited immediately because `silk test src/semantic/Semantic.silk` treats the path as an unexpected positional argument · Use `silk test --root src/semantic/Semantic.silk` · self-hosted compiler
- 2026-09-28 · The assumed `/opt/homebrew/opt/node@24/bin` resolves to Node 26.5; even the verified project Node 24.18.1 and LLVM 22 full SemanticCases root exhausted the approved 6144 MiB local heap · Print both tool versions before heavy runs, use cheaper focused checks locally, and rely on exact-head Linux CI for the full root without raising the heap · self-hosted compiler
- 2026-09-28 · Interval-based heap samplers reported a 3.8 GB peak, but the SemanticCases compile still ran out of memory at 4608 MiB. Instance discovery runs synchronously for minutes, so timers never fired while a transient 2.8 GB memo map lived · Force GCs at probes called from inside the work loop (or use `--heapsnapshot-near-heap-limit`), never timer samples · compiler memory
- 2026-09-28 · Codebase Memory indexing refused this checkout while another unverified generation was active · Use targeted source searches until the index is available · compiler
- 2026-09-28 · A native acceptance fixture added to `corpus` was silently skipped by `DriverNativeAcceptance` · Add native-only cases to `nativeCorpus` and select them with `SILK_NATIVE_CORPUS_CASES` · compiler
- 2026-09-28 · Orca worktree commands could not read runtime metadata while the app was unavailable · Use an isolated plain Git worktree and the workspace commit helper, then resume Orca workflows when its app is running · self-hosted compiler
- 2026-09-28 · A native run after merging selfhost reproduced a fixed enum call-target failure because `packages/compiler/dist` still contained the older bootstrap · Rebuild the CLI and compiler dependency outputs after selfhost changes to `packages/compiler` before native runs · self-hosted compiler
- 2026-09-28 · U7 codebase-memory indexing could not start because another generation held the coordination lock · Use scoped source reads while the graph worker is occupied and retry once it clears · self-hosted compiler
- 2026-09-28 · Concurrent M2.4 agents initially edited one shared checkout and switched its branch during another unit's work · Move each unit's exact patch into its own named git worktree and reverse-apply only its own hunks in the shared checkout · self-hosted compiler
- 2026-09-28 · U7's focused `SemanticCases` root exhausted Node 24's default 4 GiB heap after five minutes despite prior U7 cases and exact-head CI passing · Use smaller local roots where possible and exact-head Focused Linux CI for the full semantic root, per the existing 6144 MiB heap guard · self-hosted compiler
- 2026-09-28 · Parallel M2.4 agents shared one checkout, so a branch switch collided with another unit's edits · Move each unit to its own Git worktree and register the secondary root for attributed commits · self-hosted compiler
- 2026-09-28 · `silk format` on touched legacy semantic files rewrote thousands of unrelated lines · Format new actor modules only; keep legacy-file edits narrow until those files are formatted separately · self-hosted compiler
- 2026-09-28 · An isolated U5 worktree lacked dependencies and built outputs, and the shared CLI output could not resolve `@effect/platform-node` · Release the local build slot and use focused PR CI until the worktree has its own dependencies and rebuilt outputs · self-hosted compiler
- 2026-09-28 · A shared-value operator compiled in isolation but CI rejected its nested anonymous callback with SEM0199 · Move the inner Shared.with callback into a named helper and exercise the SemanticCases root in CI · self-hosted compiler
- 2026-09-28 · A static control test failed as `Unavailable` because semicolons in its inline Silk fixture lowered to `ErrorStatement` nodes · Remove semicolons and assert zero source diagnostics before evaluating fixture behavior · self-hosted compiler
- 2026-09-29 · A selfhost-only corpus runner placed under `packages/compiler/test` failed the main-first provenance guard even though it was test support · Keep backend-specific runner code under `compiler/scripts` and import the existing pinned corpus from there · self-hosted compiler
- 2026-09-29 · A focused native SemanticCases run spent minutes compiling, then Apple system clang rejected LLVM 22 bitcode with `Unknown attribute kind (102)` · Put `/opt/homebrew/opt/llvm/bin` first on `PATH` before the CLI test so its object stage uses LLVM 22 clang · self-hosted compiler
- 2026-09-29 · The workspace commit helper refused a resolved merge whose tree matched HEAD because no files were staged · Complete that empty merge with `git commit` after confirming the merge has no conflicts or staged changes · self-hosted compiler
- 2026-09-29 · A focused native SemanticCases build consumed one CPU and about 5.5 GiB for seven hours without output, holding the shared build slot · Stop the stalled process, release the slot, and use exact-head Linux CI for the diagnostic instead · self-hosted compiler

- 2026-09-29 · Concurrent full-manifest bootstrap checks exhausted the five-minute cap without diagnostics on the 32 GB Mac · Hold `/private/tmp/silk-build-slot.lock` with an owner marker for local checks; when busy, skip the concurrent check and use exact-head Linux CI as instructed by the coordinator · self-hosted backend
- 2026-09-29 · The B6 full-manifest bootstrap check aborted at the default 4 GiB heap, and verified Node 24.18.1 with 6144 MiB reached the five-minute cap without diagnostics · The coordinator disabled local bootstrap checks after matching failures across agents; push and use exact-head Linux CI without holding the build slot · self-hosted backend
- 2026-09-29 · The workspace commit helper rejected an explicit file list during a clean main merge as a partial merge commit · Stage the task changes with git add, then call ws.git.commit with userRequested and no files list to complete the staged merge checkpoint · self-hosted backend
- 2026-09-29 · Corepack-backed pnpm install in a new backend worktree stayed silent on this Mac · Reuse an existing locked worktree's dependency directories and rebuild the isolated TS CLI outputs with verified Node 24; do not copy native outputs · self-hosted compiler

- 2026-09-29 · An expanded C ABI assertion expected fneg for signed float literals, but HIR stores those literals as signed constants, causing a CI-only failure · Assert the exact emitted f32/f64 argument constants and keep foreign-header scans off ordinary signature queries · self-hosted backend

- 2026-09-29 · A MIR assertion counted unique extern declarations even though repeated calls retain separate foreign edges · Assert foreign edge presence and an empty runtime-body worklist; declaration deduplication happens at final emission · self-hosted backend
- 2026-09-29 · An inline effectful tuple copy inside a nested match argument reported PAR0001 in Linux CI even after simplifying its call · Use a statement-block arm with an explicit enclosing return, and verify the replacement head in CI · self-hosted compiler

- 2026-09-29 · A direct-call test passed all assertions but exceeded the 1 s CI gate after B6 added repeated declaration/header queries and whole-source unsafe-prefix scans to ordinary calls · Retain foreign facts on the resolved call target and direct-prefix evidence during the existing syntax traversal; verify timing in exact-head Linux CI without dropping assertions · self-hosted backend
