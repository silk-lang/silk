# Breadth-first search

Searches an unobstructed 5×5 grid from its first cell to the opposite corner. Breadth-first search
discovers cells in distance order, so the returned shortest distance is eight grid edges.

The effectful entry point verifies that distance and then returns `()`. A successful process exits
with status zero; `OutOfMemoryError` is deliberately left to the runtime's unhandled-effect reporting
instead of being caught in the example.

The append-only queue is a `List<QueueEntry>` imported from the physical Silk standard library.
Visiting all 25 cells grows its capacity from zero through 4, 8, 16, and 32. Those transitions make
four allocations; each old buffer releases after migration and the final buffer releases when the
queue leaves scope. At most the old and replacement buffers are live together.
