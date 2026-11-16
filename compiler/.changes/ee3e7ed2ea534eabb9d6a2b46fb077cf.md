---
bump: patch
---

Split the cold cycle-scan, rotated-member and trace-recording paths out of `demandUnit`, `memberCycleAnswer` and `emit`, so their hot hit paths stay small. Front-end instructions drop 0.34% on an hr_shape build.
