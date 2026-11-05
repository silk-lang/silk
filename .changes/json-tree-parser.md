---
bump: patch
---

`Json.parse` reads the document with its own recursive-descent parser and converts numbers in the same pass (canada.json 37% faster).
