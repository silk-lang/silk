# Per-declaration invalidation

**Status:** parked draft; the cold-build gate fails. See
[the handoff](per-declaration-invalidation-handoff.md). Semantic facts validate through typed
source projections and ordered direct query dependencies. Absolute syntax identities and source coordinates remain explicit
inputs; moving them causes recomputation. This is a sound per-declaration cache with conservative
location invalidation, rather than the location-independent cache originally proposed here.

## Problem and observed result

The previous validator compared the complete bytes of every module an answer transitively
observed. An edit to one function therefore restarted unrelated facts in its module and facts
in importing modules. A special Body candidate path could keep some typed payloads after those
restarts, but MIR still lowered again.

The committed probe in `compiler/src/semantic/InvalidationCases.silk` uses two modules:
`lib` defines `leaf` and `other`; `main` defines `a`, which calls `Lib.leaf()`, independent `b`,
and `c`, which calls `Lib.other()`. Each revision demands all five bodies and all five MIR graphs
in that order. The same-width edit changes `leaf`'s return value from `1` to `9`.

| Observation                        | Previous validator | Current validator |
| ---------------------------------- | ------------------ | ----------------- |
| Body provider starts               | 4                  | 1                 |
| Old Body payload reuse after start | 3                  | Removed path      |
| MIR provider starts                | 4                  | 1                 |
| Starts after a trailing comment    | —                  | 0 Body, 0 MIR     |

The previous behavior was reproduced on the PR's pre-implementation compiler. These are provider
counts, not whole-project timing claims. The probe also compares warm and fresh MIR shape,
exact callee instances, safety state, local syntax identities and spans. It checks shifted syntax,
a declaration inserted before an existing function, missing modules and names becoming present,
a signature becoming incompatible, and a newline edit that preserves byte offsets.

Run the focused probes with a matching LLVM toolchain on `PATH`:

```sh
node packages/cli/dist/bin.js test --manifest-path compiler/silk.toml \
  --root src/semantic/InvalidationCases.silk --no-cache
node packages/cli/dist/bin.js test --manifest-path compiler/silk.toml \
  --root src/semantic/SourceIndexCases.silk --no-cache
node packages/cli/dist/bin.js test --manifest-path compiler/silk.toml \
  --root src/semantic/QueryCases.silk --no-cache
```

## Keys and declaration selection

Declaration-family query addresses intern the full canonical `DeclarationId`, including the
module and owner chain. Current declaration ordinals are refreshed when a key is encountered;
they locate current syntax but no longer define the cache address. Applied facts retain their
application, origin, conditional context and profile in the scoped key. Instance families retain
their canonical instance, layout or content subjects.

A declaration can be remapped across source edits only when every owner is uniquely named.
Anonymous declarations and ambiguous owner chains require an exact declaring-source proof and
use a source-revision-scoped address. They still survive changes to unrelated modules. A duplicate,
removal or changed anonymous binding cannot accidentally select an older occurrence. No ordinal
matching heuristic substitutes for identity.

Selection answers still expose current ordinals. Changing those ordinals invalidates selection
and syntax-bearing facts even when their stable cache address survives. This keeps existing
absolute references safe while allowing a fresh answer to occupy the same declaration slot.

## Typed source projections

`semantic/SourceRead.silk` records the input each provider consumed:

- **Presence:** whether a source exists. Missing modules are first-class negative inputs.
- **Selection:** declaration identity, ambiguity, conditional arm and exposed ordinals.
- **Header:** selection plus canonical header content and header locations.
- **Body:** header and body content, with the complete owned syntax locations.
- **Name:** the ordered candidates for one name, including visibility, import binding and
  conditional context. An empty bucket is a first-class negative input.
- **Shape:** ordered declaration headers for providers that scan a module's declarations.
- **Diagnostics:** the count and spans of a module's parse diagnostics.

Header and body projections also observe enclosing lexical headers. An anonymous body observes
its enclosing bodies because preceding bindings and captures can affect it without changing the
literal's own text. Shape reads are intentionally conservative for module scans: a header edit
may invalidate several scanned facts, but an ordinary runtime body edit does not change them.

A provider that reads raw syntax records the projection of the declaration owning that syntax:
the header when the node lies in it, otherwise the body. Locating a declaration by identity is a
Selection read; only an absent identity observes the module shape. Static execution follows the
same rule. Its authored cursor observes only the module's presence, because the evaluated root's
own query already observes the syntax it supplies. A selected static callee records its own Body
read, and mixed static bodies record Name reads for routed spellings, Header and Body reads for
the declarations they inspect, and a Diagnostics read for their parse-error check. A declaration
appended after a `static if` function therefore leaves that function's signature and body valid.

