# Compilation settings and package parameters

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
`aarch64-unknown-linux-gnu`, `x86_64-pc-windows-msvc`, `wasm32-unknown-unknown`, `wasm32-wasip1`, `wasm32-wasip2`, and
`wasm64-unknown-unknown`. Each has a versioned machine description
with architecture, operating system, ABI, object format, endianness, primitive widths and
alignments, address spaces, stack alignment, supported CPU features and toolchain class. Target
selection is independent of the host. Only an application edge can explicitly supply host facts
when neither a request nor a compilation names a target.

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

A compilation may also set `max-memory`, the most linear memory a wasm32 module may grow to: a
whole number of bytes, `KiB`, `MiB` or `GiB` that is a positive multiple of the 64 KiB page and at
most 4 GiB, such as `max-memory = "256MiB"`. It is a final-link setting, not an initial fact, so it
never enters source specialization or its identity. Another target refuses it as an unsupported
combination. A multi-threaded wasm32 profile defaults it to 1 GiB (THREAD-009).

A compilation may also set `stack-size`, the wasm32 main thread's stack: a whole number of
bytes, `KiB`, `MiB` or `GiB` that is a positive multiple of 16, below 4 GiB, and below `max-memory`
when that is set, such as `stack-size = "8MiB"`. Without it the main stack is 1 MiB, the size the
runtime gives each new thread (THREAD-009). The stack sits below the module's data, so a program
that recurses past it traps with an out-of-bounds memory access. Like `max-memory` it is a
final-link setting outside the profile's identity, and another target refuses it as an
unsupported combination.

A compilation may set `codegen-units`, a whole number from 1 to 256: how many codegen units an
optimized executable splits into (one module when unset or `1`). It changes no
source-visible fact, but it is part of the profile's identity, so each count keeps its own cache.

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

A command binds values with `Package.set(module, name, Deferred<T>)` and attaches that package
configuration through `Compilation.package(alias, package)`. The alias must already be declared
in `[dependencies]`; `self` selects the root package. A required public parameter without a
binding fails when the compilation request is resolved, before code generation.

`T` implements `Schema`, `Parameter`, and `Transferable`. The ordinary library encoder preserves
nominal enum identity, integer precision, records, sequences and nested optional layers. A deferred
producer is evaluated before the parameter is encoded. `Package.supplyPath` grants a package plan
access to a physical path; `Package.path` instead resolves an included dependency asset.

The request uses the schema of `silk.build.request.ParameterValue`: `Text { value }`,
`Boolean { value }`, `Integer { decimal }`, `Enum { nominal, member }`, `None`, `Some { value }`,
`Sequence { values }`, and `Record { fields }`. Each record field has a name and another value.
The schema readers and writers define the TOML and JSON representation; callers do not maintain
another binding parser.

Integer decimal strings avoid JSON numeric precision loss. Type checking supplies the declared
integer width and record identity; external callers cannot forge a resolved static value.

The resolved request records each parameter's canonical module, name, value and provenance.
Explicit compilation bindings override package defaults. Multiple bindings for the same parameter
at the same tier are conflicts, even when their values are equal. Every binding is checked for
identity, visibility, type and provenance; a failed binding cannot become a source fact.

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
`relocation`, `optimization`, `safety`, `threading`, `unwind`, `runtime-kind`, `runtime-name`, `backend`; flag key is `debug`;
set keys are `cpu-features` and `sanitizers`. Invalid keys are structured static diagnostics.
Ordinary Silk wrappers own nominal domain enums and ergonomic operations. Package parameters are
read by declaration identity, not through arbitrary library-field key lookup. No ordinal target
`Profile` or `Intrinsic.targetProfile` operation exists.

Commands select settings through `Compilation`; built-in commands expose `--target`,
`--optimization none|speed|size`, `--release`, and `--debug`. The default is host-target development:
unoptimized with debug information. Release selects speed with debug information disabled unless
explicitly requested. Requests carry the complete normalized profile, using kebab-case schema keys.
`backend` selects LLVM or the direct WebAssembly backend. Preview 2 components also need wasm-tools.

The language server selects a saved compilation request and uses its package graph, parameters,
native inputs and profile. It may refresh the graph through a sandboxed `plan` task in a trusted
workspace. Read-only source commands never execute a task. There are no named manifest profiles or
JSON command-line profile overrides.

