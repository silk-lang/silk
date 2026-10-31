# Warp and Weft

An original 8-bit song in D minor, played by fibers and kept in time by schedules.

```sh
cd examples/warp-and-weft
silk run -- play             # render, start a player, and show the song live in the terminal
silk run -- wav song.wav     # only render the WAV file
silk run                     # check the arrangement and exit
```

`play` uses the first of `afplay` (macOS), `aplay`, `paplay` or `ffplay` that it finds. The WAV is
44.1 kHz, 16-bit mono, and 45 seconds long: 43 seconds of song and the tail of the last crash.

## How it works

**One fiber per instrument.** `band` forks four children under a `LocalScheduler`: the lead, the
arpeggio, the bass and the drums. Each one steps through its own part with `Effect.repeat` and a
`Schedule`, and returns the notes it played as its result. The parent joins all four.

| Fiber    | Schedule                                       | Sound                               |
| -------- | ---------------------------------------------- | ----------------------------------- |
| lead     | `Schedule.fixed(100ms)`, sixteenth notes       | 25% pulse with vibrato              |
| arpeggio | `Schedule.fixed(50ms)`, thirty-second notes    | 12.5% pulse                         |
| bass     | `Schedule.fixed(200ms)`, eighth notes          | 16-step triangle                    |
| drums    | `Schedule.fixed(100ms)`, then a roll on `Schedule.exponentialBy(first, 0.85)` | 15-bit noise and a falling triangle kick |

`Schedule.fixed` keeps a steady beat: each delay runs to the next multiple of the interval, so the
time a step takes never drifts the part. The drum roll at the end uses a shrinking exponential
schedule, so its sixteen gaps get shorter and add up to exactly one bar.

**Two clocks, one program.** The fibers only ask the `MonotonicClock` service for the time. To
render, `record(false)` provides a virtual clock, so the scheduler jumps from deadline to deadline
and the whole song plays in a few milliseconds. To perform, `record(true)` provides the real clock,
and a fifth fiber draws one tracker row per step on the same kind of schedule.

**Parallel synthesis.** `mix` starts a `ThreadPool` and forks one pool fiber per track. Each one
synthesizes its track on its own native thread, and the program sums the four tracks into the WAV,
through a high-pass filter like the output stage of an 8-bit console.

The song itself is plain text in `main.silk`: one token per sixteenth note, with `-` to hold a
note and `.` for silence, and one chord name per bar for the bass and the arpeggio.
