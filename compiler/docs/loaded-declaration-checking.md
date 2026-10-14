# Loaded declaration checking (MODULE-004)

`main.silk` preloads the program through `ModuleSources.preloadProgram` before it
creates the semantic store. Build and test compile through `Semantic.buildRuntime`.
Its declaration sweep checks every active, closed, nongeneric, provider-free
declaration in the loaded root package independently of the executable instance
walk. A standard-library module loaded as a dependency is checked when a use
reaches its declaration. The same library can be built as the root package to
check its own loaded declarations.

Preloading follows syntactic imports to closure. The root-package sweep uses the
existing query families for headers, aggregate members, implementation contracts,
constant initializers, and function bodies. Availability queries exclude inactive
static arms. Anonymous bodies belong to their enclosing body demand;
declarations without bodies have only header demands. Generic and provider-dependent
bodies retain existing symbolic contract typing where possible. Complete MIR and
ownership verdicts require a concrete use; full standalone checking of
unspecialized bodies is deferred. Bodies with unsupplied static inputs or
generic-dependent static expansion defer whole-body typing.

Rejections keep their original codes, modules and spans, and independent
rejections are deduplicated. The sweep shares the semantic cache and profile with
the executable walk without adding LLVM emission roots. An unreferenced
well-typed function remains absent from emitted IR. Compiler-owned sealed glue
never requests an authored source module.

OWN0016 uses `localSharedEscapes` over concrete MIR `SuspensionSummary` values.
An analysis-only MIR closure checks otherwise unreferenced closed nongeneric,
provider-free root-package functions and their callback/call dependencies without
requesting LLVM text. Open templates and provider-dependent bodies lack a complete
named MIR instance. Universal abstract OWN0016 summaries are a follow-up; this
change never fabricates a provider or specialization to mark an abstract body
checked.

Bodies with unsupplied static inputs or generic-dependent reflected expansion are
classified structurally before checking. Their headers and selected applications
remain checked. Every deferred declaration is retained as coverage evidence and
listed by `--stats`. Checking non-static structure within these unspecialized
bodies is a separate follow-up. The whole-body deferral is an explicit native
coverage gap: bootstrap checks the exact format and reflect libraries and rejects
injected invalid non-static returns with SEM0129.

LIFE-002 inference preserves field-derived nominal variance. An unchanged phantom
requirement row does not block shortening another lifetime argument, but a
requirement key mentioning that lifetime remains invariant, including subtraction
terms. Exclusive referents, opaque storage and other invariant boundaries remain
invariant. Ordinary outlives and contents bounds admit inference shortening when
their longer side or subject does not mention the shortened binder. This only
changes inference candidates: every final applied bound is still proved.

Focused Cases cover unused invalid bodies and headers, imported modules,
conditional availability, unchanged emission reachability, concrete OWN0016,
static-template deferral, and positive and invariant-negative inference controls.
The ordinary stdlib-root CI test build copies the canonical library sources into
one package directory and overlays the manifest and aggregate from
`compiler/fixtures/stdlib-root`. The aggregate imports every standard-library
module except the four application-dependent startup modules (`native_start`,
`native_start_sync`, `raw_start`, and `wasm_start`). Test mode supplies the
discovery context used by `silk/test_runner` and selects the normal hosted
startup with a compatible application, so `native_start` is still reached and
checked. An inventory check keeps the aggregate in sync with the library manifest
and source files. The compiler self-build selects `native_start_sync`. Main CI's
bootstrap conformance builds exercise `raw_start` through
`packages/compiler/conformance/raw-linux/run.mjs` and `wasm_start` through
`packages/compiler/conformance/execution-storage/wasm.mjs`. Their native LLVM IR
builds currently stop at separate backend gaps (`foreign-contract` and
`c-abi-target`); the stdlib-root gate does not claim native backend coverage for
them. Native verification also includes N1/N2 smoke tests and byte-identical
compiler IR, affected Cases roots, workflow entry builds, the complete corpus and
gap guard.
On ARM64 development machines N1 is built with the coordinator's shared native
compiler; the pinned-seed chain and bootstrap double compilation run in CI.

Sweep cost is measured against the PR base using isolated before/after one-shot
compiler builds, several samples, user CPU and peak RSS. Cost acceptance and any
change to the checking structure are decisions for the coordinator and Julia.
