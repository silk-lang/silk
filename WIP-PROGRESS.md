# B9: observer traps and failure identity (WIP checkpoint)

Ticket B9 asks for:
- the native fatal line for MIR traps;
- SEM0216 and SEM0217;
- the `observer-callback` and `failure-identity` gaps.

The checkpoint branch `wip/selfhost-native-traps-checkpoint` has one real commit, "Report observed
MIR traps with their reasons", rebased onto origin/selfhost 4f8adda92. A WIP commit on top adds only
this file.

## Item 1: trap fatal line (implemented, verified, not merged)

**State:**
- The same commit is in draft PR https://github.com/silk-lang/silk/pull/1680, branch
  `selfhost-native-traps-1`.
- Main-first companion: https://github.com/silk-lang/silk/pull/1677, branch
  `main-native-traps-fatal-bounds`. Do NOT merge it before #1680. It adds the corpus program
  `native-termination-fatal-bounds`, whose expected stderr is
  `fatal trap: index out of bounds\n  at memory/driver.pick (memory/driver:2:10)\n`. If it syncs
  into selfhost before #1680 merges, the selfhost corpus fails. After the sync, the borrow-gap
  baseline needs `check-borrow-gap.mjs update`.

**What changed:**
- `compiler/src/backend/Mir.silk`: new `TrapReason` enum and `trapReasonText`, using the bootstrap's
  reason strings. `Terminator.Trap {reason, origin}`. `trapHere` records the trap site label, like
  arithmetic traps, then terminates. Every `trapUnless` site passes a reason:
  - index → index out of bounds
  - sliceView → slice range out of bounds
  - bufferRange and the RawBufferCopy supplied length → raw buffer range out of bounds
  - RawBufferFrom → invalid raw buffer layout
  - SharedFromAllocation → invalid shared allocation layout
  - SharedClone → shared count overflow
  - ExecutionFromAllocation → invalid execution allocation layout. This one is native-only: the
    bootstrap emits `unreachable` there.
  - control word → invalid execution control word
  - notify → execution notify after its handle was dropped
  - drive → invalid execution drive
  - relinquish → relinquish outside a running execution
  - executionCurrent → execution reference outside a running execution

  SharedClone now uses a wrapping increment plus a `!= 0` trap, so it no longer reports
  `arithmetic overflow`.
- `compiler/src/backend/LlvmText.silk`: a `Trap` terminator sets `writer.trap = trapReport(...)`,
  calls `reportTrap(reason)` (`silk.diagnostic.fatal`), then emits `llvm.trap`.
- `compiler/src/backend/InstanceRecipe.silk`: encodes the reason code.
- Tests in `compiler/src/semantic/SemanticCallableCases.silk`:
  - `observedTrapsRecordTheirSites` adds a `pick` bounds function and asserts the reason, the label
    `observer-trap.pick (observer-trap:3:59)` and the emitted fatal call with its reason and label
    strings.
  - `storagePrimitivesFollowTheirContracts` asserts the clone, raw-buffer layout and shared-layout
    reasons.
  - The executable-trap test asserts that an unobserved trap emits no `silk.diagnostic.fatal`.
- Docs:
  - `COMPILER_COMPATIBILITY.md`: the entry is renamed "Selfhost checks observations partially" and
    the fatal-trap row is retired.
  - `compiler/docs/failure-observer-and-trace.md` and `effect-calling-convention.md` are updated.

**Verified locally (ARM64):**
- Native `SemanticCallableCases`, all 113 pass, after the rebase onto 4f8adda92. Command:
  `silkc-2d109766 test compiler/src/semantic/SemanticCallableCases.silk -o .scratch/x --stdlib $PWD/packages/compiler/stdlib --no-cache`
- With a self-built N1 (`silkc build compiler/src/main.silk -o .scratch/silkc-next --optimization speed`),
  stderr matches the bootstrap probe byte for byte for:
  - index bounds;
  - `Slice.view` range (`at silk/slice.Slice.view (silk/slice:24:12)`);
  - `RawBuffer.read` index (`silk/raw_buffer:105:21`);
  - `RawBuffer.from` layout (`silk/raw_buffer:78:21`).
- Selfhost corpus subset, 71 programs matching
  `trap|termination|bound|raw-buffer|slice|owned-allocation|execution`: all PASS with N1, before
  the last rebase.

**NOT yet verified:**
- The TS bootstrap check of compiler sources. It was killed twice by session restarts and was
  rerunning at checkpoint time. Run it before the DDC (the brief for avoiding OWN0012/OWN0019 DDC
  failures):
  `pnpm --filter @silklang/cli... run build` (or `CI=true node scripts/turbo.mjs run build --filter=@silklang/cli...`), then
  `(cd compiler && NODE_OPTIONS=--max-old-space-size=12288 node ../packages/cli/dist/bin.js check --manifest-path silk.toml --target x86_64-unknown-linux-gnu)`.
  The new code uses only:
  - a field-less enum;
  - match to byte literals;
  - `if let X {reason: recorded, ..} = &...` binding a Copy enum, compared with `==`;
  - an existing `Effect.result(...)` pattern in tests.
- DDC: `gh workflow run selfhost.yml --ref selfhost-native-traps-1`, then mark #1680 ready and
  merge when it passes.

## Item 2: SEM0216 / SEM0217 (not implemented, by design; question for Julia)

- `COMPILER_COMPATIBILITY.md` ("Selfhost checks observations partially") records them as a
  temporary divergence that retires with the suspension stage's executable-closure summary.
- `compiler/docs/failure-observer-and-trace.md` §9 Q7 recommends recording the divergence rather
  than shipping an approximation. That is a recommendation; Julia has not decided it.
