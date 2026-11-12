# Silk standard library

The files under `silk/` are the standard-library modules the native compiler loads from the
directory it is given with `--stdlib`. An installed `silk` finds them at `lib/silk/stdlib`.

Public API documentation lives in the `//!` and `///` comments of the Silk sources. See
[DOCUMENTATION.md](./DOCUMENTATION.md) for contributor rules and the
[language reference](../reference/index.md) for the language itself.

## JSON Schema and TOML

`silk.json.schema.Schema` compiles schemas for drafts 4, 6, 7, 2019-09, and 2020-12.
It validates the existing `silk.json.value.Value` tree; there is no second JSON parser or
schema-specific value model. Use `Json.parseExact` for JSON schemas and instances to retain
arbitrary-precision numbers, or `SchemaValue.parseToml` for either side written in TOML.
The ordinary `Json.parse` remains the machine-number parser.

```silk
import silk.json.schema { Schema, Draft, SchemaError }
import silk.json.schema_resolver { SchemaResolver, SchemaRegistry, SchemaResolutionError }
import silk.json.schema_value { SchemaValue, ValueError }
import silk.toml.scanner { TomlError }
import silk.text.regex { RegexError }
import silk.core.effect { Effect }
import silk.mem.allocator { Allocator, OutOfMemoryError }

effect fn checkConfig(schemaToml: &[u8], configToml: &[u8]) -> bool
  ! TomlError | ValueError | SchemaError | SchemaResolutionError | RegexError | OutOfMemoryError
  ? &mut Allocator {
  let schema = run SchemaValue.parseToml(schemaToml)
  let config = run SchemaValue.parseToml(configToml)
  let mut registry = SchemaRegistry.make()
  let mut options = Schema.options(Draft.Draft202012)
  options.assertFormats = true
  let compiled = run Schema.compile(&schema, "https://example.com/config",
    options) |> Effect.provideMut<SchemaResolver>(&mut registry)
  let output = run Schema.validate(&compiled, &config)
  return output.valid
}
```

TOML tables and arrays of tables become JSON objects and arrays. Dates and times become
their original text; base-prefixed integers become exact decimal numbers. NaN and infinity
are rejected. JSON Schema's boolean schemas and `null` cannot be expressed as TOML document
roots; use JSON or construct the shared `Value` directly when those forms are needed.

The compiled schema borrows its root and owns any resolved external documents. It can validate
multiple instances after the resolver has gone out of scope. Compilation requires the replaceable
`silk.json.schema_resolver.SchemaResolver` service; validation does not. Its `resolve` operation
receives an absolute URI without a fragment and returns an owned optional `Value`. Missing
resources become unresolved-reference errors; provider failures preserve `SchemaResolutionError`.
Each retrieval URI is resolved at most once per compilation.

`SchemaRegistry.make()` creates an explicit empty in-memory provider. Add owned JSON or
TOML-derived schemas with `SchemaRegistry.add(&mut registry, uri, move schema)`. The registry is
reusable; `SchemaMetas.documents` supplies official metaschemas to register when explicitly
referenced. Applications can instead implement filesystem, HTTP, embedded-resource or other
providers and bind them with `Effect.provideMut<SchemaResolver>`. The validator has no default
filesystem or network access and never executes schema code. `$dynamicRef`, `$recursiveRef`,
vocabulary declarations and unevaluated-property/item annotations follow the selected dialect.

`format` is an annotation by default. Set `assertFormats` to check the standard formats;
the 2020-12 format-assertion vocabulary also enables their assertions. Draft 7's optional
`base64`/`application/json` content assertions require `assertContent = true`; newer drafts'
content keywords remain annotations. Regex resource-limit errors are distinct from a
non-match. Source parsing retains the existing JSON/TOML nesting limits.

Invalid instances return `Output.valid = false` with keyword and instance JSON Pointers.
Invalid schemas, unresolved references, and operational failures use typed errors.
`Schema.toJson` produces the standard basic output as a `Value`, written with `Json.write`.

Run the pinned official conformance suite, including optional cases, with:

```sh
integration/json-schema-conformance/check-json-schema
```

The driver downloads a checksum-pinned suite, builds the native runner, and reports failures
without skips. `--draft draft2020-12` or `--match unevaluated` narrows an investigation;
`--runner /path/to/runner` reuses a build. IDNA data is reproducible with
`scripts/unicode/generate-idna`. The `pattern` engine is `silk.text.regex`, Silk's
own regular-expression engine; its Unicode tables come from SilkJS's
`scripts/generate_unicode.py`.

## Compression

The compression modules cover the formats in Zig's `lib/std/compress` (reference commit
`738d2be9d6b6ef3ff3559130c05159ef53336224`), and Brotli:

| Format | Encode | Decode |
| --- | --- | --- |
| Raw DEFLATE, zlib, gzip | `silk.compress.deflate.Encoder`, `EncodeWriter` | `silk.compress.inflate.Decoder` |
| LZMA-alone (`.lzma`) | — | `silk.compress.lzma.Lzma.decode` |
| Raw LZMA2 | — | `silk.compress.lzma2.Lzma2.decode` |
| XZ (`.xz`, single LZMA2 filter per block) | — | `silk.compress.xz.Xz.decode` |
| Zstandard | `silk.compress.zstd_encode.ZstdEncoder` | `silk.compress.zstd.Zstd` |
| Brotli | `silk.compress.brotli_encode.BrotliEncoder` | `silk.compress.brotli.Brotli` |
| Tar archives (ustar, GNU, pax), streamed | `silk.compress.tar.TarWriter` | `silk.compress.tar.TarReader` |
| ZIP archives (stored or DEFLATE members, ZIP64) | — | `silk.compress.zip.ZipReader` |

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
`brotli` up to quality 9, and its binary tree hasher, shortest path search, static dictionary
matches, and literal block splitting at 10 and 11, in steps with flushes. From quality 5
literals have prefix codes for clusters of their contexts, and commands and distances are split
into block types. Its streams decode with the reference `brotli` and are within about 1% of its
size from quality 8, and within about 2.5% at the others.

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
