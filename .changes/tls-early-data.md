---
bump: minor
---

`silk.tls` sends and accepts TLS 1.3 0-RTT data. `Resumption.Enabled` gains a required `earlyData` field with the bytes to send right after the ClientHello, and `Client.earlyData` returns an `EarlyDataStatus`. The client sends them only when the session's ticket allows that many bytes, and `make` refuses more than 16384 with `TlsLimitKind.EarlyDataBytes`.

`TicketPolicy.Issue` gains a required `maxEarlyData` field that tickets advertise. The server accepts early data when the ticket allows it, there was no HelloRetryRequest, the cipher suite and ALPN protocol match the session, and the ticket age is within 10 seconds. It reports accepted data as `PlaintextReady` before `HandshakeComplete`, and `Server.earlyData` tells what happened. Rejected early data is skipped up to the new `ServerLimits.rejectedEarlyDataBytes`. `ServerProtocolReason` gains `EarlyData`. `TlsRecordReceiver.skipUndecryptable` drops records that the receiver cannot read, for rejected early data.

The server keeps no state across connections, so it cannot detect replayed early data. Accept it only for requests that are safe to repeat.
