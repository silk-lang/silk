# Inflate benchmark

Measures how fast `silk.compress.inflate` decodes gzip and how fast `silk.compress.checksum`
computes CRC-32, against system zlib, zlib-ng and libdeflate on the same bytes. It is not a CI
gate: run it by hand when you change the decoder, the checksums or the code the compiler
generates for them.

```sh
SILK=/path/to/silk integration/inflate-benchmark/run --callgrind --before /path/to/main/stdlib
```

`SILK` is the silk command that builds this checkout's standard library (default `silk`).
`--before` adds rows for the same program built against another standard library, such as a
checkout of `main`. `--callgrind` adds instructions per output byte and needs valgrind. `run
--help` lists the other options.

## What it measures

The corpus is 306 npm tarballs: `typescript`, `next`, `react-dom`, `lodash`, `@types/node` and
`@esbuild/linux-x64`, which the table lists one by one, and 300 packages of at most 256 KiB from
the dependency trees of `next`, `express`, `webpack`, `eslint`, `jest` and `vite`.
`corpus.lock.json` pins each tarball by version, URL and SHA-512, and `run` downloads the
tarballs into `build/inflate-benchmark/corpus` once. `run --relock` rebuilds the lock from the
registry's newest releases.

Every implementation decodes each tarball fully in memory:

| Mode    | What runs                                                                    |
| ------- | ---------------------------------------------------------------------------- |
| `chunk` | Decode into one 64 KiB output buffer that every step reuses.                 |
| `whole` | Decode into one output buffer that holds the whole output.                   |
| `crc`   | Only the CRC-32 of the decoded bytes, without the decoder.                   |

libdeflate has no streaming decoder, so it has no `chunk` row. Each decoder verifies the gzip
CRC-32 as part of the decode, and `run` stops if two implementations disagree on a tarball's
length or checksum.

A pass runs every implementation once, so a busy machine slows all of them alike. A tarball's
time is its fastest round of all passes. A group's MB/s is its output bytes over the sum of those
times. Instructions per byte are a callgrind run of two rounds minus a run of one, over the
decoded bytes.

zlib is the system's library. zlib-ng and libdeflate are pinned releases that `run` builds from
source with their default options, so every machine measures the same code.

## Files

| File               | What it holds                                                      |
| ------------------ | ------------------------------------------------------------------ |
| `run`              | Fetches the corpus, builds the programs, runs them, prints a table. |
| `corpus.py`        | Reads, fetches and rebuilds the pinned corpus.                     |
| `corpus.lock.json` | The pinned tarballs.                                               |
| `src/main.silk`    | The Silk program.                                                  |
| `baseline.c`       | The same program for zlib, zlib-ng and libdeflate.                 |
