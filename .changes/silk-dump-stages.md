---
bump: minor
---

Add `silk dump tokens|syntax|hir|mir <source>`, which prints a source file's tokens, its syntax tree, its HIR, or the MIR its build lowers, including from the compiler built for WebAssembly.

## Migration

Run `silk dump syntax <source>` instead of `silk <source>`, and `silk dump hir <source>` instead of `silk hir <source>`.
