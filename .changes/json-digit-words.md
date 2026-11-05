---
bump: patch
---

`Json.parse` reads number digits 8 at a time, including a final partial group (canada.json parse 11% faster).
