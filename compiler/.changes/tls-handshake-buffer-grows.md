---
bump: patch
---

The TLS server handshake buffer starts at 4 KiB and grows to the messages that arrive, instead of taking the full limit per connection.
