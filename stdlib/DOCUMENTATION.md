# Standard-library documentation workflow

The comments in `silk/*.silk` are the standard library's canonical API documentation. Follow the
[Silk doc comment style guide](../reference/documentation-style-guide.md) for comment
coverage, structure, examples, links, language, and review rules.

This file defines the additional repository workflow for standard-library documentation.

## Generated outputs

`silk doc-reference` renders these `//!` and `///` blocks into the generated reference in
[`reference/stdlib/`](../reference/stdlib/index.md); never edit those pages by hand. After changing
a comment, regenerate them with a native compiler built from this checkout:

```sh
"$SILK_COMPILER" doc-reference --stdlib-root "$PWD/stdlib" --output "$PWD/reference/stdlib"
```

Selfhost CI fails when the committed pages differ from the generator's output.

## Module categories

Each module header ends with an `@category` line (see the style guide). Give a new module the
category of the modules that it is used with. The current categories are: Numbers, Geometry, Core, Text,
Collections, Memory, Concurrency, Input and output, System, Data formats, Cryptography, TLS and
certificates, HTTP, Networking, SIMD, Native platform, Testing, and Compiler support.

## Example evidence

`silk doctest --stdlib` compiles each ordinary `silk` fence exactly as written. It adds no prelude or hidden
wrapper. Use `silk ignore` only when an intentionally invalid example becomes less clear as a
complete valid program.

A doctest proves compilation. It does not prove runtime behavior. A claim about results, ownership,
lifecycle, failure, or ordering must have a behavioral test.

## Public representation

Document the public surface that the compiler currently exposes. Do not change visibility during a
documentation-only pass. Record a likely visibility defect in the local Markdown tracker.

## Completion standard

A standard-library documentation change is complete when:

- each changed claim agrees with implementation and tests;
- each required summary is locally owned by its declaration;
- each symbol link resolves;
- each example builds with the native compiler; and
- the repository checks pass.
