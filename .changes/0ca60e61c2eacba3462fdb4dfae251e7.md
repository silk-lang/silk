---
bump: patch
---

Fix git dependencies on Windows: git now gets normal `C:\...` paths, and the `silk` tool passes `SILK_HOME` to the compiler in Windows spelling; add `WindowsPath.toArgumentBytes`.
