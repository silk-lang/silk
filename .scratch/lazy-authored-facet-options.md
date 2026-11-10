# Lazy authored facet identities: source-only review

Scope: exact V22 source in `/workspace/silk-cpu0-cache-work`; no implementation or compiler run. Weighted CPU0 V24 evidence is still pending. This is a design comparison, not a claimed speedup.

## What is already retained

- `SourceUnit.parseSyntax` lowers syntax then drops parser node/element arrays. `SourceIndex.demandSource` builds the module index and immediately calls `SourceUnit.releaseTokens` (SourceIndex.silk:254). A design assuming token arrays are free to retain would add memory across every source/worker.
- Exact source bytes, authored HIR and HIR spans remain. `SourceLocations` already retains eight bytes per significant-token start/end pair, plus line starts. Its spans omit ordinary and documentation comments; it has no token kinds or cached token hashes. A narrow read accessor can stream token text from the held bytes without lexing again.
- `ModuleIndex.Fingerprints` currently exists only for revisable indexes. It hashes significant text and preceding-linefeed markers, replaces nested declaration bodies with their identities, and omits documentation comments. These are useful syntax equality guards but **not** the current SourceInputs facet definition.
- `Fingerprint.header/body` construct canonical byte arrays. Each first traverses an ordinal pass, then emits framed HIR fields. Most SourceInputs Written/Import/Location calls pass the *header HirId*, so their ordinal pass is header-only; do not attribute a whole-body walk to those header calls. Body passes the declaration and traverses its complete HIR to assign ordinals, then emits its body.

## Why one generic token span is insufficient

The current projections deliberately separate Header, Binders, Members, Operations, Parent, Body, Written, Import and Directives. In particular SourceSyntax.header excludes aggregate members; Members can expose names/positions independently of their types; operations/enclosed/name lookups include membership and absence. Replacing all of these with whole declaration text is conservative for validity only if all contextual facts are included, but causes materially broader editing invalidation.

A sound token-based format would need:

1. Domain/version and exact stable declaration/owner context, with precisely selected span lists per facet. Retain existing name/roster/arm/request/resolution dependencies; a token interval cannot prove absence in a module or replace application/profile evidence.
2. Significant-token framing and parser-relevant line breaks. Raw byte slices invalidate on every horizontal-space/comment edit. Dropping all trivia without keeping line breaks is not sound because parsing consumes them.
3. Documentation and directive observations where the current facet includes them. Documentation can lie outside a header span. Directives are currently sorted canonically; hashing written order introduces additional invalidation.
4. A declaration/body binding-context identity when lowering resolves references against header or enclosing binders. Identical body token text after changing/reordering binders is not a proof of identical authored HIR. Simply assuming another query has a header edge is inadequate for this API boundary.
5. Explicit handling of implicit Effect headers, anonymous literals, zero-width/missing/recovery spans and syntax damage. Token text from a subtree can parse differently after surrounding syntax changes. A structural/context guard or continued canonical HIR path for unsupported projections is required; this is a deliberate facet-specific representation, not old-cache compatibility.
6. Full nested declaration content for Body where current Fingerprint.body includes it. Existing ModuleIndex nested-identity substitution would miss those edits if copied wholesale. Smaller header projections must still avoid pulling nested bodies into their validity guard.

## Editing behavior comparison

| Change | Exact current canonical memo | Raw selected bytes | Framed significant-token projection |
|---|---|---|---|
| Horizontal spacing / ordinary comments | Same digest | Rechecks affected spans | Same if no parser-significant linebreak change |
| Line break accepted as equivalent syntax | Usually same HIR | Rechecks | Conservatively rechecks |
| Documentation | Same current facet-specific behavior | Requires separately included attached docs | Requires explicit docs evidence |
| Binder/local spelling change | Same current HIR behavior | Rechecks | Rechecks, and binding context still required |
| Aggregate member type edit | Existing fine facets only | Broad if whole header used | Fine only with explicit per-field span selections |
| Nested body edit | Body includes nested content; other projections unchanged | Depends on selected span | Must not substitute identity for content in Body |
| Directive reordering | Canonical sorted digest unchanged | Rechecks | Rechecks unless directive digest list remains sorted |
| Damaged syntax / context recovery | Existing cause/structure identity | Span equality insufficient | Needs structure/context or canonical handling |

## Concrete alternatives

**A. Lazy exact canonical facet memo.** Cache canonical Header encoding (or its immutable shared bytes) by `(IndexedSource identity, HirId, domain)` on first requested capture. Written, Import, Location and imported Selection share it; keep their outer framing/location fields unchanged. Body/Directives memoize their own domains. Clear with the immutable source object. No eager parent prehash, parser changes or new invalidation. Cached bytes consume memory, but exact hash memo alone requires a format change because today callers wrap full bytes. This removes repeated construction, not the first construction.

**B. Lazy HIR streaming/Merkle identity.** Change the authored facet digest format, not its semantic coverage. Hash stable node kind/field tags/scalars/child digests directly, using framed fields or fixed-size child digests instead of constructing expanded canonical byte arrays. Retain canonical owner and binder-reference meaning; cache the declaration ordinal map once when required. Sorted directive digests preserve order independence. Memoize only demanded nodes/facets. This attacks the first-construction allocation/copy cost as well as repeated work, without the token projection's extra invalidation. It still traverses selected HIR and hashes literal/string bytes, and nested cached hashes must be keyed by ordinal/context where binder reference encoding depends on the parent declaration. Not all HIR nodes are context-free memo keys.

**C. Lazy token projection.** Potentially the cheapest simple linear byte hashing for large Body/Written observations, using existing SourceLocations spans and source bytes. Start only with well-defined facet domains, not all observations. It requires more semantic design/proof and mutation tests than A/B and has conservative extra invalidation. Keeping linefeed metadata while tokens are already visited could avoid future gap rescans, but an unconditional per-token cryptographic prehash would be an added eager load cost and is not proposed. Full token relexing in the writer would defeat the premise.

Recommendation pending V24: use A when repeated canonical headers dominate; use B when first capture/expanded canonical bytes dominate; consider C only if direct byte hashing has a demonstrably larger envelope and its fine projections can be specified/tested. Never adopt a token whole-file surrogate to win cold time at the cost of first-edit reuse.

## Quantified envelope and limits

The earlier V14 seven-store census had 77,003 Written/Import/Location header captures over 61,670 distinct same-store declaration keys: 15,333 repeated constructions before imported Selection or shared subprojections. This is a count lower bound for memo opportunity, **not** CPU0 saved time; it includes parallel stores. Body had 29,368 captures and 17,353 exact cross-store identities; cross-store duplication is not evidence of CPU0 benefit. Total 11.85% unexported pending inputs belonged to private children, not serial stores.

V11 sampled fingerprint family was about 1.05 weighted user-CPU seconds (encodeNode about0.576, late export), on a different parallel construction. That caps neither CPU0 cost nor speedup reliably. Upcoming V24 CPU0 selector capture/hash-text bytes+elapsed phases and sampled CPU are required to decide. Phase clocks include instrumentation and elapsed scheduling time. Count reductions cannot be added to native/backend speedup claims.
