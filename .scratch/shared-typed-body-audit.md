# Shared typed-body audit

Read-only review of Semantic / SharedBodyArena at 130601c9e, with pending-provider unwind cleanup subsequently added in 8138a008a. No confirmed soundness blocker; promotion still requires native actual engagement and unchanged-own-body dependency-edit coverage.

- READY is published by release-store only after complete body/earlier-offset guard records. Readers acquire-load the directory; records are immutable, bounded, sealed, and copied before arena lifecycle changes. Reserved/pending slots never wait.
- Authority is the inherited frozen fork-family revision, completed provider, exact target/application/profile/scoped declaration context, and full dependency guard. Hash seals detect corruption; they are not semantic authority. SourceRevision explicitly never reads host files after publication.
- All guard dependencies are traversed, with cycles/depth/size and context-sensitive Condition/origin/selected Body paths refused. Immutable Answer.dependencies retains only Conditions in the normal path, so recursively excluding those justifies an empty imported ledger.
- Imported guard nodes use monotonic synthetic ModuleCheck name8 identities. Cache image construction walks arbitrary UpToDate interior Graph nodes and exports every exact SourceInput selector plus file/digest/text/position. Interior guards do not require a stable root key.
- Initial/private workers inherit the mapping; parent stop/abort/normal retained completion reaps workers before releasing its mapping. Imported nodes retain owned local metadata after unmap; ordinal counters do not reset when an arena is replaced.
- Stage-before-Shared.make left a pending capsule on allocation failure; worker corrected this with nonallocating withRunning.release cleanup. Other partial import allocations produce unused graph nodes or conservative refusal, not an installed Body answer.

Coverage additions requested: real fork publishing an actual checked body and receiver-local reconstruction, plus save/adopt with unchanged importing body text and changed dependency signature/provider/roster. Worker drafted both before bootstrap.

CallableSchema is an exact generic named-section/deferred-binder recipe, including anonymous callable-parameter cases; it is not present in every ordinary direct call. Concrete CallableValue and ordinary call metadata are supported. Higher-order generic code may still refuse frequently. Minimal first-sticky encoder refusal counters distinguish schema, witness, unsupported static, resource, depth, bytes, malformed plan, and other, without expanding accepted codec cases.
