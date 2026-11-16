---
bump: minor
---

Resolve package-backed compilation graphs into explicit requests, including generated roots, package parameter bindings, dependency exclusions, and declared native inputs.

## Migration

Construct compilations with `Compilation.fromPackage`, `Compilation.executable`, or `Compilation.fromDefinition`; configure their settings before requesting an artifact. Dependency build tools always require a supported sandbox. Explicit request files must include `root-module` alongside the physical `root` path.
