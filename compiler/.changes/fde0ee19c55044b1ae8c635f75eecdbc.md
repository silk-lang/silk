---
bump: minor
---

A `with Namespace.operation(...)` clause after a declaration header is no longer Silk syntax; it reports PAR0011, which names the directives to write before the declaration instead.

## Migration

Move each `with Intrinsic.*(...)` clause into directives on the lines before the declaration: `with Intrinsic.inlineAlways()` is `@inlineAlways`, `with Intrinsic.foreign(memory: "read", callbacks: ("f",))` is `@foreign(memory: "read")` and `@callbacks("f")`, `with Intrinsic.machine(features: ("avx2",), naked: true)` is `@features("avx2")` and `@naked`, and `with Intrinsic.foreign(module: "m", name: "n")` on an import is `as "m#n"` after the signature.
