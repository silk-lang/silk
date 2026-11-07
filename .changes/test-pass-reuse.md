---
bump: minor
---

`silk test` does not run the tests again when their runner, `--file`, `--filter` and `--timeout` are unchanged since they last passed; it prints that run's output, and `--no-cache` runs them.
