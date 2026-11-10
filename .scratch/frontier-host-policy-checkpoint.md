# Fixed-four host admission candidate

Source worktree `/workspace/silk-frontier-host-policy`, branch `codex/frontier-host-policy`, base `9eb6040ae`. Commits `12e036d40` and `309925e3d` add only `compiler/src/semantic/FrontierPolicy.silk`. No integration/default activation.

`FrontierPolicy.eligible()` is a best-effort native probe requiring only an allocator. It catches probe errors/allocation failures and returns false. It does not grant fork permission: CLI-only permission, immutable/recording store, cold work thresholds and fixed four-lease architecture must remain separate. Prefer calling just before the first attempted pool creation, after warm work thresholds, so unchanged/tiny commands avoid probing.

Capacity is the minimum of process affinity, every visible cgroup-v2 CPU quota (rounded down), host available memory, and every visible cgroup-v2 remaining memory allowance. Remaining group memory is max minus current charged usage after discounting exactly `inactive_file`; missing, duplicate or inconsistent statistics refuse eligibility. The estimated additional reserve is 6 GiB: measured aggregate checking PSS 4.35 GiB rounded to 5 GiB plus 1 GiB backend/native overlap. This is conservative admission headroom, not an OOM guarantee.

Mountinfo and actual PID membership locate the group. In this environment mountinfo exposes `/..` while `/proc/self/cgroup` says `/`; the actual group is `/sys/fs/cgroup/init` and limits reside in its parent. A bounded 64-directory search verifies membership and all visible ancestor limits through the mount root; membership is rechecked afterward. Unsupported v1, missing/ambiguous mounts, escaped paths, bind-mounted subtree roots and malformed readings refuse eligibility. Controllers above a cgroup namespace's visible mount are not observable by this probe; namespace-level limits exposed at the mount and all visible descendants/ancestors are checked.

Validation:
- Whole compiler sourcecheck passed, though the unreferenced helper's meaningful compilation gate is its own runner.
- Focused pure policy tests 4/4 passed: CPU/memory boundaries, fractional/invalid quotas, parent/host minima, reclaim accounting, duplicate/missing/inconsistent statistics, path/PID matching. `.scratch/frontier-host-policy-tests.log`.
- Tiny native caller compiled all probe code and ran successfully: affinity 5, parent quota 4, unlimited `/init`, parent 16 GiB limit, reclaim-adjusted remaining 8,069,562,368 bytes, host available 15,833,960,448 bytes => eligible. Same executable restricted to three affinity CPUs => serial. These are observations, not CI assumptions. `/workspace/frontier-host-policy-probe/{build.log,observation.json}`.
- No heavy jobs remain. Root decides production activation and whether to integrate the candidate.
