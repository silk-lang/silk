---
bump: patch
---

`Intrinsic.FunctionRef` holds a static function value with its contract erased, so one description can store checks of different types; `Intrinsic.functionAs<F>` restores it, and a lifetime-generic function such as `fn(&u32) -> bool` can now be read by runtime code as well.
