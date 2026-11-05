---
bump: patch
---

A standard-library function that does not type or ownership check is now reported where the library writes it, and a call of a method that collides with a field reports the collision (SEM0195) instead of a private field error.
