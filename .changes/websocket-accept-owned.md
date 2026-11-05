---
bump: patch
---

`acceptOwned` of `silk.http.websocket_upgrade` answers a handshake on an accepted connection and returns a session that owns it; `channelTransport` runs a session over the channel of `withUpgrade`.
