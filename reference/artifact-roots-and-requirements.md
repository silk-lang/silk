# Artifact roots and native requirements

An artifact combines selected source, an application binding, an optional source runtime, explicit
retention roots and a logical native dependency plan. This chapter specifies the JUL-125 foundation;
physical supply discovery and replacement of the default hosted startup are separate changes.

## ARTIFACT-001 — Form, stage and runtime are separate

**Status:** Candidate.

**Rule:** Native artifact forms are executable image, loadable module, static archive and relocatable
object. LLVM IR, bitcode, assembly and intermediate object are emission stages. The normalized
profile selects a default, named or absent runtime independently of form. The build/package graph
supplies named runtime descriptors and default candidates; exactly one source root or none resolves.
An invalid or absent explicit composition never falls back to a hosted runtime.

**Example:** A profile with `artifact = "object"` and `runtime = { kind = "none" }` produces a
relocatable object without requiring `main`. The same logical form can be inspected at its LLVM IR
stage before machine emission.

**Boundary:** Two default runtime candidates are ambiguous even when both compile for the target.
A named request that is not in the build catalog is an error. LTO is not admitted.

**Diagnostics:** Configuration errors identify every ambiguous candidate or the missing request's
origin. Unsupported combinations are rejected before tool execution.

**Evidence:** JUL-125; Native OS Integration Plan D-013; `explicit-artifact-roots` OpenSpec change.

## ARTIFACT-002 — Runtime source imports the exact application

**Status:** Candidate.

**Rule:** The compilation root is the explicit application module. A selected runtime is an
additional analysis root. `Intrinsic.application` is the sealed generic import binding for the
application; it resolves to the same canonical module identity, not a copy or a privileged library.
Ordinary visibility and selective/public import rules apply. Unselected runtime sources are not
loaded. A runtime descriptor names a source module; ordinary calls in that module select the
application function and adapt its result. Runtime descriptors do not name an invocation function.
The distribution selects `silk/native_start` for hosted executables and `silk/wasm_start` for
standalone WebAssembly executables. Their source C exports define `main`. Explicit libraries,
objects, and runtime-none profiles acquire no default startup or storage component.

**Example:**

```silk
import Intrinsic.application
export "C" fn answer() -> i32 as "answer" { return application.answer() }
```

The application can expose `pub fn answer() -> i32 { return 42 }` without defining `main`.

**Boundary:** A private application member is not accessible through this import. An active binding
outside an artifact request with an application root is unavailable. Self/cyclic imports follow the
ordinary module rules.

**Diagnostics:** Missing bindings diagnose at the import; inaccessible members at the use; missing
runtime source at its configuration origin. Inactive imports produce no failure.

**Evidence:** D-013; selected module closure rules; artifact-root-planning specification.

## ARTIFACT-003 — Explicit retention does not export a declaration

**Status:** Candidate.

**Rule:** Active foreign exports and explicit retention selectors seed native reachability. A
selector names a canonical module and one unambiguous monomorphic runtime function. It may select
a private function; it does not change visibility or create a C ABI export. Public visibility alone
does not retain a function. The selected runtime/module graph is analyzed before these roots are
resolved. No-runtime compositions may be empty.

**Example:** Retaining `{ module = "support", declaration = "capability" }` keeps a private
`fn capability() -> i32 { return 7 }`, while an unrelated public function in that module can disappear.

**Boundary:** Static/generic declarations and ambiguous overload names are not retention roots.
Duplicate active foreign exports are invalid. An archive keeps its retained definitions, but a
later unrelated link does not automatically extract an otherwise unused archive member.

**Diagnostics:** Invalid root roles identify the selector and relevant declarations; duplicate
exports relate every active definition before emission.

**Evidence:** LLVM 22.1.8 LangRef `llvm.used`; artifact-root-planning specification.

## ARTIFACT-004 — Loader entry is a symbol policy

**Status:** Candidate.

**Rule:** Profile `entry` is default, none or a named loader/linker symbol. It does not select a Silk
application function and does not imply a foreign export. A named symbol may come from an explicit
link input. The request remains in logical identity at every emission stage. Final tool plans must
honor an admitted policy or reject the combination; they cannot ignore it.

**Example:** `entry = { kind = "named", name = "boot" }` can refer to an explicit startup object.
The application's ordinary function may have a completely different name.

**Boundary:** A library/object form cannot silently acquire a process entry from an unrelated
runtime invocation. Contradictory hard entry requests are errors.

**Diagnostics:** Unsupported form/policy combinations and conflicting entry requests retain their
configuration origins. Missing physical symbols remain final-link failures.

**Evidence:** D-013; artifact-root-planning specification; pinned target linker conformance.

## ARTIFACT-005 — Native requirements have an attachment scope

**Status:** Candidate.

**Rule:** `with Intrinsic.native(...)` on a foreign declaration activates with that declaration's
reachability. A standalone `module with Intrinsic.native(...)` clause activates when its selected module belongs to the closure,
even if no function in it is reachable. Artifact configuration requirements always activate for the
artifact. Multiple sealed function clauses compose; native requirements do not change foreign
behavioral contracts. Module clauses may occur inside module-level static selection.

**Example:**

```silk
module with Intrinsic.native(kind: "startup-object", name: "startup")

unsafe extern "C" fn readValue() -> i32 as "read_value"
  with Intrinsic.foreign(memory: "read")
  with Intrinsic.native(kind: "library", name: "values", linkage: "dynamic")
```

