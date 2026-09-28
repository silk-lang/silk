# Module static selection

## MODULE-STATIC-001 — A module has one selected declaration surface

**Status:** Confirmed contract; implementation tracked by JUL-121.

Module scope accepts `static if condition { declarations }` with an optional `else { declarations }`
or `else static if`. Groups may nest. Their selected declarations belong to the containing module,
not a new lexical namespace. Each declaration uses its ordinary visibility. A condition cannot be
prefixed by `pub`; publish individual declarations or selective imports inside its arms.

```silk
import policy { useFirst }

static if useFirst() {
  pub import platform.first { write as writeBytes }
} else {
  pub import platform.second { write as writeBytes }
}
```

Both arms of every loaded source are parsed, including inactive arms. Only the selected arm admits
imports, types, aliases, ordinary functions, external declarations and publication. A false
condition without `else` contributes nothing. A failed condition admits neither arm. Selected
declarations with duplicate names produce ordinary collision diagnostics; mutually exclusive names
do not collide. Inactive declarations contribute no ordinary name/type/Effect/ownership checks,
foreign inventory, runtime reachability or backend work.

## MODULE-STATIC-002 — Dependencies determine selection order

Conditions are ordinary static Silk expressions producing `bool`. They can call imported static
helpers and use admitted constants, types and completed package parameters. Evaluation uses the
ordinary deterministic step, call-depth, retained-value and residual-growth limits.

Unconditional declarations and imports are visible regardless of source order. A reference to a
conditional declaration first demands the conditions governing its availability, so a later
independent selected group can supply a condition dependency. A condition cannot use a declaration
whose availability depends on that condition, directly or indirectly. No arm is admitted to break
such a cycle. An inactive-only declaration is unavailable.

Required helper signatures, types, constants and static bodies are checked as condition
dependencies. Unrelated declarations and inactive bodies are not checked to determine a condition.
Missing, inactive-only, cyclic, non-static and non-boolean dependencies have structured diagnostics
with source spans and relevant dependency origins.

An import confined to an inactive group causes no resolver call, load, missing-module diagnostic,
dependency or cycle edge. An import needed to evaluate a condition is an actual dependency even
when its declarations do not become runtime-reachable. Selected imports retain ordinary outcomes.

## MODULE-STATIC-003 — Configuration precedes selection

The compiler normalizes immutable initial target/artifact inputs, loads the explicitly registered
package schema modules, applies explicit bindings, evaluates defaults and validation, then publishes
the complete immutable compilation profile. Module selection consumes that profile. Registration
determines which schema headers are discovered; imports and selected imports do not register
schemas. Package parameters cannot be declared conditionally. A default requiring conditional
availability is a configuration dependency failure; the compiler never mutates a published profile
or selects an arm provisionally to break the dependency.

## MODULE-STATIC-004 — Selective publication preserves declaration identity

`pub import module { name, original as local }` publishes the specified public members under their
selected local names. Consumers resolve the original declaration identity; diagnostics and tooling
retain both publication and declaration origins. An imported private member cannot be published.
Namespace-wide public imports and wildcard publication are invalid. Private namespace and selective
imports retain their ordinary meaning.

## MODULE-STATIC-005 — Semantic results belong to a profile and dependency closure

Generic compiler analysis exposes the active normalized profile, one concrete selected public
surface and inactive source ranges. Distinct profiles coexist in one process. Equivalent profiles
produce equivalent selection and diagnostics. Full parsed syntax can be reused across profiles;
selected semantic results cannot be reused solely because syntax is unchanged.

Both condition-required and selected program dependencies govern invalidation. A changed condition
helper body invalidates its consumers even if its public signature is unchanged. An unloaded source
outside both closures does not invalidate the profile. Inactive-range editor presentation and
provider/catalog migration are tracked separately by JUL-122.

**Evidence:** [OpenSpec design](../../../../openspec/changes/add-module-static-selection/design.md)
and [selection requirements](../../../../openspec/changes/add-module-static-selection/specs/module-static-selection/spec.md).
