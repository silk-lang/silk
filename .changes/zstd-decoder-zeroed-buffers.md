---
bump: patch
---

The Zstandard decoder takes its history window and block buffers from `Allocator.allocateZeroed` instead of filling them with zeros, so a large window costs memory only as a frame fills it.
