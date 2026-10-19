# Complete-source kernel prerequisite

These modules are the tested rule and dataflow substrate for the complete-source
borrow-checker migration. They are imported by the existing capture test root.
The production checker does not use them yet; this change makes no claim about
new Checked bodies, source enumeration, or mandatory lifetime discharge.

## Ownership and computation

- `SourceRules.Program` owns a finite set of local atom identities and normal
  rules. Its indexed positive closure and alternating lower/upper refinement
  preserve Undefined for unresolved negative cycles. A possible witness does
  not establish truth. Presence and Stored/Alternatives losses are separate
  positive facts.
- `SourceFlow.Flow` reserves runtime points, exact storage components,
  definitions, reads, and stable definition/read pairs. Definitions describe
  values, including caller and loan-free values; they do not require loans.
  Strong writes kill other definitions of the same authenticated component;
  weak writes preserve earlier definitions. Terminal emission includes all
  later definitions and loop backedges and binds the already reserved gates.
- `SourcePolicy` translates ordered result, naming, parent-retention, cleanup,
  and precision decisions into the same program. It consumes explicit inputs
  and observation versions, and emits decisions/effects. It does not read a
  mutable global loan table or execute checker effects. First-match order,
  real repeated occurrences, paired-history alternatives, and loss propagation
  remain distinct.

Reservation and equation emission do not solve prefixes. A caller must finish
candidate/operation closure and then solve one program. An absent fact is not an
Exact source; Undefined cannot authorize a proof or release. Source identity,
physical routes, original-contract correspondence, and completeness are outside
these modules and must be authenticated by their eventual owning analysis.

Every program and flow is owned by one analysis invocation. There is no global
revision, query cache, or whole-program solve. The later preparation integration
must retain the existing query engine's exact dependencies and change pruning;
these kernel tests do not establish incremental compiler acceptance.

## Executable contracts

The eight tests are included by `SemanticCaptureCases.silk`, so they use the
existing Capture CI root without another native compilation target. They cover:

- grounded positive cycles, unresolved negative cycles, duplicate premises,
  source presence, and losses following actual value edges;
- pre-loop reads, zero-iteration/backedge sources, whole-value kills, stable
  pre-emission pair identities, late definitions/reads, weak/conditional stores,
  sibling components, and infeasible edges;
- MAX naming order, real repeated inputs, parent promotion before effects,
  cleanup interval versus loss gates, cyclic complete/drop uncertainty, and
  operation snapshots versus sequential per-loan observations.

The late-reservation test uses a captured pair gate to control a subsequent
write. It also retains that pair's identity across emission. This exposed and
repairs a bug where terminal emission reordered pairs after incremental
reservation, even though each gate itself remained valid.

## Subsequent boundaries

1. **Preparation and producer correspondence:** retain actual physical maps,
   contracts and substitutions; verify producer/type/MIR agreement and exact
   incremental dependency/reuse behavior. The factory and checker callers stay
   out of this independently executable slice until the real consumer exists.
2. **Occurrence product and structural traversal:** consume frozen preparation,
   close finite paired residual/contract routes, use actual current storage,
   and reserve complete source candidates in this kernel. Verify genuine
   replacement/copy/backedge/unknown/empty cases. Preparation metadata alone is
   not route activation or source proof.
3. **One atomic production replacement:** migrate all ownership/policy consumers,
   wire `prepare`/`checkPrepared` and all three body boundaries, discharge retained
   obligations, and delete the eager checker entry and superseded bookkeeping.
   No compatibility wrapper or second production checker is planned. Review
   boundaries need not merge separately when a runnable consumer is inseparable.

Full C acceptance still requires focused source and lifecycle validation,
independent implementation review, integrated CI and parent-owned corpus/gap
comparison. Kernel execution is evidence only for the contracts listed above.
