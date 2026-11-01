# Compilation profiles and package configuration

A compilation profile is the immutable logical input shared by static evaluation, semantic
analysis, artifact planning and developer tools. The profile is published after package schemas,
defaults, bindings and validation resolve. This reference specifies the JUL-120 contract.

## PROFILE-001 — Initial facts and complete profiles

Initial inputs describe a canonical target and logical artifact/build choices. They contain no
resolved package parameters. The compiler freezes those inputs before resolving registered schemas. A
complete profile additionally contains every resolved package parameter and its origin. Only a
complete, validated profile can enter ordinary specialization or backend work. Failed bootstrap
returns diagnostics and publishes no partial profile.

The canonical targets are `aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-unknown-linux-gnu`,
`aarch64-unknown-linux-gnu`, `x86_64-pc-windows-msvc`, `wasm32-unknown-unknown`, `wasm32-wasip1`, and `wasm32-wasip2`. Each has a versioned machine description
with architecture, operating system, ABI, object format, endianness, primitive widths and
alignments, address spaces, stack alignment, supported CPU features and toolchain class. Target
selection is independent of the host. Only an application edge can explicitly supply host facts
when neither a request nor a selected project profile names a target.

The Windows target uses the x86-64 instruction set, the Microsoft ABI, COFF objects and little-endian
storage. Pointers are 64 bits with 8-byte alignment; C `long` is 32 bits with 4-byte alignment
(LLP64). It uses the same CPU models and feature implications as the GNU x86-64 target.
Its profile defaults to `libc = "system"`, which names the Windows system DLL ABI, and rejects
`libc = "gnu"`. `libc = "none"` is available for objects and static archives.
The target supports no-CRT executable linking, objects and static archives, synchronous and
asynchronous runtime compositions, and Win64 scalar, aggregate and vector C boundaries.
See [native pointer boundaries](native-pointer-boundary.md) for aggregate layout restrictions
and [Silk on Windows](windows.md) for host requirements and filesystem scope.

The WASI command targets use `libc = "none"`, static linking and relocation, and single threading.
A Linux executable defaults to `relocation = "static"`: it loads at a fixed address and its code
is not position independent. `relocation = "pic"` builds it as a PIE. macOS executables are always
position independent, and objects and libraries default to `"pic"`.
Preview 2 final executables are components; intermediate artifacts use the WebAssembly core ABI.
See [WASI targets](wasi.md) for the command runtime and host-tool requirements.

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
| Optimization          | none, speed or size                                                   |
| Debug information     | enabled or disabled                                                   |
| Safety                | checked or unchecked library policy                                   |
| Threading             | single or multi library policy                                        |
| Sanitizers            | an unordered set of address, thread and undefined requests            |
| Unwind                | none or native                                                        |
| Runtime               | default, named package composition, none                              |
| Package configuration | typed values keyed by package/module/parameter identity               |

A project profile may also set `max-memory`, the most linear memory a wasm32 module may grow to: a
whole number of bytes, `KiB`, `MiB` or `GiB` that is a positive multiple of the 64 KiB page and at
most 4 GiB, such as `max-memory = "256MiB"`. It is a final-link setting, not an initial fact, so it
never enters source specialization or its identity. Another target refuses it as an unsupported
combination. A multi-threaded wasm32 profile defaults it to 1 GiB (THREAD-009).

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

A manifest writes values under `[config]` (project tier) and a profile's `config` (override tier).
A key is the root module's path and the parameter's name, as `main.limit = 42` or
`net.http.retries = 3` for `net/http.silk`, in the manifest's own package. The value is plain TOML
with no tags: an integer, a boolean, a string, or an array of them; an inline table inside an array
is a record. Assembly checks it against the declared type, and a refusal names the manifest line of
its key. Every manifest value has `literal` provenance.

`--profile-input` and other tools use the portable binding transport, which tags each value:

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
names: text keys are `target` (the canonical target name), `cpu`, `deployment`, `libc`, `artifact`, `entry-kind`, `entry-name`, `link`, `code-model`,
`relocation`, `optimization`, `safety`, `threading`, `unwind`, `runtime-kind`, `runtime-name`; flag key is `debug`;
set keys are `cpu-features` and `sanitizers`. Invalid keys are structured static diagnostics.
Ordinary Silk wrappers own nominal domain enums and ergonomic operations. Package parameters are
read by declaration identity, not through arbitrary library-field key lookup. No ordinal target
`Profile` or `Intrinsic.targetProfile` operation exists.

