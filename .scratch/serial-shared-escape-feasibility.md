# Serial Inline → existing strict SharedEscapeGraph feasibility

Status: **do not validate/promote the draft**. Source-only experiment at `/workspace/silk-serial-shared-escape-graphs`, base V22 `85ba82efe`. No compiler/test/bootstrap process was started. Patch retained at `.scratch/serial-shared-escape-rejected-draft.patch` for review; no production changes.

The proposed narrow path merged borrowed clean captures, kept each original dependency guard and exact MIR evidence, and substituted existing descriptors/blob only after strict finite/escape validation. It would change no cache format or budget policy. Existing generic artifact BuildRecords remained Inline. This looked natural from producer APIs but is not effective on the actual serial cache.

## Actual cache census

Input is the preserved V24 CPU0 original compiler cache after direct edit and unchanged reuse, at `benchmarks/v24-cpu0-cache-sequence-c8g97kw5/silk/build/cache/silk-compiler/semantic-3a1870c601be524d8b386951c44330e8.roots`.

The standalone format12 census parses root/answer/record framing exactly and reads identities/refs/flags; it is offline diagnostic evidence, not compiler cache authorization or a substitute for full callback/finite proof. Script: `.scratch/serial-escape-union-census.py`. Results: `.../serial-union-census.jsonl`.

-239 Inline records,176,667rows,46,369,505answer bytes.
-101,664 full occurrences and75,003 LEFT occurrences; no aliases.
-Union45,766 identities:43,205 have a completed body,2,561 remain LEFT-only.
-No conflicting full-row summary/reference pairs, missing required known/key/boundary flags, or open application facts were found.
-Reverse reachability from unresolved LEFT taints10,196 identities.
-Only159 records have all requested roots outside that tainted set:5,535original rows and1,164,692bytes, about2.5% of record bytes. This ignores possible additional callback-validation refusal, so it is an upper bound.

Strict EscapeGraph.encodeGraph correctly refuses LEFT: the shared blob represents a complete finite graph independent of a particular boundary. The large serial records intentionally stop at boundaries, and their union does not contain every omitted body. Replacing LEFT with FOREIGN or erasing those edges is unsound; demanding the missing MIR merely to persist the cache adds cold work. Extracting the small complete subset is not a meaningful structural win.

## What remains possible

1. A shared immutable *row dictionary* with per-check traversal/LEFT overlays can represent these traces exactly. This is a real representation design, not reuse of the current complete graph contract; descriptors would need to retain each check's bounded edge/leaf semantics and original non-MIR/application guards. It must preserve ordered diagnostics and stale selective replay. Do not silently loosen existing SharedEscapeGraph validation.
2. Canonical exact body/fact adoption across Inline records can reduce redundant declaration decoding/budget body equality without claiming graph completeness. It does not by itself remove46MB of parsing/storage. Any budget witness must participate in nested transactions and retain exact original-body conflict/maxima behavior.
3. Independent cold source capture construction is measured at~.788sampled userCPU seconds in the cold writer; streaming canonical HIR remains a bounded alternative, not an additive3× claim.

The supported conclusion is that the requested narrow complete-graph reuse lacks a meaningful engagement envelope on this workload. Keep the existing correct cache until a separate design is explicitly chosen.
