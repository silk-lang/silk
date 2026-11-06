---
bump: minor
---

Add `silk.crypto.des_wrap` with `TripleDesKeyWrap`, the Triple DES key wrap of RFC 3217 (CMS `id-alg-CMS3DESwrap`, OpenSSL and Node `des3-wrap`). It wraps under a caller's random IV and unwraps with a constant-time check of the SHA-1 integrity value.
