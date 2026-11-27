---
bump: patch
---

A per-package `optimization` or `debug` setting equal to the program's no longer splits the build, and a package optimized with `speed` in an unoptimized build now inlines across its modules and into the standard library code it calls (ThinLTO).
