---
bump: patch
---

Symbolic links in package paths:

- A dependency whose `path` goes through a symbolic link, such as a linked folder or `/tmp` on macOS, is read at its real directory instead of failing with `no readable silk.toml`.
- A source file that is a symbolic link, or that sits under a linked folder, is read through the link.
- A dependency without a readable `silk.toml` names the directory it looked in, and a source file that cannot be read is named on its own line before the failure.
