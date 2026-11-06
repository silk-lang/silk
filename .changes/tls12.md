---
bump: minor
---

`silk.tls` speaks TLS 1.2 (RFC 5246) next to TLS 1.3, as a client and as a server. `ClientConfig` and `ServerConfig` gain a required `versions` field, a `VersionPolicy` from `silk.tls.record`: `defaults()` allows both versions and prefers TLS 1.3, `tls12()` and `tls13()` allow one, and `range` takes a minimum and a maximum. `silk.http.exchange` `RouteSettings` and `silk.http.exchange_native` `Options` gain a required `tlsVersions` field for the same choice, and `Options.defaults()` allows both versions.

TLS 1.2 uses the ECDHE suites with ECDSA or RSA keys and ChaCha20-Poly1305 (RFC 7905), AES-128-GCM or AES-256-GCM, over X25519, P-256 or P-384. Both sides require the extended master secret (RFC 7627) and refuse renegotiation. When TLS 1.3 is also allowed, the server puts the RFC 8446 downgrade mark in a TLS 1.2 ServerHello and the client rejects a marked one. In TLS 1.2 there is no session resumption and no KeyUpdate, the client sends an empty Certificate when asked for one, and a server with `ClientAuth.Request` uses only TLS 1.3.

The new module `silk.tls.prf` has the TLS 1.2 PRF, the extended master secret, the key block and Finished. `SigningKey.RsaPss` is now `SigningKey.Rsa`, since a TLS 1.2 RSA key may also sign with PKCS #1 v1.5. `NegotiationFailure` gains `ExtendedMasterSecret`, `Server.version` returns the negotiated version, `Authentication.version` returns it on the client, and `NamedGroup` gains `P384` for TLS 1.2. `CipherSuite` gains the six TLS 1.2 suites and `version`, `code`, `fromCode`, `hashLength` and `isEcdsa`.
