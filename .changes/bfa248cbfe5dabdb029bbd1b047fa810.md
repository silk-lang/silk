---
bump: patch
---

Fix compilations on Windows whose definition names the manifest or standard library in the host spelling (`C:\\...` or `C:/...`): `Compilation.fromDefinition` now records them as `/C:/...` instead of failing with "the path is not valid".
