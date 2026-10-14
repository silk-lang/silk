# R3 phase 1: approved proof interface and amendments

Status: Julia approved the design with five amendments on 2026-10-14. The amendments below qualify the phase counts and cost gate; no production checking verdict changes here. #1654 remains a draft evidence checkpoint and must never be merged. Production branches start from clean `selfhost` and carry no `RegionProbe.silk`, probe output, or analyzer-only metadata.

## Provenance and counting unit

The replay uses `origin/selfhost` `aed79798a2a78d005db2931171ea9cacd12b94d0` with the temporary `wip/selfhost-regions-r3` probe at `9f2914c79a3e1ee743c98c9ea033f89b5585e6d4`. A verified pinned native seed builds the instrumented N1; N1 then produces the self-build and corpus receipts. The probe records each typed checking owner, an exact instance-key MIR mapping, and final emission identity. The emitted census assigns one cause mask per emitted definition, so generic instances are weighted and repeated checking demands are not mistaken for distinct emitted bodies. Masks overlap by cause: 1 relation, 2 capture contents, 4 crossed referent loan, 8 outside-owner atom.

A single declaration owner can have multiple valid receipts under different instantiations. The reader keeps all owner variants and validates each emitted instance's mask against the exact-key mapping; it does not assume one receipt per owner. The self-build also includes the diagnostic probe's own source, so its count is an instrumented measurement, not the production compiler's gap baseline.

## Current replay results and the older handoff figures

The full corpus completed **423 pass, 0 fail, 0 unsupported** (`track` 328). The exact-key emitted-definition census has **15,882** region-deferred definitions, with **zero missing, ambiguous, or zero-mask mappings**. Its disjoint mask distribution is `1:13,631; 2:21; 4:71; 5:432; 8:1,181; 9:514; 13:32`. The four overlapping causes are:

| Cause                                             | Corpus emitted definitions | Instrumented self-build emitted definitions | Corpus distinct per-program checking owners |
| ------------------------------------------------- | -------------------------: | ------------------------------------------: | ------------------------------------------: |
| Retained RegionRelation                           |                     14,609 |                                       7,751 |                                      12,171 |
| Retained Contents                                 |                         21 |                                           0 |                                          11 |
| Crossed referent loan                             |                        535 |                                         401 |                                         344 |
| Outside-owner atom                                |                      1,727 |                                       2,057 |                                       1,344 |
| All region-deferred definitions / checking owners |                 **15,882** |                                   **8,954** |                                  **13,231** |

An emitted definition is identified by the first-profile final emission identity within one corpus program, including generic specialization. The table's first two numeric columns count a cause if its bit is present in that definition's mask, so column cause counts overlap and must not be added. The last column deduplicates checking owner hashes **within each program** and unions masks across that owner's valid instantiation variants; it has a different denominator and cannot be compared as a one-to-one body count. The raw corpus contains 13,276 owner receipts and 13,238 distinct owner-mask variants, versus 13,231 distinct per-program owner hashes; the current analyzer preserves all variants. The 15,882 emitted total and its disjoint mask distribution exactly match the archived #1654 checkpoint. The `algorithm-crc-32` program alone has a 17-definition / 16-body region floor shared by all 423 programs, which helps explain repeated emitted counts. The separate self-build is instrumented by the probe source itself; its 8,954 total is 26 above the archived 8,928 and is **not** evidence of a production checker regression.

The earlier handoff listed 11,887 deferred relation, 1,285 outside-owner, 390 crossed, and 11 contents. It did not specify a denominator, deduplication rule, or provenance for those four numbers. They do not match the archived or current emitted-definition census, the current distinct-owner union, or the raw owner receipts. Contents 11 happens to match owner-level count, but that coincidence cannot validate the other figures. Treat those handoff figures as an unverified preliminary summary, not as an alternate current census or an observed checker regression. The compressed raw receipts, parser, and `current-replay.json` in this folder make the table reproducible.

## Existing boundaries to reuse

