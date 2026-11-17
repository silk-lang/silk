---
bump: patch
---

`silk check` now accepts an import of a symbol the package also exports when both print the same C declaration, such as `?*mut u8` and `?[*]mut u8`, as a build does.
