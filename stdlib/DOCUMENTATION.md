# Standard-library documentation workflow

The comments in `silk/*.silk` are the standard library's canonical API documentation. Follow the
[Silk doc comment style guide](../reference/documentation-style-guide.md) for comment
coverage, structure, examples, links, language, and review rules.

This file defines the additional repository workflow for standard-library documentation.

## Generated outputs

The native `silk doc` reads the same `//!` and `///` blocks for generated reference pages and
editor hovers. Until it lands, Selfhost CI's repository coverage builds every active `silk` fence
in these comments with the native compiler.

## Example evidence

The doctest compiles each ordinary `silk` fence exactly as written. It adds no prelude or hidden
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
