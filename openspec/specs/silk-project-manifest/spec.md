# silk-project-manifest Specification

## Purpose

Defines how Silk language-tool commands discover, validate, and materialize one reproducible project configuration from `silk.toml`.

## Requirements

### Requirement: Minimal project manifest

The system SHALL accept a UTF-8 `silk.toml` containing a `[package]` table with required `name`, `version`, and `root` strings and optional `source-root` and `silk-version` strings. The package name SHALL be a portable lowercase identifier beginning with an ASCII letter and continuing with lowercase letters, digits, or hyphens. The version SHALL be a valid semantic version. A present `silk-version` records the compiler release that created the project and SHALL be a valid semantic version; no command SHALL compare it with the running compiler. Manifest paths SHALL be interpreted relative to the manifest directory.

#### Scenario: Load the minimal manifest

- **WHEN** `silk.toml` declares `[package]`, `name = "hello"`, `version = "0.1.0"`, and `root = "src/main.silk"`
- **THEN** the project name and version are retained, the entry is the canonical manifest-relative `src/main.silk`, and its directory is the source root

#### Scenario: Use an explicit source root

- **WHEN** the package root is `src/app/Main.silk` and `source-root = "src"`
- **THEN** the project source root is `src` and the root module identity is `app/Main`

#### Scenario: Record the creating compiler release

- **WHEN** `silk.toml` declares `silk-version = "0.1.0"` under `[package]`
- **THEN** the manifest loads, and a build with any compiler release proceeds as without the field

#### Scenario: Reject an invalid manifest

- **WHEN** TOML is malformed, a required field is absent, the package name, version, or `silk-version` is invalid, the entry is not an exact `.silk` file, or the entry escapes its source root
- **THEN** project loading fails with a typed project error that identifies the manifest and reason

### Requirement: Upward project discovery

Without an explicit manifest path, the system SHALL search the current directory and then each parent directory for the nearest `silk.toml`. With `--manifest-path`, the system SHALL load only the named file and SHALL NOT search elsewhere.

#### Scenario: Discover a parent project

- **WHEN** a command starts within a nested directory below a project
- **THEN** it uses the nearest ancestor `silk.toml`

#### Scenario: Prefer the nearest nested project

- **WHEN** both a directory and one of its ancestors contain `silk.toml`
- **THEN** discovery selects the manifest in the nearer directory

#### Scenario: Explicit manifest is absent

- **WHEN** `--manifest-path` names a missing file
- **THEN** project loading fails without falling back to upward discovery

#### Scenario: No project exists

- **WHEN** upward discovery reaches the filesystem root without finding `silk.toml`
- **THEN** the command fails with guidance to create a manifest or pass `--manifest-path`

### Requirement: Deterministic project artifact layout

The system SHALL derive each artifact destination below
`<output-dir>/llvm/<target>/<optimization>/`. Executables SHALL use the package name, WebAssembly
modules SHALL append `.wasm`, shared libraries SHALL use the target platform's conventional shared
library prefix and suffix, and static libraries SHALL use the target platform's conventional static
archive prefix and suffix. Target segments SHALL use resolved canonical identifiers, including
resolution of `host`, and required parent directories SHALL be created before compilation.

#### Scenario: Build a debug host artifact

- **WHEN** package `hello` is built as an executable through LLVM for `aarch64-apple-darwin` with optimization mode `debug`
- **THEN** its destination is `<project>/build/llvm/aarch64-apple-darwin/debug/hello`

#### Scenario: Build host libraries

- **WHEN** package `hello` is built as shared and static libraries for an Apple host
- **THEN** their filenames are `libhello.dylib` and `libhello.a` beneath their LLVM, target, and optimization directory

#### Scenario: Build WebAssembly through LLVM

- **WHEN** package `hello` is built for `wasm32-unknown-unknown`
- **THEN** the artifact is `<project>/build/llvm/wasm32-unknown-unknown/debug/hello.wasm`

