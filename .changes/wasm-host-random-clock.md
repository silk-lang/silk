---
bump: minor
---

`OsRandom`, `OsSystemClock` and `OsMonotonicClock` now work on `wasm32-unknown-unknown` through the host imports `silk.random` and `silk.clock`, which `host/wasm-runner.mjs` supplies, so a browser program provides the same services as a native one.
