# Persisted declaration verdicts

**Status:** Julia has approved the semantic rule that a declaration verdict may be reused across
compiler processes when the compiler and declaration fingerprint are unchanged. This note
proposes the additional dependency and context validation needed to make that rule sound;
Julia has not approved an implementation. The aim is to avoid checking the same loaded
standard-library declarations on every build. This proposes an
extension to the explicit “no disk caches in v2” decision in
[incremental-architecture-v2.md](incremental-architecture-v2.md#11-decisions), not a claim that
v2 or the cache already implements it. The in-memory declaration dependency work of #1659 was
reviewed at `91c27eb4d`; its draft PR had not merged at the time of this note. The loaded
declaration sweep described here was inspected on `selfhost-loaded-declaration-complete` at
`4be687d5`, also not assumed to be present on this branch.

## Verdict and scope

The cache stores the **result of checking an active authored declaration in a particular
context**, not a typed body, MIR, a query slot, or an emission artifact. A reusable result is one
of: checked phases with their exact scope of proof; a deterministic rejection or unsupported
gap with its original code and report sites; or a reasoned, explicitly unchecked/deferred phase.
The loaded-module syntax and import inventory, active static-arm selection, and declaration
eligibility still have to be established for the current program before a verdict is applied.
Module-wide syntax errors, import-member errors, name collisions, and other checks outside
the verdict's recorded obligation set must still run or have their own validated certificate.
An inactive arm and a declaration with no body have no body verdict to reuse. A body with
unsupplied static inputs, a provider-dependent selection, pending ownership obligations, or an
unsupported form remains unchecked for precisely that reason. Neither a cached typed body nor
an evicted MIR slot upgrades such a body to checked.

The verdict must name which obligations it covers. A successful symbolic `Body` check covers
that body's typing and borrow stage only to the extent reported by the existing stage; it does
not certify executable instances or OWN0016. A typed `Body` success with pending obligations is
not `Checked`. For a closed concrete runtime function, OWN0016 is decided by the analysis-only
MIR and callback/call closure over `SuspensionSummary`, including
otherwise unreferenced functions. Its closure result needs its own validated dependency
certificate, or the current build reruns that analysis. A reused body verdict alone must never suppress
the OWN0016 pass or turn its analysis-only MIR into an LLVM emission root. Open and
provider-dependent bodies retain their existing lack of a complete named MIR instance.

The normal build may still demand and lower a declaration for reached code. A verdict hit saves
the loaded-declaration checking work covered by that verdict; it does not stand in for semantic
answers, MIR, or LLVM text needed elsewhere in the build. If the current checking pipeline
cannot skip that work while preserving its normal semantic answers, that is a design constraint
to resolve before implementation, not a reason to accept an incomplete verdict.

## Identity and validation

A lookup candidate is identified by a cache schema/version, the exact compiler build identity,
the portable `ModuleId` components and full `DeclarationId` owner chain, the checked phase and
selection, that phase's own whole or prototype declaration fingerprint, and all relevant build
context. The proposed compiler identity is a content digest of the compiler/checker artifact,
combined with the cache schema and checking-phase version; a human-readable version string is
insufficient. Context includes target and ABI, optimization/debug or other options when they
affect the check or report, the resolved profile and effective package
parameters, static arguments and selected application, and any configuration or environment
value read by the check. The compiler identity changes when compiler semantics or its embedded
rules change; an incompatible schema is a miss. Standard-library source is an observed input,
not an assumed property of the compiler build. This is a lookup key, **not** sufficient proof
that the answer remains valid.

Before using a candidate, validate its complete recorded dependency closure against the
current source index and effective context. `DeclSource` compares the whole significant-token
fingerprint, `DeclPrototype` its header fingerprint, `Name` the complete written candidate
bucket including an empty result, `Namespace` its written names and visibility, and
`SourceFile` presence or absence. A header obligation may look up by its prototype fingerprint;
a body or OWN0016 closure certificate requires the whole declaration fingerprint and its
consumed closure, never the prototype alone. Presence alone cannot validate the contents of a
present module. A `UnitResult` edge requires recursive validation of that unit's own recorded inputs and
portable query context. The persisted proof is a complete acyclic dependency graph built from
portable unit identities; validate children before their parent, with no cycle placeholder or
partly validated hit. An old process generation or revision stamp is not proof. A hit must not
rely on an old process's unit ordinal or an unvalidated child result. This is the same dependency
meaning as #1659's graph, expressed with portable
subjects for persistence. A query that read an untracked input, has an incomplete closure, or
has a result whose meaning cannot be reconstructed from these inputs misses the cache.

The current `ModuleIndex` computes `whole` and `prototype` fingerprints only for revisable
indexes; a one-shot index has neither. A cache-enabled build therefore must collect the needed
fingerprints and dependency edges with the existing recorder and query semantics. It must account
for the first-build time and memory cost separately from the ordinary one-shot path. An absent
fingerprint cannot count as equality. The current 128-bit `ContentHash` and index comparison
rules are useful evidence, but this proposal makes no cache encoding or long-term format
compatibility promise. A compiler/schema change discards older entries.

Do not persist process-local `ModuleId`/declaration ordinals, `Query` IDs, `HirId`s, interned
name/type handles, pointers, MIR vector indices, or absolute source offsets as identities.
Serialize portable module and declaration names and the relevant selection in canonical form;
map them to fresh current-session handles only after validation. A declaration whose identity
contains an unstable anonymous/synthetic occurrence, an ambiguous same-key sibling, a missing
stable owner, or a source read which #1659 marks unscoped is ineligible for persistence. It is
rechecked. Parent-owned anonymous bodies may only be covered by a stable enclosing verdict
whose whole-source input includes them. Lost or renamed declarations miss rather than match by
position.

## Reporting and safety of a hit

A cached refusal retains its existing diagnostic or gap code, classification, arguments,
primary and secondary sites, and deterministic ordering/deduplication identity. Persist authored
sites as a stable declaration owner plus token-relative span/boundaries, and reproject them before
formatting. If a report consumes line/column or token-boundary coordinates, validate the
`DeclLocation` projection or recompute that report. A report with an ownerless absolute site is
ineligible. A whitespace or preceding-line edit can therefore move a diagnostic correctly even
when the semantic fingerprint is equal. Compiler-generated sites remain explicitly generated.

The current sweep must aggregate fresh and cached per-declaration facts in its current request
order, using its existing deduplication and first-error selection. It must never replay an old
process's global diagnostic order after declarations move. The same report construction path
should consume fresh and cached facts. A cached failure must produce the same original code,
module, current primary and related spans, and exit status as a fresh check. A cached unchecked
result must preserve its reason and coverage count; an old completed query or evicted MIR slot
cannot upgrade it. A cached OWN0016 gate result must retain evidence that its entire concrete
callback/call closure was analyzed.
Transient provider errors, cycles, revision mismatches, I/O failures, and interrupted writes are
not reusable semantic refusals. An entry is published only after its phase and recorded closure
have completed. Malformed, truncated, stale, or otherwise unverifiable entries are ordinary
misses followed by recomputation, never evidence of `Checked`.

Publish complete entries atomically under their validated key so a process cannot observe a
partly written verdict. Concurrent writers of the same content may race harmlessly; a reader
accepts only a fully decoded entry with the expected compiler/schema identity and dependency
certificate. An integrity digest covers the canonical key, full closure certificate, and
outcome/report facts; a mismatch is a miss. Random corruption must not silently change an
unchecked phase or failure into `Checked`. Cache deletion or corruption changes performance
only. Storage location, eviction policy, and byte encoding are implementation decisions after
semantic approval.

## Acceptance before enabling reuse

Correctness compares a full cold cache-disabled build, a first cache-enabled build, a warm build
from a new compiler process, and a fresh cache-disabled build after each edit. Use a small
multi-module program and the compiler self-build with its standard library. Their diagnostics
(including codes, module and current spans), unchecked/deferred counts and reasons, exit status,
and emitted IR or executable behavior where applicable must agree. The warm run must show fewer
declaration checks; report counts of hits,
misses, validated inputs and rechecked declarations alongside user time and peak RSS, without
timing assertions in correctness tests.

Change cases must cover a declaration body edit, a callee header change, a new or removed name
that previously had an empty lookup, namespace or import changes, static-arm/profile/target
changes, compiler rebuild, source movement with updated report coordinates, anonymous or
ambiguous identities, cached rejection and unsupported/unchecked reporting, corrupt/partial
entries, and an otherwise unreferenced function whose OWN0016 result changes through its MIR
call closure. A cache hit is accepted only where fresh and warm results agree. The performance
gate compares cache-disabled cold, cache-enabled cold, and warm builds for both the small program
and the full self-build. The existing v2 cold one-shot 1% time/1% peak RSS and first incremental build 3%
time/5% peak RSS gates remain in force; persistence adds a separate cold/warm budget for Julia
to approve, without waiving those gates.

## Source anchors

- #1659 at `91c27eb4d`: [DependencyGraph.silk](https://github.com/silk-lang/silk/blob/91c27eb4d20d7da3f4b7a7fe4759c2eb27c74cb7/compiler/src/semantic/DependencyGraph.silk#L44-L68)
  defines the seven dependee variants and its [recorder](https://github.com/silk-lang/silk/blob/91c27eb4d20d7da3f4b7a7fe4759c2eb27c74cb7/compiler/src/semantic/DependencyGraph.silk#L356);
  [ModuleIndex.silk](https://github.com/silk-lang/silk/blob/91c27eb4d20d7da3f4b7a7fe4759c2eb27c74cb7/compiler/src/semantic/ModuleIndex.silk#L62-L116)
  defines token fingerprints and excludes anonymous literals;
  [DeclarationTable.silk](https://github.com/silk-lang/silk/blob/91c27eb4d20d7da3f4b7a7fe4759c2eb27c74cb7/compiler/src/semantic/DeclarationTable.silk#L139-L159)
  refuses ambiguous, lost, or unfingerprinted matches;
  [Semantic.silk](https://github.com/silk-lang/silk/blob/91c27eb4d20d7da3f4b7a7fe4759c2eb27c74cb7/compiler/src/semantic/Semantic.silk#L3743-L3950)
  records scoped declaration, name, namespace, and location reads and marks unscoped present
  reads transient.
- [Incremental architecture v2](incremental-architecture-v2.md#31-fingerprints) §3.1–3.5
  defines fingerprint and identity intent, §5 the one-shot recording policy, and §11 the
  earlier disk-cache decision. The note is an approved architecture, not a statement that
  every slice has landed.
- [Loaded declaration checking](https://github.com/silk-lang/silk/blob/4be687d5cf5b28f460bfc6c27eb75f9352824605/compiler/docs/loaded-declaration-checking.md)
  on `selfhost-loaded-declaration-complete` at `4be687d5` documents the active declaration
  sweep and analysis-only OWN0016 closure. That branch's
  [declaration sweep](https://github.com/silk-lang/silk/blob/4be687d5cf5b28f460bfc6c27eb75f9352824605/compiler/src/semantic/Semantic.silk#L67008-L67074),
  [analysis-only closure](https://github.com/silk-lang/silk/blob/4be687d5cf5b28f460bfc6c27eb75f9352824605/compiler/src/semantic/Semantic.silk#L67337),
  and [build pass](https://github.com/silk-lang/silk/blob/4be687d5cf5b28f460bfc6c27eb75f9352824605/compiler/src/semantic/Semantic.silk#L69676-L69700)
  keep those checks distinct. [Native borrow checking](native-borrow-checking.md#45-captures-effects-and-local-sharing)
  §4.5 explicitly excludes OWN0016 from a per-body `Checked` verdict.
