---
bump: patch
---

TLS clients and record layers get their buffers from `Allocator.allocateZeroed` instead of filling them byte by byte, and a TLS connection keeps its client state in one heap box, so handshakes no longer touch or move 14 KB of state they do not use.
