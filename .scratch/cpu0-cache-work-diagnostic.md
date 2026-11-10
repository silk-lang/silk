# V22 cache-work diagnostic

Source: /workspace/silk-cpu0-cache-work, exact base 85ba82efe750a4682cc21192ad5dcb37d7bbd981. Diagnostic only; no cache policy or validity changes. Full combined sourcecheck is pending root scheduling.

Enable SILK_CPU0_CACHE_TRACE (name is historical; works on one/four CPUs). Optionally set SILK_CPU_TRACE_FD to an already-open append-only descriptor inherited with pass_fds. Default is stderr. The supplied descriptor prevents native coordinator stderr redirection hiding events. Each line is one bounded write:

    cpu0-cache LABEL at_ns=N pid=P tid=T ns=D a=A b=B c=C

at_ns is absolute CLOCK_MONOTONIC time; ns is elapsed wall nanoseconds, not CPU time. Pure point(label,a,b) records ns=0. Unsupported hosts disable the FrontierHost environment hook. No per-input/per-row writes occur. Timer calls and diagnostic bitsets add overhead; compare attribution, not absolute diagnostic timings against an uninstrumented executable. The external current-CPU sampler supplies independent CPU attribution.

## Events

- settle-inputs: entire deferred-input drain; a=pending at entry, b=remaining.
- input-lookup FAMILY: module/source demand, selector handle and declaration position lookup; a=count.
- input-capture FAMILY: captureInput canonical encoding plus temporary arena setup; a=count, b=encoded observation bytes (including selector/framing, not only HIR bytes).
- input-hash-text FAMILY: text observation and digest of canonical bytes; a=count, b=bytes.
- fresh-image: fresh image assembly after settlement; a=node count, b=root count.
- carry-image: held-image unpack and carried graph copy; a=output nodes, b=roots.
- carried-checks-files: carried/replayed check roots and source evidence refresh. May contain another settle-inputs; nested durations must not be summed as independent work.
- prune-blobs, compact-roots: publication pruning phases; a=output nodes, b=roots.
- encode-files, write-files: full encoded graph/roots publication; a=graph bytes, b=roots bytes. Early failed writes do not emit a completed write event.
- green-inline/shared: a=actual rows visited, b=first row visits in this immutable graph/adoption, c=calls; ns excludes initial directory/selection creation.
- budget-inline/shared: a=offered selected rows for completed calls, b=first offered rows, c=calls. Early failed includeBudget may internally visit fewer rows than offered. Diagnostic masks do not roll back and are never semantic evidence.
- directory-inline/shared: ns=index-reader elapsed time, a=payload bytes, b=directories, c=new definitions committed by completed budget calls.

Green/budget/directory snapshots are cumulative per adoption and emitted before the parent's cache save/current fast path. If a command saves more than once, snapshots are not independent and must not be summed. First visits identify immutable graph rows, not unique definitions across separate graphs. OOM exits preserve existing semantic rollback and may omit incomplete diagnostic events. All hashes, exact inputs, graph ordering, budget policies, and writer behavior remain unchanged.

Use a baseline-matched source snapshot with separate cold/unchanged/direct-edit sequences on CPU0. Capture parent and detached writer PID events until every descendant settles. First distinguish writer settlement/hash cost from graph encoding/write and unchanged row repetition. Only then choose an optimization; moving settlement to the foreground is not a total-work reduction.
