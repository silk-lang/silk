# flows

State machines, written with `silk.machine`, that define what the `silk` toolchain does.

- `src/Silk.silk` is the machine of the `silk` tool. The tool runs it: each command of the tool
  is a row of this machine. `silk task pages` writes `reference/flows` from it.
- `src/ProjectFlow.silk`, `src/DependencyFlow.silk`, `src/BuildFlow.silk` and `src/ServerFlow.silk`
  are the machines of the compiler's commands: `silk init`, the dependency commands, check, build,
  run, clean and format, and the check server. The compiler does not run them. They are
  references: a run of the real compiler is compared with them, and a disagreement is a bug in
  the compiler or a wrong row.

Every row lists everything the command leaves behind: the exit status, the messages, the files
that appear, change or go away, and what the compiler reports through `SILK_EVENTS`. Anything a
run leaves that its row does not list is a failure. Each machine also has laws, promises that
hold on every path, which the tests check over a walk of every state the machine can reach.

## Tasks

Run them from this directory.

- `silk task cover [--check]` writes `flows.json`, the routes of the tool's machine.
- `silk task pages [--check]` writes the pages of `reference/flows`.
- `silk task chart --machine <name>` prints a machine (`Silk`, `ProjectFlow`, `DependencyFlow`,
  `BuildFlow` or `ServerFlow`) as an xstate config in JSON. To see it drawn, paste it into a new
  machine in Stately Studio (https://stately.ai/editor) as `createMachine(<the JSON>)`, with
  Import.
- `silk task trips` prints the trips of the compiler's machines: paths of commands that together
  take every command from every state it can start in, each way it can go from there.
- `silk task drive --silk <tool> --toolchain <dir>` types every route and every trip into a real
  tool, with the compiler of `<dir>` (a directory with `bin/silkc` and `lib/silk`) installed as a
  toolchain, in a home directory, git host and archive of its own. Without `--toolchain` it takes
  only the routes of the tool.

## What a run does not take

- A toolchain switch under an existing cache, and a command killed halfway, are not driven.
- Routes that need a stable release of the tool's own version, a release key, or a proxy that
  stops a download are counted as not taken, with the reason.
- The bench uses POSIX host functions, so `drive` runs on Linux and macOS only.
