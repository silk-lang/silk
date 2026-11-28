---
bump: minor
---

Remove `[component]` from `silk.toml` and configure WebAssembly component settings on `Compilation.wasm` in `build.silk` using `WasmSettings`.

## Migration

Remove `[component]` (`world`, `wit`) from `silk.toml` and pass a `WasmSettings` struct to `Compilation.wasm` in `build.silk`:

```silk
import silk.build.compilation { Compilation }
import silk.build.definition { WasmSettings }

let compiled = Compilation.wasm(
  compiled,
  WasmSettings {
    ..WasmSettings.make(),
    wit: Option.some(run String.copy("wit")),
    world: Option.some(run String.copy("app")),
  },
)
```
