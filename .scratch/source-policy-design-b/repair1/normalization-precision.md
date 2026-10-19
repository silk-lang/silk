# Repair1: conditional routes and grounded precision

Design only, based on 985eb0ea2. This replaces the missing rules in B sections 3–5;
it is not source acceptance. The baseline model files remain byte-for-byte unchanged.

## One occurrence, conditional routes

An occurrence is `(EvalId, written port, physical component, LeafId, role)`. Distinct
written operands/components are real observations even when they name the same loan.
Different reaching definitions at the same occurrence are histories, not copies.
Each occurrence owns a finite set of **RouteCases**:

```
RouteCaseId = (occurrence, transfer site, paired source fact + read,
               input placement, output placement, direct evidence kind)
RouteCase = { applicability, paired witness, input/output typed ports,
              direct, source quality version, original contract edge }
EffectId = (EvalId, phase, occurrence, target LeafId/LoanId,
            output placement, effect kind, policy reason)
```

Placement is a typed component/route endpoint or the explicit opaque-position tag;
it is not a lifetime atom. Directness is Boolean evidence within a case, not a
single Boolean on the union. A fresh borrow generates direct=true; matching and
aggregate forwarding preserve it only with the original exact placement guard;
declared result placement generates direct=false, even when its field and quality
are Exact. A failed exact mapping follows the existing opaque/direct=false rule.
No equality of endpoint types or lifetime atoms supplies a direct witness.

Transfer loops reference finite predecessor case IDs, not complete history strings.
At a receiving boundary duplicate `(occurrence, paired edge, placement, direct)`
records intern; their supporting predecessors form graph edges. Cycles do not
allocate a new witness per traversal. Cross products are only finite constructor
input/output port pairs; route histories are not unfolded. Loan-free/Entry/Unknown
leaves use this same relation but never enter the Borrow carry count.

A policy invocation has one scan position per occurrence, not per RouteCase.
Evaluate case-specific guards with **that case's** read, definition, directness and
placement, using the same incoming observation state. Combine possible outputs as
conditional effects, then advance the per-loan state once. Alternative cases do
not sequentially feed one another. Two real positions do: their order is written
operand order then structural component order, as in B. Distinct leaf alternatives
still have distinct target entries in the finite may-source inventory; they do not
become two copies of the same leaf. No enumeration of simultaneous route choices
is required. This is a may analysis and may conservatively lose correlations.

Consumer quantifiers:

* A source exists only with an active paired route; universe membership is not
  existence. Required safety/coverage quantifies over **all possible** cases.
* `keptSink` evaluates the original branch order separately for each case. Local
  narrowing is a release certificate only when every applicable case allows it;
  a possible Unknown/Universal case retains its storing/escape effect. For the
  review example direct-only is Local, indirect-only Unknown, and their union
  has both conditional results (hence no unconditional Local certificate).
* `keptIn`, `destinationSlot`, `destinationField`, `excludedTransferRead` are
  case predicates. Source/destination joins require the original operand and
  paired definition/read relationship. A direct case cannot lend its evidence
  to an indirect case. Possible writes union their effects; an exact field kill
  requires a definite exact target under the existing strong-write rule.
* A result drop or complete-source release removes an occurrence only if all
  possible cases have a proved drop. A kept case preserves its own placement and
  direct flag. Declared and ordinary output paths are different cases, not a
  combined direct Exact field manufactured from their attributes.
* A definite conflict still needs the existing conflict predicate, exact target,
  actual read/event applicability and source proof. Merely possible policy effects
  are not materialized as definite conflicts. Grounded may-reaching alternatives
  remain subject to the compiler's existing may-conflict semantics; this rule does
  not demand that a bad branch execute on every runtime path.

Write `P(c)` for a grounded may-route, not 'every execution takes c'. In the normal
program, `Effect(e) <- P(c), Decision(c,e)`. A definite effect is in K; an effect
only in U blocks a proof that requires its absence. For release use
`BadRelease(o) <- P(c), not Drop(c)` for every case of o, and require positive
coverage/witnesses plus `not BadRelease(o)`. Undefined Drop is not evidence of it.
Same-target same-placement same-reason effects intern and union their supports.
Different loan targets or placements cannot collide. A later materializer neither
replays alternatives as copies nor discards an effect because another case narrows.

## Precision is the absence of grounded loss, not a seeded category

Represent precision as two loss bits: S (Stored), A (Alternatives). Exact=00,
Stored=10, Alternatives=01, Unknown=11. This encoding is of mapping quality only;
Unknown **source kind**, missing evaluation and unsupported selectors are separate
coverage facts. Unknown source is never loan-free. A genuine no-loan source has no
Loan precision field to index.

Use `Has(f)` and `Q(f,S/A)` on each value-source/case boundary; `P(v,l,S/A)` on
structurally versioned loan state. Quality has meaning only with `Has(f)` or an
active real loan l. Creation of an actual borrow grounds Has but creates no loss
fact. Reserving a borrow site or an operation creates neither Has nor Exact.

Rules below abbreviate each finite bit b and preserve case applicability:

