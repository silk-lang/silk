---
bump: minor
---

Optimized executables split into 16 balanced codegen units linked with ThinLTO by default, so the release link step runs on every core (scroll-demo: 2m34s to 45s on 4 cores). A profile's `codegen-units` sets the count, replacing `SILK_CODEGEN_UNITS`.

## Migration

Replace `SILK_CODEGEN_UNITS=<n>` with `codegen-units = <n>` in the build's profile; `codegen-units = 1` keeps one module.
