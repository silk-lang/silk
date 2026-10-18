# `@silklang/docgen`

Documentation generation for Silk source. The compiler retains raw attached comment blocks; this
package interprets them as CommonMark only when hover, highlighting, documentation generation,
doctesting, or site rendering asks for them.

## Source syntax

Use `//!` for a module document at the beginning of a source file and `///` immediately above a
documented declaration. Declaration documents attach to functions, structs, fields, parameters,
type parameters, implementations, and implementation operations.

````silk
//! Recovery utilities.

/// Recovers a [`Problem`] by returning its code.
///
/// # Examples
/// ```silk
/// recover(Problem { code: 1 })
/// ```
effect fn recover(
  /// The problem to inspect.
  problem: Problem
) -> I32 {
  return problem.code
}
````

A blank line or ordinary `//` comment between a `///` block and its declaration breaks attachment.
`////` is an ordinary line comment. Documentation is CommonMark rather than a tag language:
examples live under an `Examples` heading, while return types, failures, and requirements come from
the compiler-derived signature. Rust-style links such as ``[`Problem`]`` resolve against compiler
scope facts when possible and remain readable inline code when unresolved.

Documentation cannot reject a program. Markdown is parsed as a total, best-effort operation; an
unexpected parser failure produces a plain-text document. Markdown interpretation never runs as
part of ordinary compiler analysis.

## Package interfaces

- `Document` normalizes raw markers into an immutable package-owned CommonMark model, discovers
  examples, resolves semantic links, and renders editor Markdown.
- `Highlight` returns doc-only ranges for markers, Markdown constructs, links, and nested fenced
  Silk source.
- `Project` projects an analysis snapshot into source-ordered, public-by-default documentation with
  compiler-derived signatures and first-class child documents.
- `Json` deterministically encodes that project model with one final newline.
- `Doctest`, `Example`, `Report`, `Sources`, and `Stdlib` collect and compile fenced Silk examples.
- `Model`, `Prose`, `Search`, `Site`, and `Html` decode documentation JSON and render a static,
  searchable HTML site.

The JSON identifies itself with `"schema": "silk-documentation"` and
`"experimental": true`. It is a formatter-neutral intermediate representation, not a stable schema
or an HTML/site format. During bootstrap its shape may change without migration support. Consumers
can build Markdown, HTML, terminal, or site formatters over the model.

## Command-line use

This package has no executable entry point and performs no process-level orchestration. The
`@silklang/cli` package owns the commands:

```console
$ silk doc --output build/documentation.json
$ silk doctest --input build/documentation.json --source-root src
$ silk docs-site --input build/documentation.json --output build/site --title "My library"
```

`silk doctest --stdlib` checks the compiler-shipped standard library. A doctest is one complete
module exactly as written; use a `silk,ignore` fence when an example is intentionally illustrative
rather than compilable.

The static renderer writes plain HTML, CSS, and JavaScript search data. A caller may provide a
`<silk-snippet>` bundle as opaque text; otherwise examples use the renderer's static code fallback.
Rendering is deterministic and filesystem-independent; reading inputs, loading optional assets,
and writing outputs are responsibilities of the CLI package.
