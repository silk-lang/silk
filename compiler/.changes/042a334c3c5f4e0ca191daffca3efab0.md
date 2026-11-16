---
bump: patch
---

Optimized builds copy values between places that cannot overlap with `memcpy`, so LLVM builds a struct literal like `Outer { inner: Inner.new() }` directly in its binding instead of in temporaries.
