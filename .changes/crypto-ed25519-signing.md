---
bump: minor
---

Sign with Ed25519 in `silk.crypto.ed25519`. `Ed25519PrivateKey.fromSeed` takes the 32-byte RFC 8032 seed and `Ed25519PrivateKey.generate` makes a new key. `sign` gives the deterministic 64-byte signature, and multiplies by the secret scalars in constant time.
