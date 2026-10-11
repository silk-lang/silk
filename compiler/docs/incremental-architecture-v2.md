# Incremental architecture v2

**Status:** design note for Julia's review. Nothing here is implemented. Outline only; sections
are filled in as evidence arrives.

**Inputs:** the Zig source audit in [research/zig-incremental-verification.md](research/zig-incremental-verification.md),
the #1359 cold-build gate, the native self-build profile (#1427), identity interning (#1431) and
the borrow-checking note (#1421).

Every claim is tagged **[measured]**, **[source]** (with a `path:line` on `selfhost` or a Zig
citation through the audit) or **[assumption]**.

## 1. Current state

What a cold build records and validates today, and what it costs.

## 2. Units and dependees

## 3. Source change detection

## 4. The graph

## 5. Recording policy

## 6. Invalidation and cutoff

## 7. Lifecycle

## 8. Language and safety-model proposals

## 9. Budgets and evidence

## 10. Migration and slices

## 11. Open questions for Julia
