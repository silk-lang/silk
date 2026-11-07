---
bump: minor
---

Add `silk hash`, which prints a SHA-256 of everything a build of the package reads (its import tree, manifests, dependencies, native sources, profile and compiler), usable as a cache key across machines.
