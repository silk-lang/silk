# Markdown conformance

`check-commonmark` checks `silk.markdown.document` and `silk.markdown.html` against all
652 examples of [CommonMark 0.31.2](https://spec.commonmark.org/0.31.2/). CI does not run it.
All 652 examples pass with strict default syntax; there are no excluded CommonMark examples.

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

The runner sets `rawHtml: true`, `unsafeLinks: true`, and `headingIds: false` for reference output.
Its optional second argument selects `safe` (safe rendering), `parse` (strict parse only),
`gfm` (the four GFM syntax extensions), `all` (GFM plus footnotes, frontmatter, and alerts),
`all-safe`, `all-parse`, `text` (strict visible text), or `ids` (strict HTML with heading ids). Standard
output uses a 64 KiB `BufferedWriter`. It accepts valid UTF-8 files and exits with status 4
for invalid UTF-8, which the public parser's `string` input cannot contain.

The pinned downloads are:

| Input | SHA-256 |
| --- | --- |
| `spec.json` | `d431b29d97b6f73e69d547109cf5081578fac931e72afe95639ebe766c1b2a20` |
| `gfm-0.29-spec.txt` | `7d8e5814befec287ac116786d81ff14e0adc9b13295b4494649e995408fd871c` |
| `spec.txt` | `bfef4ddc97276b6ab6c2a28ace48478e35b1c50e60cde9f517ab8ab030aa3b82` |

A corrupt cache fails explicitly. Remove the affected file before fetching it again.
Downloaded data stays in `build/` and is never executed. The CommonMark specification is
licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).

## GFM and additional syntax

```sh
SILK="$HOME/.silk/bin/silk +0.1.0-dev.68+c11c7e82c2ab" \
  integration/markdown-conformance/check-commonmark --gfm --report /tmp/gfm-report.json
```

This mode extracts every example in the four extension sections of
[GFM 0.29-gfm](https://github.github.com/gfm/), from the checksum-pinned
[cmark-gfm 0.29.0.gfm.13 specification source](https://github.com/github/cmark-gfm/blob/0.29.0.gfm.13/test/spec.txt).
It enables `MarkdownOptions.gfm()` and compares UTF-8 HTML byte for byte. Results are tables
8/8, task list items 2/2, strikethrough 2/2, and autolink literals 11/11: 23/23 total.
The task-list examples permit different checkbox serialization. The harness preserves
`specHtml` in the JSON report and uses cmark-gfm's exact `type`, `checked`, `disabled`,
and `/>` spelling as `html` for those two examples. No example is skipped.

The Disallowed Raw HTML (`tagfilter`) extension is out of scope. Default rendering escapes
all raw HTML. Enabling `rawHtml` emits it verbatim without tag filtering.

`MarkdownOptions.make()` disables every extension. `gfm()` enables only `tables`,
`strikethrough`, `taskLists`, and `autolinkLiterals`. `footnotes`, `frontmatter`, and `alerts`
are independent flags. The standard-library reference documents tree accessors, visible
text, outlines, and reusable slug state in `silk.markdown.text`. HTML `headingIds` defaults
to false and uses the same slugger. Writer rendering requires an allocator for optional
heading-id state, as well as the writer; it does not flush.

Autolink literals include `www.`, `http://`, `https://`, `ftp://`, email addresses,
and cmark-gfm's lowercase `mailto:` and `xmpp:` protocol forms. Existing links and code
suppress literal links. Table cells run the normal inline parser after pipe unescaping,
including pipe escapes inside code spans. Cell and inline spans select the original source.

Footnotes match cmark-gfm's section, numbering, repeat-reference suffixes, and backref
HTML. Definitions use link-label whitespace normalization and Unicode case folding, as
required by this API; this also accepts labels containing spaces that cmark-gfm rejects.
Unreferenced definitions remain accessible in the tree and do not render. Frontmatter
borrows its raw body without YAML or TOML interpretation. Alerts are block containers with
the marker line removed.

A local cmark-gfm 0.29.0.gfm.13 oracle matched all three upstream footnote fixtures,
all 240 generated footnote cases, and 1,330 of 1,332 seeded mixed-inline/table cases. The two retained differences are a lowercase
HTML declaration accepted by CommonMark 0.31.2 but rejected by the older oracle, and a
same-line nested task item (`- 2) [ ] text`) that follows the GFM task-marker rule but is
missed by that oracle. These are not excluded from the specification conformance mode.

## Pathological inputs and throughput

```sh
SILK="$HOME/.silk/bin/silk +0.1.0-dev.68+c11c7e82c2ab" \
  integration/markdown-conformance/check-commonmark --pathological
SILK="$HOME/.silk/bin/silk +0.1.0-dev.68+c11c7e82c2ab" \
  integration/markdown-conformance/check-commonmark --bench
```

The pathological mode retains the ten plain-CommonMark cases and adds seventeen cases
with all extensions enabled: pipe and tilde storms, 10,000-column tables with 50 full rows,
a table with many short rows, 100,000 footnote openers, 100,000 definitions and references,
cyclic footnotes, URL/domain/email/parenthesis/entity storms, decoded email text, 256 nested
quote/alert containers, a 10 MB unclosed frontmatter opener, and escaped extension runs.
Each process must finish successfully within 20 seconds. All 27 pass. Corpus programs
assert results and source/tree invariants without timing assertions.

The benchmark repeats the pinned specification text to approximately 10 MB. It reports the
best of three runs for parse-only and parse-plus-render, including file reading and process
startup. If `cmark`, `md2html`, or `pulldown-cmark` is on PATH, it also times that command on
the same input. It installs nothing. Comparisons use standard input and discard output;
these are process-level measurements, not a controlled microbenchmark.

On AArch64 macOS, the phase 2 baseline measured 77.81 MB/s for parsing and 68.18 MB/s
for parsing plus rendering. With the extensions implemented and disabled, it measured
78.67 MB/s and 69.43 MB/s. These process-level measurements are within ordinary timing
noise; they are observations, not correctness thresholds. Installed `md2html` measured
about 205 MB/s. cmark-gfm was built separately in a temporary directory for differential
checks; the harness installs no oracle.

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
Footnotes have a separate normalized-label index. A preorder walk counts each reference once,
including references inside definitions, so self-references and cycles terminate. Table rows allocate only their
actual output cells. As in cmark-gfm, tables stop accepting rows after the count of padded
cells exceeds 524,288; the next line returns to ordinary block parsing.

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

## Slug lowercase data

`scripts/markdown/generate-slug-lowercase` generates private exceptions in
`stdlib/silk/markdown/text.silk` from checksum-pinned Unicode 17.0.0 `UnicodeData.txt`,
`SpecialCasing.txt`, `CaseFolding.txt`, and `DerivedCoreProperties.txt`. It reuses the
stdlib's case-fold mapping and stores only differences needed for lowercase conversion
and final-sigma context properties. `--check` verifies reproducibility. Downloads use
`build/markdown/` and are never executed. Unicode data is covered by the
[Unicode License v3](https://www.unicode.org/license.txt).
