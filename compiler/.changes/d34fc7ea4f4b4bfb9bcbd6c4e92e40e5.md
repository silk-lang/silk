---
bump: minor
---

The native runtime prints an unhandled error's value. Its report now ends with an `unhandled value:` line holding the error's `Debug` form, cut to 1024 bytes at a character boundary. In exchange, every error an effectful `main` can raise must implement `Debug` (SEM0225 says so); `Format.debugFields` does it in one line. A `main` that cannot fail needs nothing: `never` now takes every reference-only interface, such as `Debug`, since no value of it exists.
