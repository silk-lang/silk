from urllib.request import Request, urlopen
from opentelemetry import propagate, trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
tracer = TracerProvider(resource=Resource.create({"service.name": "python-checkout"}))
tracer.add_span_processor(SimpleSpanProcessor(OTLPSpanExporter(endpoint="http://127.0.0.1:14318/v1/traces")))
trace.set_tracer_provider(tracer)
with tracer.get_tracer("client").start_as_current_span("call-silk", kind=trace.SpanKind.CLIENT) as span:
    headers = {}
    propagate.inject(headers)
    with urlopen(Request("http://127.0.0.1:18479/shop", headers=headers),timeout=90) as response:
        assert response.read() == b"recorded"
    print(headers["traceparent"], flush=True)
tracer.shutdown()
