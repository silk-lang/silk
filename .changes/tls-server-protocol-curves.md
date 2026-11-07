---
bump: patch
---

`silk.tls.server_protocol` compiles again: `TlsServerConfig.fromPem` refuses a key of any curve other than P-256 and P-384 with `UnsupportedKey`, and the protocol's server config states that it accepts TLS 1.3 only.
