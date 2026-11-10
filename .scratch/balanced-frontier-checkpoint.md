# Balanced frontend candidate

Worktree `/workspace/silk-balanced-frontier`, branch `codex/balanced-frontier`, current compiled commit `c7b163a85`.

Composition:
- validated original finite frontend checkpoint2e0c210b2;
- dynamic inherited-task/module schedulingfb2197aaa;
- current-main production fixes, ephemeral transport, host adapter, finite policy/RPC cleanup through7599047df;
- private runtime worker forks9baaefe65, runtime-frame-only donation guard83a87cadf;
- exact declaration-range module chunks6fde9921d;
- assigned-capture transport and full-graph subset coverage1110fec02, replayed asc7b163a85.

Merge details: rootworker module loop retains donor compute-lease priority; descendants>=4 skip all module/chunk work. Chunk records remain transport-only packets; owned escape list contains runtime plus ordinary completed module walks only. Every descendant proof root still concatenates through proxy; runtime presence counted once per rootworker. All worker-list allocations precede shared mappings. Current integration mergecaee2628f removed old ancestry decision paths while preserving protocol.

Full sourcecheck and optimized speed-four bootstrap succeeded100s. Binary `.scratch/frontier-balanced`, SHA256 `f78f295f9e01681533295b9890c7b315bdf554e822b5b06ab4d8715859bf380d`. Package `.scratch/balanced-candidate-package`, seed `.scratch/ci-n1-4a1fa332/N1`, frozen worktree stdlib, LLVM22.1.8.

Prepared validation, not yet run on this binary:
- `.scratch/balanced-parity.py <binary> --run`:4 native320-declaration fixtures, two enabled repetitions, full JSON parity; enables shared/ephemeral/private-fork/chunk flags.
- `.scratch/balanced_warm_proof.py`: compiler cold+warm cached-frontier and balanced modes; no fallback permitted after split, exact diagnostic equality; correctness only, may run alongside bootstrap under shared lock.
- `.scratch/balanced_frontier_compare.py 2`: exclusive reversed pairs baselineN0-one, ephemeral, private-forks, balanced; fixed original compiler/Harf snapshots; aggregate CPU/writer settlement/accepted proof recorded.

Current scheduling: backend exclusive large-build/packing underway; walks warm-cache regression fix test occupies/queues next shared slot, then balanced parity/warm proof, then worker_forks retained-proxy sourcecheck. Wait explicit releases. No balanced runtime process active yet.