Per-package `Package.optimize` and `Package.debug` affect code defined by that package, including
generic instantiations used elsewhere. They do not change `silk.core.compilation` queries or
semantic cache identity. Units with distinct settings are optimized separately without cross-unit
inlining; intermediate outputs preserve those settings too. Program settings remain the defaults
for packages without an override.

Entry and runtime selections use `default`, `none`, or a named symbol/composition.

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

The default CPU model is `x86-64` on x86-64, `apple-m1` on `aarch64-apple-darwin` and `generic`
elsewhere. `x86-64` and `generic` guarantee only the baseline; `apple-m1`, the oldest CPU of an
AArch64 Mac, also guarantees `aes`, `crc`, `crypto`, `dotprod`, `fullfp16`, `lse`, `rdm`, `sha2` and
`sha3`. x86-64 also admits the microarchitecture levels `x86-64-v2` (`cx16`, `popcnt`, `sse3`,
`sse4.1`, `sse4.2`, `ssse3`), `x86-64-v3` (v2 with `avx`, `avx2`, `bmi`, `bmi2`, `f16c`, `fma`,
`lzcnt`, `movbe`, `xsave`) and `x86-64-v4` (v3 with `avx512bw`, `avx512cd`, `avx512dq`, `avx512f`,
`avx512vl`). A native build always names its model to Clang, and a ThinLTO link generates code for the same
model and features.

At the command-line edge, `--cpu native` asks the machine that runs the compiler, through
`silk.simd.cpu`, and adds each catalog feature it has to the compilation CPU features; the model stays the default.
The frozen profile therefore names a concrete feature list, and two machines with the same
features share caches. Only the compiler's own target can be native; another target with
`native` is an unsupported combination of CPU selection. `InitialProfile.freeze` itself never
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

An optimized (`speed`) executable is one module unless its profile sets `codegen-units`
above 1. Then, when it holds more than 4 MB of bitcode, it splits into that many codegen units,
which Clang optimizes on separate threads; an unoptimized build already splits by module. The units follow the call graph:
a function that only one group of functions calls joins that group, up to an even share of the
program, and every unit keeps its own internal copy of each function that asks to be inlined that
it calls. The split keeps a rebuild after an edit small. The edited part of a program is the
functions the root package and its `path` dependencies declare, and every function that reaches
one of them; the rest, such as the standard library and fetched dependencies, is split as if the
edited part were absent, so its units hold the same bytes after an edit and their objects and the
link's results for them are reused. The edited part takes a share of the units by its size, at
least one, and each of its functions goes to the unit its declaring module picks, so an edit to
one module recompiles one unit. The link also generates again the code of each unit that inlines
a function of that unit. A window program of 22,000 functions rebuilt in 7 s after an edit to its
application module, in 16 units on 4 cores, and in 1m58 from nothing; as one module each took over
5 minutes. The units compile for ThinLTO, and lld links them, or wasm-ld for a wasm target: the link imports what each unit calls
from the others, inlines it, and generates each unit's code on its own thread, keeping each result
in a cache beside the units' objects. A split program runs slower than one module, and its code is
larger: the compiler ran 3% slower in 16 units, and silkjs 10% slower and 30% larger. A wasm32 UI page
built in 1m24 in 8 units on 4 cores instead of 3m29, and was 9% larger. With
no lld beside Clang (`ld.lld`, or `ld64.lld` for macOS), with a platform supply's own linker, on
Windows, or in a build with debug information, the program stays one module.

## PROFILE-008 — Generated source

Generated modules are graph outputs. Use `WriteFiles` for authored text, `Run` for an external
generator, or an ordinary type implementing `Step` for a custom generator. Pass a producer's
`Deferred<Path>` to `Compilation.moduleFile` or `Plan.module`. The runner executes reachable
producers before resolving the compilation and fingerprints their inputs and outputs.

Maintenance generation belongs in an ordinary task variant. A task that updates committed source
can expose its own check mode and compare the resulting bytes. Fetching or importing a package
never runs a maintenance task. Manifests do not describe generators or build hooks.

## PROFILE-009 — Build plans

A package declares its portable build requirements in a `build.silk` beside `silk.toml`.
The file exposes a typed `pub const PLAN: Plan`. Its values use the same deferred paths and
standard `Run` and `WriteFiles` steps as root task graphs:

