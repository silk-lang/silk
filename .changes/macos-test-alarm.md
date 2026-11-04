---
bump: patch
---

Tests of packages without native sources link on macOS again: the libSystem stub now exports `alarm`, which the test runner uses for time limits.
