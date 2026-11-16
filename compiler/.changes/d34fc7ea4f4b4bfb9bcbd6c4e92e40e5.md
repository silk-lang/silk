---
bump: minor
---

The runtime prints an unhandled error's `Debug` value.

## Migration

Every error type an effectful `main` can raise must implement `Debug`; `Format.debugFields` does it in one line.
