---
bump: patch
---

Report errors inside a standard-library `effect fn` that requires a service, such as `? &mut Allocator`, at the library line instead of the call.
