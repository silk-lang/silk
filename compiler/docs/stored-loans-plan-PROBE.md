# Stored-loans slice plan (W5)

This is a plan only, with no code. It was measured on selfhost b0414d1 with probe branch `probe-w5-stored-loans-subcauses`. N1 was built from the pinned d2abdeb seed.

**How the probe works.** Each of the 15 `leave(StoredLoans)` sites in `BorrowCheck.silk` gets its own temporary `BorrowStatus`. Five sites are further split by whether the escaping loan borrows a body local (`Loan.local`) or a referent reached through a reference. Unrooted borrows are split by the operand's shape.

## Receipts by sub-cause

`leave` records only the first reason in a body, so each count is the first stored-loans site the walk meets. The self-build totals 705 and the corpus totals 1223, which matches the baseline exactly. The corpus run passed 421/0/0. Only 5 of the 15 sites fire first; the other ten are masked or rare (see the end of this section).

| Site | Loan root | Self | Corpus | Illustrative shape (not sampled from the corpus) |
| --- | --- | ---: | ---: | --- |
| Arm result (`matchArms`) | referent | 382 | 324 | `match self.kind { A => &self.a, B => &self.b }` |
| Arm result | local | 2 | 9 | an arm yields `&x` of a body local |
| Exit value (`Shape.Exit`) | referent | 22 | 243 | `return &self.items[i]`, or a view of a parameter |
| Exit value | local | 2 | 77 | a returned value carries a loan of a body local |
| Loan-carrying subject | referent | 16 | 74 | `match view.peek() { ... }` where the subject retains a parameter's region |
| Loan-carrying subject | local | 77 | 190 | `match iter.next()` over an iterator borrowing a local |
| `let mut` holder | referent | 62 | 184 | `let mut cursor = &self.root` advanced in a loop |
| `let mut` holder | local | 13 | 36 | `let mut best = &values[0]` |
| Unrooted borrow | call result | 95 | 53 | `&make()`, or a receiver pass on a temporary such as `make().first()` |
| Unrooted borrow | constructed value | 32 | 13 | `&Pair { ... }`, or a borrow of an operator result |
| Unrooted borrow | read or other | 2 | 20 | literals and other operands with no place |
| **Total** | | **705** | **1223** | |

Totals by root:

| Root | Self | Corpus |
| --- | ---: | ---: |
| Referent | 482 | 825 |
| Local | 94 | 312 |
| Unrooted | 129 | 86 |

The ten silent sites are assignments into retaining locals and places, `Branch` and loop results, unrooted moves, drops and `match move` subjects, read-through-holder, and the body result.

- They are masked by first-reason recording, or they are rare. For example, an assignment into a `let mut` holder is always preceded by the holder's own binding, which already leaves.
- After each slice I re-probe, and the next site's count becomes visible. The expected movements below are therefore upper bounds on what the slice clears, but exact for what leaves the site.

## Ordering against R1–R3 (agreed with W8)

The split W8 agreed to:

- **Mine:** every `leave(StoredLoans)` site, the exit and join handling in `visit`, `matchArms` and `Branch`, scope ends as events, OWN0019 at the first required point outside a root's scope, and the `run`/`fail` failure edge.
- **R2:** adds universal regions and assumptions. It touches no walk shapes.
- **R3:** consumes the region facts my walk produces at returns and joins, and adds the returned-value check.

| Order | Slice | Owner | Depends on |
| --- | --- | --- | --- |
| 1 | R1 (`regionClosed`, nesting invariant) | W8 | none (in validation) |
| 2 | **S1: referent loans across joins, holders and returns** | W5 | R1 |
| 2′ | R2 (universal regions) | W8 | R1. Parallel with S1: disjoint code. |
| 3 | R3 (relations and returned regions) | W8 | S1's exit and join facts. If R3 lands first, it only adds its post-Clear check, and S1 then feeds it. |
| 4 | **S2: scope ends, local escapes and the failure edge** | W5 | R1, S1 |
| 5 | **S3: temporaries** | W5 | S2 (storage-end events) |

## S1: referent loans across joins, mutable holders and returns

**Change.** A loan whose place is reached through a reference (`Loan.local == false`) is allowed to cross a scope boundary. A body is still never answered `Checked` on these grounds: it answers `regions` until R2/R3 prove the region relations. A local loan still leaves with `stored-loans`.