`BorrowCheck.check` already builds typed evaluation points and control-flow edges in `Walker`, including normal, branch, loop, return and failure paths. `releaseScopes` records reverse-order cleanup and `Kind.End` events for roots on every outgoing path. The current walk checks conflicts and moved places, and it can report an expired local loan when a live carried or held loan crosses an End event. These points, edges, access origins and End events are the approved interface for R3; a second checking graph would duplicate ordering and risk disagreeing with the existing proof.

Typing retains `SafetyObligation.RegionRelation` with its offered and wanted region and original site, and `SafetyObligation.Contents` for unresolved captured generic contents. `regionClosed` currently prevents a clear walk from becoming Checked when expression or local types contain atoms outside the declaration's own closed set. `Walker.crossed` separately prevents a referent loan that crossed a scope boundary from being called Checked. The four census causes can overlap on a body, so a solver must discharge all remaining causes for that body before it changes its verdict.

## Approved solver contract

1. Read the already typed body, its declared outlives and contents premises, retained safety obligations, and the existing Walker points, edges, loans and End events. Keep the proof inside the body query and leave MIR and `bodyRegions` unchanged.
2. Treat declared lifetime parameters, invocation/environment regions and `'static` as universal terms; local loan regions have requirements at actual use and cleanup points. The source note in `compiler/docs/native-borrow-checking.md` §4.1–4.3 specifies outlives propagation from shorter to longer and a violation when a required point falls outside its available points. The region proof must preserve the distinction between a body-local atom and an enclosing declaration's atom.
3. For a `RegionRelation`, use its original site and the actual region terms rather than the probe's coarse bit pattern. For `Contents`, consult the declared premise and the subject's retained contents. For a crossed referent loan, retain its specific loan, holder and points; the current boolean is only a reason for deferral. Outside-owner atoms follow the explicit rule in amendment 4 below.
4. A definitive expired requirement reports OWN0019 at the reference's compile-time use or retention boundary according to the existing diagnostic parity contract. A valid control may become Checked only after all obligations are discharged. An unresolved or approximate case remains unchecked. No verdict from one body depends on another body's stage.

The approved direction needs no further approval once the amendments and cost gate are resolved. A semantic or cost decision still belongs to Julia. Each production slice needs valid and rejected compile-time controls with exact code/spans, the Cases/corpus/gap gates, and time/peak RSS. Before merging compiler or stdlib changes, dispatch `selfhost.yml` for T1 DDC. Never run executables from rejected Cases. MIR and `bodyRegions` remain unchanged, and unresolved or approximate causes prevent `Checked`.

## Amendment 1: cost gate

