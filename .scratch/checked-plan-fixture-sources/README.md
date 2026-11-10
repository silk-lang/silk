# Exact accepted test-source extracts

Extracted from V22-derived semantic fixtures. These are snippets for the Semantic
owner; no new cases have been compiled or added to production.

- `finalizer.silk`: demand `finalized`; work once, tidy twice, success/failure order.
- `observer-failure.silk`: demand observing `finalizing`; actual observer helper,
  failure context, caught union and finalizer. Also `inline` and `passing`.
- `observer-adapters.silk`: observing `paired` makes two distinct adapter keys;
  `staged` and `captured` cover stored section/environment; `consumed` is a negative
  callable-admission case and must not be counted as successfully planned.
- `cancel-held-failure.silk`: ordinary `held` can be compared directly. The original
  test uses application Semantic plus execution storage and full build to create
  expanded frames; those remain explicit executable-oracle capabilities. Do not
  claim that comparing ordinary `held` proves frame/cancel expansion parity.
- `package.silk`: demand `package`, then its concrete `adopt` callee application
  as the original test does, to obtain generated Start/Notify helpers. This text
  imports `silk.mem.layout`; add the in-memory module with source
  `pub struct Layout { pub bytes: usize, pub alignment: usize }` from the original
  fixture. No filesystem/stdlib preload is necessary. Generic uninstantiated
  `adopt` alone is not an actual helper-coverage test.

A smaller package source can omit packageLayout and the Layout import, leaving
all remaining accepted definitions unchanged. Record that this is a reduced
variant, not an already executed fixture.
