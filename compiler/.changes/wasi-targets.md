---
bump: minor
---

Add the `wasm32-wasip1` WASI command target and the `wasm32-wasip2` WASI component command target, with explicit host inputs, file and stream providers, clocks, randomness, raw Preview 1 ABI bindings, and Wasmtime-backed `silk run` and `silk test`. Preview 2 final executables require wasm-tools and `SILK_WASI_ADAPTER` naming the WASI command adapter. Both targets are single-threaded and need no libc or WASI SDK. See `reference/wasi.md` for tool setup and host capability grants.
