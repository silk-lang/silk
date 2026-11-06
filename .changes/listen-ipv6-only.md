---
bump: minor
---

Add an `ipv6Only` setting to `ListenOptions`, so that an IPv6 TCP listener can also take IPv4 clients.

## Migration

Pass the new `ipv6Only` argument to `ListenOptions.make(kernelBacklog, reuseAddress, ipv6Only, pollIntervalNanoseconds)`. Pass `true` to keep the old behavior.
