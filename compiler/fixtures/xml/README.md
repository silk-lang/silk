# XML conformance

`silk.xml.document` is an XML 1.0 Fifth Edition, Namespaces 1.0 non-validating
processor. The shared `xml-document` corpus case checks its API and regressions.
This opt-in harness adds independent W3C acceptance and XMLTEST output oracles.
It builds one native driver and feeds each document through standard input.

Download the [W3C 2013-09-23 suite](https://www.w3.org/XML/Test/), extract
`xmlts20130923.tar.gz`, then run from the repository root:

```sh
uv run --with lxml python compiler/fixtures/xml/verify.py \
  --suite /path/to/xmlconf --silk /path/to/silkc --clang /path/to/clang
```

The archive SHA-256 is
`9b61db9f5dbffa545f4b8d78422167083a8568c59bd1129f94138f936cf6fc1f`.
`lxml` reads the upstream catalog; expected outcomes and output come from the
suite, not from `lxml`. The driver emits the XMLTEST canonical format, not W3C
Canonical XML. It is a test adapter, not a public XML serializer.

The harness selects XML 1.0 Fifth Edition and Namespaces 1.0. It reports separate
counts for unsupported recommendations, earlier editions, namespace-incompatible
XML, optional errors, optional encodings, and failures that require reading
external entities. It compares the 117 standalone XMLTEST output files, including
normalized attributes, entity expansion, processing instructions, and notation
identifiers. Other selected cases check acceptance or rejection. Process crashes,
I/O failures, allocation failures, and timeouts never count as valid rejection.

The parser does not fetch external subsets or external entities. Use
`XmlDocument.skippedExternalContent` and `XmlDocument.skippedEntities` before
relying on a tree or attribute value being complete. It reports notation and
unparsed-entity identifiers through `notations` and `unparsedEntities`.

Specification anchors:

- [XML 1.0, non-validating processors](https://www.w3.org/TR/xml/#proc-types)
- [Parameter entities and internal-subset restrictions](https://www.w3.org/TR/xml/#sec-prolog-dtd)
- [Conditional sections](https://www.w3.org/TR/xml/#sec-condition-sect)
- [Notation declarations](https://www.w3.org/TR/xml/#Notations)
- [Namespaces in XML 1.0](https://www.w3.org/TR/REC-xml-names/)
