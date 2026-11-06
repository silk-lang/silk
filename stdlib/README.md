# Silk standard library

The files under `silk/` are the standard-library modules the native compiler loads from the
directory it is given with `--stdlib`. An installed `silk` finds them at `lib/silk/stdlib`.

Public API documentation lives in the `//!` and `///` comments of the Silk sources. See
[DOCUMENTATION.md](./DOCUMENTATION.md) for contributor rules and the
[language reference](../reference/index.md) for the language itself.

## Compression

The compression modules cover the formats in Zig's `lib/std/compress` (reference commit
`738d2be9d6b6ef3ff3559130c05159ef53336224`), and Brotli:

| Format | Encode | Decode |
| --- | --- | --- |
| Raw DEFLATE, zlib, gzip | `silk.compress.deflate.Encoder` | `silk.compress.inflate.Decoder` |
| LZMA-alone (`.lzma`) | — | `silk.compress.lzma.Lzma.decode` |
| Raw LZMA2 | — | `silk.compress.lzma2.Lzma2.decode` |
| XZ (`.xz`, single LZMA2 filter per block) | — | `silk.compress.xz.Xz.decode` |
| Zstandard | `silk.compress.zstd_encode.ZstdEncoder` | `silk.compress.zstd.Zstd` |
| Brotli | `silk.compress.brotli_encode.BrotliEncoder` | `silk.compress.brotli.Brotli` |

DEFLATE encoding follows zlib: levels 0 to 9, its strategies and flush modes, preset dictionaries,
and stored, fixed, or dynamic Huffman blocks, with raw, zlib, or deterministic gzip framing.
LZMA, LZMA2, and XZ decode complete input buffers into caller-owned output buffers, with explicit
`silk.compress.limits.DecodeLimits`. XZ verifies block checks, index records, and footers, and accepts concatenated streams and padding. Its supported block checks are none, CRC-32,
CRC-64, and SHA-256. Other XZ filters are reported as unsupported, matching the reference's scope.
The existing DEFLATE and Zstandard decoders provide incremental decoding.

Zstandard encoding covers levels 1 to 22 with the reference `zstd` parameters and match strategies
(hash tables, lazy hash chains, binary trees, and the optimal parser), in steps with flushes, an
optional checksum, and the content size. Its frames decode with the reference `zstd` and are
within about 1% of its size at each level, but are not the same bytes that it writes.

Brotli encoding covers qualities 0 to 11: the bucket hashers and lazy matching of the reference
`brotli` up to quality 9, and its binary tree hasher, shortest path search, and static dictionary
matches at 10 and 11, in steps with flushes. From quality 5 literals have prefix codes for
clusters of their contexts. Its streams decode with the reference `brotli` and are within about 4%
of its size on text at each quality, and up to about 6% larger on source code, where the
reference also splits meta-blocks into block types.

The Brotli decoder covers all of RFC 7932, including the static dictionary and its word
transforms, and decodes incrementally into a window it allocates once. Regenerate its dictionary
and transform tables with `scripts/brotli/generate-tables`, which fetches checksum-pinned sources
from google/brotli.

The shared native corpus includes independent liblzma fixtures and malformed-input cases.
Regenerate them with `python compiler/fixtures/compression/generate.py` from the repository root.
To check Silk's encoded output with an independent zlib decoder, run:

```sh
python compiler/fixtures/compression/verify.py --silk /path/to/silk --clang /path/to/clang
```
