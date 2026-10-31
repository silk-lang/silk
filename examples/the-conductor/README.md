# The Conductor

An original 8-bit song where every part is a `Fiber` and every rhythm is a `Schedule`.

```sh
cd examples/the-conductor
silk run -- play             # render, start a player, and print what each fiber does, live
silk run -- wav song.wav     # only render the WAV file
silk run                     # check the log of the performance and exit
```

`play` uses the first of `afplay` (macOS), `aplay`, `paplay` or `ffplay` that it finds. The WAV is
44.1 kHz, 16-bit mono, and 47 seconds long.

## How it works

A conductor fiber runs the song in seven scenes. It forks a fiber for each part, joins the parts
that end, and interrupts the parts that would play forever. Each part repeats one small effect with
`Effect.repeat`, `Effect.retry` or `Effect.timeout`, and its Schedule decides when:

| Scene | What the fibers do                                   | Schedule                                       |
| ----- | ---------------------------------------------------- | ---------------------------------------------- |
| 1     | a ball bounces in, faster and faster                 | `exponentialBy(first, 0.8) \|> limit(11)`      |
| 2     | groove, bass and shaker start and never stop         | `fixed(STEP)`, `fixed(STEP * 2)`               |
| 2     | the shaker plays loose, but stays on the grid        | `fixed(STEP) \|> jitteredBetween(0.7, 1.0)`    |
| 2     | the verse plays 128 steps, and the conductor joins it | `fixed(STEP) \|> limit(127)`                  |
| 3     | an endless solo, stopped after two bars               | `Effect.timeout` around `fixed(STEP / 2)`     |
| 4     | one arpeggio fiber per bar, each stopping itself      | `fixed(BAR) \|> limit(3)`, `upTo(BAR - STEP)` |
| 5     | interrupt the groove, then race two fills            | `exponentialBy(first, 0.85)` vs `linear(40ms)` |
| 6     | a note that fails three times, then lands            | `Effect.retry` on `exponential(STEP / 4)`      |
| 7     | interrupt the endless parts, and slow down           | `fibonacci(STEP) \|> limit(7)`                 |

`fixed` measures each delay to the next beat of its grid, so a part never drifts, and jitter only
moves single hits. The snare roll speeds up and fits in one bar; the tom run slows down and would
need 2.2 s, so `race` gives the snare the win and interrupts the toms in the middle of their run.

Every note and every fiber event goes to a log that the fibers share. The log is allocated up
front, so a fiber can write to it without an allocator, and an interrupted fiber keeps the notes it
played. To render, `rehearse` runs the song under a virtual clock that jumps from deadline to
deadline, so the 45 seconds take a few milliseconds. `play` runs it again on the real clock, with a
screen fiber that prints each event as it happens. Then four pool fibers synthesize the four voices
on their own threads, and the program mixes them into the WAV.

**In a browser.** Built with `silk build --release --target wasm32-unknown-unknown`, the same
program sends the names and schedules of the fibers, the whole log, and the WAV file (as base64
lines that start with `pcm `) through the `silk.console` import. Its WAV is byte for byte the native
one.
