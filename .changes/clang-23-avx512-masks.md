---
bump: patch
---

Builds whose CPU features include avx512vl with avx512dq or avx512bw (as `cpu.model = "native"` gives on recent x86 CPUs) now need Clang 23, because Clang 22 miscompiles their mask code.
