# Terminal B repair2 handoff for NEW independent design review3

Branch julia/source-policy-design-b. Parent b1e21c5efb6ff41ea3843a40eae2c138a643e726
and accepted main6c160865 are unchanged ancestors. Final repair head is reported in
the terminal message; this commit includes only two normative-document corrections
and this new evidence directory. No preparation/architecture/production change.

R2-1: corrected Same/Different/Unknown slot classification, located evidence,
indirect/mixed exact histories, actual Unknown-path directness, final parent closure
before effects and the existing Exact/Stored caller adapter. R2-2: separated cleanup
interval and named.empty loss subgates with outer gates and original interval IDs.
Read compiler/borrow-source-policy-rules.md and the updated overview/evidence section
of compiler/borrow-source-design.md. Preparation stays verbatim at SHA b769dd2625bf54c7972da511648c8a51c7ba6310249f423a9f3084a64d84e9b8.

All new model assertions pass: six stated slot boundaries plus exact-indirect/mixed,
Unknown-path and slot-accumulator controls;16 parent-closure cases;128 qualified
adapter/applicability/reason cases;192 cleanup cases. Scope is explicitly specialized
helper correspondence, not an independent compiler/source/type/diagnostic oracle.
The README names every domain and omitted claim. Historical model PASS is retained
without claiming its stale classifier proved current policy.

Baseline, repair1 and both independent review probes replay from temporary copies;
all stdout/JSON match originals byte-for-byte (four exit0 receipts). First replay
harness wrongly expected review1 to write an adjacent JSON file; its stdout-only
format is now handled explicitly. No original artifact/expectation was changed.
Baseline hashes, unchanged old models/preparation, zero production delta and
whitespace checks pass. Exact commands, source/output/review hashes and that harness
failure are preserved here. No native/source/compiler/corpus/CI/PR work occurred.

No architecture blocker is reopened; no implementation C, proof relaxation, source
API/schema or new #1957 behavior is authorized by this patch. NEW independent design
review3 is required. Existing implementation/native/lifecycle/metadata/issue acceptance
requirements remain unmet and unchanged. No owned process or native slot remains.
