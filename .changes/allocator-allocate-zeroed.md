---
bump: minor
---

Add `Allocator.allocateZeroed`, a required service operation that returns storage whose bytes start as zero; the system provider gets it from `calloc` (or `HeapAlloc` with `HEAP_ZERO_MEMORY` on Windows), so untouched pages cost nothing.

## Migration

Every `Allocator` provider must now define `allocateZeroed`. A provider that wraps another one forwards the request, as in `return run Allocator.allocateZeroed(move layout) |> Effect.provideMut<Allocator>(&mut inner)`; a provider that hands out its own storage writes the zeros before returning it.