```
Has(dst) <- Has(src), Transfer(case), ReadReaches(def, read)
Q(dst,b) <- Has(src), Transfer(case), ReadReaches(def, read), Q(src,b)
P(next,l,b) <- P(prev,l,b)                         // structural state version
P(barrier,l,b) <- Has(input), Q(input,b), Targets(input,l)
P(barrier,l,b) <- P(before,l,b)
Q(output,b) <- Kept(case), Has(input), P(afterCase,l,b)
Exact(f) <- Has(f), not Q(f,S), not Q(f,A)
Stored(f) <- Has(f), Q(f,S), not Q(f,A)
Alternatives(f) <- Has(f), Q(f,A), not Q(f,S)
UnknownQuality(f) <- Has(f), Q(f,S), Q(f,A)
```

Versioned loan predicates use ActiveLoan(l) instead of Has(f). The barrier is
operation-local, before its snapshot and sequential carry processing. Loss is
joined from all real present input cases, not arbitrary candidate leaves. A
transported loss cannot reach an earlier structural version merely through l;
it needs a producer -> value transfer -> actual read edge into that barrier.
Copying captures the producer's Q at that boundary. A saved pre-loop copy has
no edge from later loop output to its earlier read. A later use of saved can still
observe conservative later **global** P effects, as the current policy does;
that must not rewrite the earlier source/quality snapshot.

Positive generators, with the original ordered branch guards:

| Transition | Grounded effect |
| --- | --- |
| fresh borrow / verified no-loss copy | presence/transport only; no S/A generator |
| resultDecision kept+exact (stores/declared/forward/unique etc.) | preserve bits, never clear them |
| resultDecision kept+not exact+alternatives | add A; Stored becomes Unknown, Exact becomes Alternatives |
| resultDecision kept+not exact+not alternatives | add S and A |
| resultDecision not kept | no result Has/Q; preserve all prior global P; bound/unretained effects remain ordered as before |
| accepted retained PlaceAssignment store | add S; Alternatives becomes Unknown |
| observeCleanup original matched definition gate | add S and A at its exact observation version |
| construct, keepCarried, consume, rejoin | no invented quality generator; retain original escape/storing/bound/interval effects and transport existing Q |

Every generator includes active target/input evidence. Unknown quality is produced
by a real loss operation, not by an unsupported cyclic lookup. Loss propagates
positively; gates such as complete or exact-dependent implied drop can still
contain negation and are solved by the same founded alternating program. There
is no quality solver alongside a source solver. The generic four-category join
table is **not** used; it loses the grounded identity cycle.

Absence/undefined rules: absent Has outside U has no quality and is not Exact.
Has in U\K leaves applicability unresolved. Has in K and loss outside U proves
the corresponding negative; Has in K with loss in U\K does not. Exactly one
category must be definite for each present quality required by a publication
certificate; otherwise that certificate is Pending. All categories false with
Has true is a construction/admission defect, not total success. A source-free
cycle cannot initialize a read. Enumeration may include possible alternatives,
but no mandatory success can use an unresolved route/category/coverage predicate.
A complete no-loan entry still has a real source and its signature obligations.

## Observation versions, feedback and grounded examples

For each operation reserve `before`, input barrier, snapshot and every real scan
position's `pre`/`post` version. Snapshot parents/declared/required/naming/complete
use the single pre-result snapshot. `resultDecision` reads the current per-loan
version; repeated real same-loan positions see earlier effects. Alternative cases
of one position share pre and join their possible effects into post. All other
loan versions pass through. Snapshot predicates never read this operation's post.

`finish`: keepCarried then consume then snapshot then ordered result cases.
`defer`: argument visit then retention immediately, before the next argument.
`invoke`: pipeline/callee/argument order, finish, storeIntoLent, storeThroughExclusive.
`construct`: all capture/reborrow visits, opaque pass, universal/CaptureHold pass,
storable/inherited pass, result. The second pass's ownedStorageLoan sees P at
**that pass**, including input/earlier capture effects, not final-body P. The
opaque pass's escapes do not themselves change precision. Prior whole-hold queries
use only earlier conditional effect IDs, require at least one applicable hold and
all relevant ones described/known; no empty 'all' proof.

The finite MAX-sensitive naming machine uses the established occurrence order,
including [MAX,0] vs [0,MAX]. `retainedParents` remains known && !stores && count>1.
Declared and required snapshots keep their independent original gates. Count
means normalized Borrow occurrences, never route-case count. No later state repairs
an earlier snapshot. Escape/bound/storing/storable/whole-hold/unretained facts each
have their own original observation versions/reasons, rather than one final state.

Identity cycle: entry Borrow grounds Has(input); input -> identity -> backedge
propagates Has. No operation generates S/A. Positive loss closure is empty, so
both losses lie outside U and Exact derives. This chooses the actual no-loss
semantics instead of arbitrary algebraic fixed points I=join(Exact,T), T=I.
A real stored backedge adds S at its store version, Q carries it along the actual
loop edge, then the earlier loop barrier sees S. It cannot remain Exact. A copy
before the loop retains its earlier Q=00 unless a value path really revisits it.

Complete/drop feedback: Has(output) is conditional on the ordered kept branch;
quality travels only along that output. Complete requires grounded present Exact
witnesses plus all original guards. If dropping a source would erase the only
witness supporting that very drop, alternating K/U leaves it undefined or false;
no output is selected from a frozen maximal input set. The two-operation example
still has two grounded stable outcomes; neither is chosen. Absence of stable
solutions cannot prove safety. The admission invariant and mandatory dependency
closure are checked in addition to the normal-program mathematical enclosure.
