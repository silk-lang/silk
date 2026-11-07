---
bump: patch
---

`sendAll` in the native HTTP client sends a large batch in rounds of at most 128 requests, or two for each task when the client runs more than 64 tasks, so a round's prepared requests and responses stay in cache: at 64 connections a batch of 256 HTTPS requests takes about 15% less time for each request. The worker tasks keep their trust sources from one round to the next, and a request no longer copies the client's whole table of default headers.
