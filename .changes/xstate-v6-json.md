---
bump: patch
---

`Xstate.write` writes the JSON of xstate v6: guards as `{"type"}` objects, a `target` on history states, and done transitions on `xstate.done.state`; `Xstate.read` takes both v5 and v6 forms.
