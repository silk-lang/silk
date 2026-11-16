---
bump: patch
---

Build steps record the digest of each unchanged input and output tree beside the step cache, so a build through a project `Build` command no longer reads the toolchain and standard library on every run.
