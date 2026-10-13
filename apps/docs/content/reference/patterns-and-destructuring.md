# Patterns and destructuring

Patterns inspect existing value structure and introduce local bindings. Silk uses the same pattern
grammar in exhaustive `match`, unconditional `let` destructuring, and conditional `if let`.
The surrounding construct decides whether a pattern must always match or provides a mismatch path.
Scalar enums additionally provide a qualified, payload-free member pattern for exhaustive `match`.
Nominal unions provide parent-qualified unit and named-field variant patterns in `match`, `let`, and
`if let` wherever the surrounding context admits a refutable selection.

Patterns are not expressions. They perform no conversion, equality call, interface dispatch,
constructor call, or user-defined extraction.

## PATT-001 — One pattern grammar is shared across binding contexts

**Status:** Confirmed

The same nominal destructuring and whole-member patterns have the same meaning in `match`, `let`,
and `if let`. A context may reject a refutable or otherwise unavailable pattern without changing
the meaning of forms it accepts.

```silk
struct Point {
  x: i32
  y: i32
}

fn sum(point: Point) -> i32 {
  let Point { x, y } = move point
  return x + y
}
```

**Boundary:** Sharing the destructuring grammar does not make every pattern valid everywhere. An
unconditional `let` must prove success, while a `match` arm or `if let` may test a refutable union
member. The qualified scalar enum member form is currently match-only under PATT-020; it is not an
`if let` or unconditional destructuring form.

**Diagnostics:** A pattern form unavailable in its current context reports the form, context, and
nearest valid construct. No stable general code is assigned.

**Evidence:** [shared-pattern syntax requirements](../../../../openspec/changes/archive/2026-08-20-add-shared-pattern-destructuring/specs/bootstrap-syntax/spec.md),
[existing match grammar](../../../../openspec/specs/bootstrap-syntax/spec.md).

## PATT-002 — The matched expression chooses ownership access

**Status:** Confirmed

The matched expression is evaluated exactly once. Its ordinary syntax chooses access: a Copy value
may be read bare, `move value` consumes an owner, `&value` creates shared bindings, and
`&mut value` creates exclusive bindings. Patterns contain no second move or borrow language. `match place value` additionally refines an
owned discriminant without reading its complete payload. Its bindings denote selected places, so
explicit field moves may leave a partial owner after guard success; the variant proof ends at the
arm boundary. This access mode belongs to `match`, not `let` or `if let`.

```silk
if let Token { kind } = &event {
  return kind
}
```

**Boundary:** A bare affine value is not copied implicitly. Moving an unavailable owner, borrowing
a temporary beyond its owner, or borrowing an immutable place exclusively remains invalid.

**Diagnostics:** Invalid access receives the corresponding ordinary ownership or borrowing
diagnostic at the matched expression.

