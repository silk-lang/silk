# S3 progress: retire `stored-loans` from native borrow checking

Checkpoint note for the A4 / S3 ticket. Delete this file in the final PR of the series.

## Baseline (origin/selfhost `3b9756af1`)

- Corpus (`--mode corpus-full`, this checkout's `corpus.ts`, 423 programs, all pass): matches
  `compiler/borrow-check-gap.txt` exactly: regions 15,889, stored-loans 607, storage 1, imprecise 6.
- Self-build (baseline N1 builds `compiler/src/main.silk --emit llvm-ir`): 9,218 unchecked
  (regions 9,058, stored-loans 160); 78.3 s wall, 3,918,452 KiB peak RSS.

## Step 1: temporary receivers and hidden owners (in flight)

- Branch `claude/vibrant-faraday-0oc1r5` (the session's designated branch; target `selfhost`).
- `BorrowCheck.borrow` no longer leaves for an unrooted borrow. `holdTemporary` evaluates the
  borrowed value into a hidden-owner root (`temporaryRoot`, the subject root space), which holds
  the value's loans and observes its cleanup (`storageNodes` feeds `Semantic.borrowCleanup`).
- The root ends with the innermost statement scope (new `Scope.statement`) or arm scope. A fixed
  array in the initializer of a binding whose type `Type.holdsView` is kept for the binding's
  scope; `Type.holdsView` is Mir's former `borrowingType`, so checker and lowering share one rule.
- Results: probe spans match the bootstrap exactly (`left.*`, `whole.first`, OWN0019); the valid
  controls (statement-scoped receiver view, array temporary) are Checked.
- Self-build with the step-1 compiler: 9,192 unchecked (regions 9,192, stored-loans 0); 67.4 s,
  3,921,440 KiB. No rejection in the compiler source.
- Corpus with the step-1 compiler: 423/423 pass; stored-loans 607 → 520 (the 53 call-result and
  34 temporary borrows), regions 15,889 → 15,927 (every per-program rise is covered by that
  program's stored-loans fall), imprecise and storage unchanged. Gap file updated by `update`.
- Remaining corpus stored-loans: 514 `Execution.make` (`executionFromAllocation`) and 6 retained
  displacements.
- Hidden-owner roots live after the match-subject roots (`temporaryRoot = MAX/4 + nodes + base`)
  so no node can collide; `storageNodes` returns `2 * nodes` holder slots.

## Step 2: package construction contract (in flight)

- Branch `selfhost-stored-loans-s3-execution`, stacked on step 1 (retarget/merge after #1674).
- `executionFromAllocation` is a `contractCall`: it consumes its four operands and its result
  retains only the regions `Intrinsic.Execution<A>` names. Typing now proves `F`, `O` and `R`
  `Intrinsic.Detached` at the call with the body's premises (EXEC-004, `UnsatisfiedExecutableProperty`
  / SEM0139), so the contract is enforced, not trusted. The bootstrap checks the property on each
  reached instance instead; an unreached generic misuse is accepted there and rejected natively.
- A stored (non-immediate) `executionDrive` stays `StoredLoans`: lowering refuses it
  (`GapCode.EffectForm`), so no emitted body has one.
- Probe `.scratch/probe/x1` (generic package with a non-detached readiness state): SEM0139 at the
  intrinsic call. Probe s2's `Execution.make` is now Checked.

## Next action

Finish step 1: corpus run with the step-1 N1, `check-borrow-gap.mjs update`/`diff`, run the
`SemanticCaptureCases` filter `borrowStatusNamesWhatRemains`, adversarial review, open the draft
PR, dispatch `selfhost.yml`. Then step 2 (`executionFromAllocation`/`executionDrive` contract).

## Local tooling

- LLVM 22.1.8 in `.scratch/llvm-22.1.8`; `SILKC_CLANG=.scratch/clang-wrapper` (adds
  `--ld-path=/usr/bin/ld`). Pinned seed in `.scratch/seed/silkc-seed` (sha256 verified).
- Baseline N1: `.scratch/base/N1` (seed-built from origin/selfhost). A branch compiler is built by
  `N1 build compiler/src/main.silk --emit llvm-ir` then `clang -O2 -x ir … -lc -lm`.
- Corpus: `node .github/scripts/bundle-selfhost-verification.mjs` then
  `SILKC=<compiler> node .scratch/selfhost-verification.mjs --mode corpus-full`.
- Bootstrap spans: `.scratch/tools/bootdiag.mjs` (copy into `packages/compiler` to resolve imports).
