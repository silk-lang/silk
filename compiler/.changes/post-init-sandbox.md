---
bump: minor
---

`[[post-init]]` entries run in the build tool sandbox, confined to the new project with no network; a host with no sandbox needs `silk init --unsandboxed-post-init`.
