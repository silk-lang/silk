---
bump: patch
---

Fix git dependencies on Windows: git gets normal `C:\...` paths, the `silk` tool passes `SILK_HOME` in Windows spelling, and `FileSystem.removeFile` removes read-only files there as it does on Unix; add `WindowsPath.toArgumentBytes`.
