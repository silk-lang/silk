# #1665 NonParking proof — WIP progress (self-contained)

Issue: https://github.com/silk-lang/silk/issues/1665 (read the body, the revised design comment and Julia's
decisions comment). Julia's decisions: no over-approximating interim (never refuse e.g. a `main` that nests a
transfer); two PRs in order; SEM0139 (`RejectionCode.UnsatisfiedExecutableProperty`) is the existing code, no new
codes; compare every rejected program's code+span with the bootstrap; compile-time verdicts only, never run
executables of rejected programs; full native corpus on PR2's head; independent adversarial review before merging
PR2; PR2 says "Fixes #1665". Coordinator: a reached instance whose argument is not exact gets SEM0139 as the
bootstrap does, never a silent accept. Keep new compiler code within what the TS bootstrap accepts (another DDC
failed on OWN0012/OWN0019): run the TS check below before dispatching the DDC.

## Branches

- `selfhost-nonparking-summary` (PR1), commit "Record external parks beside suspension boundaries in native MIR",
  on top of selfhost 3a8ae4877. Code complete; NOT yet validated (the Case run and TS check were interrupted by
  session restarts). No PR opened yet.
- `selfhost-nonparking-proof` (PR2), WIP checkpoint commit on top of PR1. Never merge as-is.

## PR1: what it does (no verdict change)

- `compiler/src/backend/Mir.silk`: `MirFunction.parks: Option<Origin>`, set by new `markPark` only in
  `lowerRelinquish` and `lowerCurrent` (beside `markSuspension`). `Effect.suspend` (`RunPlan.Suspend`) marks only
  `suspension`. All MirFunction literals (Mir.silk x3, DropGlue.silk x2, SemanticCaseSupport.silk x1) updated.
- `compiler/src/semantic/Semantic.silk`: `SuspensionSummary.park: Option<Span>` filled from `function.parks`.
- Cases: `fallibleRunsUseFailureEdgesAndOutSlots` in `compiler/src/semantic/SemanticLoweringCases.silk` gains an
  `asks` fixture (`run Intrinsic.executionCurrent()` + `executionNotify`) and asserts: relinquish sets `parks` at
  `run Intrinsic.relinquish`; executionCurrent sets `parks` and `suspension` at the same site; `suspends`
  (suspendEffect) has `suspension` but no `parks`.

### PR1 next actions
1. Run the Case (takes >10 min to compile; run detached with `setsid nohup ... &` since background jobs die on
   session restart):
   `export PATH=<llvm22>/bin:$PATH SILKC_CLANG=<llvm22>/bin/clang;`
   `$SILKC test compiler/src/semantic/SemanticLoweringCases.silk -o .scratch/lowering-tests --stdlib $PWD/packages/compiler/stdlib --no-cache --filter fallibleRunsUseFailureEdgesAndOutSlots`
   ($SILKC = a native compiler from selfhost, e.g. a prebuilt N0; on the VM `/home/julia/silk-tools/silkc-2d109766`).
   If `asks` fails to lower in the static fixture (executionCurrent needs sealed core identities), drop the
   `asks` assertions and keep the relinquish/suspend ones.
2. TS bootstrap check of compiler sources: `pnpm install --frozen-lockfile && pnpm --filter @silklang/cli... run build`
   then `cd compiler && node --max-old-space-size=16384 ../packages/cli/dist/bin.js check --manifest-path silk.toml --target x86_64-unknown-linux-gnu`.
3. Open the PR to `selfhost`, `gh workflow run selfhost.yml --ref selfhost-nonparking-summary`, merge when green.

## Verified bootstrap facts (bootstrap `silk check` on probe packages, 2026-10-14)

- ExternalPark roots are `ExecutionRelinquish` and `ExecutionCurrent`; NestedTransfer is `EffectSuspend`
  (`packages/compiler/src/ExecutableOrigin.ts` ~l.4008, 4536). NonParking forbids only ExternalPark
  (`ExecutableProperty.nonParkingOfSummary`).
- ExternalPark PROPAGATES through `Effect.suspend` (probe `suspendpark` is rejected). So the park closure must
  include calls made inside a Suspend plan; the design comment's "leave Suspend inner calls out" is wrong.
- Generic applications (`ExecutableProperty.violationDiagnostics` → `functionApplications`): every reached instance
  whose own type parameter has `Intrinsic.NonParking` checks the exact argument's summary. Span = the earliest
  incoming call to that instance. A non-exact argument is `Unavailable:exact execution target` → SEM0139. Nominal
  type applications with NonParking params in expression types are checked too (`nominalApplications`).
- Forwarding: a finalizer/release whose type is a NonParking-bounded representation parameter carries the proof
  (`carriesNonParkingProof`, ExecutableOrigin.ts ~4144): no obligation at the intrinsic; the obligation surfaces at
  the instance level, at the user's call (`Effect.ensuringNonParking(...)`, `invoke(application)`).
