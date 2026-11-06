---
bump: minor
---

`silk.tls` resumes TLS 1.2 sessions. With `Resumption.Enabled`, a client that allows TLS 1.2 sends a session_ticket extension (RFC 5077), and after a full TLS 1.2 handshake `Client.takeSession` returns a session that holds the master secret and the server's ticket or session ID. A later client offers both, and resumes when the server echoes the session ID. A server with `TicketPolicy.Issue` issues one TLS 1.2 ticket per full handshake and resumes from it, without a session cache, so it never resumes by session ID alone.

`Session` gains `version` and `sessionId`. A session resumes only with its own version, so a TLS 1.2 session is not offered over TLS 1.3. `Session.encode` writes a new format, and `Session.decode` refuses sessions that an older version encoded.
