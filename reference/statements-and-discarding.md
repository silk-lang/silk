# Statements and discarded values

An expression statement evaluates an expression without binding or returning its result. The
current compiler accepts this form only when the result is `()` or `never`.

## STMT-001 — A non-unit expression result must be handled explicitly

**Status:** Confirmed

The current compiler rejects a standalone expression whose type is neither `()` nor `never`. To
discard such a result, source must say so explicitly with `drop`; to preserve it, source must bind
or return it.

```silk
effect fn answer() -> i32 { return 42 }

pub effect fn main() {
  drop run answer()
}
```

**Boundary:** Calling an effect function as a standalone statement constructs and then attempts to
ignore its lazy Effect value. It does not execute the Effect.

```silk,ignore
effect fn answer() -> i32 { return 42 }

pub effect fn main() {
  answer()
}
```

The current compiler reports `SEM0087` because the statement produces `Effect<i32>`.

**Diagnostics:** A non-unit expression statement reports `SEM0087` at the expression and includes
the produced type. The error must distinguish constructing and discarding an Effect from executing
it; it must not imply that the Effect body ran.

This is a uniform statement rule rather than a borrow-checker requirement. It rejects an ignored
`i32` even though the value is Copy, and it rejects an affine result before automatic cleanup can
silently stand in for authored intent. The same rule prevents a lazy Effect construction from
looking like execution. `drop` is the explicit statement that the result is intentionally unwanted.

Dropping an Effect value does not run it. `drop answer()` constructs and discards the Effect;
`drop run answer()` executes it and discards its successful result.

**Evidence:** expression-statement requirements,
[semantic implementation](https://github.com/silk-lang/silk/blob/bbab200c9fb9c17c1611436cb031f45f4d0e8fb7/bootstrap/packages/compiler/src/Elaboration.ts),
elaboration tests.

When the operand is an owned place, `drop place` performs cleanup on its live remainder, including
a partial aggregate. It ends that place's ownership and skips components already moved away.
This differs from passing `move place` to an ordinary function, which requires a complete value.
Active loans and whole-value user `Drop` boundaries still apply; a second drop is use after move.
