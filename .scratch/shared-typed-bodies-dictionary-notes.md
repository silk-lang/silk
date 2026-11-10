# BodyTypes implementation notes

Owner: /root/edit_overlap. Source tree: /workspace/silk/.scratch/shared-typed-bodies.

Own only compiler/src/semantic/BodyTypes.silk and BodyTypesCases.silk. BodyWire/BodyCapsule belong to parallel_semantics; integration belongs to worker_forks. Sole coherent compile owner is parallel_semantics, root-assigned slot2. No compiler has been launched by this owner. Source frozen pending first snapshot/gate; coordinate before edits.

API agreed: Encoder/Decoder, encoder()/decoder(); write/readType,Lifetime,Application,StaticData,Declaration,Binding. Writes !OOM ?Allocator, reads !OOM ?Allocator|Types. StaticSlot and Argument helpers public too. KeptRegions handled by body layer. Complete declarations use StableKey content, no Resolver callbacks/foreign ordinal remap. Only whole-capsule guard validation may publish body answers; local interning on decode failure is permissible.

Dictionary wire: 0=new structural definition, 1=backward id. New parent published after recursive children complete. Each family has its own ID table, global entry limit16384. Type/Application/Lifetime/StaticData/Row encoder lookup now InternIndex keyed local retained immutable handle address; declaration index keyed stable hash plus exact equality. Addresses never serialized. Decoder rejects absent/forward refs. Resource bounds use shared BodyWire byte/depth/step/item budgets; counts only for containers, readSize for IDs/ordinals. Declaration count is checked BEFORE StableKey allocation (three fields then owner-count word), and again after decode.

25 Type variants supported, including Anonymous and CallableValue. CallableValue private runtime cache rebuilt with Type.callableValue; reject if factory changes canonical contract or fieldInputs. Type.CallableSchema/CallableWitnessResult unsupported. All6 Lifetime variants preserved, including local owner+ordinal+binder and meet membership. Application preserves exact target/arguments/original ordinals/scopes/statics. All Row fields present. Static Unit/Boolean/Character/Integer/Float/Enum/Text/Bytes/Borrow supported. Static Sequence/Field/Aggregate private admissions and Static Callable currently explicitly unsupported.

Structural type decoders split into readTypeTag0..24 helpers to avoid large recursive debug frames. Immutable safe Interned.get/Frozen.get used for writer structural reads; no deep Type.copy/Application.copyShared allocation. No type guessed from runtime layout.

Tests drafted: portableBodyDictionariesPreserveCompleteBindings and portableBodyDictionariesRefuseMalformedAndPrivateEvidence. Cross-TypeTable identity, repeated local refs, application lexical scopes/static bit values/original ordinals, different local inference binders, orphan refs, malformed tags/truncation/depth refusal, admitted static aggregate fallback. Not compiled yet. Some fixtures/imports may need normal first source-gate fixes.

Generation scripts /tmp/generate_body_types.py and /tmp/extend_body_types.py are historical scaffolding; DO NOT rerun because subsequent source edits (InternIndex, split variants) are authoritative.

Pending: first coherent compiler diagnostics, reason-code instrumentation agreed with BodyWire owner, source/native focused gates under root scheduling; coverage/performance only after correctness. Root requires explicit unsupported coverage reasons. No independent compile or timing.
