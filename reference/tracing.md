# Tracing

A span records one operation with its start and end times. Its trace ID groups it with
related operations. Its parent span ID identifies the operation that caused it. The
standard library can export spans, correlated logs and cumulative metrics using
OpenTelemetry. The following rules have Candidate status.

## TRACE-001. Ambient observation

`silk.trace` declares independent ambient services `Tracer` and `Meter`, both with
default provider `Off`. A program enables a recorder for an effect with
`Effect.provideAmbient<Tracer>(&recorder)`, where `recorder` is an `Arc<Recorder>`.
A second provide enables `Meter`. Ordinary functions and effect functions can record
observations without adding either service to their requirement row.

A build enables instrumentation according to the providers reachable from its roots.
With no reachable tracer provider, a span's entry, termination, attributes, events and
guard emit no tracing code. The same rule applies to metric updates with no reachable
meter provider. With matching source locations, removing these observations produces
identical object bytes in debug and release, on native targets and WebAssembly. The
ordinary rules for evaluating user expressions still apply. Ambient operations return
`()` and their bodies obey the [ambient service rules](requirements-and-services.md#amb-002--running-an-ambient-operation).

[Object comparison](../.github/scripts/measure-trace-off.sh) · [Observations in a plain function](../corpus/native/trace-plain-fn/main.silk)

## TRACE-002. Function spans

`@trace` on a runtime function, effect function or method opens a span each time its
body starts. Generic functions and methods follow the same rule. Constructing an effect
is lazy. Its span begins when the effect runs.

```silk
@trace(name: "cart.load", kind: "client", args: .("userId"))
fn loadCart(userId: u64) -> u64 { return userId }
```

All three arguments are optional literals. The default name is the qualified declaration
name, such as `shop.loadCart` or `shop.Cart.load`. The default kind is `"internal"`.
The other kinds are `"client"`, `"server"`, `"producer"` and `"consumer"`. The names
in `args` select parameters to borrow at entry. Each becomes an attribute under its
parameter name. Parameter ownership stays with the function.

A normal return closes the span. A typed failure closes it with error status and
`exception.type` set to the error type name. Cancelling a suspended execution closes
its open function spans with error status and `silk.cancelled = true`. Each span
closes once. A decorated function evaluated statically produces no span.

The directive requires a function body and rejects `static fn`, `@naked`,
extern declarations, and interface and service operations. An unknown argument, invalid
kind, duplicate name in `args` or unbound parameter name reports `SEM0271`. An invalid
attachment reports `SEM0236`. The `trace-directive` runtime
capability binds `enter`, `exit`, `failed` and `cancelled` to standard library hooks.
A missing or incompatible capability reports `SEM0270` at the directive.

[Function entry and attributes](../corpus/native/trace-directive-basic/main.silk) · [Typed failure](../corpus/native/trace-directive-failure/main.silk) · [Cancellation](../corpus/native/trace-directive-cancel/main.silk)

## TRACE-003. Manual spans and attributes

`Trace.span("parse")` enters a span and returns a guard. Bind it to a local to keep the
span current until scope exit. Dropping the guard closes the span and restores the
previous context. Keep the guard in the execution and provider scope that opened it,
and drop nested guards in reverse opening order. A recording guard dropped outside
that scope or out of order traps before closing a span.

```silk
fn parseCount(count: u64) -> u64 {
  let _span = Trace.span("parse count")
  Trace.set("items", &count)
  Trace.event("count available")
  return count
}
```

`Trace.set` adds an attribute to the current span. `Trace.event` records a timed event.
`Trace.setError` marks the span as failed and `Trace.link` associates it with another span
context. Manual spans carry the name supplied by the caller. Decorated spans also
record the declaration as source metadata.

Numeric and Boolean attributes retain their OpenTelemetry value types. The recorder
uses `Display` to format other values within its text limit. Formatting happens inside
the ambient operation and only for sampled spans. A `Display` implementation that
parks, suspends or requires a service cannot supply a tracing attribute. A suspending
formatter reports `SEM0269` at the manual tracing call or `SEM0272` at the directive.

[Nested guards](../corpus/native/trace-memory-tree/main.silk) · [Out-of-order drop](../corpus/native/trace-guard-order-trap/main.silk) · [Drop under another provider](../corpus/native/trace-guard-provider-trap/main.silk) · [Rejected formatter](../corpus/invalid/trace-display-parks/main.silk)

## TRACE-004. Context and execution lifetime

`Trace.current()` returns an optional `SpanContext` containing a 128-bit trace ID, a
64-bit span ID and trace flags. It returns `None` when there is no current span. Use
this value for propagation and correlation. Application decisions must be independent
of the presence of an observer.

A new execution captures the current context when it is created. Suspending an execution
and resuming it on another worker preserves its current span. The driver regains its own
context after each drive. A child inherits its parent's IDs by value, so it can open
a child span after the parent span closes. Only the execution that opened a record may
update it.

A nested provider can use a different recorder. Its first span uses the inherited IDs
as a remote parent. Leaving the nested span restores the previous context, including
its owner. Even two nested provides of the same recorder have separate scopes. Only
the scope that opened a record can close it.

[Fork parenting](../corpus/native/trace-fork-parent/main.silk) · [Suspension and migration](../corpus/native/trace-suspend-migrate/main.silk) · [Nested recorders](../corpus/native/trace-two-recorders/main.silk)

## TRACE-005. Sampling and capacity

The recorder decides whether to sample each new root using its configured ratio.
Children inherit their parent's sampled flag. An unsampled span still establishes
IDs for propagation. It produces no finished span or formatted attributes.

The recorder reserves capacity before it is provided. Its ambient operations use an
open-span pool and thread-local buffers. If capacity runs out, recording drops the
affected data, counts the loss and lets application code continue. A dropped record
preserves the active span's IDs for its children. Export reports the recorder's drop
counts as resource attributes such as `otel.dropped_spans` and as metrics.

[Sampling](../corpus/native/trace-sampling/main.silk) · [Exhausted capacity](../corpus/native/trace-buffer-full/main.silk)

## TRACE-006. Propagation between services

`Trace.traceparent` encodes a context as a version 00 W3C `traceparent` field.
`Trace.parseTraceparent` returns `None` for an invalid field, including an all-zero
trace ID, an all-zero parent ID or malformed lowercase hexadecimal. A valid field
preserves the sampled flag. `Trace.spanFrom` opens a span with an explicit remote
parent. To propagate over HTTP, call `silk.http.trace.inject` on the outgoing request
and `silk.http.trace.serverSpan` on its received head. The server opens a local server
span if the field is absent, duplicated or invalid.

[Header parsing and round trip](../corpus/native/trace-traceparent/main.silk) · [HTTP propagation](../corpus/native/trace-http-propagation/main.silk)

## TRACE-007. Correlated logs and cumulative metrics

Providing `silk.trace.log.OtelLogger` as the ambient `Logger` records structured log
events. It retains the static template and typed fields. Trace, debug, info, warning
and error levels map to severity numbers 1, 5, 9, 13 and 17. A log inside an active
span carries its trace and span IDs. A log outside any span still exports. The logger
can forward events to another provider.

`Meter` records counters, up-down counters, gauges and histograms. A static instrument
name identifies an instrument and its attributes select a series. Once the instrument
reaches its series limit, new attribute combinations contribute to one overflow series.
An export takes a cumulative snapshot. For a counter, successive snapshots report the
total since recording began. An unsigned counter saturates at `u64.MAX`. An up-down
counter saturates at `i64.MIN` or `i64.MAX`. An update in the opposite direction can
move it back inside the range.

[Correlated logs](../corpus/native/trace-logs/main.silk) · [Metric series and overflow](../corpus/native/trace-metrics/main.silk)

## TRACE-008. Export

The recorder transfers finished spans, logs and metric snapshots to a sink.
`flush` drains once. `exportBatches` waits for more work and sends batches, retrying temporary
failures. Both are effect code, so HTTP and timer waits happen outside the observed
operation. Run the exporter outside the provided application scope to keep its own
activity out of the recorder.

The OTLP/HTTP sink posts JSON to `/v1/traces`, `/v1/logs` and `/v1/metrics`.
Resource attributes identify the service. The instrumentation scope identifies the
package that produced a decorated span.

[OTLP JSON encoding](../corpus/native/trace-otlp-json/main.silk) · [Retry behavior](../corpus/native/trace-otlp-retry/main.silk)
