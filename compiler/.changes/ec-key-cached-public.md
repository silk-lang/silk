---
bump: patch
---

P-256 and P-384 private keys keep their public key, so a TLS server checks its key once per config instead of on every handshake.