Each syntax location records HIR identity, byte span and one-based line and column. `SourceUnit`
retains a line-start index belonging to its exact parsed bytes. Equal byte offsets alone are not
sufficient: replacing a space with a newline before a declaration changes emitted locations.
Comments after all consumed syntax preserve the projections. Comments that move consumed syntax
cause the relevant facts to recompute.

Exact source observations remain provenance for held authored cursors and diagnostics. They are
not transitive validity inputs. The narrowly scoped exact-source proof for anonymous/ambiguous
selection is part of declaration authentication, not a second whole-module validator.

## One validator for every family

Every completed answer stores its own typed source reads and ordered direct query dependencies.
Validation first checks the source reads, then visits the dependencies in their observed order.
It stops immediately at the first changed input; it does not validate later dependencies from an
old execution before rerunning the provider. The active-query reservation and frame are released
on typed failure, including allocation failure.

A dependency remains equal when its completed answer ID is unchanged, or when its complete
result identity and location digest compare equal. This cutoff applies to all query families.
Successful facts compare every field consumers can observe. Ordinary semantic refusals compare
their code, module, spans, operands, names, related sites, witness evidence and declaration path.
Refusals carrying static-execution or specialization traces conservatively require the same
immutable diagnostic handle; they cannot produce an unsafe equality cutoff.

Backend equality includes complete MIR instruction recipes, exact selected type/instance
identity, origins, admission edges, safety state and region-selection sensitivity. Layout uses
canonical layout encoding and exact child types; emission inputs use their complete content subject; LLVM definitions
compare text, symbol, encoding, foreign declarations and safety. Origin plans compare ordered
applications, producers and solved environments. Hashes address canonical content; equality never
uses truncated pretty printing or a fixed-buffer serialization.

A runtime caller depends on the callee signature rather than the callee runtime body. Its body
and MIR therefore survive a body-only edit to the callee when their actual inputs stay equal.
Static evaluation records the bodies it executes, so changes to those bodies reach its callers.
Profile, target, application and region-sensitive identity remain separate query inputs; this
change does not broaden region erasure. See `region-sensitive-identity.md` for that contract.

The previous `BodyInput`, forgotten-Body candidate, special payload-reuse event and body-only
validator are deleted. A validated Body hit can publish a new immutable answer wrapper with
current source provenance while retaining its typed payload and answer ID. Previously returned
handles remain unchanged. `Query.refresh` replaces only completed entries and cannot replace an
active reservation or create an absent entry.

## Discovery and retained handles

Cache validity and source publication serve different purposes. A request rebuilds its current
source discovery and demand footprint from the validated completed dependency graph, obtaining
observations from the current revision. It therefore discovers sources on warm hits even when a
cached answer's captured provenance belongs to an earlier revision. Public answer provenance
continues to describe the capture retained by that handle.

Missing paths are included in discovery. Successful LLVM text is immutable content-addressed
work; emission preparation contributes current source discovery. Failed LLVM preparation retains
its own typed reads and dependencies so a repaired source can invalidate the failure.

## Limits and further optimization

The implementation deliberately treats locations as observable inputs. It does not promise that
inserting a comment line or another declaration preserves typed bodies containing absolute HIR
references. Stable keys prevent aliasing; location digests force safe recomputation.

Making those edits cheap would require declaration-local syntax references throughout typed
bodies, static facts, origin data, diagnostics and MIR, plus explicit current-revision location
maps at their consumers. Removing location reads before completing that representation change
would make the cache unsound. This is a separate representation optimization, not a prerequisite
for the implemented body-edit cutoff.

The structural probe establishes invalidation granularity and warm/fresh agreement for its
fixtures. It does not establish project-wide latency improvement. Parsing still reads a complete
changed source.

## Projection cost

Recording a read must not cost more than the fact it protects. Each parsed source retains every
projection computed from it: content digest, location digest and stability, keyed by kind,
declaration ordinal and name. Later reads and validations of the same exact source reuse the
entry, and it is discarded with the source payload. A stability check looks up each owner prefix
of the identity by hash instead of scanning the module, and each parsed source builds, on first
request, a table from authored node to its innermost owning declaration. Without these, a cold
self-build hashed every declaration header for each module-shape read and scanned the module for
each dependency edge and each type, path, lifetime and binder node it read.
