# silk-project-initialization Specification

## Purpose

Defines how the Silk CLI safely creates a minimal executable project in a new or existing directory without damaging user-owned content.

## Requirements

### Requirement: Initialize a minimal executable project

`silk init [path]` SHALL create a sparse `silk.toml`, a `src/main.silk` executable entry declared as
a public zero-argument `effect fn main() -> ()`, and a `/build/` ignore rule at the selected project
directory. An omitted path SHALL select the current directory, and a missing selected directory
SHALL be created. The generated manifest SHALL record the creating compiler's release version as
`[package].silk-version`. The generated project SHALL load, check, build, and run using manifest
defaults without further configuration.

#### Scenario: Initialize a named child directory

- **WHEN** a user runs `silk init hello` and `hello` does not exist
- **THEN** the CLI creates `hello/silk.toml`, `hello/.gitignore`, and `hello/src/main.silk` as a valid effectful executable project

#### Scenario: Initialize the current directory

- **WHEN** a user runs `silk init` in an eligible existing directory
- **THEN** the CLI creates the project files in that directory rather than creating another child directory

#### Scenario: Run the generated entry

- **WHEN** the generated `src/main.silk` is built and run for the host
- **THEN** its public zero-argument effectful `main` is run once and the process exits with status `0`

### Requirement: Derive or explicitly select the package name

Initialization SHALL use `--name` when supplied and otherwise derive the package name from the selected directory basename. The chosen name SHALL satisfy the same portable package-name rules as project loading. An invalid derived name SHALL fail with guidance to pass `--name`; initialization MUST NOT silently normalize it.

#### Scenario: Derive a valid name

- **WHEN** `silk init hello` runs without `--name`
- **THEN** the generated manifest declares package name `hello`

#### Scenario: Override an unsuitable directory name

- **WHEN** the selected directory basename is not a valid package name and the user passes `--name valid-name`
- **THEN** initialization uses `valid-name` without renaming the directory

#### Scenario: Reject an invalid derived name

- **WHEN** the selected directory basename is invalid and no explicit name is supplied
- **THEN** initialization fails before writing and suggests `--name`

### Requirement: Preserve existing directory content

Initialization SHALL allow unrelated pre-existing files but MUST NOT overwrite an existing `silk.toml` or `src/main.silk`. It SHALL preflight every managed path before mutation and SHALL expose no force-overwrite mode.

#### Scenario: Initialize beside unrelated files

- **WHEN** the selected directory contains a `README.md` but none of the project-owned paths
- **THEN** initialization succeeds and leaves `README.md` unchanged

#### Scenario: Refuse an existing manifest

- **WHEN** the selected directory already contains `silk.toml`
- **THEN** initialization fails before changing any file

#### Scenario: Refuse an existing entry source

- **WHEN** the selected directory already contains `src/main.silk`
- **THEN** initialization fails before changing any file

### Requirement: Merge the build ignore rule safely

When `.gitignore` does not exist, initialization SHALL create it containing `/build/`. When it exists, initialization SHALL preserve its contents and add `/build/` exactly once only if that exact rule is absent.

#### Scenario: Extend an existing ignore file

- **WHEN** `.gitignore` contains user-authored rules but not `/build/`
- **THEN** initialization preserves those rules and adds one `/build/` rule

#### Scenario: Keep an existing rule unique

- **WHEN** `.gitignore` already contains the exact `/build/` rule
- **THEN** initialization does not duplicate or otherwise rewrite that rule

### Requirement: Initialization failure leaves no partial project

If initialization fails after mutation begins, the CLI SHALL remove only files and directories it created and SHALL restore any pre-existing `.gitignore` content exactly. It MUST NOT remove or rewrite unrelated pre-existing content.

#### Scenario: Roll back a failed write

- **WHEN** writing one generated project file fails after another generated path was created
- **THEN** the command restores the selected directory to its pre-initialization contents
