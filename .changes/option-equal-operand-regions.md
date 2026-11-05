---
bump: patch
---

Add `Equal` for `Option`, and let `==` and the other operators accept operands that differ only in lifetimes, such as `&found == &Option<string>.some("Ada")`.
