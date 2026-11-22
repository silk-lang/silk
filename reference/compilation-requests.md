# Compilation requests

`silkc compile --request <file>` compiles the explicit inputs in a TOML request. Use `-` to read
the request from standard input. This entry point does not read a package manifest, fetch a
dependency, or evaluate a package's build script. Source imports resolve through the packages
and import aliases in the request.

The wire format is defined by `Request` in `silk.build.request`. Read and write it with
`SchemaToml` or `SchemaJson`. Its generated JSON Schema ships at
`lib/silk/stdlib/silk/build/request.schema.json`; `silkc request-schema` prints that schema.
Unknown fields and unsupported format versions are errors. A schema failure reports the path
of the failing field. Package identities must be unique, dependency aliases must be unique
within each package, and each dependency must name a package in the request.

All filesystem paths are absolute. The request includes the source root and output path, the
standard library, normalized profile, source packages, runtime composition, native inputs, and
generated module source files. Parameters record their declaring module, type, documentation,
default when available, and selected value. Integer parameters use decimal text to preserve
their exact value through JSON tools.

A request's optional `trace` record asks the compiler to record its own work on that request:
`file` is the absolute path it appends OpenTelemetry spans and logs to, as OTLP JSON lines or, for
a path ending in `.pftrace` or `.perfetto-trace`, as Perfetto packets with memory and processor
counters,
`queries` the number of microseconds a semantic query run must take to be a span, and `parent` a
W3C `traceparent` under which the compilation continues another program's trace. The record
changes nothing else the compiler writes, and a build writes none into the request it publishes.

An ordinary artifact build writes `requests/<artifact-name>.toml` beside its output. Generated
source files are retained under `requests/sources/`. Replaying a request requires the source
files and native inputs it names to remain available. The request itself contains no executable
build instructions.

The compiler-workspace replay check builds the compiler's LLVM IR through the ordinary driver,
replays the resulting request, and compares the output bytes. The native CLI fixture separately
checks dependency aliases, parameter bindings, generated modules, C sources, and file/stdin
artifact parity with invalid manifest and build-script files beside its source.

The `root` field names the physical entry file. `root-module` names its module within the root package, such as `main.silk`. Generated entries retain that logical identity even when the file is in a step output directory.

`silkc resolve --definition <file> --output <request>` resolves a `Definition` from
`silk.build.definition`. Definitions select a package manifest, optional source settings,
generated files, native inputs, and overrides keyed by declared dependency alias. Unspecified
source settings use the compiler's target defaults before runtime composition is selected.
Resolution writes a complete request; the compilation entry point consumes only that request.
Excluded dependencies are removed before fetching or loading packages.
