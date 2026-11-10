# Focused completion-barrier measurement

Status: prepared only. Candidate construction metadata and frozen binary are not yet supplied. Do not run timed jobs before root grants exclusive ownership.

Run only Harf builds initially: four execution CPUs, one frozen binary, registry OFF, pipeline OFF/ON with every other frontier/cache/packing feature identical, two reversed rounds. Each cohort is cold→first edit→second edit without waiting for a prior writer before editing. Four cohorts yield 12 invocations. No unchanged priming. Compare foreground, all-observed-writer settlement, edit-action→return, launch gaps, process-tree CPU and total cohort elapsed. Preserve same-input artifact/ordered-diagnostic parity and warm no-refork gates.

Prepared generic command (fill pins from the new candidate’s construction JSON):

```sh
python3 .scratch/incremental_reporting/immediate_pipeline_screen.py \
  --candidate FROZEN_BINARY --source EXACT_SOURCE --expected-sha256 BINARY_SHA \
  --construction CONSTRUCTION_JSON --workloads harfrust --rounds 2 \
  --require-checkpoint --require-completion
```

The script owns `performance.lock`; do not wrap it in another flock. It requires 1.5GiB free before each cohort and never pauses or cleans inside an overlapping cohort. Completed-cohort environmental refusal can resume with exact pins, unchanged supervisor harness, restored source and no partial cache.

Cold ON acceptance requires exactly one ordered trace chain:

`frontier native coordinator started` → `frontier native cache checkpoint` → `frontier native objects published` → `frontier native cache completed`.

OFF and warm invocations must emit no cache-completed event. Before each ON first edit, the one-shot birth-tick-checked prior-descendant observation must show zero live cold descendants. Zero detached descendants in a cold ON row is valid: the compiler now owns and reaps its checkpoint writer. Its CPU is already included in the primary `wait4` usage; do not add it twice or infer missing CPU from an empty detached list. Every descendant actually observed by the supervisor must exit successfully and be reaped. The external supervisor does not independently observe the exit status of a writer already reaped by the compiler; the completion marker and native ownership tests establish the join, while product cache writes remain best-effort.

Report to root after Harf. A compiler confirmation pair is optional only if the result/new evidence justifies it; do not automatically repeat the previous 24-call matrix. CPU0 performance acceptance remains held for a comparable-construction final binary. Native CPU0 admission correctness already passed; previous V17 one-core regressions remain flagged.
