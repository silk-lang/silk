---
bump: minor
---

`silk.text.regex` now runs the QuickJS engine from SilkJS: matching is 15 to 100 times faster, long text no longer fails with `MatchLimit`, and `RegexError` carries a `message` with `RegexReason` reduced to `Syntax`, `PatternLimit` and `MatchLimit`.

## Migration

Match syntax failures with `RegexReason.Syntax` instead of the removed specific reasons such as `UnclosedGroup`; read `RegexError.message` for the detail.
