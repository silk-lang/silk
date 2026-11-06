---
bump: minor
---

A profile's `codegen-units = <n>` splits an optimized executable into `n` codegen units linked with ThinLTO, so the release link runs on several cores; without it the program stays one module, which runs fastest.

## Migration

Replace `SILK_CODEGEN_UNITS=<n>` with `codegen-units = <n>` in the build's profile.
