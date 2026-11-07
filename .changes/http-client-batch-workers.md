---
bump: patch
---

`sendAll` runs a whole batch on one set of worker tasks. The root task steps each request to its next job and hands it to a worker without one, through a queue of that worker's own, instead of preparing rounds of jobs and forking a new set of workers for each round. On loopback HTTPS this sends about 19% more requests per second at 64 connections and 17% more at 16.
