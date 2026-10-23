---
bump: patch
---

An edit now rechecks far less of a package. `silk check` checks the escapes of each module's bodies on their own instead of walking the whole program from `main` on every check, so an edit to one module reruns only the modules that call into it. A debug build of an executable splits its code into one unit per module and keeps each unit's object in `<output>.units` beside the output, so a rebuild compiles only the units whose code changed, on all cores.
