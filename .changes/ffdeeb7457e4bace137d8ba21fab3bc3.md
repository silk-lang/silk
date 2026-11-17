---
bump: patch
---

Fix task-driven builds on macOS failing with "the path is not valid" when an input tree, such as the macOS SDK, holds a link back to one of its own directories.
