# Direct function pipelines

The native compiler will support `input |> NamedFunction` and module- or type-qualified function
targets through the ordinary direct-call route. The language rule is
[PIPE-001](../../apps/docs/content/reference/functions-callables-and-control-flow.md#pipe-001--a-pipeline-invokes-one-unary-callable-after-evaluating-its-left-value):
evaluate the input exactly once before invoking the target with that value.

Implementation is in progress, based on `selfhost` after #712. This document records the shared
boundary for sessions depending on the pipe work; it does not claim support has landed.

## Shared call representation

Introduce one argument source with written HIR children for ordinary calls and a single HIR
expression for pipelines. Call collection, selection, body checking, and static-call phases must
all consume that representation. Typed direct calls then use the existing MIR lowering path.

Callable-value targets and interface-operation pipelines remain structured, named gaps anchored
at the complete pipe expression. They must not become ordinary semantic failures.

## Validation and coordination

Use one shared source snapshot to check argument typing, selected callee, input-before-call
lowering, and both gap codes and spans. Source tests must stay below one second, aiming for
500 milliseconds. Exact-head selfhost CI must report zero FAIL and preserve every previous PASS.

If `trivial-features` passes, add its corpus pin and B11 baseline entry. If it reaches another gap,
record that construct and its owner without extending this change to repair it.

#706 also edits `checkExpression` and call collection; keep its statement-pattern changes separate
from the shared call-argument migration. Cleanup-gap changes may affect corpus outcomes and must
be accounted for when comparing PASS totals.
