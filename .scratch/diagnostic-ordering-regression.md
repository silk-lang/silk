# Cold parallel cache changes later diagnostic order

V14 SHA ae58fdc06b5911f73ead685cdac25ab5e3b903b1459f72aab84f553835de9546. Both controls use40modules whose answer calls parking.identity<i32>(parking.value()). A cold parallel check is accepted, then parking.value is renamed without updating callers. Compare warm cache diagnostics against a fresh serial cache on exactly the same paths/source.

- Registry ON: `.scratch/benchmarks/completed-body-cache-nkk1phlg/results.json`. Cold proof accepted with20actual registry hits.
- Registry OFF: `.scratch/benchmarks/completed-body-cache-xb2fpwgd/results.json`. Cold proof accepted without registry.
- Both warm edits exit1 and return the exact same41diagnostic objects as fresh serial, including codes, paths, spans, messages, related sites and multiplicity. Array order differs. Fresh serial starts callback.silk,pad00.silk,pad01.silk; the adopted parallel result begins a worker-dependent pad order.
- This defect predates the completed-body optimization. It is not a stale clean answer, but it fails strict ordered diagnostic parity and remains unresolved. Do not treat sorting the harness output as a fix.

The fixture topology was subsequently changed to make the shared generic body itself call parking.value (a single authored use), retaining repeated generic roots and dependency invalidation coverage without40independent call-site errors. The original ON/OFF evidence above remains the separate regression record.

## Correctness repair validated

The source traversal issue was shared-view replay treating a full merged proof closure as an ordinary bounded walk trace. It could recheck/report stale bodies the destination module leaves to another check. Shared Views now reconstruct the current boundary/root/reference/callback walk; ordinary Inline replay is unchanged. No diagnostic sorting was introduced.

V16-based diagnostic source `014c9641c7cfa988ddaf427c7b9eda5e13ef1564`, binary `.scratch/frontier-diagnostic-order`, SHA256 `886f8ae3f9a9a9d93d717a849b64c2303d627836c03a19e77f0207da5123fedc`.

- Full sourcecheck and focused two-module ordering/guard lifecycle tests pass. Tests cover save→fresh unchanged with no replay, same-command repeat, application A→B, inherited declaration-roster guard, and a newly added unused invalid declaration.
- Original 41-error native control passes all four calls: cold parallel proof accepted, then deletion yields all 41 SEM0014 diagnostics in exactly fresh-serial order with identical full objects and no warm refork. Evidence: `.scratch/benchmarks/completed-body-cache-_q2hioi8/results.json`.
- Reproduce with `.scratch/completed-body-cache-lifecycle.py --compiler .scratch/frontier-diagnostic-order --stdlib /workspace/silk-diagnostic-order-v16/stdlib --reuse-off --first-edit-only --multiple-callsite-errors` under the shared performance lock.

The composed clean check retains the still-valid original non-MIR record guard, fresh own reads, and exact selected MIR evidence. It publishes the newly bounded Inline trace; it never republishes the obsolete View answer as that trace. Unlinked cache adoption retains its documented never-revised caller contract.

The composed candidate also passes the full 28-call callback/application lifecycle: `.scratch/benchmarks/completed-body-cache-im7zb5wx/results.json`. Cold parallel proof engaged; deletion/header/escape-body edits, shifted spans, application switches and recoveries preserve exact ordered JSON against fresh serial. Native outputs42/43 match and warm checks do not restart frontier workers. All descendants were reaped. These are correctness gates, not authoritative performance measurements.
