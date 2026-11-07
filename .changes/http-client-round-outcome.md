---
bump: patch
---

`sendAll` keeps each job's failure boxed while a round collects results, so the result slots of a round hold a pointer and not a whole `HttpError` for every request.
