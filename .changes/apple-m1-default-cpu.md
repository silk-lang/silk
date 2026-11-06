---
bump: minor
---

`aarch64-apple-darwin` builds for `apple-m1` by default, so `aes`, `crc`, `crypto`, `dotprod`, `fullfp16`, `lse`, `rdm`, `sha2` and `sha3` are static there and AES-GCM and SHA-256 skip their run-time checks.
