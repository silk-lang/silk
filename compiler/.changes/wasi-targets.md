---
bump: minor
---

Add the `wasm32-wasip1` command target and the `wasm32-wasip2` command and component target, with explicit host inputs, filesystem and stream providers, clocks, randomness, all Preview 1 syscall bindings, and Wasmtime-backed `silk run`, `silk test`, and `silk doctest`. Both targets are single-threaded and need no libc or WASI SDK.

Preview 2 includes owned TCP, UDP, DNS, and HTTP providers, HTTP server components, and raw bindings for the bundled WASI interfaces. Packages can select custom WIT worlds and implement canonical ABI imports and exports, including strings, lists, records, and resources. Component builds require wasm-tools; commands also require `SILK_WASI_ADAPTER`, while pure Preview 2 components need no adapter. See `reference/wasi.md` for setup, bindings, and host capability grants.
