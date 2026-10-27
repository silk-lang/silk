# Incremental build fuzzer

`fuzz.mjs` checks that an incremental build gives what a cold build gives. It copies a workspace, then edits it at random for a number of rounds. After each round it builds the package with the cache the earlier rounds left, sets that build's output folder aside, and builds the same sources cold. The two builds must agree on the exit status, the diagnostics, and the bytes of the executable.

CI does not run it. Run it by hand after a change to the semantic cache, the build record, or codegen units.

## Running

You need Node 22 or newer, Python 3 (to wait on the cache writers a build leaves running) and Clang (on `PATH` or in `SILK_CLANG`). From the repository root, with a compiler built from this tree:

```sh
node integration/incremental/fuzz.mjs --silk build/silkc --workspace . --package silk-tool --iterations 30 --seed 7
```

| Option | Effect |
| --- | --- |
| `--silk` | The compiler to run. |
| `--workspace` | The workspace or package folder to copy. Its `build`, `.git` and `node_modules` folders are left out. |
| `--package` | The package to build. |
| `--stdlib` | The standard library to copy. Default: `<workspace>/stdlib`. |
| `--iterations` | How many rounds of edits. Default 20. |
| `--seed` | Names one sequence of edits, so a failure can be run again. Default 1. |
| `--work` | Where the copy and any failures go. Default: a folder in the system temp folder named for the seed. |
| `--command` | `build` (default) or `check`. A check compares status and diagnostics only. |
| `--edits` | Picks edits only from these, named as below and separated by commas: `comment`, `blank`, `literal`, `swap`, `rename`, `call`, `uncall`, `duplicate`. Default: all of them. |
| `--edit-stdlib` | Edits the standard library copy too. |
| `--keep-going` | Keeps going after a round whose builds disagree. |

Each round makes one to three edits, each to a random file of the package's own folder (one edit in four goes to the standard library copy instead, with `--edit-stdlib`): a comment before a top-level item, a blank line, an integer literal one higher, two adjacent items swapped, a private function renamed through its file, a function copied under a new name, a call to a helper added at the top of a function (the helper reused or appended to the file), such a call taken out again, or a file put back as it was. Edits may well break the build. That is fine, since both builds must break the same way.

A round whose builds disagree is saved in `<work>/failures/round-<n>`: `edits.json` lists every round's edits up to it, `warm.txt` and `cold.txt` hold each build's status, executable digest and output, and `sources/` holds each file as it then read.

A cold build of `silk-tool` takes about 20 seconds, so 30 rounds take about ten minutes. The compiler itself (`--package silk-compiler`) takes about a minute per round.
