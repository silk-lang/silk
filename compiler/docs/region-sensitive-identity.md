# Region-sensitive identity

Lifetimes select no code, so the selfhost compiler gives every region pattern of one application
one backend instance: one lowered body, one emitted definition and one symbol. The exception is a
region-sensitive application, whose region patterns each get their own instance. This note states
the rule, why it is sound, and how a build decides it.

## Terms

- A **region pattern** of an application is its exact semantic key: the canonical numbering of
  the caller regions it was given, including which of them coincide and which are `'static`.
  Patterns of one application differ only in regions.
- A **lifetime-selective head** is an `impl` head whose contract or provider names `'static`,
  names one region at two positions, or whose bounds constrain a region (`'a: 'b`, `T: 'a`).
  `ImplementationHead.regionSelective` records it when the head is resolved.
- An instance **lends its own regions** to a reference when the reference's key, before
  canonical numbering, mentions a `Supplied` region of the instance's own application. Regions
  local to its body and `'static` are the same for every pattern of the instance, so they are not
  lent. `InstanceKey.lendsOwnRegions` records it.

## Rule

An application is region-sensitive when:

1. lowering it consulted a lifetime-selective head while selecting a conformance witness, a
   sealed `Drop` or `Copy` head, or proving a bound; or
2. one of its references lends its own regions to a region-sensitive application.

Every other application has region-erased identity.

## Soundness

Take an application `f` that is not region-sensitive, and two of its region patterns `P` and `Q`.
Lowering `P` makes a sequence of specialization-time decisions: which witness proves each goal,
which `Drop` or `Copy` applies to each type, whether each bound holds, and which keys the body
references. We show that lowering `Q` makes the same decisions modulo regions, so `P`'s body is
`Q`'s body.

1. **Selection.** Coherence erases lifetimes, so the heads a goal's bucket offers, and the head
   that matches, are a function of the goal with its regions erased. `P` and `Q` pose the same
   goals modulo regions.
2. **Matching.** A head that is not lifetime-selective has a distinct binder at every region
   position and no `'static`. It unifies with any assignment of regions, so no goal of `Q` fails
   to match a head that the same goal of `P` matched, or the reverse.
3. **Bounds.** A head that is not lifetime-selective has no region bound, so instantiating it
   adds no region obligation. Its type bounds are discharged by selecting further heads, to which
   1 and 2 apply again; by induction over the proof, `P` and `Q` prove the same goals.
4. **Cleanup and copies.** Sealed `Drop` and `Copy` selection follows 1 to 3 over the sealed
   heads of the type's owner.
5. **Callees.** Each reference of `f` either mentions none of `f`'s own regions, and is then the
   same key for `P` and `Q`, or lends them. By rule 2, a lent reference targets an application
   that is not region-sensitive, which by the same argument has one body for all of its
   patterns, so `P` and `Q` reach the same callee body.

Generic function bounds such as `'b: 'a` are premises inside the callee's body. The obligations
they create at the calls a body makes are checked when that body is type-checked against its own
parameters, not per caller pattern, so they never differ between `P` and `Q`.

A region-sensitive application loses nothing: each pattern lowers, proves and emits itself, as
exact identity always did.

## How a build decides it

- `proveGoal` and sealed head matching increment `Resolver.regionSelections` whenever they
  examine a lifetime-selective head of the goal's bucket. The query dispatcher restores the
  counter after every nested query, so the count around one `Mir` query is exactly what that
  lowering consulted, independent of which demand first resolved a shared child. `resolveMir`
  stores the result in `BackendInstance.regionSensitive`, whatever the lowering's outcome.
- A build walks the reached instances. The first pattern of a backend instance publishes its
  body; every later pattern resolves to the same text. The walk records each lending reference.
- After the walk, `markRegionSensitive` closes rule 2 over the walk graph by repeated passes in
  walk order, and marks each newly sensitive application exact. If any was marked, the walk
  restarts; marks only grow, so this terminates. Answers of the abandoned walk, rejections
  included, are never reported, because a rejection of a shared body may belong to another
  pattern.
- `buildRuntime` clears the marks first, so every build decides sensitivity from scratch and a
  warm build emits exactly what a clean build of the same revision emits.
- Outside a build, a demand for one pattern of a backend instance whose published body consulted
  a selective head marks the application exact and lowers the requested pattern itself.

## Incremental behavior

Sensitivity lives with the cached `Mir` answer and the cached `ImplementationHead`. Editing a body
relowers that body only; its callers keep their answers unless the edit changes what they
consulted. Adding or changing a lifetime-selective head changes its bucket's answer, which
invalidates exactly the lowerings that read that bucket. Marks are rebuilt by each build's
closure, which costs one graph pass when nothing is sensitive.
