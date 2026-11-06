---
bump: minor
---

`silk.tls` client certificates work in TLS 1.2. A server with `ClientAuth.Request` now also speaks TLS 1.2: it sends a CertificateRequest that lists ECDSA and RSA schemes under SHA-256 and SHA-384 and no certificate authorities, and checks the client's CertificateVerify over the handshake hash. A client with `ClientCredential.Certificate` presents its chain and signs with a scheme the server lists. An Ed25519 key cannot sign in TLS 1.2, so such a client sends an empty Certificate.

`SigningKey.signDigest` signs a precomputed digest with a scheme, and `HandshakeSignature.verifyDigest` and `HandshakeSignature.digestLength` check one, for the TLS 1.2 CertificateVerify, whose hash can differ from the suite's.
