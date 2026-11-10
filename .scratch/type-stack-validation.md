# Type rewrite stack fix

Production changes are applied but uncommitted in `compiler/src/semantic/Type.silk` and `compiler/src/semantic/SemanticLoweringCases.silk`.

A 400-reference canonicalization input exhausted the ordinary 8 MiB native stack before the existing bounded structural collector returned `CanonicalizationFailure.Resource`. A signal shim and the binary's `silk_frames` table located the failure in alternating `rewriteTypeInside` / `rewriteType` frames. The unoptimized dispatcher reserved 47,400 bytes on every recursive visit. The original test passed with a 32 MiB stack, confirming collection rather than fixture construction or teardown.

The fix moves 22 variant bodies, byte-identically, into separate helpers. Parameter substitution, leaf reuse, nominal rewriting, child order, identity rules, and all canonicalization limits are unchanged. The dispatcher now reserves 8,792 bytes; individual variant helpers reserve 2,632–7,032 bytes (reference: 3,048). The collector's existing work counter bounds structural depth, and the regression now reaches Resource under the normal stack.

Validation:
- Scratch focused frontier suite: 9/9 passed, including the original 400-reference fixture under optimization none / 8 MiB stack.
- Production sourcecheck: passed.
- Production existing caller-region numbering test, extended with the same 400-reference Resource assertion: passed at optimization none / 8 MiB stack; 36 ms runtime, 1 selected of 214 discovered.
- Production log: `.scratch/cache-correctness-type-stack-test.log`.
- Standalone Type-only patch: `.scratch/type-rewrite-stack.patch`.

The production change is independent of the experimental finite-specialization language policy. It does not enable parallel graph checking or alter which bounded identities are accepted.
