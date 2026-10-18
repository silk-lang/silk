# `@silklang/formatter`

Formats one complete Silk source artifact with the canonical project policy. In addition to ordinary
syntax layout, active fenced `silk` examples in attached `///` and leading `//!` documentation are
formatted recursively in the source file that owns them.

```ts
import * as Formatter from '@silklang/formatter/Formatter'

const formatted = yield * Formatter.format(syntax)
```

The formatter is pure and document-local. Syntax damage, an unclosed active fence, or damage in any
active embedded module refuses the complete artifact without exposing partial replacement bytes.
