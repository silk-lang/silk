---
bump: minor
---

ChaCha20 in `silk.crypto.chacha20_poly1305` runs four blocks at a time in 128-bit vectors, and eight at a time with AVX2 when an x86-64 machine has it, checked at run time. Poly1305 keeps its accumulator in 64-bit words with 128-bit products and hashes whole blocks straight from the input.
