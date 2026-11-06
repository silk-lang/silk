---
bump: minor
---

`silk.tls` resumes TLS 1.3 sessions with tickets and (EC)DHE. `ClientConfig` gains a required `resumption` field: `Resumption.Disabled`, or `Resumption.Enabled` with an optional `Session` to offer. With resumption enabled the client sends `psk_key_exchange_modes`, and `Client.takeSession` returns a `Session` for each NewSessionTicket. `Session.encode` and `Session.decode` store sessions, and `Authentication.resumed` tells whether the server accepted one.

`ServerConfig` gains a required `tickets` field: `TicketPolicy.Off`, or `TicketPolicy.Issue` with a `TicketKey`, the current time, a lifetime and a ticket count. The server seals its session state into stateless tickets with AES-256-GCM, checks PSK binders, and resumes without certificate messages. `Server.resumed` reports it, `ClientCertificateStatus` gains `Resumed`, and `ServerError` gains `Binder` and `InvalidTicketPolicy`.
