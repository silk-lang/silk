# Compilation profiles and package configuration

A compilation profile is the immutable logical input shared by static evaluation, semantic
analysis, artifact planning and developer tools. The profile is published after package schemas,
defaults, bindings and validation resolve. This reference specifies the JUL-120 contract; its
implementation checklist is `openspec/changes/add-structured-compilation-profiles/tasks.md`.

## PROFILE-001 — Initial facts and complete profiles

Initial inputs describe a canonical target and logical artifact/build choices. They contain no
resolved package parameters. The compiler freezes those inputs before resolving registered schemas. A
complete profile additionally contains every resolved package parameter and its origin. Only a
complete, validated profile can enter ordinary specialization or backend work. Failed bootstrap
returns diagnostics and publishes no partial profile.

The four initial canonical targets are `aarch64-apple-darwin`, `x86_64-unknown-linux-gnu`,
`aarch64-unknown-linux-gnu` and `wasm32-unknown-unknown`. Each has a versioned machine description
with architecture, operating system, ABI, object format, endianness, primitive widths and
alignments, address spaces, stack alignment, supported CPU features and toolchain class. Target
selection is independent of the host. Only an application edge can explicitly supply host facts
when neither a request nor a selected project profile names a target.

The profile separates these domains:

| Domain                | Logical choices                                                       |
| --------------------- | --------------------------------------------------------------------- |
| CPU                   | model and an unordered feature set                                    |
| Deployment            | optional minimum logical platform version                             |
| Libc                  | none, system, GNU                                                     |
| Artifact              | executable image, loadable module, static archive, relocatable object |
| Entry                 | default, named symbol, none                                           |
| Link                  | static or dynamic                                                     |
| Code model            | small or large                                                        |
| Relocation            | static or position independent                                        |
| Optimization          | none or speed                                                         |
| Debug information     | enabled or disabled                                                   |
| Safety                | checked or unchecked library policy                                   |
| Threading             | single or multi library policy                                        |
| Sanitizers            | an unordered set of address, thread and undefined requests            |
| Unwind                | none or native                                                        |
| Runtime               | default, named package composition, none                              |
| Package configuration | typed values keyed by package/module/parameter identity               |

Safety and threading choices are source-visible policy requests; they never change the language's
ownership or type rules. Logical runtime, entry and native link requests do not resolve startup
roots, runtime packages, SDKs or sysroots. Their later resolution has separate contracts.
Unsupported combinations must be diagnosed before use, including unsupported CPU features,
conflicting sanitizers, Darwin GNU-libc selection and native-only choices on WebAssembly.

## PROFILE-002 — Unconditional package schemas

The grammar of a package parameter is:

```text
parameter = ["pub"] "param" identifier ":" type ["=" expression] ["where" expression]
```

A parameter is an unconditional module declaration with an explicit concrete type. An application
request explicitly registers the modules whose package parameters participate in its profile.
Registration uses canonical module identities; importing a module, including through an alias,
does not register its schemas. A registered module contributes every package parameter it declares,
even if no source expression reads it. An unregistered parameter cannot be demanded by a default,
validation expression, or ordinary static helper.

The parameter is an
immutable static value in ordinary Silk expressions. It cannot be declared inside a function,
conditional declaration, implementation or type. A public parameter can omit its default, in
which case an external binding is required. A private parameter requires a default and rejects
external bindings.

The optional `where` expression must evaluate to `bool`. It runs after all final values resolve,
and the parameter name denotes its final value. It can refer to other resolved parameters or call
ordinary static helpers. A false result rejects the configuration. A helper can call
`compileError` to report a more specific failure. Validation cannot mutate values.

For example, the declaration `pub param enabled: bool = false` allows a build to bind a boolean
that ordinary static helpers observe. The declaration `pub param workers: u32 = 1 where workers > 0`
validates both the default and externally supplied values.

A parameter identity consists of package `name@version`, canonical module path relative to that
package, and declared name. Import aliases do not affect identity. Physical checkout paths are not
identities. The source provider must reject unequal source packages that claim the same logical
identity within one graph. A standalone source request supplies its logical package identity
explicitly at the application edge.

## PROFILE-003 — Values and external bindings

Admitted types are integers, booleans, strings, nominal enums, optionals, arrays and records
recursively containing admitted values. An optional is any nominal union with exactly one fieldless variant and one single-field variant;
variant and payload field spellings are not compiler-recognized names. The `none` and `some`
transport cases map to those shapes. Integer range and signedness, enum type and member,
optional element type, array length/element type, and record fields are checked without coercion.
Callable values, runtime handles, resources, opaque identities and ambient capabilities are not
configuration values.

The portable binding transport uses tagged objects:

