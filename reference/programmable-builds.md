# Programmable builds

A manifest identifies a package and declares its dependencies. A command constructs compilations and steps in ordinary Silk, then explicitly passes the graph to the runner. The runner resolves each compilation into a versioned TOML request before invoking `silkc compile --request <file>`.

## Commands

`build`, `run`, `test` and `plan` are reserved task names. Each has a built-in implementation. A variant in the root package's `tasks.silk` replaces that built-in. Other variants are project commands, invoked with `silk task <name>`.

A tasks module implements `CommandLine` and `TaskSet` for its command union and calls `Task.main<Tasks>()` from its entry. It declares nothing else. A package without a `tasks.silk` uses the built-ins directly. A package with one sends all four reserved commands to its tasks program, so that program is built first. For a reserved command the union has no variant for, `Task.main` runs nothing and the toolchain runs its built-in. Only the root package's tasks run. Dependencies contribute static `build.silk` plans and ordinary modules the root may import.

Commands embed `silk.build.options.Options` and flatten it in their `CommandLine` description. It owns `--target`, `--release`, `--optimization`, `--debug` and `--unsandboxed-tools`. Commands may add flags but cannot redefine these. A command building several targets creates a compilation for each target.

`Compilation.fromPackage(&options)` starts with the package's default compilation. Artifact constructors are `executable`, `loadableModule`, `staticArchive`, `object` and `test`. Every setting that can depend on a step takes a `Deferred<T>`.

```silk
import silk.build.graph { Build, Compilation, Options, BuildError }
import silk.build.step { Deferred }
import silk.build.package { Package }
import silk.build.options { Optimize }
import silk.mem.allocator { Allocator }
import silk.system.filesystem { FileSystem }
import silk.system.host_input { HostInput }

// Called by a task's perform method.
effect fn graph(options: &Options) -> Build
  ! BuildError
  ? &mut Allocator | &mut FileSystem | &mut HostInput {
  let dependency = Package.make()
    |> Package.optimize(run Deferred<Optimize>.value(Optimize.Speed))
  let base = run Compilation.fromPackage(options)
  let app = run base.package("renderer", move dependency)
  let build = run Build.make()
  return run build.add(move app)
}
```

The dependency alias must exist in the manifest. A graph cannot introduce an undeclared package. `Compilation.without(alias)` excludes a declared dependency from that compilation. Dependencies are fetched as selected imports reach them; `silk fetch` downloads all declared pins without evaluating package code.

`when(condition, transform)` on `Compilation`, `Build` and `Run` applies `transform` only when `condition` is true, so a pipeline can branch without rebinding. `transform` is a `once effect fn`, so it may move captured values and fail with the pipeline's errors. A plain lambda that returns the step's Effect fits it, as `|c| c.without("devtools")` does. Write an `effect` lambda when the body runs steps itself or branches. `run` is only allowed inside an `effect` lambda. A named `effect fn` works too. `Plan.when` takes a plain `fn`, because plans are static.

```silk
import silk.build.graph { Build, Compilation, Options, BuildError }
import silk.build.step { Deferred }
import silk.mem.allocator { Allocator }
import silk.system.filesystem { FileSystem }
import silk.system.host_input { HostInput }

effect fn graph(options: &Options, devtools: bool, release: bool) -> Build
  ! BuildError
  ? &mut Allocator | &mut FileSystem | &mut HostInput {
  let base = run Compilation.fromPackage(options)
  let app = run base.when(!devtools, |c| c.without("devtools"))
  let shipped = run app.when(release, effect |c| {
    let stripped = run c.debug(run Deferred<bool>.value(false))
    return run stripped.without("profiler")
  })
  let build = run Build.make()
  return run build.add(move shipped)
}
```

## Completing a graph

- `Compilation.build()` builds one compilation and returns its `Built` result.
- `Build.compile()` runs reachable steps and compiles the graph's compilations.
- `Build.write()` writes the graph's request files. It runs only prerequisites needed to resolve request values and does not compile the requested roots.

A `Plan` command ends with `Build.write()`. Other commands choose their final operation explicitly. `Built.write` copies artifacts to a destination; `Built.launch` uses the configured runner. WASI programs use Wasmtime by default. A graph may configure a different runner for a foreign target.

