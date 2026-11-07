---
bump: patch
---

`sendAll` runs a whole batch on one set of worker tasks. The root task steps each request to its next job and queues at most one job for each worker, instead of preparing rounds of jobs and forking a new set of workers for each round. On loopback HTTPS this sends 17% more requests per second at 64 connections and 10% more at 16.
