# Loaded declaration checking (MODULE-004)

`main.silk` preloads the program through `ModuleSources.preloadProgram` before it
creates the semantic store. Build and test compile through `Semantic.buildRuntime`.
Its declaration sweep checks the active authored declarations in every loaded
runtime and application module independently of the executable instance walk.

The sweep follows active imports to closure and uses the existing query families
for headers, aggregate members, implementation contracts, constant initializers,
and function bodies. Availability queries exclude inactive static arms. Anonymous
bodies belong to their enclosing body demand; declarations without bodies have
only header demands. Generic bodies use the ordinary symbolic Body query,
including its borrow verdict and retained obligations.

Rejections keep their original codes, modules and spans, and independent
rejections are deduplicated. The sweep shares the semantic cache and profile with
the executable walk without adding LLVM emission roots. An unreferenced
well-typed function remains absent from emitted IR. Compiler-owned sealed glue
never requests an authored source module.

OWN0016 uses `localSharedEscapes` over concrete MIR `SuspensionSummary` values.
An analysis-only MIR closure checks otherwise unreferenced closed nongeneric,
provider-free runtime functions and their callback/call dependencies without
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
Native verification includes N1/N2 smoke tests and byte-identical compiler IR,
affected Cases roots, workflow entry builds, the complete corpus and gap guard.
On ARM64 development machines N1 is built with the coordinator's shared native
compiler; the pinned-seed chain and bootstrap double compilation run in CI.

Sweep cost is measured against the PR base using isolated before/after one-shot
compiler builds, several samples, user CPU and peak RSS. Cost acceptance and any
change to the checking structure are decisions for the coordinator and Julia.