- Bootstrap producers are in `packages/compiler/src/DiagnosticObservation.ts`, using
  `ExecutableOrigin.ts` suspension graph facts:
  - SEM0216 fires when the callback's execution summary is unavailable, has suspension modes, or
    reaches a nested observation. Span: the incoming call to the instance, else the callback
    argument, else the call.
  - SEM0217 fires for an `observeUnhandled` outside every `catchFailure` handler's inherited
    closure. It is suppressed when anything is unresolved.
- Native has no suspension summary. SEM0216's core is the NonParking proof that #1665 owns. Left
  as is.

## Item 3: failure-identity (investigated, not started)

The bootstrap identity is `Type.encode` (`packages/compiler/src/Type.ts:3237`). Native
`identityText` is in `compiler/src/backend/Mir.silk`, near `raise`. Divergences found:
- A string renders as `string` natively and `string<'static>` in the bootstrap. Verified by probe:
  `pub effect fn main() ! string<'static> { fail "boom" }`.
- References and slices: the bootstrap renders `&'static mut T` with the lifetime; native omits it.
- Nominal lifetime arguments: the bootstrap lists them (`Holder<'static>`); native skips them.
  Native also silently skips Row arguments.
- An array is a gap natively; the bootstrap renders `Array<i32, 2>` (verified by probe).
- Pointers: the bootstrap renders `?[*]mut align(N) T`.

Plan:
- Render `'static` lifetimes, arrays, slices and pointers.
- Return false, which keeps the gap, for non-static lifetimes and Row arguments. Bootstrap names
  like `'a` are not recoverable from native `Supplied` lifetimes.
- Keep the gap for anonymous tuples and records, whose bootstrap encoding has a compiler-minted
  hash, and for callables, Effects and foreign functions.
- Prove it with structured MIR context-text assertions in `SemanticCallableCases`, plus one
  main-first corpus program for `string<'static>` and arrays, if wanted.

## Item 4: observer-callback (not started)

The `Semantic.silk` lines near 56230/56257 reject a capturing or indirect callback. The work is to
put callback environments in the observer record (N1). That is larger than local.

## Tools

**Bootstrap probe.** Put this file, untracked, at `packages/compiler/scratchpad/dist/boot.mts`.
Run `pnpm install --frozen-lockfile` and `pnpm --filter @silklang/compiler scratchpad:prepare`
first. Then run, with `SILKC_CLANG=<llvm22>/bin/clang`:
`packages/compiler/node_modules/.bin/tsx scratchpad/dist/boot.mts <dir with memory/driver.silk> <out>`.

```ts
import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Driver from '../../src/Driver.js'
import * as FileSourceResolver from '../../src/FileSourceResolver.js'
import * as NodeHeapObservation from '../../src/NodeHeapObservation.js'
const sourceRoot = process.argv[2] ?? '.'
const destination = process.argv[3] ?? 'program'
const clang = process.env.SILKC_CLANG ?? 'clang'
const program = Effect.gen(function* () {
  const outcome = yield* Driver.compile({
    compilation: { root: 'memory/driver' }, packageName: 'corpus', artifactKind: 'NativeExecutable',
    toolchain: { _tag: 'Toolchain', clang, llvmAr: clang.replace(/clang$/, 'llvm-ar') },
    optimization: 'debug', destination, cache: false, saveTemps: false,
  }).pipe(Effect.provide(FileSourceResolver.layer(FileSourceResolver.make(sourceRoot))))
  if (outcome._tag !== 'Compiled') { yield* Console.log(JSON.stringify(outcome).slice(0, 4000)); return }
  yield* Console.log(`Compiled: ${outcome.path}`)
})
NodeRuntime.runMain(program.pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeHeapObservation.layer))))
```

**Native probe.** Build a package directory with `silk.toml`:
`[package] name = "corpus"`, `root = "main.silk"`, and the program at `memory/driver.silk`. Then
run `silkc build memory/driver.silk -o program --stdlib <repo>/packages/compiler/stdlib`. With that
layout, module names print as `memory/driver`, as the corpus does.

**Corpus subset.** `scratchpad/dist/corpus.mts`:

```ts
import { runCorpus } from '../../../../compiler/scripts/runSelfhostCorpus.js'
import { nativeCorpus } from '../../test/support/corpus.js'
const selected = nativeCorpus.filter((p) => new RegExp(process.argv[3]).test(p.name)).map((p) => p.name)
process.exit(await runCorpus(process.argv[2], nativeCorpus, [], selected, undefined, process.env.SILKC_CLANG, 12))
```

## Status 2026-10-14 (later session)

B9 done: #1680, #1686, #1694 (+ main #1677, #1693) merged; sync #1697 merged.

## D2/D5 (current)

- #1719 main `main-corpus-as-data`: corpus/native/<name>, corpus/invalid/<name>, corpus/corpus.mjs,
  README; corpus.ts thin loader. Outcome dump identical (sha 10bfae09...).
- #1720 main `main-corpus-harness-data` (stacked on #1719): harnesses read corpus/ directly.
- #1721 main `main-selfhost-harness-checkout` (stacked on #1720): formatter reads intrinsic
  inventory fixture (with phase); bundle script `[harness|inventory|all]`, harness has no TS input.
- Worktree /home/user/silk-main.

## Exact next action

1. Watch CI on #1719/#1720/#1721; fix failures.
2. After merge + sync: selfhost PR switching corpus and macOS jobs to
   `pnpm install --frozen-lockfile && node .github/scripts/bundle-selfhost-verification.mjs harness`
   and `node .scratch/selfhost-verification.mjs ...`; the sync must also pass
   `corpus/native/trivial-features/main.silk` as corpus-source in selfhost's selfhost.yml.
3. Then main PR: stop publishing silk-selfhost-verification; drop download-bootstrap verification.
