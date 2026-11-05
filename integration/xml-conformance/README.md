# XML conformance

`check-xmlconf` checks `silk.xml.document` against the W3C XML Conformance Test Suite
(`xmlts20130923`, pinned by SHA-256). CI does not run it. Run it by hand after a change to
`stdlib/silk/xml/`.

## Running

From the repository root:

```sh
SILK=silk SILK_STDLIB=$PWD/stdlib integration/xml-conformance/check-xmlconf
```

The script builds the runner in `src/main.silk`, downloads the suite once to `build/xmlconf`,
parses every selected case and compares accept or reject with the expected outcome. Leave out
`SILK_STDLIB` to test the stdlib of the installed `silk`. `--report PATH` writes every selected
case and its outcome as JSON.

The selection is the one that applies to a namespace-aware, non-validating processor that never
reads external entities. These cases are skipped:

- XML 1.1 and Namespaces 1.1;
- rules of earlier editions only;
- cases for processors that are not namespace-aware;
- optional errors (`TYPE="error"`);
- not-well-formed cases whose error is in an external entity, which the parser never reads.

`valid` and `invalid` cases must parse, and `not-wf` cases must fail. All 1899 selected cases
passed before the parser moved into the standard library.
