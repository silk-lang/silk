# Same-binary feature sequence audit

Reviewed `feature_sequence.py` and its unchanged `edit_sequence.py`, `immediate_edits.py`, `option_screen.py` and `lane.py` dependencies. No compiler invocation was run.

The environment now clears both feature switches, the streamed-body-hash switch, actual executable trace name, cache-packet and escape-replay censuses, CPU/query event diagnostics, MIR verification and inherited workload PGO settings. It then recreates the fixed retained/frontier/private/chunk/packing policy and enables only the selected feature for candidate mode. Registry remains absent; native pipeline exists only for builds. Per-mode/per-operation Silk environment metadata is compared with the actual environment before every cohort.

The three choices are shared-bodies, executables and streamed-body-hash. The streamed mode uses presence of SILK_STREAMED_BODY_HASH; both sides start with a fresh cache, so its intentional mode-specific cache identity cannot silently prime the comparison.

The new pure construction guard verifies identical binary/source/hash/construction paths and constructor hashes, and enforces four units, optimization=speed, debug=false and no PGO. Previously equal but incorrect settings could satisfy the comparison while contradicting the report's O2 description. Binary bytes are still hashed before the run; source and SHA must match the construction receipt.

CPU affinity is explicitly set to [0] or [0,1,2,3] and checked in every supervisor result. CPU0 uses the normal flags and requires automatic host-capacity refusal; it does not replace the policy with explicit serial flags. Four-core cold calls require proof acceptance. Warm calls forbid pools; build completion events must be ordered, and immediate first build edits cannot have a live prior writer.

The sequence is cold → direct first edit → second edit → unchanged. There is no earlier unchanged run or hidden cache priming. Immediate mode launches after foreground notification and retains artifacts by hard link rather than reading them. Settled mode waits for each invocation's writers. Unchanged verifies source bytes without changing mtime. Synthetic tests exercise real subprocess/fork lifetimes, independent reaping, overlapping versus settled order, four artifacts and unchanged mtime. Process-tree CPU includes foreground wait4 usage plus separately adopted children; overlapping settled intervals are not added.

Build validation happens after the whole cohort has settled. Each edit must change help output to its own marker; checks compare complete rendered diagnostic blocks. Exact parity requires hashes plus runtime output. Explicit runtime parity allows changed native bytes but still compares help and Harf Latin/Arabic shaping. Full JSON byte spans and actual feature engagement remain separate correctness gates; feature flags alone do not prove an optimization executed. Executable tracing remains OFF for timings.

Validation: `python3 -m unittest test_feature_sequence test_edit_sequence test_immediate_edits test_component_sequence test_option_screen` — 13 tests pass. New feature policy test covers all six feature×operation pairs. Historical harness files were not modified. This audit does not establish N0 acceptance or any performance improvement.