- **Joins.** `Branch`, arm results and loop results union the carries of the incoming paths at the join point. Each carried loan keeps one in-flight interval per path, so `inFlight` already answers the per-point question.
- **Loan-carrying subject.** The subject's carry stays live through every arm's pattern, guard and result (MATCH-002 bindings are projections), and is consumed at the join.
- **`let mut` holders and assignments of a retaining type.** The holder gets a per-assignment definition. A loan assigned at point *d* is held at point *p* when *d* reaches *p* without an intervening assignment of the whole holder, and the holder is live at *p*. This is the existing `reaching` dataflow, with assignments as gens and kills.
  - An assignment through a field of the holder (partial replacement) keeps the earlier loans. That is conservative, and it never drops a loan.
  - Callables stay as they are today.
- **Exit value.** The returned carries are recorded as the body's *returned loans*, the fact R3 consumes, and consumed at the exit point. No local loan is admitted.

**Rules.** BORROW-004 and BORROW-005 conflicts across joins; VIEW-001 and VIEW-002 (returned views retain their source); FLOW-001 (every reaching path); MATCH-002.

**Soundness.**

1. A referent loan borrows storage the body does not own. Its root is a parameter's referent or a reborrow of one, which typing has already related to a parameter region. No scope end inside the body can end that storage, so no OWN0019 can arise inside the body from it. The only remaining obligation is the region relation (does the loan outlive what the result or holder promises?), which this slice does not claim. The body answers `regions`, never `Checked`.
2. Conflicts stay exact:
   - At a join, a loan is in flight on exactly the paths that carry it. A loan carried on one path is live at an access after the join only along that path's points, because `inFlight` is per interval. Union-at-join is therefore the bootstrap's reachability (`LifetimeFlow.liveAt`), not an over-approximation.
   - For `let mut` holders, held-ness is reaching definitions composed with liveness, so a reassigned holder releases its old loans exactly where the bootstrap does.
3. Anything this slice cannot decide exactly answers `imprecise`, never a conflict, and so is never `Checked`. That covers a partial replacement that may keep a loan, and a join where one side's loan is approximate.

**Tests.** These are structured cases in `BorrowFieldCases` and `SemanticCaptureCases`, asserting codes and spans.

- **Accepted, answering `regions`:**
  - an arm-joined view, `match k { A => &p.a, B => &p.b }`, followed by a read of `p.a`;
  - a `let mut` cursor that is reassigned and then has its old referent mutated;
  - `return &self.x`.
- **Rejected with OWN0011:**
  - a shared arm-joined view of `p.a` held across `p.a = ...` (`&mut` through the parameter);
  - a `let mut` holder whose *current* loan conflicts.
- **Not rejected:** the same holder after reassignment releases the old loan, and the access becomes legal.
- **Unchanged:** a local-loan variant of each case still answers `stored-loans`.

**Expected movement.**

| Reason | Self | Corpus |
| --- | --- | --- |
| `stored-loans` | −482 | −825 |
| `regions` | +482 | +825 |

The movement is lower where an unmasked later site fires; that site becomes the body's new first reason. `imprecise` may rise by the few bodies with approximate joined loans, and I'll measure that before landing.

## S2: scope ends, local escapes, and the `run`/`fail` failure edge (deferred from R1)

**Change.**

- **Scope ends become events.** A binding's storage ends at the exit of its `Block`, at a match arm's end for arm-local bindings, and at body exit. Ends are released in reverse declaration order on every path out, including the `break`, `continue`, `return` and `fail` edges (§3 item 5).
- **Failure edges.** Every `run`, and every call whose callee can fail, gets a failure edge to the exit beside `fail`'s. The exit then carries the release events of every scope it leaves.
- **OWN0019.** A local loan whose region is required at a point after its root's storage end is OWN0019 at the first such required point, relating the borrow. For the arm-escape program that is the `match` expression, matching the bootstrap.
- **Local loans may now cross joins, subjects, holders and returns** under S1's machinery. A returned loan whose root's storage ends at body exit is OWN0019 at the return.
- **Precondition: sample `exit-local` first.** The probe's `local` flag only means "not reached through a reference". The 77 corpus `exit-local` bodies all pass the bootstrap, so they cannot all be escapes. I have not yet identified their shapes. One candidate is a carried holder loan that the returned value's type does not actually retain, because `Shape.Exit` leaves on any carry without asking `nodeRetains`. Before S2 I'll add a span probe for that site, sample those bodies, and split the flag so admission follows storage ends rather than the flag.

