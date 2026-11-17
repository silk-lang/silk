---
bump: patch
---

`silk check` and the other commands that compile no native code no longer fetch the archives native code reads: a plan's archive files are fetched when they are compiled or linked. A step that reads an archive, and `Plan.compileSources` over one, still fetch it when the plan runs.