The budget in [native-borrow-checking.md §9](../native-borrow-checking.md#9-cost-budget-for-the-self-build) applies to the **whole borrow stage**, not separately to R3: 10% of front-end time (approximately 30 s on the note's original machine) and 524,288 KiB added peak RSS.

The archived `baseline-self-build.time.json` and `probe-self-build.time.json` measure **probe overhead**, with S1/S2 enabled on both sides: wall 108.852 → 120.294 s, user 74.050227 → 79.549391 s, peak 3,659,556 → 3,659,508 KiB. Neither is a borrow-disabled baseline. The current replay's 33.584 s wall / 32.078419 s user / 3,664,848 KiB is instrumented and has no matching clean comparator. Subtracting either comparison from the borrow-stage budget would misstate the remaining share.

The S1 [#1606](https://github.com/silk-lang/silk/pull/1606) receipt has no time/RSS comparison. S2 [#1644](https://github.com/silk-lang/silk/pull/1644) explicitly labels its +3.42% user CPU / +0.42% RSS result historical; its later 33.095 → 31.465 s user / 3,660,990 → 3,660,732 KiB comparison measures only the review fix. These cannot establish the total stage cost on today's head.

A fresh controlled comparison therefore uses clean `selfhost` `3b9756af1d3ba4413ebf5cdd781dffa06ae10a43`, the pinned seed SHA `eef9424329c48ea719a7a008acceac9ceb5ee78fdaa45d5e021411bcb6ea409e`, and two seed-built native producers with identical optimization. The scratch-only [disabled-stage patch](borrow-stage-disabled.patch) removes the two post-typing borrow-stage entry blocks (anonymous and named bodies), including cleanup-summary preparation, the S1/S2 Walker and region-closed fast path. It preserves typing, captures, retained relations and MIR. This measures the **combined current stage**, including S1/S2 and other landed slices, rather than pretending to separate their historical costs. The disabled producer is a measurement tool, never a production compiler or correctness oracle.

Both producers compile the same unmodified clean source, one shot (`Semantic.oneShot`), with `--emit llvm-ir --optimization speed --debug false`; no census recording or concurrent compiler workload runs during samples. Disabled/enabled/enabled/disabled order supplies two independent one-shot samples per side. Native producer construction time is recorded separately and is not charged as stage overhead. The completed measurement and remaining-share decision are recorded below.

[cost-comparison.json](cost-comparison.json) records commands, producer hashes, patch hash and every sample on an Intel Xeon Platinum 8573C (5 logical CPUs), Linux x86_64, clang 22.1.8:

| Borrow stage                                                 | Wall samples (s) | User CPU samples (s) | Peak RSS samples (KiB) |
| ------------------------------------------------------------ | ---------------- | -------------------- | ---------------------- |
| Disabled                                                     | 46.798, 46.526   | 43.301957, 42.903331 | 3,902,980; 3,903,080   |
| Enabled (clean current S1/S2 and other landed borrow slices) | 47.899, 46.946   | 44.359585, 43.601799 | 3,917,188; 3,917,192   |

Median overhead is 0.7605 s wall, 0.878048 s user CPU, and 14,160 KiB RSS. For allocation use the more conservative **maximum enabled minus minimum disabled**: **1.373 s wall, 1.456254 s user CPU, 14,212 KiB (13.879 MiB)**. The pre-clang LLVM-IR endpoint includes Silk analysis/lowering/emission, not external backend optimization/linking; it is the available same-source front-end measurement, not a finer per-query timer. It charges all current post-typing borrow work together. Two samples show variability, not a statistical guarantee.

Apply 10% to this machine's minimum disabled one-shot time, not a portable 30-second allowance: **4.6526 s wall / 4.2903331 s user CPU**. After that conservative stage charge, R3's cumulative remaining share is **3.2796 s wall AND 2.8340791 s user CPU, plus 510,076 KiB (0.486446 GiB) added peak RSS**. The user-CPU charge consumes 33.94% of the measured time allowance; the RSS charge consumes 2.71%. All R3 slices together must remain within that remainder; each PR records its incremental and cumulative cost. Remeasure both producers on the same host/source when the baseline changes. If the stage plus R3 exceeds 10% or 0.5 GiB, fix it before the next slice or return the cost decision to Julia. No cost-versus-soundness tradeoff or larger budget is authorized.

All four outputs are byte-identical LLVM IR, SHA-256 `36b88de9aa6e103b22e6e6bf93ffde974b267c1784ac438b0ac4d81dc39cd68d`. The measurement is not T1 DDC and authorizes no merge. The disabled-stage patch and binaries remain measurement-only; they must never enter a production branch.

## Amendment 2: universal/local split from existing receipts

[relation-split.json](relation-split.json) is reproduced by `python compiler/docs/r3-census-checkpoint/amendments.py`. No new census probe was built. The analyzer associates each contiguous kind-5 relation multiset with its following kind-1 owner receipt, checks its count, and requires every emitted owner/mask to select exactly one relation multiset. It then uses the existing exact-key MIR/emission join and weights each final definition once. This preserves duplicate obligations at a site and avoids deduplicating different instantiations into one body. The original 15,882/8,954 totals and masks remain the baseline.

Probe atom codes are 1 static, 2 own parameter, 4 own local, 8 outside parameter, 16 outside local, 32 invocation, 64 supplied, 128 meet. A relation is universal-only when both endpoints are in `{1,2,8,32}`; either endpoint 4 or 16 makes it local-involving. An environment is classified by its actual region term, not by the word “environment.” A supplied or unexpanded meet would remain unresolved. **There are no such ambiguous endpoints in these receipts.**

| Count, weighted by emitted definition | Corpus universal-only | Corpus local-involving | Self-build universal-only | Self-build local-involving |
| ------------------------------------- | --------------------: | ---------------------: | ------------------------: | -------------------------: |
| Retained RegionRelation obligations   |                    27 |                 44,821 |                         0 |                     26,257 |
| Bodies retaining relations, all masks |                    13 |                 14,596 |                         0 |                      7,751 |
| Relation-only bodies, mask 1          |                    11 |                 13,620 |                         0 |                      6,500 |

For body rows, “local-involving” means at least one relation involves a local; the obligation row counts individual relations. Of the 27 universal obligations, 26 occur on the 13 universal-only bodies; one occurs on a mixed body counted in the local-involving column. Two of those bodies also have outside-owner cause bit 8, so universal relations alone cannot clear them. All eleven mask-1 candidates retain an own-parameter → static shape; the other two retain an outside-parameter → own-parameter shape. Those shapes are **not proofs** of declared outlives premises, and the receipts contain no premise identities. In particular, membership in the universal set does not imply that unrelated universals outlive one another. Unproved relations stay pending; an obligation must never become its own assumption.

### The 16-declaration shared floor

The minimum floor is 17 emitted definitions per program, or **7,191 = 17 × 423** occurrences (45.28% of the corpus regions). Counting all specializations of those same 16 declarations gives **7,620** definitions (47.98%). RawBuffer.copy contributes 1,031, Vector.append 641, Bytes.append and Vector.appendBytes 436 each; the other twelve contribute 423 each. The exact declaration list and per-declaration counts are in `relation-split.json`.

| Floor subset                                      | Universal obligations | Local-involving obligations | Universal-only relation bodies | Local-involving relation bodies |
| ------------------------------------------------- | --------------------: | --------------------------: | -----------------------------: | ------------------------------: |
| All corpus specializations of the 16 declarations |                     0 |                      21,387 |                              0 |                           7,620 |
| Self-build specializations of those declarations  |                     0 |                         858 |                              0 |                             573 |

Every floor definition is mask 1, and every floor relation has shape **own parameter → own local (2 → 4)**. The self-build reaches five of the sixteen declarations: RawBuffer.copy (286), Vector.append (284), Bytes.append, Vector.appendBytes and native_host_input.copyArguments (one each). It does not emit the eleven native_diagnostics/native_report floor declarations. Corpus and self-build package identities differ: the cross-dataset floor subset uses the recorded stdlib source label/root, rejects ambiguous labels, and keeps the exact owner identity for every emission join.

**Amendment to the proposed order:** the floor cannot be part of universal-only 2a. Move “floor first” to 2b. A parameter outliving a local requires identifying that local's required/available points; it is not a universal-to-universal premise proof.

## Amendment 3: production phase order and count limits

These counts are emitted definitions, not distinct source declarations. The census bounds the opportunity; it cannot guarantee that an implementation proves every candidate. Each body's other causes must also be discharged before it leaves the gap. The phases are one PR each:

| Phase | Proof and priority                                                                           |                                      Corpus definitions eligible to leave Regions |     Instrumented self-build definitions eligible |
| ----- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------: | -----------------------------------------------: |
| 2a    | Universal-only relations from declared/header/where premises; no point flow                  |                         **0–11** mask-1 candidates; two mask-9 bodies wait for 2c |                                            **0** |
| 2b    | Local regions, §4.3 worklist over the existing Walker; floor first                           | Up to **13,620** local-involving mask-1 bodies, including 7,620 floor definitions | Up to **6,500**, including 573 floor definitions |
| 2c    | Crossed referent loans and outside-owner atoms, with relations already proved where possible |                        Up to **2,230** (535 crossed + 1,727 outside − 32 overlap) |        Up to **2,454** (401 + 2,057 − 4 overlap) |
| 2d    | Contents, preserving concrete capture and generic contents obligations                       |                                                        Up to **21** mask-2 bodies |                                            **0** |

The ceilings partition 15,882 and 8,954. They are not commitments to mark every body Checked. Any of 2a's eleven relations lacking an admissible premise remain pending after 2a; any additional flow/representation proof is recorded as residual scope, never invented to meet a count. The historical census does not establish a nonzero 2a reduction. Production PRs must report actual reductions against their fresh base, not substitute the instrumented self-build counts for the production gap.

Each PR includes valid and rejected compile-time code/span controls, the generated per-program gap diff table, and its time/RSS against the same clean baseline and remaining budget share. Generate `compiler/borrow-check-gap.txt` only with `node .github/scripts/check-borrow-gap.mjs update <corpus log>` and obtain the table with that script's `diff` command. Do not change OpenSpec, weaken tests, introduce diagnostic codes, or merge this checkpoint. Unresolved cost or semantic decisions stop production work for Julia.

## Amendment 4: outside-owner atoms in a nested body

The supported kinds are anonymous callable expressions (plain or effectful, inline or let-bound), Effect blocks, and provider operation bodies. **There are no named local functions.** A let-bound literal is the same anonymous-callable construct as an inline argument. [ANON-CALLABLE-001](../../../apps/docs/content/reference/functions-callables-and-control-flow.md#anon-callable-001--an-anonymous-callable-has-one-exact-source-identity-and-explicit-contract) permits enclosing type and row parameters and excludes an anonymous body nested in another anonymous body; this rule covers one nesting level, not new nesting semantics.

The implementation rule, derived from [LIFE-001/002/004/005](../../../apps/docs/content/reference/lifetimes.md), [CAPTURE-001/002, ANON-OWN-001, CALLABLE-003, EFFECT-OWN-001/002, VIEW-001/002](../../../apps/docs/content/reference/ownership-and-borrowing.md) and [SERV-001/006/007](../../../apps/docs/content/reference/requirements-and-services.md), is:

1. **Identity is preserved.** Intern a free atom by its complete originating declaration/binder identity (or originating declaration/local identity), after the existing typed substitution. Do not rebind an enclosing lifetime to an anonymous declaration's coincident ordinal, to its fresh invocation binder, or to static. Enclosing type/row parameters carry their existing substituted contents/constraints into the nested contract; their visibility creates no new outlives or contents premise. `T` being visible is not evidence for `T: 'env`.
2. **Enclosing lifetime parameters are universal in the nested proof.** So are authenticated invocation and retained-environment parameters. They cover the nested body's points and exit, as §4.1 requires, and remain distinct symbolic terms. Only the lexical contract's declared/implied header and where premises establish relationships between them. They do not all outlive each other or static merely because their finite point sets coincide. Do not read the enclosing body's checking stage.
3. **An enclosing local is an external captured dependency, not a new nested local and not an unbounded universal.** Inside the nested query, its authenticated capture/input contract makes it available for that invocation, including its cleanup. Preserve its external origin and its relation to the retained environment; an external local gains no static or arbitrary caller lifetime. A new loan of storage _owned by the nested invocation_ is still local and ends at that invocation's End events. If the typed capture/input contract does not authenticate the external origin or required relation, the nested body stays unchecked.
4. **Do not copy the enclosing point domain into the nested graph.** The enclosing query checks formation, retention, transfer, invocation and drop of the callable/Effect/provider with its own points and End events. It must keep each captured loan available through all those uses and cleanups. That independently bounds an enclosing local by its actual owner's lifetime. The nested query checks its own uses under its input/environment contract. A nested `Checked` result is conditional on that contract, never a verdict that the enclosing owner lives forever; the enclosing query must discharge its own formation/escape causes. Neither result depends on the other body's stage.
5. **Storage does not change the contract.** Binding an anonymous callable to a local transfers its same captures and region identities to a holder whose liveness/cleanup the Walker tracks. Inline passing retains those inputs through the complete call, including failure. An effectful callable additionally constructs an Effect: preserve the callee/capture loans through that Effect's run/drop, with invocation and capture environments independent (LIFE-004). Effect blocks use the same capture rule. A provider operation treats its enclosing `impl` lifetime parameters as universal; provider provision retains the provider loan/owner through completion (SERV-006, EFFECT-OWN-001). Owning a provider does not detach borrowed fields it contains.

Thus an enclosing parameter is universal **inside** the nested body; an enclosing local has contract-bounded external validity there and is bounded by the enclosing owner's points **in the enclosing query**. This is a per-body assume/guarantee boundary derived from the existing capture rules, not a second graph or permission to inspect another body's verdict. `Supplied` atoms without an authenticated binder/origin and unexpanded/approximate facts remain unchecked. The census's coarse outside-owner bit also includes invocation/supplied/meet atoms, so “outside-owner” is not proof that every counted atom belongs to an enclosing declaration.

### Compile-time Cases

[outside-owner-cases.json](outside-owner-cases.json) contains every complete source and bootstrap diagnostic code/span, including duplicate diagnostics, produced with `Analysis.ofSource` from checkpoint source `2e358659da4b912602e925f81b4197ac338cf5af`. Replay after building the bootstrap with `node compiler/docs/r3-census-checkpoint/outside-owner-cases.mjs`. There is no code generation or executable execution in this receipt.

| Cases                                                   | Valid bootstrap verdict | Rejected bootstrap verdict                                                                                  |
| ------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| Plain anonymous callable, inline argument               | Accept                  | OWN0019 twice + SEM0212 at `&inner`                                                                         |
| Plain anonymous callable, let-bound                     | Accept                  | OWN0019 twice + SEM0212 at `&inner`                                                                         |
| Effectful anonymous callable, inline argument           | Accept                  | OWN0019 twice + SEM0212 at `&inner`                                                                         |
| Effectful anonymous callable, let-bound                 | Accept                  | OWN0019 twice + SEM0212 at `&inner`                                                                         |
| Returned anonymous callable capturing an enclosing loan | Accept for input `'a`   | SEM0212 at `&value`, OWN0019 at the callable, OWN0018 at captured `view` for a local escaping as static     |
| Effect block capturing an enclosing loan                | Accept for input `'a`   | SEM0212 at `&value`, OWN0019 at the Effect block, OWN0018 at captured `view` for a local escaping as static |
| Provider operation using enclosing `impl<'a>`           | Accept                  | OWN0019 twice + SEM0212 at `&inner`                                                                         |

Two additional valid Cases invoke a callable or run an Effect while the enclosing local remains alive. Their acceptance distinguishes a legal external-local dependency from the rejected escaping examples. There are sixteen complete Cases, nine accepted and seven rejected. Diagnostics are compile-time verdicts only; repeated OWN0019 entries are preserved, not silently deduplicated.

For example, the plain let-bound pair differs only in whether the nested result points to the enclosing input or to nested-owned storage:

```silk
fn use<'a>(value: &'a i32) -> &'a i32 {
  let local = fn() -> &'a i32 { return value }
  return local()
}
// Rejected Case: replace the literal body with
// { let inner = 7 return &inner }
```

The inline Case passes the same literal to `apply<'a>(f: fn<'a>() -> &'a i32)`. The effectful pairs use `effect fn() -> &'a i32` and run the resulting Effect; the inline consumer's input is `fn<'a>() -> Effect<'a; &'a i32>`. Both preserve `'a` from the enclosing function. Full valid and rejected sources are retained in the JSON, rather than presenting a rejected fragment as executable test input.

The Effect block and provider pairs are:

```silk
fn keep<'a>(value: &'a i32) -> Effect<'a; i32> {
  return effect { return value.* }
}
// Separate rejected Case:
fn keep() -> Effect<'static; i32> {
  let value = 7
  let view = &value
  return effect { return view.* }
}
```

```silk
service Read<'a> { fn read(self: &Self) -> &'a i32 }
struct Provider<'a> { value: &'a i32 }
impl<'a> Read<'a> for Provider<'a> {
  fn read(self: &Self) -> &'a i32 { return self.value }
  // Rejected Case replaces this operation body with
  // { let inner = 7 return &inner }
}
```

## Amendment 5: diagnostic ownership and crossed referent loans

The existing code inventory is broader than OWN0019. Code names below use the actual native `Rejection.silk` mapping, not the older proposed enum spellings in §7:

| Existing code | Native mapping / location                                                           | R3 ownership                                                                                                                                                                                                                                                                                                   |
| ------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OWN0019       | `ExpiredLifetime`; required use/retention/cleanup origin, related original loan     | Finite-region solution violation (§4.3). The current Walker already reports it when an exact local loan survives its root's End. R3 reuses those events and origins.                                                                                                                                           |
| SEM0212       | `UnsatisfiedLifetimeBound`; declared requirement/offending boundary                 | Universal relation not implied by admissible premises (LIFE-002, VIEW-001). Bootstrap `LifetimeFlow.analyze` also reports this for rigid universal/owned-local-to-universal failures. A merely unresolved or approximate relation remains unchecked; do not turn missing evidence into a definitive rejection. |
| SEM0211       | `InvalidLifetime`; malformed binder/domain location                                 | Existing malformed lifetime diagnostic. Bootstrap `LifetimeFlow.diagnosticsOf` uses it for a non-Solved finite-domain result. It is not a fallback for an unsupported atom or an unproved relation. Correct compiler-generated point domains should not produce it.                                            |
| SEM0213       | Existing bootstrap type-contents-bound diagnostic under LIFE-002                    | Contents-bound formation/typing, not a new finite-point violation code. No current native `RejectionCode` mapping exists; 2a does not add one. 2d must preserve the existing reference distinction and cannot invent a replacement code or silently relabel it SEM0212.                                        |
| OWN0018       | `ExecutableBorrowEscape`; borrowed capture source, related returned callable/Effect | Capture/escape check (§4.5), **not** the §4.3 point-set solver. Bootstrap `Ownership` reports it; the native semantic capture/return checks already own it. A returned executable with a local loan can legitimately also produce OWN0019/SEM0212, as the receipts show.                                       |

OWN0010/OWN0011 remain access conflicts in the Walker. OWN0001/0004/0005/0008 remain move, replacement, loop and guard checks; OWN0014/0015 are callable/Effect access checks. OWN0016 remains the reached-call-graph build check, and OWN0020 remains the suspension gap (§4.5). None is newly emitted by R3's relation solver. There is no OWN0017 path and no new code is proposed. Actual 2a output is restricted to the existing premise/binder diagnostics above; OWN0019 requires point availability evidence in later slices.

### Exactly what `crossed` defers today

In `BorrowCheck.silk`, `cross` sets `Walker.crossed` only for a carried loan whose `Loan.local` is **false**: a loan of referent storage behind a reference, rather than storage owned by this body. The flag is set at these existing paths:

- `rejoin`: a reachable branch/block result restarts carries at its join;
- `Shape.Binding`: a retained loan enters a mutable non-callable holder;
- `replace`: a replacement carries retained loans into a non-callable holder;
- `matchArms`: a reachable arm's retained result carries loans out to the join;
- `Shape.Exit` and completed root flow: a carried loan leaves through return/fail or body completion.

An unreachable rejoin does not set the flag. Exact callable replacement and other unsupported transfers still exit as `StoredLoans`, not as a cleared region proof. For local loans, the existing End-event branch checks carried intervals and live reaching holder definitions, including cleanup; an exact surviving loan reports OWN0019 (an approximate one yields `Imprecise`). It does not establish the external referent's region relation: ending a reference descriptor is not proof that the storage behind it ended. Conversely, not seeing an End for external storage is not proof that it may escape under an arbitrary result/environment lifetime.

Thus 2c must prove that the external origin/parent region covers every crossed result, holder definition, join, return/failure and cleanup use under the body contract. Keep that loan's identity, exact origin, definition and crossing points alongside the existing Walker edges; do not clear the boolean solely because no local End conflict occurred. Existing reaching-definition kills for replacement and path-sensitive joins remain authoritative. Approximate origins, unknown overlaps and unauthenticated supplied regions stay unchecked.

The 535 corpus crossed definitions split into mask 4: **71**, mask 5: **432**, mask 13: **32**; the 401 self-build definitions split **16 / 381 / 4**. These are body counts, not crossing-event counts; the current receipts do not encode which of the six call sites caused each flag. Do not invent a per-crossing-kind count from that boolean. This makes 2c's behavioral scope concrete while retaining the census's actual resolution.