| Kind    | Transport                                                                       |
| ------- | ------------------------------------------------------------------------------- |
| Integer | `{ "kind": "integer", "value": "42" }`                                          |
| Boolean | `{ "kind": "boolean", "value": true }`                                          |
| String  | `{ "kind": "string", "value": "hello" }`                                        |
| Enum    | `{ "kind": "enum", "type": "package@version/module/Type", "member": "Choice" }` |
| None    | `{ "kind": "none" }`                                                            |
| Some    | `{ "kind": "some", "value": <value> }`                                          |
| Array   | `{ "kind": "array", "values": [<value>, ...] }`                                 |
| Record  | `{ "kind": "record", "fields": { "field": <value>, ... } }`                     |

Integer decimal strings avoid JSON numeric precision loss. Type checking supplies the declared
integer width and record identity; external callers cannot forge a resolved static value.

Each binding contains `package`, `module`, `parameter`, `value` and provenance. Its tier is assigned
by the request that contains it. Project and workspace bindings have one shared tier. Artifact
and selected-profile overrides have one higher tier. Package defaults have the lowest tier.
Multiple bindings for one parameter at one tier are conflicts, including equal values. Every
supplied binding is checked for identity, visibility, type and provenance. The highest valid tier
wins and retains its origin.

Provenance is `literal`, `translated-public`, `secret`, `physical-supply` or `runtime`. Public
translation supplies a concrete deterministic value and logical translator identity. Secret,
physical-supply and runtime inputs are rejected before their values enter diagnostics or caches.
No heuristic can reliably recognize arbitrary secret strings; build tools must label secrets.
Static Silk cannot inspect environment variables, discover supplies or invoke translation callbacks.

## PROFILE-004 — Bootstrap order and cycles

1. Freeze and validate initial machine and logical artifact/build facts.
2. Load explicitly registered modules and their unconditional schema headers; parse those files.
3. Resolve concrete schema types, including forward type references.
4. Validate external bindings and precedence, retaining source and request origins.
5. Resolve each final value on demand through the existing static evaluator. References see other
   parameters' final values. An overridden default is not executed.
6. Validate all predicates in stable parameter-identity order against the complete value map.
7. Publish the normalized immutable profile, then perform ordinary specialization.

Defaults can call forward-declared or unconditionally imported static helpers, use target facts,
and depend on other defaults. An in-progress dependency revisited during resolution is a cycle.
An explicit value can break a cycle by replacing the corresponding default. A schema type whose
shape depends on a parameter under construction is a bootstrap cycle. Merely loading an uncalled
helper does not execute its body.

Diagnostics distinguish missing/unknown/private bindings, same-tier conflicts, wrong types,
invalid defaults, failed validation, cyclic dependencies, non-static dependencies and unsupported
logical combinations. They identify applicable source spans and binding/default origins and order
cycle traces deterministically. A failed request cannot contaminate a subsequent profile.

## PROFILE-005 — Identity, queries and tooling

Canonical encoding includes its version, machine-description revision, every normalized logical
choice and all resolved typed parameter values. Feature/sanitizer sets and record/parameter keys
are sorted; arrays retain order; strings retain exact content. Enums include nominal type identity.
Physical paths, origins, output directories, host state and runtime discoveries are excluded.
Equal resolved logical inputs have equal identity regardless of allocation or input order.

Bootstrap cache keys additionally account for initial facts, effective bindings and demanded
source dependencies. Editing a referenced helper or default invalidates affected results even if
the target is unchanged. Completed evaluation keys combine final profile, source and application
identity. Cached values cannot substitute another request's diagnostic origins.

The sealed `Intrinsic` namespace exposes static-only `targetArchitecture`, `targetOperatingSystem`,
`targetAbi`, `targetObjectFormat` and `targetEndianness` queries returning `string`;
`targetPointerBits` and `targetPointerAlignment` return `u32`. Individual logical build domains are
queried through static-only `profileText(key: string) -> string`, `profileFlag(key: string) -> bool`
and `profileContains(key: string, value: string) -> bool`. Keys are closed compiler-owned domain
names: text keys are `cpu`, `deployment`, `libc`, `artifact`, `entry-kind`, `entry-name`, `link`, `code-model`,
`relocation`, `optimization`, `safety`, `threading`, `unwind`, `runtime-kind`, `runtime-name`; flag key is `debug`;
set keys are `cpu-features` and `sanitizers`. Invalid keys are structured static diagnostics.
Ordinary Silk wrappers own nominal domain enums and ergonomic operations. Package parameters are
read by declaration identity, not through arbitrary library-field key lookup. No ordinal target
`Profile` or `Intrinsic.targetProfile` operation exists.

A manifest selects its default with `build.profile`; `[profiles.<name>]` contains logical profile
inputs and `bindings`. `build.bindings` contains project-tier bindings. Each profile names its
`target` explicitly. A complete request override replaces project profile selection. CLI `--profile`
and LSP profile-name settings select a project profile; `--profile-input` and its LSP equivalent
provide the complete input object; target-triple shorthand selects a default logical input for
that target. Conflicting explicit modes are errors. Without an explicit mode, tooling uses the
project default, then an explicitly supplied host fallback. Compiler and language-server analysis
consume the same normalized model.

Named entry/runtime selections expose their kind separately from their name. A named value spelled `default` remains distinct from the default request.