```silk,ignore
import silk.build.plan { Library, Plan }
import silk.build.source { Source }
import silk.build.step { sourcePath }
import silk.build.write_files { WriteFiles }
import silk.core.static_text { StaticText }

static fn plan() -> Plan {
  let files = WriteFiles.empty()
    |> WriteFiles.literal("limit.silk", StaticText.concat("pub const LIMIT: i32 = ", Source.text("limit.txt")))
  return Plan.empty()
    |> Plan.module("generated_limit", WriteFiles.result(&files, "limit.silk"))
    |> Plan.compileC(sourcePath("native/shim.c"))
    |> Plan.linkLibrary("m", Library.dynamicSearch())
}

pub const PLAN: Plan = plan()
```

The compiler evaluates the constant in an isolated analysis that imports only the standard library.
Static construction runs no processes and reads package files only through `silk.build.source`.
The resulting ordinary values describe dependencies; the build runner executes their producers
before resolving generated modules and native inputs. The compiler decodes typed native records
directly. There is no serialized plan language or generated manifest.

`Plan.module` accepts a canonical module path and a deferred file. Native source, include, archive,
object, search-directory, linker-script, and function-order methods also accept deferred paths.
A plan contributes its requirements whenever the package is compiled. Invalid plans, missing
outputs, duplicate modules, and modules that shadow existing package files refuse the build.

Parameters declared by `build.silk` are bound only in its isolated analysis. `Package.supplyPath` grants
read access to an explicitly supplied host path through a text parameter in that file. Such a
parameter cannot become a source-code parameter or a source profile identity.

## PROFILE-010 — Build tools

A plan describes a process with the standard `Run` step. Passing a deferred input records its
producer dependency; output arguments name files below the step's private output directory:

```silk,ignore
import silk.build.plan { Plan }
import silk.build.run { Run }
import silk.build.step { sourcePath }

static fn plan() -> Plan {
  let generator = Run.command("tools/gen.sh")
    |> Run.input(sourcePath("tables.txt"))
    |> Run.output("tables.silk")
  return Plan.empty()
    |> Plan.module("generated_tables", Run.result(&generator, "tables.silk"))
}

pub const PLAN: Plan = plan()
```

The process runs in its private content-addressed graph directory. Arguments contain the resolved
absolute paths of its declared inputs and outputs. It must exit successfully and write every
output. Its executable, arguments, declared file and tree contents, sandbox launcher, and producer
keys determine its cache identity. Package plans cannot capture ambient environment variables.
`WriteFiles` runs through the same graph without starting a process and requires no tool permission.

The root package's steps always run. A dependency's steps run only when the dependency entry grants tool permission:

```toml
[dependencies]
tables = { path = "../tables", tools = true }
```

A step runs in an operating-system sandbox. On Linux 6.7 or newer it runs under Landlock: it reads
and runs only files below `/usr`, `/bin`, `/lib`, `/lib64`, `/etc`, `/dev` and `/proc`, its program
and its declared inputs, writes only its output directory, and can neither bind nor connect a TCP
socket; where the kernel allows an unprivileged user namespace, it also has no network interface
but loopback. On macOS it runs through `sandbox-exec` with a profile that denies everything but
running programs, reading the system directories, its program and its inputs, and reading and
writing its output directory, so it has no network at all. A host without a supported sandbox refuses tools unless the command explicitly selects
`--unsandboxed-tools`. That choice runs the package tools with the caller's rights and is part of
the request-resolution cache key. Editor refresh never enables it.
`SILK_NO_TOOL_SANDBOX` set makes a host behave as one without a sandbox.

## PROFILE-011 — Project templates

`silk init [path] --template <template>` (or `-t <template>`) creates the project from one
directory of a GitHub repository. Without `--template`, a package comes from the official
`default` template, `silk-lang/examples/default`. `--template minimal` never fetches anything: the
compiler writes its own minimal package, as it does for `--lib` and `--workspace`. The template is written
`<owner>/<repository>[/<directory>...][@<revision>]`:

- One segment alone names a directory of the official examples: `silk init -t ui` is
  `silk init -t silk-lang/examples/ui`.
- Two segments name a repository whose root is the template, such as `julia-script/starter`.
- More segments name a directory inside the repository, such as `julia-script/starters/cli`.
- `@<revision>` picks a branch, a tag or a full commit hash; without it the default branch is used.

