---
bump: minor
---

Add `[pack.binary]` to `silk.toml`: an executable package with it ships binary archives without `--bin`, as `tar.gz` or `zip`, with the executable in `bin/` or at the top and extra `include` files, and `[pack.binary.target.<target>]` replaces any of these for one target.
