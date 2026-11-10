# Bounded second runtime donation candidate

Worktree `/workspace/silk-frontier-reshare`, branch `codex/frontier-reshare`, commit `57d883e43`, base root05d8f5275 (sparse inherited captures, complete-module experiment, Enter-only walks, retained backend, refusal cleanup). Not yet sourcechecked or compiled; profiling exclusive windows take priority.

Enable existing frontier/shared/ephemeral/private flags plus `SILK_FRONTIER_RESHARE=1`. Without the new flag, each original worker still donates at most once. With it, each may donate twice, while shared control word2 atomically reserves at most4 private children globally. Four original workers +4 retained descendants is still the resident-worker bound; compute control word0 still permits at most4 active heavy computations. Failed fork setup returns both child reservation and compute lease, then disables further donations from that worker.

The nth child of root r receives logical owner r+4*n. On a second fork, the new child closes inherited sibling control/file endpoints and clears its local child list, so it cannot proxy into a sibling or retain an endpoint that hides EOF. Original ancestors retain both child stores. Module sweeps/chunks remain original workers only; donation remains confined to the original runtime walk frame.

Backend proxy accepts1–2 descendants. Commands3/6 already broadcast; commands4/5 partition into local + every child batch, preserve input reply order, retry unknown graph requests once per resident store, and retain exact-key/definition/store emission pinning. Root routing remains logicalowner%4; descendant side is logicalowner/4. `artifact descendant store emitted` traces specific logical child IDs, allowing second-child backend reuse to be verified. Artifact record payload remains opaque and compatible with build_pipeline's pending exact-edge persistence protocol.

Focused reservation helper now checks global4-child cap and returning exactly one slot after a failed spawn. Pending validation: whole compiler sourcecheck, focused partition/reservation test, optimized bootstrap, same-binary reshare off/on cold check pairs with actual child IDs>=8, full retained build parity with second-child emission, reshare failure injections and memory if it materially improves performance. User goal still3× cold check/build; current build gap remains significant, so reject the opt-in candidate if overhead exceeds straggler reduction.

Prior evidence driving the candidate: integrated-v2 compiler trial1 root0 donates at2.237s, child4 finishes3.217s; other original workers finish module work5.631–5.643s, root0 runtime lasts6.356s. Existing one-donation cap prevents using the newly idle compute leases for the final~0.7s. Trial0 has no comparable tail, so repeated same-binary measurements are necessary.

Package scaffold `.scratch/frontier-reshare-package` points to this source and includes manifest.schema.toml; profile speed-four. No heavy candidate job has run yet.

## V3 acceptance completed

Root integrated production reshare57d883e43 into frozen source24e8e8302. Binary `.scratch/frontier-integrated-v3`, SHA256 `1000d42772fea2a1bd355999513a8cb81711f61bb7a5abe105b4a17b6ff551db`. Additional two-partition test cfe4b8dba was applied after the frozen build and awaits the next helper test.

Shared correctness-only full compiler build run `.scratch/benchmarks/reshare-build-parity-zq97opp3` enables complete modules, reshare, speculative emission and4MiB global packing. First on trial had children4+7; second had children4+8 under root0 and child7 under root3. ID8 emitted3,698 definitions, ID4 emitted2,257 and ID7 emitted232. Full finite frontier/artifact proof accepted. Speculative preparation warmed46,904 texts with36,090 hits. Generated compiler --version exits0.

Both parallel trials and same-snapshot serial build produced byte-identical compiler binary SHA256 `fcf9d1698d84199586b306fd5ea7a214133126ce0fa0dc21b7c6230ff9bcc974` and every generated artifact. Evidence `results.json` and `parity.json`; all workers/cache writers reaped. Shared durations are not performance measurements. Script `.scratch/frontier-reshare-build-parity.py BINARY` bounds engagement attempts and requires same-root IDs4+r/8+r, actual second-child emission, warm hits, complete proof and full serial artifact parity.

Parallel_semantics also passed V3 unused-module-error-after-donation exact JSON parity and cleanup (2actualchildren, fatal chunk/module diagnostic, no accepted union or lease wait stall). Root owns controlled V3 timing/packing comparison. Remaining optional failure case: terminate only second private child while first sibling remains retained, to exercise multi-child abort/reap/fallback.
