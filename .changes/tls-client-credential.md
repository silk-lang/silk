---
bump: minor
---

`silk.tls.client` can send a client certificate. `Client.make` takes a required `ClientCredential`: `ClientCredential.None`, or `ClientCredential.Certificate` with a chain and a `SigningKey`. When the server asks, the client sends the chain and a CertificateVerify with a scheme the server lists, or an empty Certificate when none fits. `ClientLimits` gains `credentialCertificates` and `credentialBytes`, and `TlsError` gains `EmptyCredential`, `CredentialDecode`, `CredentialKeyMismatch` and `Signing`.

`silk.tls.signature` also signs: `SigningKey` holds an ECDSA P-256 or P-384, Ed25519 or RSA-PSS key, and both the client and the server sign with it. `Server.make` takes a `SigningKey` in place of the removed `ServerKey`, `ServerError.Signing` replaces `ServerError.RsaSignature`, and `CertificateDer` moves to `silk.tls.certificate`.