The startup requirement is module-bound. The values library is required only when `readValue`
enters the artifact's reachable foreign set.

**Boundary:** An unreachable foreign declaration or inactive module branch contributes no
requirement. A source clause cannot request artifact scope, a filesystem path or a raw command.
No symbol or standard-library actor spelling implies a dependency.

**Diagnostics:** Unsupported attachment and malformed clauses diagnose at the clause and offending
property. Reachability alone does not suppress ordinary errors in active declarations.

**Evidence:** D-015; artifact-root-planning specification.

## ARTIFACT-006 — Logical constraints merge without overrides

**Status:** Candidate.

**Rule:** Required literal fields are `kind` and `name`. Kinds are `library`, `framework`,
`startup-object`, `linker-script`, `prebuilt-object` and `prebuilt-archive`. Names and alternatives
are logical identifiers, never machine paths. Optional `linkage` is `static` or `dynamic` for a
library only. `minimumDeployment` and `maximumDeployment` are numeric version bounds;
`alternatives` is a nonempty tuple of permitted logical provider names. Unknown or duplicate fields
are invalid. Module/declaration attachment determines scope; build records supply artifact scope.

Requirements with the same kind/name collapse exact duplicates, retain all origins and combine
compatible constraints: linkage must agree, version bounds intersect, and alternatives intersect.
A build choice must satisfy that intersection. Final linking needs explicit physical bindings until
the separate supply resolver is available. Physical input lists preserve order and duplicates.

**Example:** Two requirements admitting alternatives `( "system", "custom" )` and `( "custom", )`
merge to `custom`. Their source locations both remain visible in plan inspection.

**Boundary:** Static and dynamic hard requirements for the same library conflict. Empty alternative
intersections and inconsistent deployment intervals conflict; configuration cannot override them.
A logical library name does not itself authorize searching a host SDK.

**Diagnostics:** Conflict diagnostics identify every contributing origin, including artifact
configuration. Missing or inadmissible explicit supply bindings diagnose before final tool execution.

**Evidence:** D-015; artifact-root-planning specification.

## ARTIFACT-007 — Inspectable identity accounts for semantic choices

**Status:** Candidate.

**Rule:** The logical plan exposes profile, form/stage, requested and resolved application/runtime/
retention roots, runtime selection rule, loader request/symbol, active exports, selected source
content, active requirement scopes/constraints/origins, codegen settings and compiler identity.
Canonical logical identity ignores incidental construction order and machine-local storage paths.
It distinguishes default/named/none selection rules even when they resolve to the same source or
symbol. Ordered physical identity is composed separately for emission/link caching.

**Example:** Reordering equivalent retention selectors leaves identity unchanged; changing the
selected private declaration or the bytes of a selected module changes it.

**Boundary:** Unselected catalog module content does not enter the selected closure identity.
Physical input order cannot be sorted or deduplicated as if it were a logical set.

**Diagnostics:** No diagnostic applies to valid identity comparisons. Invalid inputs are rejected
before a successful plan is published.

**Evidence:** D-013/D-015; artifact-root-planning specification and native conformance requirements.

## Build configuration

`build.stage` accepts `final` (default), `llvm-ir`, `llvm-bitcode`, `assembly` or `object`.
`build.artifact` additionally accepts `object`. Intermediate destinations use `.ll`, `.bc`, `.s`
or `.o`; `silk run` requires a final executable. A build can select an ordinary source runtime and
retain private support code:

```toml
[build]
artifact = "object"
stage = "final"
composition = { runtimes = [{ name = "custom", module = "runtime" }], defaults = ["custom"], retention = [{ module = "support", declaration = "keep" }], requirements = [] }
```

Profile `runtime = { kind = "none" }` overrides default candidates by explicitly selecting no
runtime. Foreign exports in the selected source and explicit retention declarations are roots.
A custom runtime may call any visible application function with arguments and result handling
expressed in ordinary Silk. The compiler imposes no special application function shape.

Native requirements are resolved by explicit build bindings, preserving their listed input order:

```toml
[build]
artifact = "shared-library"
composition = { requirements = [{ kind = "library", name = "values", linkage = "dynamic", alternatives = ["system"] }] }
native-bindings = [{ kind = "library", name = "values", alternative = "system", inputs = [{ search-path = "native/lib" }, { library = "values", mode = "dynamic" }] }]
```

Binding input paths resolve relative to the manifest. Library bindings admit library inputs and
static archives according to hard linkage; framework, script, object and archive requirements admit
the corresponding typed payload. Scripts use `{ linker-script = "relative/script.ld" }` and are
admitted only by GNU/Linux final tool plans. No raw linker options are accepted. Object/archive
forms preserve unresolved link requirements in the logical plan; final executables/modules require
every active requirement to have an admitted binding. Explicit flat `native-link-inputs` retain
their existing ordered build semantics and do not override source requirements.

Named loader entries are exact linker symbols, including any target-specific spelling. Final
library/object forms reject named entries. GNU/Linux executable `entry = { kind = "none" }` uses
an absent entry and omits default startup files; Darwin executable absence is unsupported. A named
executable entry also omits default startup files. Intermediate stages preserve these requests
without performing a final link.

`Analysis.Snapshot.artifactPlan`, `Realization.Prepared.artifactPlan` and `Driver.Compiled.artifactPlan`
expose the logical plan. The compiler inspector's **Instances** view includes its identity, runtime
and loader selections, roots, exports and requirement constraints with every source/configuration
origin. `Driver.Compiled.nativeBindings` exposes the chosen physical alternatives separately.
