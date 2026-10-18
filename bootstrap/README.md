# Frozen TypeScript bootstrap

This is the original Silk compiler, written in TypeScript. It is frozen: its only job is to build
the first native compiler, the commit named in [`anchor.json`](anchor.json), from source. From
there the native compiler in [`compiler/`](../compiler) builds itself from its pinned seed.

Change it only when that build breaks. [Bootstrap CI](../.github/workflows/bootstrap.yml) runs
only when this directory or what builds it changes. It bundles the compiler into one `silk.mjs`,
smoke-tests the bundle with Node 24 and Bun, and runs a diverse double compilation: the bundle
builds the anchor's compiler (T1), the anchor's pinned seed builds it too (N1), and both must emit
the anchor compiler's LLVM IR byte for byte.

On `main`, a passing run publishes the bundle as the `bootstrap-<commit>` GitHub release, with
`silk.mjs` and its SHA-256. It needs no checkout, dependencies, or build:

```sh
gh release download bootstrap-<commit> --repo silk-lang/silk --pattern 'silk.mjs*'
sha256sum -c silk.mjs.sha256
node silk.mjs --help
```

To build it locally, run `pnpm bundle:bootstrap` from the repository root; the output is
`bootstrap/packages/cli/dist/silk.mjs`. The standard library it compiles with is embedded in
`packages/compiler/src/Stdlib.generated.ts`, the anchor's standard library.
