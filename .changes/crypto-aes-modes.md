---
bump: minor
---

Add the AES modes in Node's default OpenSSL provider that `silk.crypto` lacked: `AesCfb`, `AesCfb8`, `AesCfb1` and `AesOfb` in `silk.crypto.aes`, and the new `silk.crypto.aes_xts` (XTS with ciphertext stealing), `silk.crypto.aes_ccm` (CCM), `silk.crypto.aes_ocb` (streaming OCB3) and `silk.crypto.aes_wrap` (RFC 3394 and RFC 5649 key wrap) modules.
