---
bump: patch
---

A tasks program no longer evaluates its own package's `build.silk` until it imports one of the package's modules, so a plan that names an archive the tasks manifest lacks, or one a task prepares, does not stop the task. Each package's tasks program is built under `build/steps/tasks/<package>/`, so one package's task can run another's on Windows, which cannot replace a running executable.
