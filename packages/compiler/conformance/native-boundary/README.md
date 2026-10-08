# Native pointer boundary conformance

This designated lane compiles Silk to LLVM bitcode and native objects, compiles a separate C
translation unit, links them, inspects the object headers/symbols/relocations, and executes the
result. It runs debug and optimized modes for every requested target. Missing supplies and failed
commands terminate the run; there is no skip path.

The fixture tests C-to-Silk and Silk-to-C scalar arguments and narrow results, a callback passed
back through C, buffer writes with a separate length, nested nullable many pointers, an external
record with a fixed array, truly unaligned reads/writes, and a C-initialized output owner. C checks
record size/alignment and observes each write independently. The C translation unit never casts
its unaligned byte address to an aligned `int32_t *`.

## Pinned supplies

The [supply manifest](../../../../openspec/changes/archive/2026-09-10-add-native-pointer-boundary/supplies.json)
records normative revisions, LLVM/Clang 22.1.8, the macOS 15.5 SDK and deployment target 11.0.0,
and GNU compiler/linker/libc packages and header hashes. The runner verifies compiler versions,
SDK/header hashes, and every listed GNU package before conformance.

Build the two GNU images with the pinned Dockerfile:

```sh
docker build --platform linux/arm64 -t silk-jul123-conformance:arm64 packages/compiler/conformance/native-boundary
docker build --platform linux/amd64 -t silk-jul123-conformance:amd64 packages/compiler/conformance/native-boundary
```

Run all three targets from a Darwin ARM64 host with Docker's Linux runners:

```sh
pnpm --filter @silklang/compiler build
pnpm --filter @silklang/compiler test:native-boundary
```

Pass explicit target ids to select a designated CI lane. Each selected target must execute both
modes; selecting a lane does not report the other targets as passed:

```sh
pnpm --filter @silklang/compiler test:native-boundary aarch64-unknown-linux-gnu x86_64-unknown-linux-gnu
```

`SILK_BOUNDARY_CLANG`, `SILK_BOUNDARY_LD64`, and `SILK_BOUNDARY_SDK` select physical paths to the same pinned supplies.
`SILK_BOUNDARY_OUTPUT` selects the output directory. The default is `.scratch/native-boundary`
at the repository root. It contains bitcode, LLVM text, object files, C runtime source, object
inspection output, executables, and `report.json` with supply identities and content hashes.

LTO is outside the supported compilation profile. The runner verifies that an explicit `lto`
profile field is rejected and does not substitute an untested LTO invocation for either native
object mode.
