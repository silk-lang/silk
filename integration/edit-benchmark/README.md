# Edit benchmark

`bench.mjs` times the commands of an edit loop after one edit to a package: `silk build`, `silk check` asking the check server, `silk check --no-server`, and `silk test`. It reports the cold run, the first edit after it and the edits after that side by side, for several kinds of edit.

CI does not run it. Run it by hand before and after a change that claims to make an edit loop faster, on the same machine, and compare the two reports.

## Running

You need Node 22 or newer, Python 3 (to wait on the cache writers a build leaves running), `pkill` and `pgrep` (to end the check servers it starts), and Clang (on `PATH` or in `SILK_CLANG`, or the one a release bundles). From the repository root:

```sh
node integration/edit-benchmark/bench.mjs --silk build/silkc
```

| Option | Effect |
| --- | --- |
| `--silk` | The compiler to run. |
| `--workspace` | The workspace to copy. Default: the current folder. Its `build`, `.git` and `node_modules` folders are left out. |
| `--packages` | The packages to time, separated by commas. Default: `silk-compiler,silk-tool`. |
| `--commands` | Picks from `build`, `check`, `check-no-server`, `test`. Default: all of them. |
| `--edits` | Picks from the edits below. Default: all of them. |
| `--rounds` | How many edits to time after the first one. Default 3. |
| `--stdlib` | The standard library to use. Default: `<workspace>/stdlib`. |
| `--work` | Where the copy and the samples go. Default: `silk-edit-benchmark` in the system temp folder. It is removed first. |

The whole matrix takes about 50 minutes on a 4-core machine, most of it in `silk test` on the compiler. `--packages silk-tool` takes about two minutes.

`examples/the-conductor` is listed too, as a program with fibers. It is a package of its own, so name it as the workspace:

```sh
node integration/edit-benchmark/bench.mjs --silk build/silkc --workspace examples/the-conductor --stdlib stdlib --packages the-conductor
```

## What it measures

The script copies the workspace, and a standard library outside it, so the checkout is never edited. For each package and command it then does this:

1. Removes `build` and runs the command. This is the cold run.
2. Keeps a copy of the `build` folder the cold run left, and runs the command again with nothing changed.
3. For each kind of edit: puts the copy of `build` back, makes one edit and runs the command (the first edit), then makes `--rounds` more edits to the same place with a run after each (the later edits).

So every first edit meets the state a cold run leaves, and the later edits meet the state an edit build leaves. For `check`, each kind of edit starts with a new check server: the script ends the last one, puts `build` back and runs one check with nothing changed, which is listed in the samples as `server start`.

No edit text is used twice in a run, and each run starts its texts from the clock, so no run finds a state its cache has seen. Before the cold run each place already holds its first text, so every round changes a line where it stands. The exception is `lines`, which adds a line each round.

| Edit | What changes |
| --- | --- |
| `leaf` | A statement in a function of a file few others import. |
| `large` | The same in the package's largest file. Not listed for a package of one file. |
| `std` | The same in `List.pop`, generic standard library code. |
| `signature` | A parameter's name, through its function. Callers keep compiling. |
| `field` | The name of a public `Option<bool>` field of a struct. Literals may leave it out, so no other file changes. |
| `comment` | The text of a comment line in the largest file. |
| `lines` | One more comment line near the top of the largest file, so the lines below it move down. |

The places are listed per package in `packages` at the top of the script, each as a file and the whole text of one line of it. The script stops when a file no longer holds its line exactly once, and when a run fails; move the place then. To time another package, add it to `packages` with a place for each edit.

## Reading the result

The script prints one line per run as it goes and a table per package and command at the end:

```
silk-tool, build: cold 8.10 s, nothing changed 0.06 s
  edit       first edit later edits  emitted   each later edit
  leaf             0.56        0.56        2   0.57 0.55 0.56
```

Times are seconds of wall time from starting the command to its exit. `later edits` is the median of the samples listed after it. `emitted` is how many functions the last edit's codegen row counted, for the commands that print one.

Every sample is one line of `<work>/samples.jsonl`: the package, command, edit and state, the edit's text, the seconds, the seconds the cache writer went on after the command (`writer`), the exit status, the seconds of each row of the progress report (`rows`) and the first number each row counts (`counts`), and the line that ends the output or counts the tests (`last`). Each run's whole output is in `<work>/logs`.

A run's time is its own, so compare two compilers by running the script once with each on a quiet machine. After every run the script waits for the cache writer the run left behind, so no timed run waits on an earlier run's writer. That wait is not part of the run's time; it is the sample's `writer`.
