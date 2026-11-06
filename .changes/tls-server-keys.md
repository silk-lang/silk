---
bump: minor
---

`silk.tls.server` signs with Ed25519 and RSA certificate keys. `ServerKey` gains `Ed25519` and `RsaPss`, and the server picks a signature scheme that the client offers: `ed25519`, or `rsa_pss_rsae_sha256`, `rsa_pss_rsae_sha384` and `rsa_pss_rsae_sha512` in that order. `ServerError` gains `RsaSignature`. `Server.make` now also checks the leaf's key algorithm, not only its key bytes.