**Evidence:** [match access](functions-callables-and-control-flow.md#match-001--a-match-states-how-it-accesses-its-scrutinee),
[pattern ownership](ownership-and-borrowing.md#match-002--pattern-bindings-inherit-the-selected-match-ownership).

## PATT-003 — Nominal patterns select canonical nominal identity

**Status:** Confirmed

`Type { ... }` destructures one canonical nominal type. `Type binding` binds that complete nominal
payload. Imports and aliases may change how the type is spelled locally but do not create another
pattern case.

```silk
match move event {
  Token token => move token
  End {} => End {}
}
```

**Boundary:** A nominal pattern does not expose or compare a union's numeric tag. PATT-015–019 use
the same whole-value form for exact non-nominal members without inventing structural fields.

**Diagnostics:** A member absent from the scrutinee reports `SEM0042` and identifies both the
pattern type and scrutinee type.

**Evidence:** [nominal matching](functions-callables-and-control-flow.md#match-004--matching-narrows-only-inside-the-selected-arm),
[exhaustive matching specification](../../../../openspec/specs/bootstrap-exhaustive-matching/spec.md).

## PATT-004 — Field destructuring is recursive and explicit

**Status:** Confirmed

A field may bind under its own name, rename with `field: local`, or contain another nominal pattern.
Without `..`, every visible field must be named exactly once. `..` explicitly acknowledges omitted
fields, including fields inaccessible from the current module.

```silk
let Token { span: Span { start: offset, .. }, .. } = move token
```

Omitted owned state remains an ordinary cleanup obligation of the selected branch or binding
initialization.

**Boundary:** `..` does not grant access to private fields, forget owned state, or introduce a local
name for omitted data.

**Diagnostics:** Missing fields report `SEM0046`, duplicate fields `SEM0047`, and unknown or private
fields their ordinary field or visibility diagnostic.

**Evidence:** [nominal pattern completeness](functions-callables-and-control-flow.md#match-002--nominal-patterns-are-complete-or-explicitly-omit-fields),
[module visibility](modules-names-and-visibility.md#vis-002--private-declarations-remain-fully-visible-inside-their-defining-module).

## PATT-005 — Pattern bindings are fresh lexical locals

**Status:** Confirmed

Every name introduced by one pattern is a flat local declaration scoped to the successful body or
match arm. All bindings become available together after the pattern succeeds. Their precise types
and access modes come from the selected fields or whole payload.

```silk
if let Token { kind } = &event {
  return kind
}
```

`kind` exists only inside the selected body.

**Boundary:** Bindings cannot collide with one another or shadow another declaration visible in the
same scope. A conditional binding does not exist in its `else` body or after the conditional.

**Diagnostics:** Binding conflicts report `SEM0048`. A use outside the binding's scope receives the
ordinary unknown-name diagnostic.

**Evidence:** [pattern-binding specification](../../../../openspec/specs/bootstrap-exhaustive-matching/spec.md),
[name collision rules](modules-names-and-visibility.md#name-003--a-binding-collision-has-no-source-order-winner).

## PATT-006 — Unconditional `let` accepts only irrefutable destructuring

**Status:** Confirmed

`let Pattern = expression` is valid only when the initializer's static type proves that the pattern
must match. Destructuring an exact nominal value is irrefutable. Selecting one member from a
multi-member structural union is refutable and requires `if let` or `match`.

```silk
let Point { x, y } = move point
```

**Boundary:** This is invalid because `event` may be `End`:

```silk,ignore
let Token { kind } = move event
```

Silk does not insert a trap, default value, or hidden mismatch branch.

A standalone wildcard binding is not a second discard statement:

```silk,ignore
let _ = operation()
```

This form is invalid. Intentional result discard continues to use `drop operation()` so one rule
governs explicit discard throughout the language.

**Diagnostics:** A refutable `let` pattern reports `SEM0133`, includes the initializer type and
uncovered alternatives, and suggests `if let` or `match`. A standalone wildcard binding reports
the ordinary explicit-discard diagnostic `SEM0087` and suggests `drop` rather than silently
discarding the result.

**Evidence:** [shared-pattern syntax requirements](../../../../openspec/changes/archive/2026-08-20-add-shared-pattern-destructuring/specs/bootstrap-syntax/spec.md).

## PATT-007 — `if let` tests one refutable pattern

**Status:** Confirmed

`if let Pattern = expression { body }` executes `body` only when the pattern matches. An optional
`else` executes on mismatch and introduces none of the pattern bindings. `else if let` is ordinary
nested conditional syntax.

```silk
if let Token { kind } = &event {
  return kind
} else {
  return 0
}
```

**Boundary:** The first stabilization model has no pattern chains or guard attached to the
`if let` header. An additional boolean condition is an explicit nested `if` inside the selected
body.

**Diagnostics:** A malformed header receives a parser diagnostic local to the pattern, initializer,
or `=` separator. Pattern and ownership errors retain their ordinary diagnostics.

**Evidence:** [shared-pattern semantic requirements](../../../../openspec/changes/archive/2026-08-20-add-shared-pattern-destructuring/specs/bootstrap-semantic-facts/spec.md),
[ordinary conditional rules](functions-callables-and-control-flow.md#if-001--if-selects-one-statement-branch-using-a-boolean-condition).

## PATT-008 — A consuming conditional consumes on both outcomes

**Status:** Confirmed

When an `if let` initializer uses `move`, the source owner is consumed before its member is tested.
On success, selected fields or the complete payload become local owners. On mismatch, the unmatched
payload is cleaned before the mismatch path continues.

```silk
if let Token token = move event {
  return token.kind
}
return 0
```

**Boundary:** Pattern mismatch does not undo the move or reconstruct the original union. Using
`event` after the conditional is invalid on every continuing path.

**Diagnostics:** A later use reports the ordinary use-after-move diagnostic and points to the
conditional initializer as the consuming operation.

**Evidence:** [move semantics](ownership-and-borrowing.md#own-003--move-transfers-the-complete-value-and-consumes-the-source-binding),
[match cleanup](ownership-and-borrowing.md#match-002--pattern-bindings-inherit-the-selected-match-ownership).

## PATT-009 — A borrowed conditional preserves its owner

**Status:** Confirmed

With `&` or `&mut`, successful bindings are pattern-local loans and end with the selected body. A
pattern that introduces no bindings holds no loan in the selected body. A mismatch introduces no
field bindings. The original owner remains live after the complete
conditional, subject to ordinary loan lifetimes.

```silk
if let Token { kind } = &event {
  drop kind
}
return inspect(&event)
```

**Boundary:** A borrowed binding cannot move, escape, enter owned storage, or remain captured beyond
the owner and conditional scope.

**Diagnostics:** Escaping a borrowed pattern binding reports the ordinary borrowed-view escape
diagnostic.

**Evidence:** [borrow preservation](ownership-and-borrowing.md#borrow-003--a-borrow-preserves-the-original-owner),
[match ownership](ownership-and-borrowing.md#match-001--a-match-declares-how-it-accesses-its-scrutinee).

## PATT-010 — Redundant conditional patterns remain valid

**Status:** Confirmed

An `if let` whose pattern is statically irrefutable is valid and always selects its first body. The
compiler does not reject harmless redundancy.

```silk
if let Point { x, y } = move point {
  return x + y
}
```

**Boundary:** Redundancy does not make an invalid field, ownership transfer, or binding collision
valid.

**Diagnostics:** No compiler diagnostic applies. The language service may warn and offer conversion
to an unconditional destructuring `let`.

**Evidence:** [shared-pattern tooling requirements](../../../../openspec/changes/archive/2026-08-20-add-shared-pattern-destructuring/specs/language-server-completion/spec.md),
[tooling policy](runtime-and-standard-library.md#tooling-001--tooling-presents-library-source-and-derived-availability-honestly).

## PATT-011 — Patterns execute no user code

**Status:** Confirmed

Matching performs only compiler-defined canonical union-membership tests and nominal field
projections. It calls no interface operation, equality overload, conversion, constructor, accessor,
or extractor.

```silk
if let Token { kind } = &event {
  return kind
}
```

The test observes the union member and projects `kind`; it invokes no `Token` operation.

**Boundary:** Literal, range, alternative, negated, or user-authored extractor patterns require a
separate language direction.

**Diagnostics:** A syntax unavailable in the current pattern grammar receives a parser-owned
diagnostic and is not reinterpreted as an expression.

**Evidence:** [minimal compiler privilege](../../../../AGENTS.md),
[shared-pattern implementation design](../../../../openspec/changes/archive/2026-08-20-add-shared-pattern-destructuring/design.md).

## PATT-012 — Pattern diagnostics identify the failed proof

**Status:** Confirmed

An invalid pattern diagnostic identifies the smallest failed fact: refutability, absent member,
missing or duplicate field, visibility, binding collision, ownership access, unavailable context,
or escaped binding. It names the relevant scrutinee type and member or field set.

**Boundary:** One damaged pattern must not erase independent facts or cause later arms,
declarations, or statements to be parsed as part of the same error.

**Diagnostics:** Existing specific codes remain authoritative where assigned. Refutable
unconditional destructuring reports `SEM0133`; malformed `if let` syntax uses parser-owned
recovery diagnostics, and its member, field, binding, and ownership failures retain their ordinary
codes.

**Evidence:** [reference diagnostic policy](index.md),
[parser recovery contract](../../../../openspec/specs/bootstrap-syntax/spec.md).

## PATT-013 — Exhaustive `match` keeps its existing semantics

**Status:** Confirmed

Sharing patterns with `let` and `if let` does not weaken match. Source-order arms, guards,
exhaustiveness, reachability, local narrowing, explicit access, and reachable-result joins keep
their confirmed rules.

```silk
return match &event {
  Token { kind } if kind > 0 => kind
  Token { .. } => 0
  End {} => -1
}
```

**Boundary:** `if let` is a statement convenience for one selected pattern and mismatch path. It
does not make `if` value-producing or replace exhaustive `match` where every result is needed.

**Diagnostics:** Exhaustiveness, unreachable-arm, guard, and join diagnostics remain those of
MATCH-003–005.

**Evidence:** [match coverage rules](functions-callables-and-control-flow.md#match-003--match-coverage-is-exhaustive-and-guards-do-not-prove-coverage),
[exhaustive matching specification](../../../../openspec/specs/bootstrap-exhaustive-matching/spec.md).

## PATT-014 — The first destructuring surface stays deliberately small

**Status:** Confirmed

Initial destructuring is available in match arms, irrefutable local `let`, and refutable `if let`.
Destructuring assignment, parameter patterns, `while let`, `let ... else`, aliases binding both a
whole value and fields, pattern chains, and additional pattern operators remain unavailable.

**Boundary:** These omissions do not reserve implementation-specific behavior or permit a parser to
accept them without defined semantics.

**Diagnostics:** An unavailable construct receives a local syntax diagnostic. Tooling may suggest
the equivalent explicit `match`, nested `if`, or ordinary field assignment when one exists.

**Evidence:** [shared-pattern scope](../../../../openspec/changes/archive/2026-08-20-add-shared-pattern-destructuring/proposal.md).

## PATT-015 — A whole-value type pattern may select any exact union member

**Status:** Confirmed

The existing `Type binding` form extends from nominal payloads to any exact canonical member of a
structural union. It binds the complete selected value without destructuring it.

```silk
fn normalize(value: i32 | bool) -> i32 {
  return match move value {
    i32 number => number
    bool flag => 0
  }
}
```

Here `i32 number` selects and binds the complete integer member; `bool flag` selects and binds the
complete boolean member. The same form applies to admitted arrays, strings, finite represented
callable or Effect values, and other detached ordinary members when their exact type can be written.

**Boundary:** Field destructuring with `{ ... }` remains nominal-struct behavior. A scalar, array,
string, or represented executable pattern can bind the complete member but exposes no invented
fields. Lexical references are not detached union members and therefore are not selectors.

**Diagnostics:** A type absent from the scrutinee reports `SEM0042` with the exact requested type
and canonical member set.

**Evidence:** [ordinary structural unions](values-and-types.md#union-001--a-structural-union-is-a-normalized-set-of-ordinary-value-types),
[whole-member nominal pattern](#patt-003--nominal-patterns-select-canonical-nominal-identity).

## PATT-016 — Type-pattern coverage uses exact canonical identity

**Status:** Confirmed

An unguarded whole-value type pattern covers exactly its selected canonical member. Guards,
wildcards, reachability, exhaustiveness, and result joins then use the same rules as nominal match
arms.

```silk
fn choose(value: i32 | [i32; 2]) -> i32 {
  return match move value {
    i32 number => number
    [i32; 2] numbers => numbers[0]
  }
}
```

**Boundary:** Type compatibility, conversion, equal layout, or shared interfaces do not merge
coverage identities. `i32` does not cover `u32`, and `[i32; 2]` does not cover `[i32; 3]`.

**Diagnostics:** Missing, duplicate, guarded-only, and unreachable members receive the existing
coverage diagnostics and name exact canonical types rather than runtime tags.

**Evidence:** [match coverage](functions-callables-and-control-flow.md#match-003--match-coverage-is-exhaustive-and-guards-do-not-prove-coverage),
[exact type compatibility](values-and-types.md#type-003--compatibility-is-exact-except-for-closed-named-relations).

## PATT-017 — One type pattern selects one normalized member

**Status:** Confirmed

The selected type must normalize to exactly one member of the scrutinee. The first pattern model
does not use a union type as an or-pattern or subset selector.

```silk,ignore
match move value {
  (i32 | bool) selected => 0
  string text => 1
}
```

The first arm is invalid in this initial model. Separate `i32` and `bool` arms express the two
cases explicitly.

**Boundary:** This does not prevent a nominal type from containing a union-valued field or a
whole-value binding from carrying an exact member whose internal representation is private. It only
prevents one selector from standing for several normalized outer members.

**Diagnostics:** A multi-member selector reports that the initial pattern language requires one
exact member and suggests separate arms.

**Evidence:** [union normalization](values-and-types.md#union-001--a-structural-union-is-a-normalized-set-of-ordinary-value-types),
[small initial pattern surface](#patt-014--the-first-destructuring-surface-stays-deliberately-small).

## PATT-018 — Non-nominal bindings inherit ordinary pattern access

**Status:** Confirmed

A non-nominal whole-value binding follows the same bare Copy, `move`, `&`, and `&mut` access rules
as a nominal binding. Selection changes only the precise member type available inside the body; it
does not copy, box, allocate, erase, or convert the payload.

```silk
fn first(value: [i32; 2] | bool) -> i32 {
  if let [i32; 2] numbers = &value {
    return numbers[0]
  }
  return 0
}
```

**Boundary:** Borrowed members cannot escape, affine members cannot be matched bare, and consuming
selection consumes the original union on success and mismatch exactly as PATT-008–009 define.

**Diagnostics:** Invalid moves, loans, mutation, escapes, and later uses receive their ordinary
ownership diagnostics at the access expression or binding use.

**Evidence:** [pattern access](#patt-002--the-matched-expression-chooses-ownership-access),
[consuming conditional](#patt-008--a-consuming-conditional-consumes-on-both-outcomes),
[borrowed conditional](#patt-009--a-borrowed-conditional-preserves-its-owner).

## PATT-019 — Generic selectors renormalize at complete applications

**Status:** Confirmed

A generic body is checked once against its symbolic normalized member set. Every complete
application substitutes its concrete types and renormalizes the member set and selectors before MIR
lowering. If two symbolic selectors become the same concrete member, the first matching arm in
source order selects that member; a later equivalent arm has no runtime tag and produces no new
source diagnostic during specialization.

```silk
fn choose<A, B>(value: A | B) -> i32 {
  return match move value {
    A selected => 1
    B selected => 0
  }
}
```

`choose<i32, string>` retains two cases. `choose<i32, i32>` carries only `i32`; its first arm wins
under ordinary source-order matching and the second has no distinct concrete case.

**Boundary:** Symbolic checking must still prove that each selector belongs to the authored symbolic
scrutinee and that the authored arms cover it. Complete applications do not rerun source diagnostics
or invent overlapping runtime tags; they only substitute and normalize already-checked facts.

**Diagnostics:** An absent symbolic selector receives the ordinary member-not-in-scrutinee
diagnostic. Member collapse during a valid complete application produces no compiler diagnostic.

**Evidence:** [generic body checking](generics-interfaces-and-specialization.md#gen-004--a-generic-body-is-checked-once-against-its-declared-contract),
[finite specialization](generics-interfaces-and-specialization.md#gen-005--every-reachable-generic-application-becomes-finite-monomorphic-code).

## PATT-020 — A qualified scalar enum member pattern selects one exact member

**Status:** Confirmed

A match over a scalar enum uses `Enum.Member` to select one member of that exact canonical enum.
The pattern has no payload and introduces no binding. An unguarded member arm removes that member
from the remaining coverage set; a guarded arm handles the member only when its guard succeeds and
therefore proves no coverage.

```silk
enum Status { Pending, Ready, Done }

fn code(status: Status) -> i32 {
  return match status {
    Status.Pending => 0
    Status.Ready => 1
    Status.Done => 2
  }
}
```

The match is exhaustive without `_` because every declared member appears in an unguarded arm.
`_` may instead cover all members still remaining, after which every later arm is unreachable. The
scrutinee remains type `Status`; a member pattern does not narrow it to an integer or a distinct
member subtype.

**Boundary:** The member name must be qualified and belong to the scrutinee's canonical enum. A bare
`Ready`, `Other.Ready`, or integer literal equal to a discriminant does not select
`Status.Ready`. The current qualified enum-member pattern is available only in `match`; scalar enum
`let` and `if let` selection are not part of the stabilized surface.

**Diagnostics:** Missing declared members report `SEM0158`. A duplicate unguarded member reports
`SEM0159` at the later arm and relates the first; an arm after `_` reports `SEM0160`. A foreign enum
member reports `SEM0161`, and an integer literal pattern against an enum reports `SEM0162`.

**Evidence:** [scalar enum matching specification](../../../../openspec/specs/bootstrap-scalar-enums/spec.md),
[enum matching tests](../../../../packages/compiler/test/ExhaustiveMatching.test.ts),
[match coverage rules](functions-callables-and-control-flow.md#match-003--match-coverage-is-exhaustive-and-guards-do-not-prove-coverage).

## PATT-021 — A qualified nominal-union variant selects one hierarchical leaf

**Status:** Confirmed

A nominal-union pattern names the complete applied parent followed by its variant. A unit variant
introduces no binding. A named-field variant uses the ordinary struct-field pattern rules,
including renaming, `..`, nesting, and access derived from the matched expression.

```silk
union Option<T> { Some { value: T }, None }

fn unwrap(option: Option<i32>) -> i32 {
  return match move option {
    Option<i32>.Some { value } => value
    Option<i32>.None => 0
  }
}
```

The selector is one leaf beneath `Option<i32>`, not a standalone type. If `Option<i32>` occurs in a
structural union, selection retains both the structural member and nominal variant identities.
Guards remain provisional, and exhausting the parent requires every declared variant even when a
payload contains `never`.

A nested variant pattern checks the inner variant before binding its fields or evaluating the arm
guard. An inner mismatch continues to the next arm. Covering one inner variant leaves the other
inner alternatives available; covering all of them exhausts that outer variant.

**Boundary:** Pattern generic arguments are explicit rather than inferred from the scrutinee. A
variant cannot be used as a type, projected before selection, or flattened into the surrounding
structural union. A false guarded move leaves the whole active payload available to later arms.

**Diagnostics:** An unknown variant reports `SEM0167`; a non-union qualifier reports `SEM0168`.
Writing a unit variant with a braced payload pattern reports `SEM0224`; omitting a required field
of a named-field variant retains `SEM0046`.
Missing, duplicate, unreachable, field, and ownership errors use the ordinary match, aggregate, and
ownership diagnostics while naming the complete hierarchical selection path.

**Evidence:** [nominal-union pattern specification](../../../../openspec/changes/add-nominal-unions/specs/bootstrap-nominal-unions/spec.md),
[hierarchical matching tests](../../../../packages/compiler/test/StructValues.test.ts),
[match coverage rules](functions-callables-and-control-flow.md#match-003--match-coverage-is-exhaustive-and-guards-do-not-prove-coverage).
