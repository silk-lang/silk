# ColumnList benchmark

Compares one wide row kept as a `List` of structs and as a
`silk.collections.column_list.ColumnList`. It is not a CI gate: run it by hand when you change
`ColumnList`, the row field places (`rows[i].field`, `rows[..].field`), or the code the compiler
generates for them.

```sh
cd integration/column-list-benchmark
silk task bench --release
silk build --release && build/*/release/column-list-benchmark columns two-fields
```

`silk task bench` runs the suite of `src/tasks.silk` with `silk.bench`: it times whole processes,
so each time includes the build of the rows, and it reports the peak memory. The program also
writes one line of its own: the case, the layout, the nanoseconds of its fastest pass, and a
checksum that is equal for the two layouts. `column-list-benchmark sizes` writes the bytes a row.

## What it measures

The row is `Fragment` in `src/main.silk`: 30 fields, as a layout fragment of a UI library has. It
holds 11 `usize` links, 9 `bool` flags, four child structs of four `f32` values, a `[f64; 9]`, and
four 8-byte numbers. Each run builds 250,000 rows.

| Case              | One pass                                                                  |
| ----------------- | ------------------------------------------------------------------------- |
| `two-fields`      | For every row, add one `f64` field to another and store it.               |
| `group`           | For every row, read one child struct (four `f32` values) and sum it.      |
| `whole-row`       | For every row, give the whole row to a function that reads eight fields.  |
| `move-range`      | Move 62,500 rows 1,000 places toward the end, and back.                   |
| `append`          | Append 250,000 rows to an empty list.                                     |
| `append-reserved` | The same, into a list made with the capacity for them.                    |

A group is a child struct: `ColumnList` keeps a field of a struct type as one column, so the four
values of `box` sit together.

## Results

Linux x86_64, Intel Xeon at 2.10 GHz, 4 processors, one run of 2026-11-19. The fastest pass of
three runs, from the program's own line, in an optimized build:

| Case              | `List`   | `ColumnList` | `ColumnList` against `List` |
| ----------------- | -------- | ------------ | --------------------------- |
| `two-fields`      | 0.73 ms  | 0.16 ms      | 4.6 times faster            |
| `group`           | 1.44 ms  | 0.61 ms      | 2.4 times faster            |
| `whole-row`       | 7.39 ms  | 5.40 ms      | 1.4 times faster            |
| `move-range`      | 1.63 ms  | 1.57 ms      | equal                       |
| `append`          | 29.6 ms  | 56.0 ms      | 1.9 times slower            |
| `append-reserved` | 30.0 ms  | 30.4 ms      | equal                       |

The same build under `silk task bench --release --runs 10`, as whole processes that also build the
rows: `two-fields` 0.27x, `group` 0.54x, `whole-row` 0.99x, `move-range` 1.05x, `append` 1.79x,
`append-reserved` 1.07x of the `List` time, with equal peak memory.

In a debug build `two-fields` takes 7.0 ms on the `List` and 14.1 ms on the `ColumnList`. A debug
build inlines nothing, so each `rows[i].field` is a call of the list's function for that field,
and an index into a slice is not a call.

Bytes a row:

| Layout                                     | Bytes |
| ------------------------------------------ | ----- |
| `List<Fragment>` (a struct with padding)   | 288   |
| `ColumnList<Fragment>`                     | 281   |
| `ColumnList` with `Id<T>` for the 11 links | 237   |

## How to read it

- A loop that reads few fields is where columns win: the loop reads only the bytes of those
  fields. The `List` loop reads one 288-byte row for each 16 bytes that it uses.
- A whole row costs the same or less, because the 30 columns are 30 runs of adjacent bytes.
- An append to a list without a reserved capacity is slower. The offset of a column depends on the
  capacity, so each growth moves 29 of the 30 columns inside the block, and the `List` moves
  nothing when the heap makes its block larger in place. Reserve the capacity when the count is
  known.
