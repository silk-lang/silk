These WASI Preview 2 interfaces are copied from Wasmtime v50.0.0,
`crates/wasi-http/wit/deps`, and describe WASI 0.2.12. They retain the upstream
documentation and stability annotations. WASI interfaces use the Apache License
2.0 with the LLVM exception; see the adjacent `LICENSE` file.

`world.wit` selects the standard imports and the HTTP handler world used by Silk.
Regenerate the unsafe source bindings with:

```sh
SILK_WASM_TOOLS=/path/to/wasm-tools node .github/scripts/generate-wasi-bindings.mjs
```

Application packages may provide their own WIT package and world through
`[component].wit` and `[component].world` in `silk.toml`.

`deps/logging.wit` is `wasi:logging@0.1.0-draft` from
[WebAssembly/wasi-logging](https://github.com/WebAssembly/wasi-logging), a draft proposal that only
`silk.io.logger_wasi` uses.
