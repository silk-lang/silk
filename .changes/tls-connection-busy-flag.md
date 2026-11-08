---
bump: patch
---

A failed or cancelled `OwnedConnection` read, write, flush or shutdown leaves the connection `Invalid` with its transport open until `close` or drop, and runs without guard frames.
