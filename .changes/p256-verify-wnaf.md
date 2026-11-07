---
bump: patch
---

ECDSA P-256 verification is about twice as fast: it computes u1·G + u2·Q in one width-5 NAF pass with mixed Jacobian additions, squares with a dedicated routine, and compares r against the Jacobian X coordinate without inverting Z.
