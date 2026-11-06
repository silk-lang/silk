---
bump: minor
---

Add `silk.tls.server`, a TLS 1.3 server state machine that does no I/O, with the same calling pattern as `silk.tls.client`. It negotiates ChaCha20-Poly1305, AES-128-GCM and AES-256-GCM, and X25519, P-256 and P-384, with a HelloRetryRequest when the client sent no usable key share. It signs CertificateVerify with an ECDSA P-256 or P-384 key, selects ALPN in server preference order, gives you the SNI name, and handles KeyUpdate in both directions and `close_notify`.
