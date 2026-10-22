---
bump: patch
---

A long `silk lsp` session no longer grows with every edit: after each step the server drops the roots its request demanded and the lowered MIR functions that reruns replaced (`Request.forgetRoots`, `Semantic.releaseStaleMir`). Over 40 edits to the standard library the store grew 6 MB instead of 107 MB. `silk check --replay` reports `answers=` and `mir-functions=`, and CI replays a twenty-edit script that must end the same size it started.
