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

An ordinary artifact build writes `requests/<artifact-name>.toml` beside its output. Generated
source files are retained under `requests/sources/`. Replaying a request requires the source
files and native inputs it names to remain available. The request itself contains no executable
build instructions.

The compiler-workspace replay check builds the compiler's LLVM IR through the ordinary driver,
replays the resulting request, and compares the output bytes. The native CLI fixture separately
checks dependency aliases, parameter bindings, generated modules, C sources, and file/stdin
artifact parity with invalid manifest and build-script files beside its source.
