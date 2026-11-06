---
bump: minor
---

Add `silk.crypto.dh` for finite-field Diffie-Hellman: the MODP groups of RFC 2409 and RFC 3526, the FFDHE groups of RFC 7919, and custom groups from 512 to 8192 bits. The exponentiation takes the same time for every secret of a group, and the shared secret is padded to the length of the prime, as Node.js and TLS expect.