Artifacts live under `build/<target>/<mode>/<name>`, relative to the enclosing workspace's `output-dir` when set. Request files and their index live under `build/requests`. Consumers read that index instead of scanning artifact directories or reconstructing filenames.

## Steps and deferred values

`Deferred.source`, `Deferred.external`, `Deferred.value` and `Deferred.map` describe inputs. A deferred result cannot be inspected while constructing the graph. `Step.output` names a step's output; `Compilation.artifact`, `emittedHeader` and `emittedImportLibrary` expose compilation outputs. Passing these values to `linkArtifact`, `embed`, `moduleFile` or `Run.artifact` creates dependency edges.

A custom `Step` implements `key` and `make`. Its key declares every file, directory, environment variable and value it reads. `Make` grants access to those inputs and the step's output directory. The runner hashes inputs and toolchain contents, reuses complete cached outputs, executes independent misses on fibers and observes its memory budget. `Key.always` opts a step out of reuse.

`Run` describes an external command with declared inputs and outputs. `WriteFiles` creates files from deferred values. `Package.path(alias, subpath)` resolves a dependency's included file; the package must publish that file or its parent directory in `include`.

## Package parameters and plans

A package may declare `pub param` values in source or `build.silk`. The consumer binds them with `Package.set`. Values retain their declared type, including enums and nested options. A parameter without a default is required when resolving the compilation. `Package.supplyPath` authorizes an external path; ordinary plan paths remain inside the declaring package.

`build.silk` exports `pub const PLAN: Plan`. The compiler evaluates it statically, with standard-library imports and the package's parameters. The plan contributes generated modules, native sources and link inputs. Target conditions are ordinary static code.

```silk
import silk.build.plan { Library, Plan }
import silk.build.step { sourcePath }

static fn plan() -> Plan {
  let mut result = Plan.empty()
  result = result |> Plan.compileC(sourcePath("native/codec.c"))
  result = result |> Plan.includePath(sourcePath("include"))
  if Intrinsic.targetOperatingSystem() == "linux" {
    result = result |> Plan.linkLibrary("m", Library.dynamicSearch())
  }
  return result
}

pub const PLAN: Plan = plan()
```

Native archive pins and local overrides remain manifest data. `Plan.archivePath(name, path)` names a file in a pinned archive. Per-file flags and include directories belong to `Plan.compileNative`; `compileSources` selects a declared glob. Root compilations expose equivalent native operations.

A dependency's tool steps require `tools = true` on its dependency entry. Tools execute in a sandbox. On a host without confinement, only an explicit `--unsandboxed-tools` argument authorizes execution. The language server never supplies that argument.

## Requests and editors

`silkc request-schema` prints the JSON Schema derived from the request's Silk schema. `silkc resolve --definition <file> --output <file>` resolves a graph definition. `silkc compile --request <file|->` consumes the resulting explicit request without discovering manifests, fetching dependencies or evaluating plans.

Requests contain absolute source and native paths, all package parameters, generated modules, compiler settings and platform inputs. Replaying a request uses these captured values even when an ambient manifest changes.

The language server reads saved requests and `compile_commands.json`. With workspace trust and refresh enabled, it may run the root's `plan` under confinement. A project with a `tasks.silk` builds and starts its tasks program under the same confinement; without a `Plan` variant that program runs nothing and the built-in plan is used. An unavailable or refused refresh retains the last usable requests and reports that the developer should run `silk build` or `silk plan`. `check`, `format`, `doc`, `hash` and `pack` do not run project tasks.

## Package code generation and platforms

`Package.optimize` and `Package.debug` affect backend code generation for the defining package, including its generic instances. Source-visible compilation facts stay program-wide. Mixed package modes produce separate units without cross-package inlining, including when emitting LLVM IR, bitcode, assembly or objects.

`Compilation.windows` selects the subsystem, manifest and resource scripts. `Compilation.macos` selects a dylib install name and signing entitlements. `Compilation.wasm` selects imported or shared memory, table export and command or reactor execution. `Compilation.header` emits a C header for exported C declarations, and `Compilation.importLibrary` names a Windows import library. Shared native libraries require dynamic linking and position-independent code.
