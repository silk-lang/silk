---
bump: patch
---

`silk.json.value.Value` stores arrays as `List<Value>`, objects as `List<JsonEntry>` and numbers as a `JsonNumber` converted at parse time, and a number outside the `f64` range now fails to parse with `JsonReason.NumberOutOfRange`.

## Migration

Match `Value.Array { values }` and `Value.Object { entries }` as `List<Value>` and `List<JsonEntry>` directly: remove `Box` and `JsonChild.Item`/`JsonChild.Member` unwrapping. Replace `Value.Number { text }` with `Value.Number { value }`, where `value` is `JsonNumber.Integer`, `JsonNumber.Unsigned` or `JsonNumber.Float`, or read it with `Json.asI64`, `Json.asU64` or `Json.asF64`. Remove uses of `JsonReason.InvalidValue`, which the scanner never reports.
