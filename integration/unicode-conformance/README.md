# Unicode conformance

These runners check the stdlib Unicode modules against every row of the official Unicode 18 test files. CI does not run them. Run them by hand after a change to `stdlib/silk/text/` Unicode code or to the generators in `scripts/unicode/`.

## Running

Fetch the SHA256-pinned Unicode 18 files once. They go to `build/unicode/18.0.0`:

```sh
scripts/unicode/fetch-unicode
```

Then, from the repository root, run each runner:

```sh
silk test --release --manifest-path integration/unicode-conformance/silk.toml --root src/normalization_conformance.silk
silk test --release --manifest-path integration/unicode-conformance/silk.toml --root src/segmentation_conformance.silk
silk test --release --manifest-path integration/unicode-conformance/silk.toml --root src/line_break_conformance.silk
silk test --release --manifest-path integration/unicode-conformance/silk.toml --root src/bidi_conformance.silk
silk test --release --manifest-path integration/unicode-conformance/silk.toml --root src/sweep.silk
```

Add `--stdlib $PWD/stdlib` to test the stdlib in this checkout instead of the installed one. The runners read the files relative to the working directory, and `build/unicode` must be a real folder, not a symbolic link out of the repository.

| Runner | What it checks |
| --- | --- |
| `normalization_conformance` | `Unicode.normalizeNfc` and `Unicode.normalizeNfd` on every column of `NormalizationTest.txt`. |
| `segmentation_conformance` | Grapheme, word and sentence boundaries against `GraphemeBreakTest.txt`, `WordBreakTest.txt` and `SentenceBreakTest.txt`. |
| `line_break_conformance` | Line break opportunities against `LineBreakTest.txt`. |
| `bidi_conformance` | Levels and reordering against `BidiTest.txt` and `BidiCharacterTest.txt`, through rule L2. |
| `sweep` | Every property lookup over the whole code point range, with no traps. |

Each runner also checks the row count of its file, so a truncated download fails.

## Script itemization against ICU

`check-unicode-itemization` compares `silk.text.script_itemization` with the ICU 78.1 ScriptRun sample. It needs a C++17 compiler, `pkg-config` and the ICU development files (`libicu-dev` on Debian and Ubuntu). It downloads the two pinned sample files to `build/unicode/reference`.

```sh
SILK=silk SILK_STDLIB=$PWD/stdlib integration/unicode-conformance/check-unicode-itemization
```

The sample uses the primary Script property and not Script_Extensions, so a few cases differ on purpose. The script lists each one with its reason, and fails if either side changes.

## Regenerating the data

`scripts/unicode/generate-unicode` writes `stdlib/silk/text/unicode_data.silk` and `unicode_properties.silk` from the Unicode 18 files. `scripts/unicode/generate-dictionaries` writes the Thai, Lao, Khmer and Myanmar word dictionaries from the pinned ICU 78.1 data. Run them from the repository root after `scripts/unicode/fetch-unicode`. The generators emit code that `silk format` leaves unchanged.
