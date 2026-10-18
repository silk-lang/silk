# Frozen TypeScript bootstrap

This is the original Silk compiler, written in TypeScript. It is frozen: its only job is to build
the first native compiler, the commit named in [`anchor.json`](anchor.json), from source. From
there the native compiler in [`compiler/`](../compiler) builds itself from its pinned seed.

Change it only when that build breaks. [Bootstrap CI](../.github/workflows/bootstrap.yml) runs
when this directory or what builds it changes, and weekly. It bundles the compiler into one
`silk.mjs`, smoke-tests the bundle with Node 24 and Bun, and builds n0: the bundle builds the
anchor's compiler (T1), T1 emits that compiler's LLVM IR for each target, each target links the IR
into N1, and N1 builds n0. N1 and n0 must emit T1's IR byte for byte, n0 must build the current
native compiler, and once n0 is published every run must rebuild its exact bytes.

A manual run of the workflow on `main` with publish ticked publishes the bundle as
`bootstrap-v<version>` (the version of `packages/cli/package.json`), with `silk.mjs` and its
SHA-256, and n0 as `v<version>` (see `compiler/README.md`). Both releases are immutable. The
bundle needs no checkout, dependencies, or build:

```sh
gh release download bootstrap-v0.0.0 --repo silk-lang/silk --pattern 'silk.mjs*'
sha256sum -c silk.mjs.sha256
node silk.mjs --help
```

To build it locally, run `pnpm bundle:bootstrap` from the repository root; the output is
`bootstrap/packages/cli/dist/silk.mjs`. The standard library it compiles with is embedded in
`packages/compiler/src/Stdlib.generated.ts`, the anchor's standard library.
