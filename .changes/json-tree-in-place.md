---
bump: patch
---

`Json.parse` builds each value in its place in the parent's list instead of returning it through a copy (canada.json parse 9% faster, citm_catalog.json 3%).
