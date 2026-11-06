---
bump: minor
---

Add `silk.encoding.endian`, which reads and writes 16-, 32- and 64-bit words in either byte order with one bounds check. Make the hash kernels faster: SHA-3 and SHAKE (unrolled Keccak, a BMI path, lane loads and stores), MD5, SM3, RIPEMD-160, BLAKE2b and BLAKE2s (unrolled, whole blocks hashed straight from the input), SHA-512 (whole blocks, a BMI2 path) and SHA-256 (vector loads and state kept in registers on the SHA path).

Add `Shake128.finish` and `Shake256.finish`, which return a `Shake128Reader` or `Shake256Reader` whose `read` squeezes the output a part at a time, for rejection sampling in ML-KEM and ML-DSA.
