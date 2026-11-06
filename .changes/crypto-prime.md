---
bump: minor
---

Add `silk.crypto.prime` with `Prime.isProbablePrime` and `Prime.generate`, which supports safe primes and the `add` and `remainder` constraints of Node.js `crypto.generatePrime`. Add `Natural.remainder` for any nonzero divisor, and `DhGroup.check`, which tests whether a group's prime is prime and safe. RSA key generation now uses the shared primality test.
