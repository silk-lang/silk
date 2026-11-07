---
bump: minor
---

A signature can write an elided lifetime as `'_`, as in `fn width(span: Span<'_>) -> usize`, and `once effect fn(A) -> B ! F ? S` spells a callable whose call returns an Effect, the same contract as `for<use 'call> once fn<'env>(A) -> once Effect<'call & 'env; B ! F ? S>`.
