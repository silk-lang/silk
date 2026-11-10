# Separate logical instances from executable specialization

Status: source-only proposal based on V22, existing duplicate census and current language references. No compiler jobs, policy changes, or implementation.

## Language contract actually found

reference/synchronous-native-callbacks.md125 permits real native addresses only for named synchronous nongeneric exports. It explicitly excludes ordinary, capturing, type-generic, effect, suspending and naked machine callables. reference/functions-callables-and-control-flow.md469 retains concrete callable identities for specialization; it does not require a distinct machine entry point per logical specialization. These contracts permit executable sharing while retaining type/logical identities. Export thunks, FunctionAddress helpers, callback adapters, execution vtables and foreign declarations initially remain exact. Debug source representation can be redesigned; no reference found promises a unique PC range for every generic instantiation.

## First concrete certified families

Recognize typed-body structure, never module/name alone: a checked synchronous generic declaration that returns a single sealed RawBufferCount operation over its borrowed argument. No other expression, owned cleanup, call, trap, provider, failure, address capture or generic-result value. Its executable footprint is target + declaration/body stamp + ABI + fixed header field offset; element T has no executable role. Logical signature/borrow/type validity remains exact.

Second is equivalent RawBufferResize wrapper, with target,size,alignment,allocator convention in footprint. Existing StorageShape already establishes those complete implementation inputs, but retains every wrapper. Unlike Copy, Resize returns the same bool without source-local trap handling. Shared body should replace the wrapper, not add another helper.

Existing V15 corpus has Count609 implementations→1 exact class and Resize575→38; no predicted elapsed gain. Other RawBuffer operations include Slot,View,ViewMut,From,Copy. Their union has4176 implementations in235 classes (3941 redundant definitions,9.1% of original43,126); predicates must additionally include stride, result ABI, trap site/origin policy and observer mode. Current V22 helpers reduce some repeated instruction bodies but preserve these logical wrappers.

## Architecture

1. Keep InstanceKey/Application exact. Introduce ExecutableKey and per-declaration ParametricBodyCertificate as distinct cache query subjects. Certificate is authenticated by exact source body/header/contract and target profile; it records which type/static/provider inputs affect actual operations. Do not replace semantic identity with layout equality.
2. Compute certificate from already checked generic TypedBody before per-instance lowerMir cleanup/plan/lowering sequence (Semantic lowerMir80755, cleanupNeeds78453, storagePlan79700). For first whitelist, all type-dependent obligations are signature/callsite checks and sealed-intrinsic contract; no exact instance may bypass those. Existing storeMir73766 also coalesces/verifies/compacts; avoiding that work requires the certificate to justify the parametric body, not caching the first unchecked representative.
3. Each logical MIR query returns an authenticated logical header/reference/escape/dependency view plus a reference to immutable executable body. Executable bodies lower/verify once per complete footprint. Logical key, lifetime/provider checking, logical reference roots, budget accounting and body/header invalidation remain separate. Generic bodies outside the proved whitelist retain current exact lowering.
4. Backend ordinary ABI call lowering maps logical references through ExecutableKey. EmissionInputs/LLVM/native units deduplicate executable key; proof records still enumerate logical nodes. Retained worker transport needs explicit logical→executable map and deterministic canonical body ownership, not first claimant aliasing. Cache schema/version must carry this relation and exact source guards.
5. Generalize with a monotone parameter-use footprint: value storage/ABI uses concrete representation; pointer dereference/index uses pointee shape/stride; Drop uses cleanup recipe; calls use callee executable-key projection; selected provider/witness, static control, formatting/type identity, failure origin and reflection keep exact inputs. Recursive call SCCs need a fixed-point solver. Start only acyclic certificates.

A List<T>.length→RawBuffer<T>.count chain is a natural second family: after callee normalization, T may affect neither call ABI nor implementation. This removes whole generic wrappers rather than merely factoring arithmetic beneath them. Exact duplicate whole-corpus ceiling is10879defs25.2%; not all are admitted and instruction fraction is8.41%, so profiling must establish whether fixed definition/pass cost is substantial. Semantic lowering/coalesce/verification/emission/cache rows are additional saved stages only after step3 is implemented.

## Debug representation and explicit tradeoff

One executable body can have a generic source-declaration scope, original parameter names/source lines, concrete machine representation, and erased/opaque T in that scope. Callsite/abstract instantiation metadata can retain logical application identity. This preserves ordinary program behavior and useful stepping/value locations without fabricating one instantiated type as authoritative for every call. Initial tradeoff: inside the shared implementation, the debugger may display opaque generic T rather than the exact caller T. Validate/report that explicitly; it is a design choice, not an automatic blocker. Exact typed debug identities can be retained as non-code logical descriptors, but selecting one at a shared PC requires richer callsite-aware debugger support.

Observer identity/origin remains ordinary semantic output and cannot be similarly erased. Initial Count/Resize certificates admit no originating trap/failure/observer event; hidden ABI mode remains part of footprint, and any observer-bearing extension must carry site identity dynamically or prove identical origin. Exports/address-bearing helpers are excluded regardless of identical machine bytes.

## Implementation sequence and decision gate

Implement Count certificate + logical/executable split first with two distinct element types, header/body mutation invalidation, provider/observer/Drop/address/ABI negative cases, cross-worker determinism and cache transport tests. Then Resize and acyclic forwarding footprints reuse the same architecture. Measure actual MIR provider executions, emitted definition count, native CPU and immediate edits on both workloads and one core. Count alone is infrastructure validation, not expected to meet3x. The broader work-elimination goal is to avoid thousands of MIR/emission/native functions and exact-key bookkeeping, not merely save166k loads while preserving all43274 definitions.
