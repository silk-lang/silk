---
bump: minor
---

`silk hash --json` names each package with its hash and the artifacts its build writes, `--root <path>` hashes another root module as `silk test --root` loads it, and `--test` hashes what `silk test` builds, test runner included.