The repository is fetched with the `git` on `PATH`, without history, into a scratch directory
below `$SILK_HOME/git` (`$HOME/.silk/git` when `SILK_HOME` is unset) that is removed afterwards.
The template's directory must hold a `silk.toml` with a `[package]` or a `[workspace]` table.
Every file in it is written to the project directory, keeping executable bits and symbolic links;
a file that already exists there refuses the whole template before anything is written. For a
package, the new manifest gets the package name (`--name`, or else the directory's name) and this
compiler's release as `silk-version` and loses the template's `description`, and a package outside a workspace gets `/build/` in its
`.gitignore`. A package created inside a workspace becomes one of its members, as `silk init`
makes it. A workspace template takes no `--name`, and only a `silk-version` it pins is updated.
`--template` cannot be combined with `--lib` or `--workspace`.

`silk init --list [template]` (or `-l`) lists the templates in a template's directory and every
directory below it, the official examples at the root of `silk-lang/examples` when no template is
given. A template is each directory with a `silk.toml` that is not inside another template, so a
workspace's members are part of their workspace. Each line gives the name `--template` takes
(the short form for an official example) and the manifest's `[package].description`, when it has
one.

A template adjusts the new project with `[[post-init]]` entries in its `silk.toml`. `run` is the
command line: the program, then its arguments, where a
program with a `/` is a path below the template's directory and a bare name is searched on `PATH`.
`arguments = true` also passes the entry every argument given after `--`.

```toml
[[post-init]]
run = ["git", "init", "--quiet"]

[[post-init]]
run = ["scripts/post-init.sh"]
arguments = true
```

The entries are removed from the new manifest before they run, so they run once. They run in order
in the project directory after every file is written, in the sandbox `build.silk` tool steps use
(Landlock on Linux 6.7 and later, `sandbox-exec` on macOS): an entry reads the system's programs
and libraries and the new project, writes only the new project and a scratch `HOME`, and opens no
TCP connection. Its environment is only `PATH` (`/usr/local/bin:/usr/bin:/bin`, where a bare
program name is searched), `HOME` and `TMPDIR` (the scratch directory) and `SILK_VERSION`, this
compiler's release (such as `0.1.0-dev.50+e1a2bc7cec4a`). A template therefore cannot read your
files, reach the network or change anything outside the project it creates. A host with no
sandbox refuses a template with entries unless `--unsandboxed-post-init` is given, which runs them
with the caller's environment and full access after a warning.

An entry gets only its own arguments unless it sets `arguments = true`: then
`silk init app -t ui -- --dark` runs `scripts/post-init.sh --dark`. Arguments after `--` for a
template with no such entry are refused before anything is written. A failing
entry stops the rest, and `silk init` then removes every file and directory it created, restores a
`.gitignore` it changed and exits 1. A template it cannot fetch or use also exits 1, and a failed fetch prints git's reason and
suggests `-t minimal` for an offline project; a malformed
template or a file in the way exits 2. Builds never run an entry; they only refuse a malformed
one, naming its manifest line.

After a project is created, `silk init` prints one line naming it: `Created`, the project, and
where it came from. The project is its directory relative to the working directory, or the package
name (a workspace's directory name) when it was created in the working directory. A template is
named by its directory for the official examples, such as `the ui template`, and by its full
spelling otherwise, followed by the first seven characters of its commit:

```text
  Created myapp from the default template (c344420)

  Next steps:
    cd myapp
    silk run   build and run it
```

`--lib` prints `Created library <project>`, `--workspace` prints
`Created workspace <project> with package <name>`, and `-t minimal` prints
`Created <project> from the minimal template`. A package created inside a workspace adds
`Added <member> to the <workspace> workspace`, naming the member as the workspace lists it.

Then come the next steps: `Next steps:`, then `cd <directory>` with the project directory relative
to the working directory (quoted for a POSIX shell when it needs it, and left out when the project
is the working directory), then one line per step, with its description dimmed in a column beside
the command. The steps are the template's `[template].next-steps`, an array of tables: `run` is the
command and `description`, which is optional, says what it does; each is one nonempty line without
control characters. `next-steps = []` prints no next steps at all. Without it, the step is
`silk test` (`run its tests`) for a package whose `kind` is `library` and `silk run`
(`build and run it`) otherwise, which is also what `--lib`, `--workspace` and `-t minimal` print.
The `[template]` table, like the `[[post-init]]` entries, is removed from the new manifest. No
next steps are printed when `silk init` fails, including when it cannot add the package to its
workspace.

Every line is indented by two spaces, and the next steps by four. When standard output is a
terminal, `TERM` is not `dumb` and `NO_COLOR` is unset or empty, `Created` and `Added` are bold
green, the project and `Next steps:` bold, and the commit and the descriptions dim; otherwise the
text is the same without escape codes.

```toml
[template]
next-steps = [
  { run = "silk task dev", description = "start the dev server" },
  { run = "silk test" },
]
```