A manifest selects its default with `build.profile`; `[profiles.<name>]` contains logical profile
inputs and `config`. `[config]` contains project-tier package parameter values, keyed by the root
module's path and the parameter's name (`main.limit = 42`) and written as plain TOML that is checked
against the parameter's declared type. A profile's `config` holds override-tier values. A profile
that names no `target` builds for the host. Profile fields are kebab-case (`code-model`,
`max-memory`); the earlier `codeModel`, `maxMemory` and `bindings` are refused, naming the current
spelling. `--profile-input` JSON keeps `codeModel`, `maxMemory` and tagged `bindings`. Without a table
of that name, `dev` (unoptimized, with debug information) and `release` (optimized, without it) are
built-in profiles for the host. A complete request override replaces project profile selection. CLI `--profile`
and LSP profile-name settings select a project profile; `--profile-input` and its LSP equivalent
provide the complete input object; target-triple shorthand selects a default logical input for
that target. Conflicting explicit modes are errors. Without an explicit mode, tooling uses the
project default, then an explicitly supplied host fallback. Compiler and language-server analysis
consume the same normalized model.

Named entry/runtime selections expose their kind separately from their name. A named value spelled `default` remains distinct from the default request.

## PROFILE-006 — CPU models and features

Each target has a fixed catalog of CPU features, sorted by byte value and spelled as LLVM spells
them:

| Target       | Features                                                                                                                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| x86-64       | `aes`, `avx`, `avx2`, `avx512bw`, `avx512cd`, `avx512dq`, `avx512f`, `avx512vbmi`, `avx512vl`, `bmi`, `bmi2`, `cx16`, `f16c`, `fma`, `lzcnt`, `movbe`, `pclmul`, `popcnt`, `sha`, `sse2`, `sse3`, `sse4.1`, `sse4.2`, `ssse3`, `xsave` |
| AArch64      | `aes`, `crc`, `crypto`, `dotprod`, `fp-armv8`, `fullfp16`, `i8mm`, `lse`, `neon`, `rdm`, `sha2`, `sha3`                                                                                                   |
| wasm32       | `atomics`, `bulk-memory`, `mutable-globals`, `relaxed-simd`, `sign-ext`, `simd128`                                                                                                                         |

A feature outside the target's catalog is an unsupported combination. The frozen feature set is
the named features, the features the CPU model guarantees and the architecture baseline (`sse2` on
x86-64; `fp-armv8` and `neon` on AArch64), closed under implication: on x86-64 each SSE level
implies the one before it, `avx` implies `sse4.2`, `avx2`, `fma` and `f16c` imply `avx`, `avx512f`
implies `avx2`, `fma` and `f16c`, the other AVX-512 features imply `avx512f` and `avx512vbmi` also
implies `avx512bw`, and `aes`, `pclmul` and `sha` imply `sse2`; on AArch64 `crypto` implies `aes` and
`sha2`, `sha3` implies `sha2`, the vector features imply `neon`, and `neon` and `fullfp16` imply
`fp-armv8`; on wasm32 `relaxed-simd` implies `simd128`. `profileContains("cpu-features", f)`
answers for the closed set.

The default CPU model is `x86-64` on x86-64 and `generic` elsewhere; it guarantees only the
baseline. x86-64 also admits the microarchitecture levels `x86-64-v2` (`cx16`, `popcnt`, `sse3`,
`sse4.1`, `sse4.2`, `ssse3`), `x86-64-v3` (v2 with `avx`, `avx2`, `bmi`, `bmi2`, `f16c`, `fma`,
`lzcnt`, `movbe`, `xsave`) and `x86-64-v4` (v3 with `avx512bw`, `avx512cd`, `avx512dq`, `avx512f`,
`avx512vl`). A model other than the default is passed to Clang for tuning.

In a manifest profile, `cpu.model = "native"` asks the machine that runs the compiler, through
`silk.simd.cpu`, and adds each catalog feature it has to `cpu.features`; the model stays the default.
The frozen profile therefore names a concrete feature list, and two machines with the same
features share caches. Only the compiler's own target can be native; another target with
`native` is an unsupported combination of `cpu.model`. `InitialProfile.freeze` itself never
reads the host.

