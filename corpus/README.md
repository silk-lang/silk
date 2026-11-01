# Acceptance corpus

The shared acceptance corpus is plain data: one directory per program, read by the native corpus
harness. `corpus.mjs` is the only reader and depends on Node
built-ins alone.

- `native/<name>/` holds a program that compiles and runs natively.
- `invalid/<name>/` holds a program that compilation must reject.

A program's name is its directory name. Programs are ordered by name. Running one program reads
only its own directory and the files it splices.

## Program files

| File              | Required | Contents                                                                              |
| ----------------- | -------- | ------------------------------------------------------------------------------------- |
| `main.silk`       | yes      | The program the native compiler builds, as module `memory/driver`.                    |
| `outcome.json`    | yes      | What compiling and running the program must produce (schema below).                   |
| `reference.silk`  | no       | The portable program, when native compilation runs a different `main.silk`.           |
| `imports/**.silk` | no       | Further modules of the program. `imports/errors/kinds.silk` is module `errors/kinds`. |
| `c/*.c`           | no       | C translation units compiled and linked into the program. `c/stub.c` is unit `stub`.  |
| `windows-imports/*.def` | no | Explicit system-DLL export definitions for Windows C fixtures, built with `llvm-dlltool`. A named definition replaces that library's `dynamicLibraries` entry on Windows. |
| `expected.stdout` | no       | The exact bytes the program writes to standard output. Absent means not checked.      |
| `expected.stderr` | no       | The exact bytes the program writes to standard error. Absent means not checked.       |

An empty `expected.stdout` asserts empty output; a missing one asserts nothing.
For a Windows-specific trap contract, `expected.windowsStatus` names the exact unsigned
exception status. For example, SEH foreign-unwind guards require `3221226505` (`0xC0000409`,
fast fail), distinguishing Silk's guard from the original exception escaping unhandled.
Other targets retain their trap contract.
The Windows `foreign-libc-*`, pointer/libc, and libm-order fixtures explicitly import the Windows
system CRT for their C-library contracts. These imports belong to those fixtures; ordinary Silk
programs and the compiler retain their no-CRT link. Lifecycle-output C witnesses use direct OS
byte output from `fixtures/c-output.h` on both Windows and Unix.

## `outcome.json`

The file is canonical JSON: keys sorted, two-space indentation, one trailing newline, as
`formatOutcome` in `corpus.mjs` writes it. A test rejects any other formatting, so write it with
`formatOutcome` or by hand in that form.

| Key                | Required | Value                                                                                                                                                                                          |
| ------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`    | yes      | `1`.                                                                                                                                                                                           |
| `expected`         | yes      | `{"kind": "completes", "exitCode": N}`, `{"kind": "trap"}`, or, under `invalid/` only, `{"kind": "rejected", "diagnostics": [{"code": "SEM0051", "span": "2:31-2:54"}]}` (see below).          |
| `runs`             | no       | Separate runs of the one executable: `[{"arguments": ["a"], "closeStderr": true}]`. Each run must produce the expected outcome and output. One run without arguments otherwise.                |
| `profiles`         | no       | Native profiles the contract must hold under: `[{"debug": true, "name": "debug", "optimization": "none"}]`.                                                                                    |
| `dynamicLibraries` | no       | System libraries to link, such as `["m"]`.                                                                                                                                                     |
| `components`       | no       | Runtime components bound to program declarations: `[{"bindings": [{"declaration": "refuse", "module": "test/refusing_storage", "operation": "acquire"}], "capability": "execution-storage"}]`. |

## Rejected programs

A program under `invalid/` lists every diagnostic compilation must report, in the order the
compiler reports them: its code and its span in `main.silk` as `line:column-line:column`, both
1-based and counting characters. `formatSpan` in `corpus.mjs` writes this form. Messages are never
compared. The native corpus harness checks the exact list: native
programs that are still rejected with a different list are reported as `DIAGNOSTIC_PARITY` gaps,
and an accepted program fails.

## Splices

A source file may contain `/*@splice {...}*/` directives. The reader replaces each one with text
from a repository file, so a program can test the current text of a file it shares, such as a
standard-library module or an example, without keeping a copy:

- `{"file": "examples/algorithms/sieve/main.silk"}` splices the whole file.
- `{"file": "...", "from": "fn lengthsAdmitted(", "to": "fn validate("}` splices the section from
  the first `from` up to the next `to`.
- `{"file": "...", "declaration": "struct Length64Transition {"}` splices one top-level
  declaration, from its header through its closing brace line.

Paths are relative to the repository root. Source positions in diagnostics and reports are those
of the expanded text.

## Adding a program

Create `native/<name>/` or `invalid/<name>/` with `main.silk` and `outcome.json`, plus any
optional files. Names use letters, digits and hyphens. No index needs updating.
