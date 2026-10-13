# R3 phase 1: region census and proposed proof interface

Status: census/design evidence only. This note does not approve a solver or change a checking verdict. The existing #1654 compiler changes are temporary receipts and remain a draft checkpoint.

## Provenance and counting unit

The replay uses `origin/selfhost` `aed79798a2a78d005db2931171ea9cacd12b94d0` with the temporary `wip/selfhost-regions-r3` probe at `9f2914c79a3e1ee743c98c9ea033f89b5585e6d4`. A verified pinned native seed builds the instrumented N1; N1 then produces the self-build and corpus receipts. The probe records each typed checking owner, an exact instance-key MIR mapping, and final emission identity. The emitted census assigns one cause mask per emitted definition, so generic instances are weighted and repeated checking demands are not mistaken for distinct emitted bodies. Masks overlap by cause: 1 relation, 2 capture contents, 4 crossed referent loan, 8 outside-owner atom.

A single declaration owner can have multiple valid receipts under different instantiations. The reader keeps all owner variants and validates each emitted instance's mask against the exact-key mapping; it does not assume one receipt per owner. The self-build also includes the diagnostic probe's own source, so its count is an instrumented measurement, not the production compiler's gap baseline.

## Current replay results and the older handoff figures

The full corpus completed **423 pass, 0 fail, 0 unsupported** (`track` 328). The exact-key emitted-definition census has **15,882** region-deferred definitions, with **zero missing, ambiguous, or zero-mask mappings**. Its disjoint mask distribution is `1:13,631; 2:21; 4:71; 5:432; 8:1,181; 9:514; 13:32`. The four overlapping causes are:

| Cause | Corpus emitted definitions | Instrumented self-build emitted definitions | Corpus distinct per-program checking owners |
| --- | ---: | ---: | ---: |
| Retained RegionRelation | 14,609 | 7,751 | 12,171 |
| Retained Contents | 21 | 0 | 11 |
| Crossed referent loan | 535 | 401 | 344 |
| Outside-owner atom | 1,727 | 2,057 | 1,344 |
| All region-deferred definitions / checking owners | **15,882** | **8,954** | **13,231** |

An emitted definition is identified by the first-profile final emission identity within one corpus program, including generic specialization. The table's first two numeric columns count a cause if its bit is present in that definition's mask, so column cause counts overlap and must not be added. The last column deduplicates checking owner hashes **within each program** and unions masks across that owner's valid instantiation variants; it has a different denominator and cannot be compared as a one-to-one body count. The raw corpus contains 13,276 owner receipts and 13,238 distinct owner-mask variants, versus 13,231 distinct per-program owner hashes; the current analyzer preserves all variants. The 15,882 emitted total and its disjoint mask distribution exactly match the archived #1654 checkpoint. The `algorithm-crc-32` program alone has a 17-definition / 16-body region floor shared by all 423 programs, which helps explain repeated emitted counts. The separate self-build is instrumented by the probe source itself; its 8,954 total is 26 above the archived 8,928 and is **not** evidence of a production checker regression.

The earlier handoff listed 11,887 deferred relation, 1,285 outside-owner, 390 crossed, and 11 contents. It did not specify a denominator, deduplication rule, or provenance for those four numbers. They do not match the archived or current emitted-definition census, the current distinct-owner union, or the raw owner receipts. Contents 11 happens to match owner-level count, but that coincidence cannot validate the other figures. Treat those handoff figures as an unverified preliminary summary, not as an alternate current census or an observed checker regression. The compressed raw receipts, parser, and `current-replay.json` in this folder make the table reproducible.

## Existing boundaries to reuse

`BorrowCheck.check` already builds typed evaluation points and control-flow edges in `Walker`, including normal, branch, loop, return and failure paths. `releaseScopes` records reverse-order cleanup and `Kind.End` events for roots on every outgoing path. The current walk checks conflicts and moved places, and it can report an expired local loan when a live carried or held loan crosses an End event. These points, edges, access origins and End events are the approved interface for R3; a second checking graph would duplicate ordering and risk disagreeing with the existing proof.

Typing retains `SafetyObligation.RegionRelation` with its offered and wanted region and original site, and `SafetyObligation.Contents` for unresolved captured generic contents. `regionClosed` currently prevents a clear walk from becoming Checked when expression or local types contain atoms outside the declaration's own closed set. `Walker.crossed` separately prevents a referent loan that crossed a scope boundary from being called Checked. The four census causes can overlap on a body, so a solver must discharge all remaining causes for that body before it changes its verdict.

## Proposed solver contract for Julia's review

1. Read the already typed body, its declared outlives and contents premises, retained safety obligations, and the existing Walker points, edges, loans and End events. Keep the proof inside the body query and leave MIR and `bodyRegions` unchanged.
2. Treat declared lifetime parameters, invocation/environment regions and `'static` as universal terms; local loan regions have requirements at actual use and cleanup points. The source note in `compiler/docs/native-borrow-checking.md` §4.1–4.3 specifies outlives propagation from shorter to longer and a violation when a required point falls outside its available points. The region proof must preserve the distinction between a body-local atom and an enclosing declaration's atom.
3. For a `RegionRelation`, use its original site and the actual region terms rather than the probe's coarse bit pattern. For `Contents`, consult the declared premise and the subject's retained contents. For a crossed referent loan, retain its specific loan, holder and points; the current boolean is only a reason for deferral. For outside-owner atoms, use their declaration/binder identity; the coarse bit only identifies work, not a proof.
4. A definitive expired requirement reports OWN0019 at the reference's compile-time use or retention boundary according to the existing diagnostic parity contract. A valid control may become Checked only after all obligations are discharged. An unresolved or approximate case remains unchecked. No verdict from one body depends on another body's stage.

No semantic choice about a new relation, inference behavior, diagnostic code, or cost threshold is made here. Julia's design approval is required before production edits. A later implementation needs valid and rejected compile-time controls with exact code/spans against the reference, the full Cases/corpus/gap gates, seed/N1/N2 IR identity, and before/after time and peak RSS. The rejected controls are compile-time verdicts only.
