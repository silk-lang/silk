---
bump: patch
---

Optimized executables split into 16 balanced codegen units linked with ThinLTO by default, so the release link step runs on every core (scroll-demo: 2m34s to 45s on 4 cores).
