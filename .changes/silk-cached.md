---
bump: minor
---

Add `silk cached check|build|test`, which runs a project command once per `silk hash` and the options that change only its output, then replays its output and a build's artifacts from a task store (a local directory, `SILK_TASK_CACHE` or `$SILK_HOME/cache/tasks`).
