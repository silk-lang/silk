---
bump: patch
---

`NativeHttp` reads and decodes its trust bundle once, on its first HTTPS connection, and gives each later connection a copy of the anchors. Before, every new connection opened the bundle file and decoded every certificate in it again. With the Debian system bundle (122 anchors), opening 64 HTTPS connections now takes 40 ms of CPU instead of 287 ms. The workers of `sendAll` share the client's trust source, so they no longer make one each. A change to the bundle file takes effect in a new client.
