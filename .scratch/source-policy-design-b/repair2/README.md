# B repair2 — two bounded correspondence corrections

Reviewed parent b1e21c5efb6ff41ea3843a40eae2c138a643e726 is preserved, with all
baseline/repair1 files and results byte-for-byte unchanged. Accepted main remains
6c1608657dbdb11efce96ca973213e8cbd809f64. This is design-only, same branch, no new PR,
production/schema/API implementation, native build or CI action.

Review2 explicitly resolves all three architecture blockers. This repair changes
only advertised accepted-policy correspondence in compiler/borrow-source-policy-rules.md
and its overview/evidence description in compiler/borrow-source-design.md:

- R2-1: Same view path narrows regardless of directness; Unknown path alone uses
  the direct/referent compatibility fallback. Exact indirect and mixed histories
  are Local/located=true under the review's fixed inputs. Located remains paired
  with each original read/definition/path/direct case. Parent closure replaces
  provisional classifications before effects; Unknown promoted to Universal does
  not retain a storing effect or acquire located evidence. The Exact/Stored actual
  slot adapter, later operation applicability and independent escapes are retained.
- R2-2: eligible cleanup matching uses everything OR named.empty OR shares for its
  interval, while only interval AND named.empty adds S+A. Nonempty names preserve
  precision even with everything=true. Preserve early refusal/no-observer and
  holder gates, loop recording and interval identity.

The preparation contribution is unchanged at SHA
b769dd2625bf54c7972da511648c8a51c7ba6310249f423a9f3084a64d84e9b8.
No source architecture, signature product, proof relaxation or #1957 policy is added.
The old direct-and-field0 classifier was a stale model, not a native compiler bug.
Its historical passing subsets do not establish main6c correspondence. The old
cleanup table tested already-selected loss events, not the selection gate.

## Evidence and limits

`model.py` deliberately identifies its policy functions as accepted-main6c
specializations/transcriptions. It uses separately stated helper-boundary answers
and a set-reachability parent oracle; it does NOT claim an independent full compiler
oracle or actual typed path construction.

- Six Same/Different/Unknown × directness boundaries, additional missing/incompatible
  referent, no-slot/undescribed, non-view, mixed-slot and abort controls. Exact indirect
  and direct histories combine at one physical occurrence; historical duplication
  does not create copies. Unknown-path directness remains observable. Definition/read
  pairs never cross-authenticate. KeptSink's other full type/own/static paths are
  retained in the design but not modeled by this fixed-input specialization.
- 16 parent graphs: subsets of links0->1,1->2,0->2 × explicit-only selection Boolean.
  Node1 is nonlocal, node2 local, with separate operands. Queue closure matches an
  independently expressed reachability characterization; promotion never sets located.
  A focused Unknown->Universal/unlocated case yields independent escape, not storing.
- 128 adapter cases: four qualities × located × known field × real point × actual
  operation reachability × preexisting independent reason. Source is fixed Actual;
  this is NOT a model of the full caller source classifier or its CFG. Independent
  reasons survive failed invocation applicability; Alternatives/Unknown never acquire
  the located Exact/Stored adapter.
- 192 cleanup cases: qualities0..3 × named {},{r},{s} × observed {},{r} × unknownHeld
  × hidden × holder-match. Named/observed sets avoid impossible empty-and-shares
  Boolean combinations. Check interval, final quality and early refusal separately.
  Explicit controls retain nonempty shared/everything no-loss, empty-named loss,
  absent observation and wrong holder. Scope/loop construction and interval liveness
  are not executed by the model.

`results.json` contains the full cleanup table; `model.log` omits that repetitive
table. `replay.py` runs temporary copies of baseline, repair1, review1 and review2
scripts and compares complete stdout/JSON byte-for-byte. It never writes beside
historical files. `replay-results.json` records exact hashes and exit0 for all four.
Review2 source report/probes/json/log are copied exactly under review2/ and retain
its REQUEST CHANGES verdict, 81 release-completion checks, combined P/Q controls,
and historical falsifiers. Replay does not convert their findings into approval.

An initial replay-harness assertion expected every old script to create a JSON
file; review1 instead prints JSON only. The harness was corrected, then all four
replays passed. `replay-initial-failure.txt` records this limitation; no historical
artifact or model expectation changed. No model assertion failed in this repair.

Commands and hashes are retained. No execution of Silk programs, ownership solver,
actual source/shape/API construction, diagnostic ordering or compiler costs occurred.
NEW independent design review3 is required before implementation C. Existing full
source/lifecycle/metadata/CI acceptance boundaries and open issues remain unchanged.