- Direct `Intrinsic.finalizeEffectNonParking` / `useReleaseNonParking` with a non-carrying argument: obligation at
  that intrinsic call's span (ExecutableOrigin.ts ~4471-4510); unresolvable target → SEM0139.
- Service operations declared `with Intrinsic.nonParking()`: obligation on the provider-selected witness at the
  service call span (ExecutableOrigin.ts ~4779-4789); unresolved provider → SEM0139.
- native_start: `invoke<F: fn<'static>(OsHostInput) -> i32 + Intrinsic.NonParking>(invokeApplication, ...)`
  (`packages/compiler/stdlib/silk/native_start.silk` l.127/135). The bootstrap REJECTS a `main` that parks
  externally, with SEM0139 at `native_start.silk:135:16` (`invoke(invokeApplication, move inputs)`). A `main` that
  only nests a transfer (`Effect.suspend`) is accepted.
- For r1 and r2 the bootstrap reports two SEM0139s: first the user span (r1 `Main.silk:6:35` =
  `Effect.ensuringNonParking(`; r2 `Main.silk:5:31` = `invoke(application)`), then `native_start.silk:135:16`.
  Diagnostics are deduplicated by code+message keeping the earliest span.
- Bootstrap test cases: `packages/compiler/test/Suspendability.test.ts` ~l.761-1060.

## Probe setup (recreate)

Package per probe: directory with `silk.toml`:
```
[package]
name = "probe"
version = "0.1.0"
root = "src/Main.silk"
```
and `src/Main.silk`. Bootstrap verdict: `node <checkout>/packages/cli/dist/bin.js check` in the package dir.
Native verdict: `$SILKC build src/Main.silk -o out.ll --emit llvm-ir --stdlib <checkout>/packages/compiler/stdlib`
(native needs `-o`). Results above: r1 rejected, r2 rejected, mainparks rejected (native_start span only),
mainnests accepted, suspendpark rejected (user span + native_start span). Native (selfhost 2d109766c) accepts all.

r1:
```silk
import silk.effect { Effect }
import silk.execution { Execution, Wake }
fn register(wake: Wake) -> () { drop wake return () }
effect fn protected() -> i32 { return 42 }
effect fn release() -> () { run Execution.park(register) return () }
pub fn main() -> i32 { return run Effect.ensuringNonParking(protected(), release()) }
```
r2:
```silk
import silk.execution { Execution, Wake }
fn register(wake: Wake) -> () { drop wake return () }
fn application() -> i32 { run Execution.park(register) return 42 }
fn invoke<F: fn<'static>() -> i32 + Intrinsic.NonParking>(body: F) -> i32 { return body() }
pub fn main() -> i32 { return invoke(application) }
```
mainparks:
```silk
import silk.execution { Execution, Wake }
fn register(wake: Wake) -> () { drop wake return () }
pub fn main() -> i32 { run Execution.park(register) return 42 }
```
mainnests:
```silk
import silk.effect { Effect }
pub fn main() -> i32 { return run Effect.suspend(effect { return 42 }) }
```
suspendpark:
```silk
import silk.effect { Effect }
import silk.execution { Execution, Wake }
fn register(wake: Wake) -> () { drop wake return () }
effect fn protected() -> i32 { return 42 }
effect fn parks() -> () { run Execution.park(register) return () }
effect fn release() -> () { return run Effect.suspend(parks()) }
pub fn main() -> i32 { return run Effect.ensuringNonParking(protected(), release()) }
```

## Status 2026-10-14 (later session)

