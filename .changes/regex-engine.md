---
bump: minor
---

`silk.text.regex` has a new engine: matching is 15 to 100 times faster, a pattern that scans long text once, such as `^[a-z]+$`, no longer fails with `MatchLimit`, and `RegexError` carries a `message` with `RegexReason` reduced to `Syntax`, `PatternLimit` and `MatchLimit`.

## Migration

Match syntax failures with `RegexReason.Syntax` instead of the removed specific reasons such as `UnclosedGroup`; read `RegexError.message` for the detail.
