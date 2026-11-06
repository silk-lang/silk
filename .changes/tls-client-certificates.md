---
bump: minor
---

`silk.tls.server` can ask for client certificates. `ServerConfig` gains a required `clientAuth` field: `ClientAuth.Off`, or `ClientAuth.Request` with trust anchors, a validation time, whether a certificate is required, and whether an untrusted chain fails the handshake. The server checks the client's CertificateVerify and validates its chain, and `Server.clientCertificateStatus` and `Server.clientCertificates` report the result. `ServerLimits` gains `clientCertificates`, `clientCertificateBytes`, `clientTrust` and `clientValidation`.

`CertificatePath.validate` takes a `CertificatePurpose` (`ServerAuth` or `ClientAuth`) and checks ExtendedKeyUsage along the whole path for it. `CertificateProfile.inspect` no longer checks ExtendedKeyUsage; `CertificateProfile.checkPurpose` does. `CertificateRole.ServerLeaf` is now `CertificateRole.Leaf`, and `ExtendedKeyUsage` gains `clientAuth`.

New `silk.tls.signature` checks TLS 1.3 CertificateVerify signatures for ECDSA P-256 and P-384, RSA-PSS with SHA-256, SHA-384 and SHA-512, and Ed25519. `silk.tls.client` uses it, and `TlsError.CertificateVerify` now carries a `SignatureFailure` in place of the removed `CertificateVerifyFailure`.
