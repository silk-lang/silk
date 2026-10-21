---
bump: minor
---

The Execution package protocol is now safe when a Wake is signaled from another thread. The compiler accesses the package's authority count, lifecycle and notifying marker atomically, and the control-word operations become an acquire `executionLoad`, a release `executionStore` and a new `executionCompareExchange`. `silk.execution` packs the park generation and readiness phase into one control word, moves between phases only by compare-exchange, and publishes `Eligible` before it runs the readiness endpoint. A notification that races a drop now runs nothing instead of trapping. Handles stay local: none is `Transferable` yet.
