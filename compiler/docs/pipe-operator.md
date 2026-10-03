# Direct function pipelines

The native compiler supports `input |> NamedFunction` and module- or type-qualified function
targets through the ordinary direct-call route. The language rule is
[PIPE-001](../../apps/docs/content/reference/functions-callables-and-control-flow.md#pipe-001--a-pipeline-invokes-one-unary-callable-after-evaluating-its-left-value):
evaluate the input exactly once before invoking the target with that value.

## Shared call representation

`CallInput.ofNode` recognizes both forms without rewriting authored HIR. Its argument source is
`Arguments.Written` for ordinary call children or `Arguments.Single` for the pipeline's left
expression. Call collection, selection, body checking, static execution, and static argument
selection consume that representation. `checkInvocation` produces the existing typed direct-call
form, whose MIR lowering evaluates arguments before invoking the selected callee.

Callable-value targets remain deferred to Step 8 as `pipeline-callable`; interface-operation
pipelines report `pipeline-interface`. Both are structured gaps anchored at the complete pipe
expression, including the canonical owning declaration.

## Validation

`namedPipelinesShareDirectCallTypingAndOrder` in `SemanticCases.silk` uses one held source snapshot
for contextual input typing, selected targets, input-before-call MIR, block match arms, static
calls and slots, and both gap codes and spans. Runtime behavior is also exercised by the pinned
`trivial-features` native corpus program and its B11 baseline entry.
