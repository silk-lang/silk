# Silk standard library

The files under `silk/` are the standard-library modules the native compiler loads from the
directory it is given with `--stdlib`. An installed `silk` finds them at `lib/silk/stdlib`.

Public API documentation lives in the `//!` and `///` comments of the Silk sources. See
[DOCUMENTATION.md](./DOCUMENTATION.md) for contributor rules and the
[language reference](../reference/index.md) for the language itself.

## Compression

The compression modules cover the formats in Zig's `lib/std/compress` (reference commit
`738d2be9d6b6ef3ff3559130c05159ef53336224`):

| Format | Encode | Decode |
| --- | --- | --- |
| Raw DEFLATE, zlib, gzip | `silk.compress.deflate.Deflate.encode` | `silk.compress.inflate.Decoder` |
| LZMA-alone (`.lzma`) | — | `silk.compress.lzma.Lzma.decode` |
| Raw LZMA2 | — | `silk.compress.lzma2.Lzma2.decode` |
| XZ (`.xz`, single LZMA2 filter per block) | — | `silk.compress.xz.Xz.decode` |
| Zstandard | — | `silk.compress.zstd.Zstd` |

DEFLATE encoding uses LZ77 matches and fixed Huffman codes with raw, zlib, or deterministic gzip
framing. LZMA, LZMA2, and XZ decode complete input buffers into caller-owned output buffers, with
explicit `silk.compress.limits.DecodeLimits`. XZ verifies block checks, index records, and footers,
and accepts concatenated streams and padding. Its supported block checks are none, CRC-32,
CRC-64, and SHA-256. Other XZ filters are reported as unsupported, matching the reference's scope.
The existing DEFLATE and Zstandard decoders provide incremental decoding.

The shared native corpus includes independent liblzma fixtures and malformed-input cases.
Regenerate them with `python compiler/fixtures/compression/generate.py` from the repository root.
To check Silk's encoded output with an independent zlib decoder, run:

```sh
python compiler/fixtures/compression/verify.py --silk /path/to/silk --clang /path/to/clang
```
