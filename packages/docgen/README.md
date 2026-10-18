# `@silklang/docgen`

CommonMark documentation support for Silk editors and formatters. The compiler retains raw
attached comment blocks; this package interprets them on demand for language-server hover,
editor highlighting, and lossless documentation code-fence formatting. Ordinary compilation
does not require Markdown parsing.

## Editor and formatter APIs

- `Document` normalizes compiler-owned documentation blocks, parses CommonMark into an immutable
  package-owned tree, and renders Markdown for editor hover, including symbol references as code.
  Malformed Markdown remains readable rather than becoming a compiler diagnostic.
- `Highlight` supplies documentation and fenced Silk syntax ranges for editor presentation.
- `CodeFence` discovers CommonMark fences with source byte ranges and rewrites selected bodies
  while preserving surrounding prose and unselected fence bytes. It is used by the canonical
  formatter and the standard-library documentation formatting script.

The internal `CommonMark` parser is shared by `Document` and `CodeFence`; it is not a public
package subpath. These APIs intentionally remain TypeScript dependencies of the LSP,
editor-support, and formatter packages.

## Native documentation generation

Reference Markdown generation/checking, project JSON, symbol links, and doctests
belong to the [native Silk compiler](../../compiler/README.md), implemented under
`compiler/src/documentation`. This package has no generation commands or compatibility exports.

Use native `silk doc`, `silk doctest`, and `silk doc-reference`; the native compiler README documents
their arguments and the repository generation commands. Repository automation requires
`SILK_COMPILER` to name the absolute path of a native compiler built from the current checkout.

## Development

```bash
pnpm --filter @silklang/docgen build
pnpm --filter @silklang/docgen typecheck
pnpm --filter @silklang/docgen test
```

The retained tests cover editor document parsing/rendering and lossless code-fence
rewriting. Native documentation behavior is tested with the native compiler.
