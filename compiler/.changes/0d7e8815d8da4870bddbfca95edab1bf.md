---
bump: patch
---

`silk format` keeps a comment after a bare `return`, such as `return // nothing to do`, where it lately refused the file, and no longer adds a blank line after that `return`.