#### Scenario: Replan the same build

- **WHEN** the same project, complete profile or target shorthand, and artifact kind are planned repeatedly
- **THEN** every canonical entry, source root, root module identity, and destination is identical and ordered deterministically

### Requirement: Optional build defaults

The manifest SHALL accept an optional `[build]` table with `targets`, `output-dir`, `artifact`, and
`native-link-inputs`. Artifact values SHALL be `executable`, `shared-library`, or `static-library`,
defaulting to `executable`; native library kinds SHALL require native targets.
`native-link-inputs` SHALL be an ordered array of inline tables, each containing
exactly one input form: `object`, `static-archive`, `search-path`, or `framework`, or a `library`
paired with mode `static` or `dynamic`. Paths SHALL be non-empty manifest-relative paths that do not
escape the project and SHALL materialize as absolute paths. Names SHALL be non-empty and SHALL NOT
contain whitespace, NUL, path separators, or a leading hyphen. Invalid or unknown shapes SHALL fail
loading with a typed project error; WebAssembly planning SHALL reject non-empty native link inputs.

#### Scenario: Apply sparse defaults

- **WHEN** the manifest contains no `[build]` table
- **THEN** project building selects target `host`, artifact `executable`, output directory `build`, and no native link inputs

#### Scenario: Select multiple targets

- **WHEN** `[build]` declares `targets = ["host", "wasm32-unknown-unknown"]`
- **THEN** target selectors retain their declared order and `host` resolves to the canonical current-host triple before planning

#### Scenario: Reject an unknown build field

- **WHEN** `[build]` declares a field outside its defined schema
- **THEN** project loading fails before creating or replacing any artifact

#### Scenario: Deduplicate target selectors

- **WHEN** multiple selectors resolve to the same canonical target
- **THEN** that target is built once at the position of its first selector

#### Scenario: Load structured link inputs

- **WHEN** `native-link-inputs` declares an object, static archive, dynamic library, search path, and framework
- **THEN** the project retains the corresponding immutable tagged values in order and resolves every path relative to the manifest

#### Scenario: Load native libraries

- **WHEN** `native-link-inputs` declares dynamic libraries `c` and `m`
- **THEN** the project retains two ordered Library values with Dynamic mode and the native link plan contains `-lc` and `-lm`

#### Scenario: Reject an ambiguous input

- **WHEN** one native-link-input table declares both `object` and `library`
- **THEN** project loading fails with a typed error naming `build.native-link-inputs`

#### Scenario: Reject a raw flag

- **WHEN** a native-link-input name begins with `-` or an unknown `flags` field is present
- **THEN** project loading fails without exposing an arbitrary linker-flag channel

#### Scenario: Reject a flag disguised as a library

- **WHEN** a native-link-input library name is `-Wl,--export-dynamic`
- **THEN** project loading fails with a typed error naming `build.native-link-inputs`

#### Scenario: Reject a library kind for Wasm

- **WHEN** the manifest selects `artifact = "shared-library"` with a WebAssembly target
- **THEN** project planning fails before creating or replacing any artifact

### Requirement: Project profiles carry typed package bindings

The manifest SHALL support a named default through build.profile, named logical profile inputs under profiles, project-tier build.bindings and profile-tier bindings. Each binding SHALL identify package, module and parameter and carry the tagged serializable value/provenance transport defined in the compilation-profile reference. Named profiles SHALL select an explicit canonical target. Complete request overrides and project-profile selection SHALL be mutually exclusive. Unknown profile names and invalid logical inputs SHALL produce structured project diagnostics before compilation. Existing physical output and native link paths SHALL remain outside logical profile identity.

#### Scenario: Select a named profile

- **WHEN** build.profile names a declared profile
- **THEN** compiler and tooling requests use that profile's logical facts and bindings

#### Scenario: Reject an unknown profile

- **WHEN** a request names a profile absent from the manifest
- **THEN** selection reports the unknown name and manifest origin without falling back to host defaults
