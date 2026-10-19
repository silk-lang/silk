# B continuation model archive

Base approved A9d0a31575; ancestry integrated accepted main2ed4ebed1. Published PR1984 untouched.

Run `python3 .scratch/source-policy-design-b/model.py`. Standard-library Python only; no native compiler, no invalid fixture execution, no network. Exit0 means its independent small-domain assertions pass. model-results.json and model.log are exact captured outputs; model.sha256 records source/output hashes. They are model evidence, not Silk semantic acceptance or compiler translation proof.

Domains/oracles are specified in compiler/borrow-source-design.md section8. The CFG oracle enumerates all paths for acyclic last-write claims; alias oracle separately explores concrete program-point/store states; normal-program oracle enumerates stable interpretations independently of alternating closure; sentinel oracle uses first ordinary operand plus suffix characterization; graph query oracle enumerates walks. Counterexample uses finite sets of O/W and enumerates all output pairs, not the proposed refiner's answer as an expected value.

Exhaustive bounded results:1269 acyclic write CFG cases;8000 alias/action DAG cases;364 sentinel sequences;1024 two-atom normal programs (308 no stable model; every total result unique, every stable result enclosed);127 finite selector words. Temporal cyclic cases and complete/drop/grounded-positive cases are explicit. No timing assertions. Exact real source origins, Type queries, all compiler constructors, physical path/alias correspondence and diagnostics remain untested.

Full production constructor/effect-site text inventory at construction-sites.txt is source attribution, not an assertion oracle. The design adds no production graph/API/helper. SourceRouteId amendment and transported precision join require NEW independent design review. Parent owns review/CI/merge, and later C needs actual native acceptance of source/field/unknown/backedge/escape controls. No issue closure or gap claim.