**Rules.** BORROW-008, LIFE-001 and LIFE-005 (OWN0019); FLOW-001 on failure paths; CLEANUP ordering, where a cleanup-observing holder (a Drop) still holds its loan when its root is released on the failure path.

**Soundness.**

- Storage ends are now explicit kills. The walk's existing holder liveness (`liveness`, `heldLive`) already says where a holder is live, so a holder or in-flight value that is live at a point after its loan's root's storage end is OWN0019 there. No region solver is needed; R3's solver later refines region relations, not this check. Admitting a local loan across a boundary can therefore only produce a proof (`Clear` or `regions`) or OWN0019, never a silent acceptance.
- The failure edge closes the remaining hole: a loan held across a `run` was previously unconstrained on the failure path, because exit carried no events.
- Admission is local-loan only. Referent loans were already handled by S1 and have no in-body storage end.

**Tests.**

- **Must reject:**
  - an arm-escape (`match v { Some {value} => &value }` used after the match): OWN0019 at the `match`, with the related span at the borrow;
  - a returned `&local` of a body-scoped binding: OWN0019 at the return;
  - a `let mut best = &values[0]` that is reassigned to a block-local and then used after the block: OWN0019;
  - the failure-path program: a holder with a Drop keeps a loan of a root released only on the `run`'s failure path.
- **Must accept:** an iterator over a local, `match iter.next()` in a loop, for the subject-local case.

**Expected movement.**

| Reason | Self | Corpus |
| --- | --- | --- |
| `stored-loans` | −94 | −312 |
| `regions` or `Checked` | +94 | +312 |

No corpus program is rejected, because every corpus program passes the bootstrap. A rejection would be a parity bug to fix, not a baseline change.

## S3: temporaries

**Change.** An unrooted borrow of a call result or constructed value gets a temporary root (the bootstrap's `TemporaryRoot`).

- **Ordinary temporaries:** storage ends at the end of the enclosing full expression, meaning the statement or the binding initializer.
- **Hidden owners:** a borrowed array literal in a binding initializer gets a hidden owner, which lives to the end of the originating block, selected branch, or loop iteration (BORROW-006, `useTemporary`).
- **Other operands:** literals with no owned storage keep `stored-loans` until the decision below, and are counted separately.

**The must-reject case.** `let left = make().first()`: the receiver pass on the temporary lends to `left`, the temporary dies at the end of the statement, and `left.*` uses it afterwards.

**Rules.** BORROW-006; RECV receiver passes on temporaries; SEM0056 for operands that cannot produce owned storage.

**Soundness.** A temporary is a root like any other, with a storage end at a known point. S2's kills and OWN0019 apply unchanged, so there is no new acceptance path. A temporary used only within its statement, such as `identity(&make()).left`, needs no proof beyond the existing in-flight intervals.

**Decision needed before S3.** Which diagnostic does `let left = make().first()` report?

- `functions-callables-and-control-flow.md`, at the receiver section, says "binding a borrowed temporary reports `SEM0056`".
- `ownership-and-borrowing.md`, at BORROW-006, says that a temporary-derived view escaping its hidden owner reports "the applicable returned-view or stored-borrow diagnostic at the escape boundary", and that SEM0056 is only for operands that cannot produce owned storage.
- The bootstrap (main c4df537) reports OWN0019 at the use `left.*`, twice, not SEM0056. The same holds for `let held = identity(&make())` and `let view = &make().left`.

My recommendation is OWN0019 at the use: BORROW-006 plus the bootstrap. That means fixing the receiver sentence in the reference on `main`. If the decision is SEM0056 at the binding, the bootstrap gets the `main` fix instead (§7: the reference wins). Either way the native slice follows the decision.

**Tests.**

- **Rejected:** the three binding forms above, with the chosen code and span.
- **Accepted:**
  - `make().first().*` and `identity(&make()).left`, used within the statement;
  - `let view = sum(&[1, 2])`, a hidden owner.
- **Rejected:** a returned `&make()`, with OWN0019 at the return (the bootstrap also reports SEM0212 there).

**Expected movement.**

| Reason | Self | Corpus |
| --- | --- | --- |
| `stored-loans` (call and value operands) | −127 | −66 |

The read-or-other remainder (self 2, corpus 20) stays as `stored-loans` until literal operands are classified.

## After S3

Whatever `stored-loans` remains is the formerly masked sites, now first. I'll re-probe after each slice and append them to the next slice's scope. They should be mostly assignments into retaining places, which S1's reaching-definition holders already cover once the earlier site no longer masks them. The reason retires when the corpus and the self-build reach zero.
