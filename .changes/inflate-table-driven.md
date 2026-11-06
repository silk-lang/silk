---
bump: patch
---

The DEFLATE, zlib, and gzip decoder reads Huffman codes through multi-bit lookup tables and a 64-bit bit buffer, and copies matches 8 bytes at a time, so it decodes about as fast as zlib: 6 to 9 times faster than before on large streams, and 9 to 11 times faster on streams of a few kilobytes. A failed step now reports as consumed only the input that the decoder used. CRC-32 runs 8 bytes at a time, and Adler-32 runs with fewer checks.
