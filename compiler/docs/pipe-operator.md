# Callable pipelines

The native compiler supports `input |> NamedFunction` and module- or type-qualified function
targets through the ordinary direct-call route. The language rule is
[PIPE-001](../../apps/docs/content/reference/functions-callables-and-control-flow.md#pipe-001--a-pipeline-invokes-one-unary-callable-after-evaluating-its-left-value):
evaluate the input exactly once before evaluating the unary callable and invoking it with that
value. Anonymous literals, stored callable values and sections use their exact ordinary function
target; their environment is passed or projected directly.

## Shared call representation

`CallInput.ofNode` recognizes both forms without rewriting authored HIR. Its argument source is
`Arguments.Written` for ordinary call children or `Arguments.Single` for the pipeline's left
expression. Call collection, selection, body checking, static execution, and static argument
selection consume that representation. `checkInvocation` produces the existing typed direct-call
form, whose MIR lowering evaluates arguments before invoking the selected callee.

Qualified call references retain the authored owner application separately from call-site
generics. Nominal applications use ordinary type resolution before inherent member selection;
unknown or excess type arguments are rejected, and module qualifiers cannot take type arguments.

Callable-value lowering snapshots the input before evaluating the environment. A transferred input
remains a cleanup owner until invocation commits, so an early callee exit drops it. Sections are
constructed on the right side after the input, then append their stored suffix to the original
target's direct call. Non-unary targets receive `CallArity` at the complete pipe.

Interface-operation pipelines remain a `pipeline-interface` gap at the complete pipe expression,
including the canonical owning declaration. Effect execution belongs to Step 9.

## Validation

`namedPipelinesShareDirectCallTypingAndOrder` in `SemanticLoweringCases.silk` uses one held source
snapshot for contextual input typing, selected targets, input-before-call MIR, block match arms,
static calls and slots, the remaining interface gap and its spans, and applied-qualifier validation
for both call forms. The `callablePipeline` cases in `SemanticCallableCases.silk` assert
input-before-capture MIR, section suffix appending, unary arity codes and spans, and transferred
input cleanup on callee exit. Runtime behavior is also exercised by the pinned `trivial-features`
native corpus program and its B11 baseline entry.
