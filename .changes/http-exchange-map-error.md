---
bump: patch
---

HTTP exchanges turn a failed transport read, write or flush into their own error with one `Effect.mapError` frame instead of `Effect.result` and a match, so each request runs fewer effect frames.
