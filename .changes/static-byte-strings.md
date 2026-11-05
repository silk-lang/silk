---
bump: patch
---

Constants can hold byte-string literals, including in struct fields and array elements, and `--backend direct` builds now go to `build/direct/` instead of `build/llvm/`.

## Migration

Scripts that read `--backend direct` outputs read `build/direct/<target>/<profile>/<name>` instead of `build/llvm/<target>/<profile>/<name>`.
