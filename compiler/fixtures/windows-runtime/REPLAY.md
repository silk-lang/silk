# Windows source topology and replay budgets

Run [41260286867](https://github.com/silk-lang/silk/actions/runs/41260286867) used one N1
from `c6b2d2f8b` for baseline `97f009270` and feature source `1063f6105`. The short
replay's seven edits to Bytes marked and verified exactly 14 more units on the feature.
Units executed, fingerprinted answers, and unchanged answers matched the baseline.
All short differential checks reported zero differences, including the rename step.

Replacing only `Wtf8.encode`'s body in a disposable source copy removed five extra
marks. Replacing the three WindowsPath conversion bodies as well removed all 14.
Signatures and the compiler binary stayed unchanged. These controls isolate ordinary
new source consumers; they are never production changes. The baseline already has
two rejections, rising to four at the deliberate module rename.

The long replay independently measured the same increase of 14 marks and successful
verifications on each of its 20 edits, with three units executed each time and no
answer or MIR retention growth. The budget adjustment adds 14 only to Bytes-edit
outdated limits. Execution limits, verification floors, demand fractions, retention
limits, differential coverage, and compiler replay budgets stay unchanged.

Both updated budgets pass the retained logs with `check-replay-budgets.mjs`. Later
source additions need fresh measurements; the adjustment does not claim their cost.
The `windows-replay-controls` artifact retains every source variant's log and commit.
