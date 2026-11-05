---
bump: patch
---

An inherent impl member that restates its impl's type parameter now reports SEM0050, like interface and conformance members.

## Migration

To add bounds for some members only, move them to a separate impl block with the bound: `impl<T: Intrinsic.Copy> Box<T> { fn pick(self: &Self) -> T }`.