- PR1 is #1682 (WIP commit dropped, head 7317a0fe1). Case passed, TS check clean, DDC dispatched (run 38608507335).
- PR2 implemented on this branch (uncommitted pieces committed as a WIP checkpoint): entry obligations from
  `nonParkingSubjects` in lowerMir, `executableTargets` (CallableValue, CallableSchema -> declaration targets,
  composites, joins, views, references), `carriesNonParking` forwarding for Finalize/UseRelease, `closeParking`,
  `nonParkingViolations` (runtime-module sites last), immediate-run references use the call node's origin.
  Probes match the bootstrap (r1 6:35, r2 5:31, native_start 135:16, service 8:45, suspendpark, mainnests and
  calmfinal accepted) except direct intrinsic (native 6:10 at `run`, bootstrap 6:14) and forwarded bounds
  (bootstrap dedups to invoke's parameter anchor 4:11). `unreached` calm target is rejected natively, accepted by
  the bootstrap (Julia's open question). Case `nonParkingBoundsAreProvedAtBuild` passes; full
  SemanticLoweringCases root passed before the main-body edit.
- Next: other Cases roots, full corpus, TS check, compat entry, adversarial review, PR, DDC.

## PR2 design (original) and state

WIP on `selfhost-nonparking-proof` (does not compile yet; untested):
- Mir.silk (done): `NonParkingRun {callees: Vector<InstanceKey>, origin}`; `MirFunction.nonParking: Vector<NonParkingRun>`;
  `CallTarget.nonParking: bool` (service op); `RunPlan.Finalize.owed` and `RunPlan.UseRelease.owed`; `planCallees`
  collects a finalizer step's callees statically from the plan; `oweNonParking` records in `callCallee` and
  `planCall` when the call's `nonParking` is set; owed UseRelease records `[release.key]` (invoking the release runs
  its Effect in the same call); owed Finalize records `planCallees(steps, finalizer)` at the run origin.
- Semantic.silk (partly done): `ResolvedCall`/`MirCallTarget` literals get `nonParking: false`;
  `provideCall` sets `call.nonParking = operationNonParking(operation)` for service witness calls (new helper reads
  the operation header's `with Intrinsic.nonParking()`); `nonParkingProperties` comment updated.
- TODO:
  1. `compositePlan` (Semantic.silk ~55740 UseRelease, ~55816 Finalize): add `owed` = nonParking and no
     `Constraint.Property {subject, NonParking}` of the caller's closed premises (`closedApplicationPremises(caller,
     callerBindings)`) runtime-equals the stored finalizer (part 1) / release (part 2) type. Never unsound: an equal
     premise subject is proven at the instance level against the same concrete type.
  2. `SuspensionSummary`: carry `owed` runs (callee keys + anchored span).
  3. In `buildFrom`'s walk (frames None), for each reached function instance collect instance-level obligations:
     closed body premises (`closedApplicationPremises` with `&mut self.query` and a fresh dependency vector)
     filtered to `Property NonParking` whose unbound subject is a parameter of the instance's own declaration
     (or of an enclosing non-callable owner such as an impl); map the subject type to targets:
     CallableValue{application} → `InstanceKey.function(application)` matched by body declaration + `sameInstance`
     after stripping providers (`InstanceKey.function(InstanceKey.selected(summaryKey))`), with a declaration
     fallback for anonymous closures; EffectComposite → executable parts only (Catch 0,1; Finalize 0,1; UseRelease
     1,2; Bind 0; Observe 1,2; Suspend 0); EffectJoin → alternatives; CallableView/Reference → inner; CallableSchema
     → reached instances of its declaration; any other shape (opaque, contract, unresolved) → Unavailable → SEM0139.
     An exact target that is not reached: reject (SEM0139) unless a cheap MIR mini-walk proves it does not park.
     Span = the bounded instance's `BackendVisit.Enter` span; module = entered module.
  4. After `closeSuspendable` in buildFrom: `closeParking(summaries)` = instances whose `park` is set, closed over
     all direct call edges (`summaryEdges`), including through fixed-linkage shims (conservative). Reject each
     failing obligation with SEM0139; order user-module failures before runtime-module ones; return all.
  5. Update the comment in `proveAppliedBounds` (~65651) — the bound is now proven at build time.
  6. Build-level Cases (precedent: ForeignCallback case in SemanticLoweringCases ~l.2418 using
     `applicationSemantic` + `buildApplication` with the minimal entry runtime; use `Intrinsic.relinquish()` and
     inline generic wrappers instead of stdlib `Execution.park`/`Effect`): both reproductions rejected at the
     bootstrap-equivalent spans; valid controls (nonparking finalizer that does not park; a main/bounded callable
     that nests a transfer) still build; forwarded proof via a wrapper with a NonParking param; direct intrinsic;
     service op with a parking provider rejected and a nonparking one accepted; existing
     `nonParkingFinalizersAreAdmitted` (SemanticCaptureCases ~2344) unchanged.
  7. Docs in the same PR: retire COMPILER_COMPATIBILITY.md "Selfhost admits `Intrinsic.NonParking` bounds without
     proof" (~l.1110); update compiler/README.md l.153-154 sentence citing #1665.
  8. Full native corpus on PR2's head (every program must still build; gap file only via check-borrow-gap.mjs),
     native verdicts for the five probes vs the bootstrap, fresh adversarial reviewer subagent, TS check, DDC.

## Key native locations (selfhost 3a8ae4877)
Semantic.silk: buildFrom ~69214 (build checks after closeSuspendable ~69561), SuspensionSummary ~70134,
closeSuspendable ~70262, proveAppliedBounds ~65622, compositePlan ~55623, provideCall ~56550,
closedApplicationPremises ~72369. Mir.silk: MirFunction ~321, RunPlan ~650, lowerRelinquish/lowerCurrent ~6680,
executePlan ~7588, finalizeOnCancel ~7850.

## Open questions for Julia
- An exact NonParking-bounded argument that is never invoked (target instance unreached): the bootstrap analyzes it
  anyway. Native can reject (SEM0139, may refuse a valid program) or prove it with an extra MIR walk. Proposed:
  extra walk if cheap, else reject.
