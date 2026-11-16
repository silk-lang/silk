---
bump: patch
---

The local scheduler looks a task up twice per wake instead of five times, and skips the publication check when the task has nothing to publish.