## PROFILE-007 — Profile-guided optimization

Two environment variables pass Clang's instrumentation-based profile-guided optimization through
`silk build`, for native targets only (a wasm build ignores them):

- `SILK_PROFILE_GENERATE=<dir>` builds an instrumented program. Each run writes a `.profraw` file
  into `<dir>` (Clang's `-fprofile-generate=<dir>`; `LLVM_PROFILE_FILE` overrides the file name).
- `SILK_PROFILE_USE=<file>` builds with the merged profile (`llvm-profdata merge -o <file>
  <dir>/*.profraw`). Functions the profile does not cover, or covers from older source, are
  compiled as usual without warnings.

Both variables are part of the build fingerprint, and the profile's content hash is part of every
object's cache key, so changing either the variable or the profile rebuilds the objects. The
profile describes one build of the program: regenerate it after changing the source or the
compiler.

## PROFILE-008 — Generated source

A package author declares each generator as a `[[generate]]` entry in the package manifest or the
workspace manifest. `run` is the command line: the program, then its arguments. A program spelled
with a `/` is a path below the manifest's directory; a bare name is searched on `PATH`. `outputs`
lists the files it writes, as paths below the manifest's directory; a `*` in the last segment
matches any run of bytes.

```toml
[[generate]]
run = ["scripts/generate-unicode", "--pinned"]
outputs = ["src/generated_tables.silk", "src/generated_*.silk"]
```

`silk generate [--check] [--manifest-path <path>]` runs the located manifest's entries in order
and then, for a workspace, each member's. A command runs in its manifest's directory with the
caller's environment plus `SILK_GENERATE=1` (Windows passes on the common system, user and Cargo
variables). While it runs, its declared outputs that already exist are moved aside to
`.<name>.silk-generate` beside them. An output it then writes with the same bytes gets the
original file back, so an unchanged rerun keeps every file's identity and modification time and
invalidates no build cache. The command prints `Created`, `Updated` or `Removed` for each output
that changed.

`--check` restores every original and removes every new file, so it never changes the tree, and
exits 1 naming each output that is stale, would be created or would be removed. A command that
fails or exits nonzero, or does not write an output declared without a `*`, leaves every output
as it was and makes `silk generate` exit 1. A manifest it cannot use exits 2.

Generated files are committed. `silk build`, `silk check` and dependents never run an entry; they
only refuse a malformed one, naming its manifest line.

## PROFILE-009 — Build plans

A package that needs more than its manifest's `[native]` keys can say puts a `build.silk` beside its
`silk.toml`. The file declares `pub const PLAN: string`, built with `silk.build.plan` from
`Plan.empty()`:

```silk,ignore
import silk.build.plan { Plan }
import silk.build.source { Source }
import silk.core.static_text { StaticText }

static fn plan() -> string<'static> {
  let mut plan = Plan.empty()
  plan = Plan.module(plan, "generated_limit", StaticText.concat("pub const LIMIT: i32 = ", Source.text("limit.txt")))
  plan = Plan.compileC(plan, "native/shim.c")
  plan = Plan.linkLibrary(plan, "m")
  return plan
}

pub const PLAN: string = plan()
```

Every build and check of the package, or of a package that depends on it, first evaluates each
package's `build.silk` on its own: a store whose only package is that file, in the package's
directory, importing only the standard library. The constant is computed by static evaluation, so a
plan runs no process, reaches no network and reads only the package's own files through
`silk.build.source`. Its steps then join the package as if written there:

| Step                                                      | Effect                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------ |
| `Plan.module(plan, name, source)`                         | Module `name` of the package, at its source root             |
| `Plan.compileC`, `compileObjectiveC`, `compileCpp`        | A `[native].sources` entry `{ c = path }` (or `objc`, `cpp`) |
| `Plan.linkLibrary`, `linkFramework`, `linkArchive`, `linkObject` | A `[native].link` entry                               |

A dependency's plan entries reach its dependents as its manifest entries do. A plan that cannot be
evaluated, a `PLAN` that is missing or not text `silk.build.plan` writes, and a generated module
that a file of the package also defines each refuse the build, naming `build.silk`, after the
diagnostics of its evaluation.
