# Markdown conformance

`check-commonmark` checks `silk.markdown.document` and `silk.markdown.html` against all
652 examples of [CommonMark 0.31.2](https://spec.commonmark.org/0.31.2/). CI does not run it.
All 652 examples pass; there are no excluded examples or known example failures.

From the repository root:

```sh
SILK="$HOME/.silk/bin/silk +0.1.0-dev.68+c11c7e82c2ab" \
  integration/markdown-conformance/check-commonmark --report /tmp/commonmark-report.json
```

The script builds the native runner in release mode, downloads `spec.json` once into
`build/markdown/`, verifies its SHA-256, and compares UTF-8 HTML byte for byte. It prints
per-section counts and every failing example number. The JSON report includes inputs,
expected and actual HTML, and exit status for every example. `SILK_STDLIB` overrides the
checkout standard library; the default always uses this checkout's `stdlib/`.

The runner sets `rawHtml: true` and `unsafeLinks: true` for reference output. Its optional
second argument `safe` uses the safe defaults; `parse` parses without rendering. Standard
output uses a 64 KiB `BufferedWriter`. It accepts valid UTF-8 files and exits with status 4
for invalid UTF-8, which the public parser's `string` input cannot contain.

The pinned downloads are:

| Input | SHA-256 |
| --- | --- |
| `spec.json` | `d431b29d97b6f73e69d547109cf5081578fac931e72afe95639ebe766c1b2a20` |
| `spec.txt` | `bfef4ddc97276b6ab6c2a28ace48478e35b1c50e60cde9f517ab8ab030aa3b82` |

A corrupt cache fails explicitly. Remove the affected file before fetching it again.
Downloaded data stays in `build/` and is never executed. The CommonMark specification is
licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).

## Pathological inputs and throughput

```sh
SILK="$HOME/.silk/bin/silk +0.1.0-dev.68+c11c7e82c2ab" \
  integration/markdown-conformance/check-commonmark --pathological
SILK="$HOME/.silk/bin/silk +0.1.0-dev.68+c11c7e82c2ab" \
  integration/markdown-conformance/check-commonmark --bench
```

The pathological mode generates ten approximately 250 kB cases: opening brackets, emphasis
runs, unmatched backtick runs of different lengths, opening angle brackets, quote-heavy
text, valid links, quote nesting, list nesting, a large reference table, and repeated
`[a](`. Each process must finish successfully within 20 seconds. Corpus programs assert
results without timing assertions.

The benchmark repeats the pinned specification text to approximately 10 MB. It reports the
best of three runs for parse-only and parse-plus-render, including file reading and process
startup. If `cmark`, `md2html`, or `pulldown-cmark` is on PATH, it also times that command on
the same input. It installs nothing. Comparisons use standard input and discard output;
these are process-level measurements, not a controlled microbenchmark.

During development on AArch64 macOS, reuse of scratch buffers and inline stacks increased
parse throughput from about 66 MB/s to about 76 MB/s. Buffered streaming output increased
parse-plus-render throughput from about 14 MB/s to about 62 MB/s. Installed `md2html`
measured about 177 MB/s; `cmark` and `pulldown-cmark` were unavailable. An allocator wrapper
measured 57 allocator calls for the 314,602-node benchmark tree. These are observations,
not correctness thresholds.

## Representation and work limits

`MarkdownDocument<'source>` borrows its UTF-8 source. A flat `List<MarkdownNode>` owns the
nodes; their public ids index the final preorder arena. Literal payloads select either a
source range or one shared decoded `Bytes` buffer. Temporary input buffers, source-piece
maps, delimiter and bracket stacks, and the backtick cache are reused across leaf blocks.
There are no persistent allocations per node. Final compaction remaps tree links after
inline wrapping and merges adjacent compatible text ranges.

Blocks use line scanning and open-container matching; leaf content keeps source-piece maps
so inline spans remain original byte offsets across stripped container prefixes and lazy
continuations. Inline parsing uses delimiter and bracket stacks, the `openers_bottom`
optimization, a backtick-run length index, and a 256-entry special-byte lookup table.
Line-end search and HTML escape scanning use the standard library's SIMD operations.

`MarkdownOptions.maxNesting` defaults to 256. Excess container or inline nesting remains
paragraph or literal content. Destination parentheses have a depth bound of 32. Inline
lookahead has a work allowance of 16 times a leaf's byte length plus 1024; reference
payload reuse has a document-wide allowance of 16 times source length plus 65,536. When
an allowance is spent, the affected candidate remains literal text. Reference definitions
use normalized Unicode labels in a hash index; duplicate definitions keep the first value.

Unicode label folding reuses the existing Unicode 17.0.0 tables through
`UnicodeCase.fold` in `silk.text.regex_unicode`. Its `CaseMapping` result holds up to three
scalars. Label normalization collapses only spaces, tabs, and line endings. The 999-character
label limit counts Unicode characters rather than UTF-8 bytes. Delimiter flanking uses
Unicode `Zs` for whitespace and the `P` and `S` general categories for punctuation.

## Entity generation

Run `scripts/markdown/generate-entities` to regenerate `stdlib/silk/markdown/entities.silk`.
The generator follows `scripts/unicode/`: an executable Python script, checksum-pinned
upstream input cached under `build/`, and a generated Silk module with provenance in its
header. It reads [WHATWG entities.json](https://html.spec.whatwg.org/entities.json), pinned
to SHA-256 `d741d877ac77c4194c4ad526b5b4a19aef8dfe411ab840a466891cdbb9f362e6`.
All 2231 names are stored as sorted NUL-separated UTF-8 records plus little-endian offsets.
Lookup is allocation-free binary search. The Markdown scanner requires the semicolon.

## Phase 2 integration points

Add syntax flags to `MarkdownOptions` and node variants to `MarkdownNodeKind`. Extend
`MarkdownNode` payload fields and document accessors for table alignment, task-list state,
footnote ids, frontmatter values, or alert metadata. Keep extension interpretation in
ordinary source; the compiler's private documentation Markdown scanners are unchanged.

Block extensions enter `blockLine` before its paragraph fallback. Table recognition can
promote an open paragraph, as setext headings do. Frontmatter and alerts enter the block
phase; task-list markers are extracted from item content after container matching. Inline
extensions enter `inlines`; paired strikethrough can extend the delimiter-stack categories,
while autolink literals can use special-byte scanning. Footnote definitions can use the
reference-extraction pass and a separate index. Add corresponding cases to the iterative
HTML renderer. Outline, slug, and plain-text helpers can walk the public preorder tree.
There are no extension flags, placeholder variants, or extension syntax in phase 1.
