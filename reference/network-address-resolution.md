---
title: Network addresses and resolution
description: Owned IP, domain, endpoint, and finite provider-replaceable resolution contracts.
---

# Network addresses and resolution

Use `silk.network_address` to parse and retain origin hosts, and `silk.resolver` to turn an owned
host and port into a finite owned endpoint sequence. The portable actors work without libc and can
use deterministic Resolver providers in tests and embedded applications.

```silk
import silk.network_address {AddressError, Host, Port}
import silk.result {Result}

pub fn main() -> i32 {
  let host = Host.parse(b"[2001:db8::1]")
  let port = Port.make(443)
  return match move host {
    Result<Host, AddressError>.Failure {error} => 1
    Result<Host, AddressError>.Success {value} => match move port {
      Result<Port, AddressError>.Failure {error} => 2
      Result<Port, AddressError>.Success {value: admitted} => {
        if Port.value(&admitted) == 443 { return 42 }
        return 3
      }
    }
  }
}
```

## Owned values

`Ipv4Address` and `Ipv6Address` own network-order octets. Their parsers reject legacy libc IPv4
forms, zones, and IPvFuture syntax. `formatInto` writes canonical text into caller-owned storage;
the Display implementations stream that canonical form through the current Writer.

`DomainHost.make` copies at most 253 bytes of prepared ASCII LDH/A-label spelling. It rejects empty
labels, edge hyphens, trailing dots, NUL, non-ASCII bytes, an all-decimal final label, and an
`xn--` label whose payload is not syntactically valid RFC 3492 Punycode. Equality is ASCII
case-insensitive while display preserves the admitted spelling. This is syntax admission for an
already prepared ASCII A-label: Unicode-to-ASCII mapping, normalization, IDNA code-point tables,
contextual and bidirectional rules, and search-suffix expansion are outside this profile.

`Host.parse` classifies bracketed IPv6 and strict IPv4 before admitting a domain. The resulting Host
is the origin identity: resolution never replaces it with a CNAME, reverse lookup, or endpoint.

## Finite requests and results

Create a `ResolveRequest` with an owned Host, checked Port, `Any`/`V4`/`V6` family selection,
`maxResults`, and an optional absolute monotonic Instant. `maxResults` must be from 1 through 64.

`Resolver.resolve` handles numeric hosts without invoking the Resolver provider. When a numeric
request carries a deadline, it samples MonotonicClock exactly once and treats an equal or past mark
as `Timeout`. A successful numeric result contains one endpoint after family filtering.

Domain requests dispatch to the lexically supplied Resolver service. Before publication,
`Resolver.resolve` re-admits every provider endpoint through the requested family selection,
stable exact deduplication, and the caller's capacity. Wrong-family and duplicate candidates do not
consume capacity; the next matching distinct endpoint beyond `maxResults` fails `LimitExceeded`
instead of silently truncating. An empty admitted result fails `NoAddress`. Allocation refusal
remains `OutOfMemoryError`.

A provider that accepts a domain deadline can inspect the owned copy returned by
`ResolveRequest.deadline`. It must compare the deadline before query allocation or registration,
and bracket any parked work so cancellation releases its registration, sole affine `Wake`, and
result owner. A provider that cannot provide that lifecycle must return `DeadlineUnsupported`
before observable work.

## NativeSystemResolver

`silk.native_resolver` is selected only for Darwin ARM64 system libc and GNU Linux x86-64/ARM64 GNU
libc. It is deliberately synchronous.

- Domain plus `Some(deadline)` fails `DeadlineUnsupported` before clock sampling, allocation, query
  construction, or libc work.
- Domain plus `None` makes exactly one blocking `getaddrinfo` call using a root-terminated name,
  decimal service, explicit address family, stream socket, TCP protocol, and numeric-service hint.
- Every successful non-null addrinfo chain has one move-only owner. It is released exactly once
  after success or any later typed failure, including invalid shape, result-limit exhaustion, and
  Silk allocation refusal.

Once `getaddrinfo` begins, the operation has no cancellation or timeout boundary. It can block the
calling host thread, sibling fibers, and timers indefinitely. The 64-endpoint public bound limits
only published results; it does not bound libc allocation, NSS traversal, DNS activity, elapsed
time, scheduler blockage, or process memory. Use a different Resolver provider when DNS itself must
honor a deadline and structured cancellation.

## Errors

Resolution distinguishes invalid request input, unsupported forms, timeout, unsupported deadline,
no admitted address, name lookup failure, temporary failure, unsupported family, system resources,
result-limit exhaustion, malformed native results, and wrapped native failure. `NameNotFound`
describes the libc result and does not claim that a DNS NXDOMAIN packet was observed.

## HTTP integration

The streaming HTTP client owns translation into its public error vocabulary. JUL-23 must catch
`ResolverError.DeadlineUnsupported` at the hostname-resolution dispatch boundary and return
`HttpClientError.UnsupportedDeadline` before starting a hostname connection. Numeric origins keep
the caller's absolute monotonic deadline through resolution and connection setup; the Resolver
actors do not translate, discard, or replace it.
