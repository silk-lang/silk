### GEN-006 — Recursive generic calls must form a finite specialization graph

**Status:** Confirmed

A reachable generic application must have concrete type arguments, static arguments, witnesses,
and Effect requirements. Recursive calls may change those arguments when the complete reachable
specialization graph is finite. An edge back to an existing application reuses that specialization;
it does not require another copy of the function. Runtime recursion itself need not terminate.

```silk,ignore
fn walk<T>(value: T, remaining: i32) -> T {
  if remaining == 0 {
    return move value
  }
  return walk<T>(move value, remaining - 1)
}
```

This function has one specialization for each reachable concrete `T`, regardless of the runtime
value of `remaining`. Mutual recursion and recursion through generic helpers follow the same
rule. A cycle such as `visit<Node> → visit<Box<Node>> → visit<Node>` contains two specializations
and is permitted when both bodies are otherwise valid.

The graph includes every reachable lowered call, concrete interface witness, provider-selected
operation, callable body, and cleanup or `Drop` hook. Both arms of a runtime conditional contribute
edges. Static evaluation may remove an arm before specialization discovery; a runtime condition
cannot establish that an otherwise growing specialization chain is finite.

Each application must still pass the ordinary typing, conformance, ownership, lifetime, and Effect
checks. Sharing a runtime code definition across lifetime-equivalent applications does not waive
checks at their call sites. Different concrete providers remain part of specialization identity.

**Boundary:** Compilation succeeds only after all reachable work is complete and all graph edges
resolve to checked applications. For example, an unconditional `grow<T>` call to `grow<Box<T>>`
continually creates new specializations and cannot produce a completed finite graph. A changing
static argument can instead make such a chain finite when static evaluation removes the recursive
call at a concrete stopping value.

The compiler applies resource limits to specialization discovery and type construction. A finite
graph can exceed those limits; such a refusal means the compiler did not establish the graph
within its resources, not that it proved the graph infinite. Serial and parallel compilation apply
the same acceptance rules. Incomplete discovery is never reusable evidence of successful checking.

**Diagnostics:** An unresolved application reports the responsible call or escaping callable.
Resource exhaustion reports that the specialization graph could not be established within the
limit, with the relevant application and request location. Other errors retain their ordinary
typing, ownership, lifetime, and Effect diagnostics.

**Evidence:** Native specialization graph discovery and structured finite-cycle, growing-chain,
cleanup, provider, and lifetime regression tests.
