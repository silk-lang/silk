---
bump: minor
---

Add socket controls to `NativeUdpSocket`: `setIpv6Only`, `setReuseAddress`, `setBroadcast`, `setTtl`, `setMulticastTtl`, `setMulticastLoopback`, `setMulticastInterface`, group and source-group membership, send and receive buffer sizes, `peerEndpoint` and `disconnect`. `NativeUdpSocket.adopt` takes an open UDP socket descriptor, such as one that a cluster primary sent.
