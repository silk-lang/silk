# Runtime and standard-library boundary

Silk separates language semantics from the ordinary library source and toolchain runtime support
that ship together. Importing a public actor must not grant compiler privilege or silently acquire
an unrelated platform dependency.

This page records the confirmed language, library, provider, and runtime-layer rules.

## Terminology

- The **language core** is Silk syntax and closed semantics that exist without resolving a source
  declaration.
- A **language binding** is a closed name such as a primitive type spelling or `Intrinsic` whose
  identity is defined by the language rather than an imported declaration.
- A **standard-library module** is canonical public `.silk` source distributed by the toolchain and
  compiled under ordinary source rules.
- A **portable module** exposes a contract and implementation whose reachable behavior is defined on
  every target supporting its required language primitives.
- A **target-provider module** is ordinary source that implements a portable service or abstraction
  using target-restricted primitives.
- **Toolchain runtime support** is the target machinery implementing reachable intrinsic and entry
  contracts. Its guaranteed surface is those contracts, not its raw implementation symbols or ABI.
- The **source closure** contains the selected application, runtime, and component modules plus their
  transitive explicit imports.
- The **executable closure** is the concretely specialized code reachable from foreign exports and
  explicitly retained declarations.
- A **toolchain distribution** is one verified set of compiler, canonical library source, target
  support, and toolchain runtime artifacts.

## Layer boundary

### RUNTIME-001 — Language, public source, target providers, and toolchain runtime support are distinct layers

**Status:** Confirmed

Silk programs interact with four layers:

1. The language core defines syntax, built-in type identities, static semantics, ownership, Effect
   execution, traps, foreign ABI boundaries, and the sealed intrinsic catalog.
2. Portable standard-library modules define public values, functions, interfaces, services,
   validation, policy, and safe composition in ordinary Silk source.
3. Target-provider modules are ordinary Silk implementations that explicitly use target-restricted
   intrinsics to satisfy portable contracts.
4. Toolchain runtime support implements reachable intrinsic and machine-entry operations below
   source. The toolchain guarantees the contracts above this layer, not the spelling or ABI of its
   implementation symbols.

```text
program source
    │ imports and calls
    ▼
ordinary portable modules
    │ optionally provided by
    ▼
ordinary target-provider modules
    │ explicitly call
    ▼
sealed Intrinsic contracts ── toolchain target support
```

A toolchain may package all four layers together. Packaging does not collapse their contracts:
standard-library and provider declarations gain no semantic privilege, while raw runtime
implementation symbols do not become guaranteed source API merely because they are present.

**Boundary:** A declaration is not part of the language merely because every distribution ships it,
the compiler uses it for self-hosting, or its source path begins with `silk`. Conversely, a closed
language operation does not become replaceable merely because a standard-library wrapper exposes
it more conveniently.

**Diagnostics:** Errors in public library or provider source use ordinary source diagnostics and
canonical source locations. An unavailable target intrinsic is reported through target
availability before lowering. Missing support required by a matched toolchain is a toolchain-
integrity error, not a source-level missing import or typed failure.

**Current compiler:** Aligned. Canonical standard-library files compile through the ordinary
pipeline, source conditions determine availability, the generated catalog describes exact source
content, and intrinsic support is reachable-only. Portable and provider describe source roles, not
manifest policy categories.

**Evidence:** [bootstrap library source specification](../../../../openspec/specs/bootstrap-silk-stdlib/spec.md),
[unsafe and intrinsic boundary](unsafe-intrinsics-and-targets.md),
[current library manifest](../../../../packages/compiler/stdlib/manifest.json).

## Ordinary public source

### STDLIB-001 — Public standard-library declarations receive no compiler privilege

**Status:** Confirmed

Every public standard-library value, function, type, interface, service, provider, combinator, and
safe wrapper is ordinary Silk source. It uses the same parsing, name resolution, type checking,
ownership, specialization, reachability, diagnostics, and lowering rules as equivalent user source.

Canonical distribution identity lets imports find the source and lets tooling navigate it. It does
not authorize a compiler phase to recognize a declaration by module, name, signature, manifest
entry, or installation path. When ordinary source cannot express a required primitive, the smallest
operation belongs in sealed `Intrinsic` under its explicit safety and target contract.

**Boundary:** The compiler may embed verified source bytes for distribution, cache their ordinary
analysis, or precompile them without changing semantics. Generated embeddings and caches are derived
artifacts; canonical visible `.silk` files remain the editable source of truth.

The first stable model gives `Result` no dedicated language syntax or propagation rule. Automatic
typed-failure propagation remains the existing `run` behavior for Effect execution. Possible
optional-field omission involving `Option` belongs to a future struct-construction decision and is
not inferred by this rule.

**Diagnostics:** A malformed shipped module reports the same source error as equivalent user code,
at its canonical library location. Toolchain verification may additionally classify this as a
broken distribution, but it cannot silently replace the module with a privileged implementation.

**Current compiler:** Aligned. Shipped actors are canonical `.silk` files with a generated catalog,
ordinary source analysis, explicit imports, and source navigation.

**Evidence:** [canonical source requirements](../../../../openspec/specs/bootstrap-silk-stdlib/spec.md),
[standard-library source guide](../../../../packages/compiler/stdlib/README.md),
[minimal compiler privilege](../../../../AGENTS.md#minimal-compiler-privilege).

### STDLIB-002 — Standard-library APIs require explicit imports

**Status:** Confirmed

Only closed language bindings exist without source imports. Standard-library actors—including
`Option`, `Result`, `Effect`, scalar operation actors, `Vector`, `String`, services, and provider
types—enter a module scope only through explicit imports.

```silk
import silk.option { Option }

pub fn main() -> i32 {
  let value = Option.some<i32>(42)
  drop value
  return 0
}
```

The type spellings `i32` and `Effect<A ! E ? R>` remain language syntax. Importing `silk.i32` or
selecting `Effect` from `silk.effect` creates an ordinary value binding containing actor operations;
it does not define or replace the language type.

Canonical standard-library modules occupy the reserved `silk.*` distribution identity. Project
source cannot declare, replace, or shadow that identity. This reservation lets one import resolve
deterministically to the toolchain's canonical source but grants no semantic privilege to the
declarations it contains.

**Boundary:** There is no implicit standard-library prelude, token-based module discovery, or
fallback lookup after an unknown name. An LSP auto-import inserts ordinary source text. Importing an
ordinary project module named `Option` is unrelated to `silk.option`.

**Diagnostics:** Naming an unimported standard-library actor uses the ordinary unknown-name
diagnostic and may include an auto-import action. Declaring a project module under reserved
`silk.*` reports a reserved-module-identity collision naming the project and toolchain origins.

**Current compiler:** Aligned. Canonical module identities are reserved, while module closure and
name resolution introduce standard-library declarations only through explicit imports.

**Evidence:** [PRELUDE-001](modules-names-and-visibility.md#prelude-001--only-language-bindings-are-implicit),
[module implementation evidence](modules-names-and-visibility.md#implementation-evidence),
[standard-library module resolution](../../../../openspec/specs/bootstrap-silk-stdlib/spec.md).

### STDLIB-003 — One canonical catalog defines the shipped library, not the language

**Status:** Confirmed

The official toolchain ships one deterministic, dependency-complete standard-library source
catalog. The catalog is the authoritative answer to whether a standard module exists in that
toolchain release. It records canonical identity, source location and digest, documentation origin,
and any distribution classification required by tooling.

The catalog is a library/distribution contract, not a language vocabulary. Adding, revising, or
removing an ordinary module changes the standard-library API without adding a parser rule, built-in
type, intrinsic, or compiler-known declaration. Each module's own reference defines its public API;
this language page defines only how those modules participate in Silk semantics.

The first stable model has no selectable standard-library profiles. Every installation of one
official toolchain release exposes the same canonical source catalog on every supported target.
Target-specific source may be present on every installation; only reachable target-restricted
operations determine whether one executable is compatible.

The baseline catalog is expected to cover these general-purpose areas needed by real portable
programs and the self-hosted compiler:

- scalar actors, ordering, checked conversion, parsing, and formatting;
- ordinary `Option`, `Result`, and Effect composition;
- layout, allocation, owned indirection, sequences, bytes, text, hashing, maps, and sets;
- portable logging, byte streams, host input, filesystem, and child-process contracts; and
- ordinary provider modules for the targets the distribution supports.

This category list is an admission boundary, not a promise that every conceivable helper belongs in
the bootstrap API. A new module needs a coherent general-purpose actor and evidence from real
programs; compiler-specific helpers, speculative convenience, and unrelated future domains do not
enter merely to make the catalog look complete.

**Boundary:** A compiler implementation may support the Silk language without shipping the official
standard library, but it is not the complete official Silk toolchain distribution. Conversely, a
module shipped by the official distribution is not implicitly loaded, reachable, or emitted into
every program.

**Diagnostics:** Importing a canonical `silk.*` identity absent from the selected toolchain catalog
reports an unknown standard-library module and names the toolchain release. It does not pretend the
name is an unknown project path. A catalog that promises a missing or digest-mismatched file is a
broken-toolchain diagnostic, not an ordinary source error.

**Current compiler:** Aligned. One deterministic generated catalog records canonical source,
digests, documentation, layers, provider targets, and intrinsic inventories without creating source
scope.

**Evidence:** [current deterministic catalog](../../../../packages/compiler/stdlib/manifest.json),
[canonical packaging requirements](../../../../openspec/specs/bootstrap-silk-stdlib/spec.md).

### STDLIB-004 — Portable modules never select a target provider

**Status:** Confirmed

A portable standard-library module may depend on other portable modules, language operations, and
intrinsics available on every target it promises. It must not import, construct, provide, or name a
target-provider implementation.

```silk,ignore
// silk/filesystem
pub service FileSystem {
  effect fn readFile(path: &Path) -> Bytes ! FileError ? &mut FileSystem
}
```

The portable contract owns general values, typed failures, and reusable helpers. A separate module
may implement it for one host:

```silk,ignore
// silk/os_filesystem
import silk.filesystem { FileSystem }

pub struct OsFileSystem { /* ordinary owned provider state */ }
impl FileSystem for OsFileSystem { /* maps ordinary source operations */ }
```

This dependency direction applies equally to logging, standard streams, standard input, host input,
child processes, clocks, randomness, networking, and future platform capabilities. Portable source
defines the honest common contract; target providers adapt it to narrower host primitives.

**Boundary:** A portable module may document that an application commonly uses a particular
provider, but documentation does not add a dependency or default. If no honest common contract
exists, the lower-level capability remains explicitly target-specific rather than weakening the
portable API to expose native details.

**Diagnostics and audit:** A selected façade can import its active platform implementation through
ordinary imports. Neither the manifest nor integrity validation prohibits that source dependency.
Service contracts remain independent where their API promises platform-neutral substitution.
Missing selected declarations receive ordinary resolution diagnostics; inactive imports contribute
no source or executable dependency.

**Current standard library:** Filesystem, standard input, host input, child-process, clock and random
contracts are separate from their selected OS providers. Allocation and standard streams retain
existing process-backed implementations until their assigned operation migrations. No manifest
category is an availability rule. See [selected source tooling](selected-source-tooling.md).

**Evidence:** [portable/provider separation](../../../../openspec/specs/bootstrap-silk-stdlib/spec.md),
[requirements and services](requirements-and-services.md),
[target availability](unsafe-intrinsics-and-targets.md#target-availability).

### STDLIB-005 — Library costs and execution contracts remain explicit

**Status:** Confirmed

Standard-library operations express allocation, typed failure, service requirements, ownership,
mutation, and cleanup through their ordinary Silk signatures. Importing a module performs no runtime
initialization and acquires no allocator, provider, registry entry, thread, global state, or host
resource.

```silk,ignore
import silk.allocator { Allocator, OutOfMemoryError }
import silk.vector { Vector }

effect fn copyValues(values: &[i32]) -> Vector<i32> ! OutOfMemoryError ? &mut Allocator {
  let mut result = Vector.make<i32>()
  // append operations state their allocation contract
  return move result
}
```

Allocation-free construction remains allocation-free. Operations that may grow owned storage state
`! OutOfMemoryError ? &mut Allocator` or another honest contract. Static strings and static bytes need no
hidden heap owner. Service use remains in the requirement row until explicitly provided.

**Boundary:** The compiler may optimize a proven allocation, provider selection, or cleanup without
changing observable behavior. It may not infer an ambient allocator, catch an undeclared failure,
run a module initializer, or inject a singleton merely because the operation belongs to the standard
library.

**Diagnostics:** A call missing an allocator or other service receives the ordinary unresolved-
requirement diagnostic. Ignoring a failure, moving an owner twice, or violating a borrow uses the
ordinary language diagnostic. No “standard library exception” suppresses those errors.

The LSP should automate the mechanical repair while preserving explicit source. From a missing
failure or requirement diagnostic it may offer to propagate the precise residual type into the
enclosing declaration, add required imports, or generate a local recovery or provision scaffold.
Hover and inlay information may show which call introduced each channel. An action previews and
writes an ordinary signature or expression; the compiler does not silently infer a larger public
contract or pretend the source already contains the edit.

**Current standard library:** Aligned for source dependencies. Allocation, services, failures, and
standard-library names remain explicit in source; entry adaptation is defined separately.

**Evidence:** [Effect contracts](effect-contracts.md),
[requirements and services](requirements-and-services.md),
[ownership and cleanup](ownership-and-borrowing.md).

### STDLIB-006 — Cataloged modules use ordinary module visibility

**Status:** Confirmed

Before Silk has a native package and re-export model, every canonical module in the shipped catalog
may be imported explicitly. Its `pub` declarations are visible across modules and its private
declarations are not. There is no second hidden “standard-library internal” visibility level.

Implementation details that must not become callable from user source stay private within their
module. A support module that must expose declarations to several canonical modules is necessarily
an importable low-level module in this first model; documentation may discourage direct use, but the
compiler does not pretend its `pub` declarations are private only to outsiders.

**Boundary:** A future package system may add package-private modules, explicit public exports, or
re-exported facades. That model must apply uniformly to ordinary packages and the standard library.
Until then, a catalog flag cannot silently override the language's confirmed `pub` meaning.

**Diagnostics:** Imports and member access use the ordinary module and visibility diagnostics. The
compiler does not report an “internal standard library API” error for a declaration that is
otherwise public and cataloged. Tooling may show a non-blocking stability or low-level API notice.

**Current standard library:** Aligned. Catalog-wide module resolution preserves ordinary `pub`
visibility, and no catalog namespace becomes visible without an explicit import.

**Evidence:** [ordinary visibility](modules-names-and-visibility.md),
[current source catalog](../../../../packages/compiler/stdlib/manifest.json),
[deferred re-exports](modules-names-and-visibility.md#export-001--imports-do-not-re-export-declarations).

### STDLIB-007 — DEFLATE decoding owns bounded resumable state

**Status:** Confirmed

`silk.inflate` exposes `Decoder`, explicit `Format.Raw`, `Format.Zlib`, and `Format.Gzip`, and
caller-supplied `Limits`. `Decoder.make` requires an allocator and acquires one 32 KiB history
buffer and a bounded table workspace. Its two allocations are released by ordinary drop. `Decoder.step` is pure, allocates nothing,
and retains no input or output borrow.

Each step receives borrowed compressed input, mutable caller-owned output, and a `finalInput`
boolean. Its `Result` reports exact consumed and written counts on both success and failure.
Success returns `NeedInput`, `NeedOutput`, or `Finished`. The caller discards only consumed input
and resubmits the unconsumed suffix after output suspension. Once final input is declared, later
calls must keep the flag true and supply exactly the remaining suffix length and contents.
Missing required bytes at final exhaustion produce `TruncatedInput`.

Raw DEFLATE supports stored, fixed-Huffman, and dynamic-Huffman blocks. Raw and zlib finish at their
first validated stream boundary, leaving trailing input unconsumed. Zlib validates its header,
declared window, and Adler-32; preset dictionaries are rejected. Gzip validates headers, optional
fields and FHCRC, CRC-32, and ISIZE. It decodes concatenated members and waits for final exhaustion
at a validated member boundary before returning `Finished`. A gzip member boundary alone is not
stream completion; trailing non-member bytes fail.

Input, output, member, and header limits are cumulative across calls and gzip members. Header
accounting includes optional fields and FHCRC; raw DEFLATE has no wrapper header charge. Each limit
is checked before accepting the excess byte or member. `maxMemoryBytes` must cover `MEMORY_BOUND`
(65,536 bytes), a conservative bound for decoder storage and bounded scratch. The bound excludes
caller buffers and allocator metadata. A larger allowance does not increase decoder storage.
Memory and initial member limits are checked before history allocation.

`Decoder.reset(self, format, limits) -> Result<(), DecodeError>` starts another independent stream
after completion, failure, or abandonment. It preserves both allocations, requires no allocator,
and has no allocation failure path. Success replaces the format and limits and restores fresh
stream behavior: empty logical history, the selected format's window and checksum state, fresh
cumulative counters with one member started, and no prior parser continuation or final-input
obligation. Within a stream, calls and gzip members retain cumulative accounting.

Reset checks `maxMemoryBytes >= MEMORY_BOUND` and then `maxMembers > 0` before any mutation.
Rejection returns zero-progress `MemoryLimit` or `MemberLimit` and leaves the original decoder
unchanged. The caller can continue that original stream. Reset does not validate, reclaim, or
sanitize prior caller-owned output; output from failed or abandoned streams remains provisional.
Reset does not securely erase decoder storage.

**Boundary:** Output is provisional until `Finished`, because integrity checks follow the payload.
Consumers must discard output after a step failure. Until explicit reset, a failed decoder rejects
steps with zero-progress `InvalidUse`, and a finished decoder returns zero-progress `Finished`. Empty output produces `NeedOutput` when
emission is required. The module neither detects formats nor provides encoders or preset dictionaries.

**Diagnostics:** Typed errors distinguish malformed headers, block and Huffman coding, invalid
distances, unsupported methods and dictionaries, truncation, checksums, member size, invalid use,
and each resource limit. No codec-specific compiler intrinsic or runtime provider is involved.

**Evidence:** [canonical decoder](../../../../packages/compiler/stdlib/silk/inflate.silk),
[shared native acceptance](../../../../packages/compiler/test/support/inflateAcceptance.ts),
[independent fixture provenance](../../../../packages/compiler/test/fixtures/inflate-vectors.md).

### P-256 ephemeral key agreement

`silk.p256 { P256, P256Error }` provides ordinary-source, bounded P-256 arithmetic. Scalars are
opaque owners imported from exactly 32 big-endian bytes in 1..n−1 or generated with explicit
exclusive `Random`. Public keys are 65-byte uncompressed SEC1 points. Agreement validates the
peer, consumes the scalar, and returns a complete fixed 32-byte shared x-coordinate or a typed
error. Deterministic calls allocate nothing and require no host service. See the prescriptive
[P-256 contract](p256-key-agreement.md) for rejection, entropy and assurance boundaries.

### STDLIB-008 — HMAC and HKDF use concrete SHA-2 actors with bounded output

**Status:** Confirmed

`silk.hmac` exposes `HmacSha256` and `HmacSha384`. Each actor provides `make(key)`,
`update(self: &mut Self, bytes)`, consuming `finish(self: Self)`, and one-shot
`authenticate(key, message)`. Keys and message inputs are borrowed byte slices. The tags are fixed
`[u8; 32]` and `[u8; 48]` values respectively. Empty keys, messages, and updates are admitted.
Any segmentation of the same message produces the same tag. Keys longer than the hash block size
(64 or 128 bytes) are hashed before key padding.

`silk.hkdf` exposes `HkdfSha256`, `HkdfSha384`, and `OutputTooLongError`. Both actors implement
RFC 5869: `extract(salt, ikm)` borrows byte slices and returns a fixed-size PRK (32 or 48 bytes).
Empty salt has the same meaning as a salt of HashLen zero bytes. `expand(prk, info, output)` borrows
a fixed-size PRK array, a byte slice of context information, and a mutable caller-owned byte slice.
Empty info and zero-length output are admitted. Expansion returns `Result<(), OutputTooLongError>`.
It accepts at most 8160 bytes for SHA-256 or 12240 bytes for SHA-384, including the exact maximum.
A longer output returns public `requested: usize` and `maximum: usize` fields without changing
any output byte or trapping for the rejected length.

**Boundary:** These are ordinary, allocation-free Silk compositions over SHA-2. They stream
variable-length inputs and use bounded key storage, with no providers, native crypto, or compiler recognition. HMAC inherits the SHA message
bit-length limit, including its initial key pad. These actors do not provide tag verification,
constant-time comparison, truncation policy, TLS labels, password hashing, or secret zeroization.

**Evidence:** [HMAC source](../../../../packages/compiler/stdlib/silk/hmac.silk),
[HKDF source](../../../../packages/compiler/stdlib/silk/hkdf.silk),
[known-answer acceptance corpus](../../../../packages/compiler/test/support/hmacHkdfAcceptance.ts),
[RFC 4231](https://www.rfc-editor.org/rfc/rfc4231.html), and
[RFC 5869](https://www.rfc-editor.org/rfc/rfc5869.html).

### STDLIB-CHACHA20-POLY1305 — Detached authenticated encryption preserves destinations on failure

**Status:** Confirmed

`silk.chacha20_poly1305` exports `ChaCha20Poly1305` and `AeadError`. The ordinary synchronous
operations `seal(key, nonce, aad, plaintext, ciphertext, tag)` and
`open(key, nonce, aad, ciphertext, tag, plaintext)` return `Result<(), AeadError>`. Inputs are
shared byte slices and destinations are exclusive byte slices. Keys contain exactly 32 bytes,
nonces 12 bytes, and detached tags 16 bytes. Empty payloads and AAD are valid. Successful
operations write only the payload prefix and preserve spare destination capacity.

Both operations check key, nonce and tag widths, output capacity, then the payload limit, in
that order. Payloads contain at most 274877906880 bytes, using ChaCha20 counters 1 through
2^32−1; counter zero derives the Poly1305 key. AAD lengths must fit `u64`, as every addressable
Silk slice does. Widened length checks and remaining-length iteration avoid target-size overflow.
Authentication pads AAD and ciphertext separately to 16-byte boundaries and includes both
little-endian 64-bit byte lengths. `open` authenticates the full tag before writing plaintext.
Every rejected operation preserves all destination bytes, including the detached seal tag.
Ordinary borrowing rules reject overlapping input/output and output/tag arguments.

**Boundary:** The implementation allocates no memory and requests no provider or native crypto
operation. Callers own nonce uniqueness and per-key usage limits. Source-level fixed work and
reviewed generated output do not guarantee constant-time execution across future compilers or
runtimes, physical secret erasure, or production security. The module provides no transport,
nonce generation, replay protection, or peer authentication policy.

**Evidence:** [canonical source](../../../../packages/compiler/stdlib/silk/chacha20_poly1305.silk),
[shared acceptance](../../../../packages/compiler/test/support/chacha20Poly1305Acceptance.ts),
[fixture provenance](../../../../packages/compiler/test/fixtures/chacha20-poly1305.md), and
[RFC 8439](https://www.rfc-editor.org/rfc/rfc8439).

### STDLIB-AES-GCM — Detached authenticated encryption preserves destinations on failure

**Status:** Confirmed

`silk.aes_gcm` exports `AesGcm` and `AesGcmError`. `seal(key, nonce, aad, plaintext,
ciphertext, tag)` and `open(key, nonce, aad, ciphertext, tag, plaintext)` return
`Result<(), AesGcmError>`. Inputs are shared byte slices and destinations are exclusive byte
slices. Keys must contain 16 or 32 bytes, nonces 12 bytes, and detached tags exactly 16 bytes.
Empty plaintext, ciphertext and AAD are valid. Destinations may exceed the message length;
the unused suffix remains unchanged.

Both operations validate widths, output capacity and widened GCM length limits before writing.
A message contains at most 2^36−32 bytes and AAD at most 2^61−1 bytes, additionally bounded by
target addressability. `open` authenticates all sixteen tag bytes before producing plaintext.
Any failure preserves every byte of every destination, including its unused suffix.
The error variants distinguish invalid key, nonce and tag lengths, insufficient output,
excess domain lengths, and failed authentication. Ordinary borrow checking forbids aliasing
inputs with exclusive outputs or overlapping ciphertext and tag destinations.

**Boundary:** This ordinary Silk implementation allocates no memory and invokes no provider or
native crypto API. Its algebraic AES S-box and GHASH have fixed secret-processing schedules.
The caller supplies a nonce unique under the key and enforces per-key usage limits.
The module provides no nonce generation, TLS records, replay protection, peer identity,
physical secret-erasure guarantee, or audited constant-time/production-security claim.

**Evidence:** [canonical AES-GCM source](../../../../packages/compiler/stdlib/silk/aes_gcm.silk),
[shared acceptance](../../../../packages/compiler/test/support/aesGcmAcceptance.ts), and
[fixture provenance](../../../../packages/compiler/test/fixtures/aes-gcm/README.md).

### STDLIB-009 — URI syntax preserves its original serialization

**Status:** Confirmed

`silk.uri.Uri` accepts RFC 3986's `URI` production: a scheme is required and a fragment is allowed.
`silk.uri_reference.UriReference` also accepts relative references. Both are lifetime-bound borrowed values.
Parsing stores the input view and validated byte ranges without allocating. Accessors retain the
input lifetime; no view can outlive its storage. `copy` and `parseOwned` explicitly create
`OwnedUri` or `OwnedUriReference`; `fromString` validates and adopts existing owned text without
copying. Owned values expose borrowed views and can transfer their serialization with `intoString`. `format` returns the original text without normalization,
including the case of schemes, hosts, and percent escapes.

Authority, userinfo, host, port, query, and fragment accessors distinguish `None` from `Some("")`.
The path is always present and can be empty. Authority excludes `//`, userinfo excludes `@`, and
port excludes `:`. Bracketed hosts retain their brackets. Userinfo remains one lexical component.
Port accepts zero or more digits with no numeric range limit. Hosts use the RFC first-match rule:
a complete IPv4 match takes precedence over reg-name. IPv6 and IPvFuture require valid brackets
and internal grammar. Zone identifiers are rejected.

Parsing synchronously returns a `Result` with a borrowed value or a `ParseError` containing its
reason, component, and byte offset. Explicit allocating operations use the separate
`OutOfMemoryError` Effect channel and the `Allocator` requirement.

`Uri.resolveInto` replaces caller-owned `Bytes` and compacts the path directly in that buffer.
Sufficient existing capacity requires no allocation. `resolveOwned` reserves one calculated upper
bound and adopts the final storage without copying; dot removal may leave spare capacity. Both follow the strict RFC 3986 section 5.2 algorithm. It removes literal dot segments
only from the selected path; percent-encoded dots remain data. Query and fragment text never take
part in path cleanup. A reference with its own scheme replaces the base, including `http:g`.
The recomposed serialization is validated again. Dot removal can expose `//` in a path without
an original authority: resolving `/a/..//g` against `x:a` gives `x://g` with authority `g`.
Resolving `/a/..//g:h` instead returns an invalid-port failure at byte 6 of the recomposed text.

`silk.uri_percent` encodes raw bytes for userinfo, reg-name, path segment, first relative path
segment, whole path, query, fragment, or unreserved-only data. Encoding escapes percent signs and creates uppercase hex escapes.
The first-relative-segment context also escapes colon, preventing data from becoming a scheme.
Decoding returns bytes, preserves plus signs, and reports malformed escapes at their percent sign.
Call `String.fromUtf8` explicitly to validate decoded bytes as text. Generic query coding does not
implement HTML form fields. `encodeInto` and `decodeInto` reuse caller storage; `encodeToWriter`
streams to a Writer. `decodeInPlace` validates before compacting bytes and leaves malformed input
unchanged. `decodeOrBorrow` borrows unchanged input when it contains no escapes. Owned percent
operations calculate the exact output size and reserve once.

`silk.uri_components.UriComponents` constructs and modifies borrowed components. `ComponentValue`
distinguishes raw bytes from encoded text, preventing accidental double encoding. `Host` separates
registered names from bracketed IP literals; authority retains unsplit userinfo and lexical ports.
Serialization can emit every component, omit authentication, or emit only path and query. Reusable
serialization validates and sizes components before replacing output, and owned construction adopts
its completed buffer. Raw colons in the first relative path segment are escaped.

The general `silk.slice.Slice.view` operation creates a lifetime-preserving borrowed subslice.
It checks offset and length without overflowing, permits an empty view at the end, and traps on
out-of-bounds requests. URI code uses this ordinary wrapper over `Intrinsic.sliceView`; the compiler
has no URI-specific operations.

**Boundary:** URI syntax does not establish that an HTTP endpoint is usable or trusted. Scheme
policy, DNS lookup, TLS service identity, IDNA, WHATWG URL, IRI normalization, file semantics,
username/password interpretation, service lookup, and canonicalization are separate concerns.

**Evidence:** [RFC 3986](https://www.rfc-editor.org/rfc/rfc3986.html),
[URI source](../../../../packages/compiler/stdlib/silk/uri.silk),
[reference source](../../../../packages/compiler/stdlib/silk/uri_reference.silk),
[percent coding](../../../../packages/compiler/stdlib/silk/uri_percent.silk),
[component construction](../../../../packages/compiler/stdlib/silk/uri_components.silk).

### STDLIB-010 — HTTP/1.x values preserve bytes, order, and ownership

**Status:** Confirmed

The public HTTP value surface is split into three actors. `silk.http` owns HTTP/1.0 and HTTP/1.1
versions, open case-sensitive method tokens, status codes from 100 through 599, validated fields,
and request/response heads. `silk.http_headers` owns ordered borrowed and owned collections,
lookups, metadata iteration, and field-line formatting. `silk.http_target` owns origin, absolute,
authority, and asterisk request-target forms, HTTP authority validation, URI conversion, and Host
selection. All are ordinary target-neutral Silk declarations; there is no HTTP intrinsic or
target-provider requirement.

Borrowed values retain the caller's exact method spelling, field-name case, raw field-value octets,
target serialization, and optional reason bytes. Field values may be empty and may contain HTAB or
obs-text, but reject CR, LF, NUL, DEL, other controls, and leading or trailing OWS. Header lookup is
ASCII case-insensitive, preserves insertion order, and never concatenates duplicates; this keeps
fields such as Set-Cookie distinct. Formatting writes only `name: value\r\n` field lines. It sizes
the complete result before mutation and leaves an insufficient caller buffer unchanged.

Every constructor accepts explicit finite limits for the dimensions it can consume. Collection and
owned-copy limits distinguish method, target, name, value, field-count, aggregate field-byte, and
owned-storage budgets. Checked addition reports representation overflow separately. Owned headers
and heads copy bytes plus offsets into affine storage; their views and iterators borrow that owner,
so neither can escape it. Semantic validation and sizing complete before the first allocation, and
allocation failure remains the standard `OutOfMemoryError` Effect channel.

Raw request-target parsing rejects fragments. URI conversion supports origin- and absolute-form,
omits a URI fragment, emits `/` for an empty origin path, and retains a present empty query.
Authorities reject userinfo; CONNECT requires a nonempty host and a numeric port from 1 through
65535, while `*` is exclusive to OPTIONS. HTTP/1.1 requires exactly one valid Host field for every
request. An authority carried by absolute- or authority-form takes precedence over a different but
valid Host value.

Connection, Content-Encoding, and Transfer-Encoding metadata are exposed as lazy ordered token
views with source field and byte offsets on failure. Unknown valid tokens remain values. These
views deliberately do not decide message framing, content-length precedence, decoder selection,
connection reuse, or transport behavior.

**Boundary:** This layer does not parse a wire head, serialize a start line or complete head, frame
a body, decode content, manage trailers or connections, resolve DNS/IDNA, impose HTTP(S) network
scheme policy, or implement a client, server, or proxy exchange. Those behaviors remain with the
dependent HTTP issues rather than accruing hidden policy here.

**Evidence:** [HTTP values](../../../../packages/compiler/stdlib/silk/http.silk),
[ordered headers](../../../../packages/compiler/stdlib/silk/http_headers.silk),
[request targets](../../../../packages/compiler/stdlib/silk/http_target.silk),
[shared acceptance](../../../../packages/compiler/test/support/httpValuesAcceptance.ts), and
[pinned Zig comparison fixture](../../../../packages/compiler/test/fixtures/http-values/comparison.json).

## Target providers and entry closure

### PROVIDER-001 — Target providers are ordinary explicit modules

**Status:** Confirmed

A target provider is an ordinary source module whose operations implement one or more portable
services through sealed target-restricted intrinsics. It follows ordinary imports, visibility,
conformance, ownership, Effect, unsafe, specialization, and cleanup rules.

Ordinary module static selection determines which provider declarations exist for the profile.
The seven maintained native providers expose no native declarations on LLVM-to-Wasm. An empty
module import is harmless, while a selected member import of an unavailable actor diagnoses.
Generic intrinsic restrictions still apply to executable calls independently of provider spelling.

```silk,ignore
import silk.os_filesystem

pub fn main() -> i32 {
  // This module can have an empty selected surface; no unavailable actor is imported.
  return 0
}
```

An executable that never reaches a provider operation pays no target/runtime cost. An executable
that reaches an unsupported OS intrinsic receives the ordinary intrinsic target-availability error.

**Boundary:** A provider cannot extend an intrinsic's target set, install a runtime fallback, or
claim portability through a source annotation. A pure in-source provider may satisfy the same
portable service on every target without using any target intrinsic.

**Diagnostics:** Source errors use ordinary diagnostics. A reachable unsupported primitive names
the intrinsic and target, not merely the provider module. Tooling may show the provider's inferred
target compatibility without rejecting an unreachable import.

**Current compiler:** Largely aligned through separate OS modules and reachable intrinsic
availability. Provider-module target summaries remain a tooling derivation rather than a stable
source feature.

**Evidence:** [TARGET-001](unsafe-intrinsics-and-targets.md#target-001--intrinsic-availability-is-checked-only-for-the-selected-executable-closure),
[canonical provider modules](../../../../openspec/specs/bootstrap-silk-stdlib/spec.md),
[current OS provider source](../../../../packages/compiler/stdlib/silk/os_filesystem.silk).

### PROVIDER-002 — Entry points receive no implicit service providers

**Status:** Confirmed

Source composition supplies an application's requirements. The installed hosted startup explicitly
provides mutable HostInput from an owned process snapshot. It supplies no logger, filesystem, clock,
standard stream, or other application service. The standalone WebAssembly startup requires a closed
application Effect. A custom source runtime may provide services under its own visible contract.

```silk,ignore
import silk.effect { Effect }
import silk.logger { LogError, LogLevel, Logger }
import silk.os_logger { StdoutLogger }

effect fn program() -> () ! LogError ? &mut Logger {
  return run Logger.log(LogLevel.Info, "ready", &())
}

pub effect fn main() ! LogError {
  let mut logger = StdoutLogger.make()
  return run Effect.provideMut<Logger>(program(), &mut logger)
}
```

The example's exact provider construction remains library API; the semantic point is that source
selects and provides it before the entry closes.

**Boundary:** Shipping an implementation does not install it. A selected source runtime constructs
and scopes any providers it supplies, and ordinary lexical provision can replace a provider. An
ordinary required service does not become optional when a provider is absent.

**Diagnostics:** A remaining requirement that the selected runtime cannot supply fails its ordinary
source interface or execution-boundary obligation before backend emission. A runtime-none artifact
has no application invocation and does not impose a separate compiler entry requirement row.

**Current compiler:** Startup is ordinary selected source. Its HostInput snapshot and source provider
have explicit ownership and cleanup; there is no private generated host-input state.

**Evidence:** [ENTRY-004](program-entry.md#entry-004--source-composition-resolves-application-requirements),
[service provision](requirements-and-services.md),
[host-input explicit-provider requirement](../../../../openspec/specs/bootstrap-host-input/spec.md).

## Runtime support and pay-for-use

### RUNTIME-002 — Source closure and executable closure control separate costs

**Status:** Confirmed

Explicit imports determine the dependency-complete source closure that must parse and type-check.
Concrete specialization and artifact-root reachability determine the executable closure that may emit code,
static data, host imports, adapters, and toolchain runtime support.

Importing an unused module therefore has source-analysis cost but no runtime behavior. An unreachable
function, constant, provider, or intrinsic contributes no executable support solely because its
module was loaded.

```silk,ignore
import silk.os_child_process { OsChildProcess }

pub fn main() -> i32 {
  return 0
}
```

A WebAssembly build remains valid and contains no process import or support when no provider
operation enters the executable closure.

**Boundary:** Runtime control flow is executable behavior. A target-specific call in a branch whose
condition is runtime data remains reachable and requires target support. Compile-time specialization
may remove a declaration only under the ordinary reachability rules; an optimizer cannot redefine
source compatibility after the fact.

**Diagnostics and audit:** Unreachable support produces no programmer diagnostic. Artifact
verification rejects unrelated host imports, runtime symbols, static tables, or adapters not
justified by the retained executable inventory.

**Current compiler:** Aligned for intrinsic operations. Source analysis follows explicit import
closure, while executable support follows reachable specialized operations.

**Evidence:** [TARGET-002](unsafe-intrinsics-and-targets.md#target-002--unreachable-target-specific-primitives-have-no-artifact-cost),
[explicit module closure](modules-names-and-visibility.md#module-004--compilation-loads-only-the-transitively-reachable-module-closure),
[current intrinsic availability](../../../../packages/compiler/src/IntrinsicAvailability.ts).

### RUNTIME-003 — Toolchain runtime support guarantees contracts, not implementation ABI

**Status:** Confirmed

Each execution target implements the selected foreign ABI and every reachable intrinsic contract
through target instructions, compiler-emitted helpers, or a linked support object.
Those contracts are the supported boundary. The raw symbols, calling conventions, layouts, and
helper structure beneath them may be compiler-versioned and may change whenever lowering, intrinsic
contracts, or target support changes.

Silk does not treat those implementation details as forbidden knowledge or permanently inaccessible
machinery. `extern "C"` ([FFI-001](unsafe-intrinsics-and-targets.md#ffi-001--extern-c-declares-a-native-symbol-under-an-explicit-abi))
is that explicit linking facility: a developer may deliberately name a target symbol that the
selected toolchain happens to expose. Doing so is unsafe, target-specific, toolchain-version-specific,
and outside the compatibility guarantee: the developer must satisfy the real ABI and accept that
another build may rename, replace, inline, or omit it.

The runtime must implement the canonical observable contract exactly. It cannot add hidden
recoverable failures, retain a Silk borrow beyond its declared lifetime, invoke arbitrary source
callbacks, change cleanup ownership, or reinterpret low-level outcomes as public domain values.

**Boundary:** Unsupported does not mean prohibited. The official compiler need not hide raw symbols,
and future low-level interop should be capable of reaching arbitrary target facilities. A stable
embedding API, portable FFI declaration, independently replaceable runtime, or guaranteed dynamic-
linking contract would create a new compatibility boundary and requires its own proposal. The
official compiler invoking one matched helper does not make that helper stable.

**Diagnostics:** A missing or incompatible support symbol the compiler itself requires from its
matched distribution is a toolchain-integrity error before execution. A developer's future explicit
unsupported linkage instead follows that low-level facility's own link and ABI diagnostics; the
toolchain does not imply compatibility merely because a symbol existed in another release.

**Current compiler:** Aligned in direction. Native and WebAssembly support are emitted through LLVM
and are not presented as a user-facing runtime library.

**Evidence:** [sealed intrinsic contracts](unsafe-intrinsics-and-targets.md#sealed-intrinsic-boundary),
[current native toolchain composition](../../../../packages/compiler/src/ToolchainPlan.ts).

### RUNTIME-004 — Silk has no ambient runtime facilities

**Status:** Confirmed

The language runtime does not imply a garbage collector, scheduler, thread pool, async executor,
reflection registry, dependency container, global allocator, random source, clock, filesystem,
environment, current directory, console, or logger.

Language-owned behavior is limited to the selected program's ordinary execution semantics: values,
calls, ownership and cleanup, Effect construction and execution, typed failure, fatal traps, and the
foreign ABI boundary. A program gains additional facilities through its selected source runtime
and by importing ordinary APIs and constructing or providing their implementations.

`Effect.suspend` transfers one deferred child through the explicit stack-safe execution boundary.
It does not park an unfinished execution or schedule another one. The sealed Execution and
ExecutionRef identities provide a separate narrow seam for independently owned activation and
external parking.
The ordinary `silk.execution` module exposes safe construction, drive, and park operations.
Schedulers, executors, queues, timers, deferred values, and cancellation policies remain ordinary
source. Programs that cannot reach these sealed operations acquire no scheduler or fiber cost.

A source function such as the following needs no heap provider itself. Its artifact costs also
include the selected source startup; the default executable runtime explicitly owns an Execution.
A retained function in a runtime-none object acquires no startup machinery:

```silk
pub fn main() -> i32 {
  return 42
}
```

**Boundary:** Compiler-planned storage for a value or callable representation is part of target
lowering, not evidence of an ambient public allocator. Source startup receives the foreign process
inputs and constructs an owned snapshot for its provider. Execution storage is an explicit selected
source component; it has no process-global allocation policy. External parking specifies Wake ownership, dormant cleanup,
and target behavior. It does not select an executor. None of these contracts is inferred from
`Effect.suspend`.

**Diagnostics:** Using an unavailable language feature receives its language diagnostic; using an
unprovided service receives a requirement diagnostic. The compiler must not silently initialize a
runtime facility to make either program succeed.

**Current compiler:** Artifact-root and intrinsic reachability retain the selected source facilities.
Runtime-none artifacts omit startup and its dependencies. Default hosted and standalone startup
include their documented Execution owner; neither installs a scheduler or event loop.

**Evidence:** [explicit requirements](requirements-and-services.md),
[Effect suspension](effect-suspension.md),
[entry requirement closure](program-entry.md#entry-004--source-composition-resolves-application-requirements),
[runtime-tier pressure tests](../../../../packages/compiler/test/LocalSharedPressure.test.ts),
[intrinsic availability tests](../../../../packages/compiler/test/IntrinsicAvailability.test.ts).

### RUNTIME-005 — Source compositions own application startup and termination

**Status:** Confirmed

The build selects a source runtime independently of the loader entry symbol. The runtime imports
`Intrinsic.application`, calls its visible application function, and defines the platform entry
through an ordinary C export. The compiler discovers C exports and explicit retained declarations;
it does not discover a specially shaped application `main` or generate an invocation adapter.

The distribution's hosted `silk/native_start` composition exports C `main(argc, argv)`. It snapshots
process inputs, installs bounded diagnostics, owns one Execution, and calls the application.
Its source interfaces adapt an ordinary `i32`, unit, or an Effect producing unit with no requirements
or one mutable HostInput requirement. Integer results become exit status; unit and Effect success
become zero. An unhandled typed failure drops its owned payload before reporting and returns one,
including when allocation or stderr output fails. Fatal traps remain abnormal termination without
cleanup guarantees. A NonParking constraint rejects application bodies needing an external scheduler.

The standalone WebAssembly composition `silk/wasm_start` exports `main() -> i32`. It owns one
Execution and adapts integer, unit, and requirement-free Effect results. It provides no host inputs
or native reporter. Typed failures drop their payload and return one; machine traps remain bare.

Custom source compositions define their own application calls, services, scheduling, reporting,
and status policy. Explicit libraries, objects, and runtime-none profiles acquire neither default
startup nor default execution storage. Source runtimes that need storage select its component
explicitly through build composition.

**Diagnostics:** Ordinary import, visibility, call, interface-conformance, requirement, and executable
property checks validate runtime source. Missing distribution source is a toolchain integrity error.
No special compiler entry-shape diagnostic or generated status/report protocol remains.

**Evidence:** [artifact roots](artifact-roots-and-requirements.md),
[hosted startup conformance](../../../../packages/compiler/conformance/hosted-start/README.md),
[typed-failure cleanup](typed-failures.md#fail-006--typed-failure-applies-ordinary-cleanup-and-preserves-diagnostic-context).

## Distribution compatibility and diagnostics

### DIST-001 — Compiler, canonical source, and required runtime support form one matched toolchain

**Status:** Confirmed

Before a native package and dependency system exists, the official compiler, canonical
standard-library source catalog, intrinsic catalog, target support, and required runtime-support artifacts
are one versioned toolchain distribution. Components the official compiler requires are built and
verified together and are not
independently selected, upgraded, overridden, or compatibility-negotiated by a Silk program.

The canonical catalog records enough content identity for reproducible source resolution. The
intrinsic/runtime inventory records enough identity for the compiler to reject a damaged or mixed
installation before source behavior depends on it.

**Boundary:** Lockstep distribution does not make the standard library part of the language or
promise source compatibility between pre-1.0 releases. It is an operational integrity rule. A
future package model may allow an independently versioned public library while required toolchain
support remains matched to the compiler.

**Diagnostics:** Mixed component versions, missing catalog files, digest mismatches, and absent
required runtime artifacts report one deterministic broken-toolchain diagnostic naming the expected
and observed component identities. The compiler does not continue with fallback copies, an older
runtime, or a user module shadowing the missing standard source.

**Current toolchain:** Aligned. [`ToolchainIntegrity`](../../../../packages/compiler/src/ToolchainIntegrity.ts)
publishes one normalized `silk-toolchain-v1` graph covering the compiler, catalog, exact source
bytes, sealed intrinsic inventory, target providers, and per-target runtime support. Its SHA-256
identities exclude absolute paths, timestamps, directory enumeration order, and other checkout
state. The driver validates the compiler/catalog/source/intrinsic set before project resolution,
then validates only providers and runtime support reached by the prepared program before emission.
Compiled artifacts retain the graph identity, and language-tooling inventories expose the same
graph and validation result.

**Evidence:** [standard-library manifest](../../../../packages/compiler/stdlib/manifest.json),
[intrinsic inventory](../../../../packages/compiler/test/fixtures/intrinsic-inventory.json).

### DIST-002 — Missing source, unsupported targets, open entries, and broken toolchains are distinct

**Status:** Confirmed

The toolchain classifies failures at the boundary that owns them:

| Condition                                                                             | Classification                                                                       |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| An import names no project or canonical library module                                | source-resolution error                                                              |
| A canonical module exists but its source is invalid                                   | ordinary source diagnostic at the library location, plus broken-distribution context |
| A reachable intrinsic does not support the selected target                            | compile-time target-compatibility error                                              |
| The application retains an unsupported service requirement                            | ordinary source conformance or execution-boundary diagnostic                         |
| A matched runtime-support artifact required by the compiler is absent or incompatible | broken-toolchain error                                                               |
| A supported host operation fails while executing                                      | the operation's declared value, typed failure, or fatal-trap outcome                 |

These classes do not substitute for one another. In particular, target absence is not a typed
failure, a missing provider is not a runtime linker error, and a damaged distribution is not an
unknown user module.

**Boundary:** One source problem may prevent later checks whose prerequisites do not exist. The
compiler suppresses derivative backend or runtime noise rather than reporting every downstream
consequence.

**Diagnostics:** Each error names the responsible module, operation, requirement, target, or
component and points to the earliest actionable source location when one exists. Stable wording and
codes belong to the diagnostic catalog; this table fixes their semantic classification.

**Current compiler:** Aligned at the bootstrap driver boundary. A malformed, unreadable, or
mismatched distribution produces the structured `ToolchainFailed` outcome; unsupported reachable
intrinsics produce `TargetFailed`; missing project imports remain `SourceResolutionFailed`; invalid application calls are ordinary source diagnostics and remain `Rejected`; backend construction and
external tool execution retain their own outcomes. The CLI renders these classes separately and
does not reinterpret a broken installation as a source or backend error.

**Evidence:** [module diagnostics](modules-names-and-visibility.md),
[entry diagnostics](program-entry.md),
[target diagnostics](unsafe-intrinsics-and-targets.md#target-availability),
[CLI reporting](../../../../packages/cli/src/Report.ts).

### TOOLING-001 — Tooling presents library source and derived availability honestly

**Status:** Confirmed

Go-to-definition, hover, completion, signature help, references, documentation, and diagnostics use
the canonical `.silk` declaration for every standard-library and provider API. Generated manifests,
embedded bytes, caches, native shims, and TypeScript compiler code are never shown as the public API
definition when canonical source exists.

Completion discovers public declarations and modules in the selected canonical catalog even when
they are not yet imported. Each candidate identifies its defining module; accepting it inserts the
required explicit import, preserves the preferred module-qualified style, and offers or applies an
alias when the local name would collide. Completion must not make an unavailable declaration appear
in scope without the corresponding visible source edit.

Hover may summarize a provider's derived target compatibility and an operation's allocation,
failure, requirement, ownership, and unsafe contracts. Derived target information is advisory until
the operation becomes reachable in a selected executable.

For an incomplete Effect contract, tooling may offer competing explicit repairs: propagate the
residual failure or requirement into the enclosing signature, insert or scaffold a matching
recovery/provision operation, and add the corresponding imports. The action must use the precise
ordinary types calculated at the failing expression and must show the source edit before applying
it; it never creates an invisible inferred contract.

The generated standard-library reference lists the modules and public declarations actually present
in the selected toolchain catalog. This is the user-facing answer to whether a library facility is
implemented in that release; absent documentation cannot be replaced by an AI-invented API.

**Boundary:** Auto-import completion writes an ordinary import; it is automation, not an implicit
prelude or alternate name-resolution path. Tooling suggestions do not add hidden imports, providers,
target fallbacks, or semantic privilege. A copied equivalent declaration navigates to the copy and
behaves ordinarily rather than redirecting to a canonical actor because its spelling matches.

**Diagnostics:** When source belongs to a damaged toolchain, tooling reports the integrity problem
and may still open the available canonical file. It must not synthesize declarations that let
analysis continue as though the catalog were complete.

**Current tooling:** Aligned for this boundary. Canonical source documentation and navigation exist;
catalog completion materializes explicit collision-aware imports, and Effect repairs write visible
source edits.

**Evidence:** [standard-library documentation guide](../../../../packages/compiler/stdlib/DOCUMENTATION.md),
[editor intelligence tests](../../../../packages/compiler/test/EditorIntelligence.test.ts),
[canonical source requirements](../../../../openspec/specs/bootstrap-silk-stdlib/spec.md).

## Zstandard decoding

`silk.zstd { Zstd }` provides bounded RFC 8878 decoding in ordinary Silk source. It accepts all
non-dictionary compressed-block modes, raw and RLE blocks, concatenated frames, and skippable
frames. Nonzero dictionary IDs fail explicitly. The decoder validates frame content sizes and
the low 32 bits of seed-zero XXH64 whenever a frame carries a checksum.

`Zstd.make` owns exact history and workspace allocations through the ordinary `Allocator` service.
Dropping the decoder releases them. `Zstd.step` allocates nothing, borrows input and output for
only that call, and returns exact consumed and written counts. The caller retains the unconsumed
input suffix and reads only the written output prefix.

`NeedInput` means the supplied input is exhausted. `NeedOutput` means pending decoded bytes need
more destination space; retry with a nonempty output slice. The first call with final input fixes
the absolute input end. Subsequent calls must provide the complete remaining suffix with final
input still set. `Finished` means that this end follows complete frame and trailer validation;
an ordinary frame boundary alone does not finish a concatenated stream. Empty final input with
no frame is truncated input. Empty final calls after `Finished` are idempotent; additional input
is an invalid-state failure.

Errors carry a typed reason, input position, and exact progress made before the failure. Failure
is sticky: subsequent calls report the original reason and position with zero progress. Output
remains provisional until `Finished`, because a later checksum or truncation error can invalidate
bytes already returned to the caller.

`ZstdLimits.make` defaults to 64 MiB consumed input, 256 MiB decoded output, 1024 total frames,
8 MiB skipped payload, an 8 MiB maximum window, and 1 MiB non-window workspace. Input, output,
frame, and skipped-byte counters apply cumulatively across all concatenated frames. The window
and workspace limits bound live storage, independently of stream length. Workspace includes three
128 KiB staging buffers, decoder state, and a conservative fixed allowance for entropy tables and
transient scratch. The constructor checks these limits before allocating. A frame advertising a
window above the configured capacity fails before its blocks are decoded. Larger configured
windows are permitted within representable storage limits.

The cataloged `silk/support/zstd_block` and `silk/support/zstd_checksum` modules expose low-level
support actors under ordinary visibility rules. Applications should use `Zstd` for frame
validation, limits, and terminal semantics.

**Evidence:** [Zstandard format](https://www.rfc-editor.org/rfc/rfc8878.html),
[HTTP window sizing](https://www.rfc-editor.org/rfc/rfc9659.html),
[canonical source](../../../../packages/compiler/stdlib/silk/zstd.silk).

## Certificate decoding

`silk.certificate { Certificate, DecodeLimits }` decodes one DER certificate with `decodeDer`
or one strict PEM certificate with `decodePem`. `silk.certificate_bundle { CertificateBundle }`
decodes one or more PEM certificates atomically. These are ordinary Silk actors with an explicit
`Allocator` requirement. Inputs are borrowed for the Effect's lifetime; successful outputs own
independent DER storage. Views borrow that storage and cannot outlive their certificate or bundle.

The decoder preserves the original signed TBSCertificate encoding, names, serial, validity, complete
SPKI, both signature AlgorithmIdentifiers and their parameters, signature bits and unused-bit count,
unique identifiers, and every extension's OID, critical bit and raw value. Unknown algorithms,
unknown critical extensions, duplicate extensions and duplicate bundle entries are retained.
Certificate versions 1, 2 and 3 are accepted when their fields obey the selected schema.

DER parsing checks canonical tag and length encoding, primitive values, default omission, RDN SET
ordering, and calendar-valid UTC times. Unknown extension values, public-key bits and signature bits
remain opaque. Algorithm parameters and name attribute values receive bounded ASN.1 framing checks;
the decoder does not infer their algorithm-specific schemas.

PEM accepts only matching `CERTIFICATE` markers, canonical base64 and SP, HT, CR and LF whitespace.
LF, CRLF and CR newlines may be mixed. Explanatory text, unrelated labels, headers, noncanonical
padding, mismatched markers and trailing data after a single certificate fail. A malformed later
bundle block releases earlier results; no partial bundle escapes.

`DecodeLimits.defaults()` permits 16 MiB of input, 1 MiB per certificate, 8 MiB of total decoded DER,
1024 certificates, 256 KiB per field, 256 extensions per certificate, depth 32 and 65,536 ASN.1 nodes
per certificate. Limits are inclusive and zero means zero. Errors distinguish `Malformed`,
`Unsupported` and `ResourceLimit`, with a reason, certificate index and input or decoded-DER offset.
Allocator refusal uses the separate `OutOfMemoryError` Effect channel.

Decoding does not verify signatures, establish trust, build or validate paths, match service
identities, or acquire roots. A successful parse is not a certificate-validity decision. Generic
public ASN.1 tooling is outside this API.

**Evidence:** [certificate actor](../../../../packages/compiler/stdlib/silk/certificate.silk),
[bundle actor](../../../../packages/compiler/stdlib/silk/certificate_bundle.silk),
[decoding contract and fixture provenance](../../../../openspec/changes/archive/2026-09-12-specify-bounded-certificate-decoding/design.md).

## Certificate semantic profiles and trust anchors

`silk.certificate_profile { CertificateProfile, CertificateRole, ProfileLimits }` applies the
restricted TLS-server certificate profile to a borrowed decoded `Certificate`. Inspection admits
P-256 or bounded RSA keys, supported SHA-256 certificate signature metadata, strict extension DER,
and role-specific BasicConstraints, KeyUsage, ExtendedKeyUsage, SAN, and NameConstraints policy.
It retains borrowed access to the original certificate and exact SAN/NameConstraints values. It
allocates nothing and reports owned `Malformed`, `Unsupported`, or `ResourceLimit` errors with
stable semantic reasons and certificate-DER offsets. `SignatureAlgorithm` identifies an unknown
signature OID or invalid signature-bit metadata, `SignatureParameters` identifies parameters that
are invalid for a recognized algorithm, and `SignatureAlgorithmMismatch` identifies two admitted
but differing inner and outer algorithms. `EmptySubject` identifies the structural requirement for
a nonempty critical SAN; malformed SAN content remains `SubjectAltName`, while `Role` remains CA
and BasicConstraints policy.

`CertificateProfile.verifyIssuedBy` checks exact issuer-name DER equality and verifies the
subject's original retained TBSCertificate bytes with the issuer's admitted key. It checks one
edge only. Successful inspection or signature verification does not check dates, authority, a
complete path, accumulated constraints, HTTPS identity, revocation, or transparency.

`silk.trust_anchor { TrustAnchor }` owns an explicitly authoritative certificate. The simple
constructor is an infallible ownership move and deliberately preserves unsupported roots. The
constrained constructor can add an independent maximum-intermediate count and strict DNS/IP
NameConstraints DER; these additions never replace embedded certificate restrictions. Cloning
creates an independent certificate and constraint owner through an explicit allocator. Identical
certificate bytes with different configured restrictions remain distinct trust candidates.

Constructing a `TrustAnchor` is a trust decision, not certificate validation. Native PEM loading
and trust-source replacement are separate APIs, and loading native certificate bytes does not
claim equivalence with an operating system's trust policy.

**Evidence:** [profile actor](../../../../packages/compiler/stdlib/silk/certificate_profile.silk),
[trust-anchor actor](../../../../packages/compiler/stdlib/silk/trust_anchor.silk),
[implementation contract](../../../../openspec/changes/archive/2026-09-12-implement-certificate-profiles-trust-anchors/specs/certificate-profiles-trust-anchors/spec.md),
[pinned x509-limbo fixtures](../../../../packages/compiler/test/fixtures/certificate-profile-limbo.json).
Profile comparisons also preserve the fixed Zig HTTP snapshot
`1bc892110da738d6137b3f0b7e8e3a586ce09928`; it is provenance, not a full-path or trust-policy
oracle.

## Bounded certificate-path validation

`silk.certificate_path { CertificatePath, ValidationLimits, ValidatedPath, ValidationError }`
builds a deterministic TLS-server certificate path from one borrowed leaf, caller-ordered peer
intermediates, and explicit caller-ordered `TrustAnchor` values. Search is iterative depth-first:
at each depth it considers anchors first and then intermediates. The first fully valid path wins,
and the returned value retains the original leaf plus original intermediate and anchor indices
rather than copying certificate material.

Every input and unit of search work has an inclusive finite bound. Candidate visits are charged
before name comparison, signature checks before primitive verification, complete paths before
root-to-leaf policy, and DNS/IP comparisons before each same-form subtree comparison. These
counters span backtracking. Exhausting a work bound is terminal, while an ordinary invalid
signature, unsupported candidate, date failure, path-length failure, or name-constraint failure
leaves later alternatives eligible.

Profile diagnostics remain distinguishable across the path boundary. Forbidden parameters on a
recognized signature algorithm report `UnsupportedParameters`; unknown signature algorithms
report `UnsupportedAlgorithm`. An empty subject without a nonempty critical SAN reports
`InvalidName`. Each mapping preserves leaf/intermediate/anchor location, original candidate index,
extension index when present, and the profile byte offset.

The validator applies the restricted certificate profile, exact issuer/subject DER linkage,
original-TBSCertificate signatures, one explicit validation `Instant`, cumulative DNS/IP
NameConstraints, and path-length restrictions. Identical anchor certificate bytes remain separate
candidates because configured restrictions may differ. Anchor authority is always explicit; peer
certificates are never promoted into anchors, and no AIA, revocation, CT, operating-system policy,
time, network, or entropy source is consulted.

A successful `ValidatedPath` is only certificate-path assurance under this documented restricted
profile. A TLS client must still verify the HTTPS service identity and the TLS CertificateVerify
and Finished messages before accepting application data. `revocationStatus()` is therefore
`NotChecked`; success is not a claim of complete RFC 5280, browser Web PKI, production security,
revocation, or transparency equivalence.

**Evidence:** [path actor](../../../../packages/compiler/stdlib/silk/certificate_path.silk),
[implementation contract](../../../../openspec/changes/archive/2026-09-12-implement-bounded-certificate-path-validation/specs/bounded-certificate-path-validation/spec.md),
[fixture provenance](../../../../packages/compiler/test/fixtures/certificate-path-limbo.json), and
[offline importer](../../../../packages/compiler/scripts/import-certificate-path-fixtures.mjs).

## Owned trust snapshots and replaceable trust sources

`silk.trust_snapshot { TrustSnapshot, SnapshotLimits, TrustLoadLimits, TrustSourceError }`
represents one opaque, immutable owner of an ordered sequence of explicit `TrustAnchor` values.
`fromAnchors` consumes an existing vector without allocation after checking its complete count and
aggregate retained byte size. Empty explicit trust is valid and authenticates no peer. `fromPem`
strictly decodes one or more certificates, transfers their owners into unconstrained anchors, and
rejects empty or whitespace-only input. Both constructors preserve every input position and
duplicate; anchors with identical certificate DER but different configured restrictions remain
distinct candidates.

`SnapshotLimits.defaults()` permits 1024 anchors and 8 MiB of aggregate certificate and configured
constraint bytes. `TrustLoadLimits.defaults()` combines that finite snapshot budget with the finite
certificate decoder defaults. Every limit is inclusive and zero means zero. Count and byte totals
are checked before snapshot allocation or growth. Semantic failures distinguish structured decoder
errors and `AnchorCount`, `EncodedBytes`, or provider-input limits. Allocation refusal stays in the
separate `OutOfMemoryError` channel.

`TrustSnapshot.copy` creates an independently owned snapshot. `TrustSnapshot.combine` copies the
primary anchors followed by the additional anchors without deduplication or restriction merging.
Dropping either source cannot invalidate the new owner. A less-restricted additional anchor can
therefore widen authority and must be an application policy decision.

`silk.trust_source.TrustSource` is the portable lexical service for loading one independent bounded
snapshot. `silk.memory_trust_source.MemoryTrustSource` owns an explicit current snapshot, copies it
on each load, and atomically exchanges it with `replace`, returning the complete old owner without
allocation. Replacement affects only later loads: prior results survive replacement and provider
drop. The memory provider performs no I/O, environment lookup, refresh, caching, or global
selection.

These APIs represent configured certificate authority, not certificate-path validation. They do
not verify signatures, identities, time, revocation, or policy. Native PEM acquisition is a
separate provider concern, and loading the same certificate bytes as an operating system store does
not reproduce that system's trust policy.

**Evidence:** [snapshot actor](../../../../packages/compiler/stdlib/silk/trust_snapshot.silk),
[service actor](../../../../packages/compiler/stdlib/silk/trust_source.silk),
[memory provider](../../../../packages/compiler/stdlib/silk/memory_trust_source.silk),
[implementation contract](../../../../openspec/changes/archive/2026-09-12-implement-owned-trust-snapshots/specs/owned-trust-snapshots/spec.md),
[shared native acceptance](../../../../packages/compiler/test/support/trustSourceAcceptance.ts).

## Owned authenticated TLS connections

`silk.tls_connection.authenticateOwned` consumes one `ByteDuplex` provider and one independently
prepared `TrustSnapshot`, then returns one affine `OwnedConnection<P>` only after TLS 1.3
authentication and a final deadline check. Trust preparation is deliberately outside the provider
cleanup guard: applications may load, decode, combine, or copy a snapshot first, and a preparation
failure retains its trust or allocation error without touching a transport. TLS authentication has
no ambient `TrustSource` requirement and does not report `TrustSourceError`.

`ConnectionOptions` always contributes a finite handshake-duration deadline and may carry an
`externalDeadline`. Authentication uses the earlier absolute monotonic instant without renewing it
across fragmented reads or writes. The owned value privately binds the authenticated TLS state to
the exact provider. Its TLS client retains the reference, ALPN, authentication, and validation-time
facts, while a private zero-state marker records their unforgeable association with that provider
without duplicating them. Borrowed accessors expose only TLS-observable authentication evidence;
route, proxy, pool, origin, and reuse identities belong to the HTTP client and connection-pool
actors.

Reads, writes, flushes, authentication metadata, and graceful write shutdown operate on the owner.
Every suspending direct-owned I/O borrow has an operation-local cleanup guard: structured
cancellation marks the owner terminal, closes the provider once, and prevents the ambiguous caller
buffer from being offered again. `shutdownWrite` sends and flushes TLS `close_notify` before closing
the transport write direction, while `close` first enters the terminal `Closed` phase and then
performs one nonparking full-provider close without TLS grace. Repeated close is local and
successful; the first direct provider-close failure remains typed as `ConnectionError`.

A failed owned TLS read, write, flush, or write shutdown terminally closes its provider before
returning the original typed failure. This includes allocation failures during protocol progress.
After successful write shutdown, peer EOF preserves the local shutdown state; repeated write
shutdown performs no additional provider operation.

`withClient` is the scoped convenience over the same owned constructor. It consumes the provider
and snapshot, lends only a higher-ranked mutable owner to the callback, and suppresses final close
failure so cleanup cannot replace callback success, typed failure, or structured cancellation.
Fatal traps remain outside these structured cleanup guarantees. HTTP exchange borrowing and pool
return/eviction policy are intentionally deferred to JUL-23 and JUL-197.

**Evidence:** [owned TLS actor](../../../../packages/compiler/stdlib/silk/tls_connection.silk),
[owned-transport contract](../../../../openspec/changes/add-owned-tls-connections/specs/owned-transport-lifetimes/spec.md),
[scoped TLS contract](../../../../openspec/changes/add-owned-tls-connections/specs/scoped-byte-duplex-tls-connection/spec.md),
[portable TLS witness](../../../../packages/compiler/test/support/tlsConnectionAcceptance.ts).

## Deferred directions

The following are deliberately outside the first stable model:

- native package acquisition, registries, version solving, and explicit re-exports;
- independently selected standard-library or required runtime-support versions;
- target-conditional source and module-level availability annotations;
- compiler-selected or overridable default service providers;
- optional service requirements, including absence, selection, and entry-closure semantics;
- a stable by-value aggregate ABI and user-selected runtime implementations;
- runtime suspension, concurrency, scheduler/executor selection, async I/O, richer streams,
  networking, and entropy facilities beyond the currently shipped providers;
- alternative standard-library profiles or “no-stdlib” project configuration in the official
  toolchain; and
- omitted struct fields, field defaults, and any deliberate integration with ordinary `Option`.

## X25519 key agreement {#STDLIB-X25519}

`silk.x25519.X25519` owns an ephemeral scalar and its canonical 32-byte little-endian public key.
Use `X25519.generate()` with explicit exclusive `Random` provision for production: each call
requests exactly 32 fresh bytes, clamps them and derives X25519(secret, 9). Provider failure
remains fatal, without retry or insecure fallback. Deterministic `fromSecret` imports exactly
32 borrowed bytes into owned storage; callers must not reimport a scalar for distinct exchanges.

`publicKey(&key)` returns the public bytes without consuming the owner. `agree(move key, peer)`
consumes it on success or failure. Peer encodings must be exactly 32 bytes. Agreement masks the
high bit, reduces noncanonical coordinates, admits curve and twist inputs, and rejects an all-zero
result. Width failures and all-zero results use `X25519Error`. No allocator or cryptographic
provider is required by the arithmetic; fixed local limbs and a 255-step ladder implement RFC 7748.

Pass the raw shared result into the protocol's key derivation. This primitive does not authenticate
a peer or implement TLS. Ownership prevents accidental reuse of the same owner, but does not
guarantee physical secret erasure. Functional vectors and inspection of a particular compiler's
output do not establish universal constant-time execution or production security.

### STDLIB-RSA — bounded RSA SHA-256 verification

`silk.rsa` exports `RsaPublicKey` and `RsaError`. `fromComponents` admits canonical unsigned
big-endian odd moduli containing 2048 through 4096 significant bits and exactly the exponent
bytes `01 00 01`. The resulting key owns bounded private storage. Verification borrows the key,
message and signature; it requires no service, entropy, allocation or private-key operation.
Messages exceeding 2^61−1 bytes return `MessageTooLong` before hashing. Each verification hashes
the exact message once with SHA-256. Signatures must have exactly ceil(modulusBits/8) bytes and
represent an integer below the modulus.

`verifyPss` selects SHA-256, MGF1-SHA-256, salt length 32 and trailer field 1. It uses
emBits = modulusBits−1 and emLen = ceil(emBits/8), including the shorter encoded-message width
for a 2049-bit modulus. It checks all leading bits, padding bytes, delimiter, salt-dependent hash
and trailer. Verification failure returns `InvalidSignature`; invalid signature width returns
`InvalidLength`.

`fromCertificateKey` takes the original AlgorithmIdentifier DER, key BIT STRING bytes and unused
bit count retained by the certificate container decoder. It requires byte alignment, rsaEncryption
with absent or NULL parameters, and a minimal positive DER RSAPublicKey sequence without trailing data.
PSS-restricted key identifiers are outside this profile. `verifyCertificate` similarly takes the
original signature AlgorithmIdentifier DER and signature BIT STRING metadata. It admits PSS only
with effective SHA-256/MGF1-SHA-256/salt32/trailer1 parameters, in unique ordered explicit fields;
SHA-256 identifiers accept absent or NULL parameters. The default SHA-1 and salt20 values do not
meet this profile. Trailer1 may be omitted or explicit.

The certificate verifier also admits sha256WithRSAEncryption with absent or NULL parameters. Its
PKCS#1 v1.5 verification checks the complete `00 01 FF…FF 00` padding and the exact SHA-256
DigestInfo, including its NULL parameter. No general PKCS#1 signing or encryption API is exposed.
Malformed key DER returns `InvalidEncoding`; unsupported algorithm metadata returns
`InvalidParameters`; an unsupported mathematical key profile returns `InvalidKey`.

Arithmetic is bounded public-data work. It does not introduce a bigint API, compiler-recognized
library declaration or external cryptographic fallback. Signature validity establishes neither
certificate trust nor certificate path or service identity validity. Native/Wasm evidence applies
only to the recorded compiler profiles; it does not claim FIPS validation or complete TLS support.

### STDLIB-010 — TLS label derivation preserves raw bytes and rejects lengths before mutation

`silk/tls_hkdf` supplies `TlsHkdfSha256` and `TlsHkdfSha384` over the corresponding generic HKDF
actors. Each `expandLabel` borrows a fixed 32-byte or 48-byte secret, label and context slices, and
an exclusive output slice. It fills the complete output or returns `LabelError` without changing it.

The info bytes are the two-byte big-endian output length, the one-byte prefixed label length,
`tls13 `, the raw label, the one-byte context length, and the raw context. Labels contain 1..249
bytes, contexts 0..255 bytes, and outputs 0..8160 or 0..12240 bytes. Validate label, context, then
output length before narrowing, framing, mutation or an empty-output return. Error variants
`LabelLength`, `ContextLength`, and `OutputLength` report the requested and maximum public lengths.
Zero bytes and caller-supplied prefix bytes retain their original meaning; there is no trimming,
normalization, terminator, or prefix detection.

`deriveSecret` hashes exactly the supplied messages, then expands to the digest width with that
hash as context. `deriveSecretFromHash` accepts a fixed-width transcript hash and does not hash it
again. Empty messages use Hash(empty), which differs from an empty expansion context. SHA-256
messages longer than 2^61−1 bytes return `MessageTooLong` before the hash operation. SHA-384's hash
domain exceeds addressable slice lengths on supported targets.

These operations require no allocator or Random provider. They retain no input and use at most
514 bytes of framing storage, independent of message size. Protocol label selection, transcript
serialization, message inclusion, and HelloRetryRequest handling belong to the TLS consumer.
This module does not implement a handshake, records, authentication or trust. Vector success does
not establish constant-time execution or secret erasure.

### STDLIB-011 — bounded TLS 1.3 record protection and byte driving

`silk/tls_record` supplies separate affine `TlsRecordSender` and `TlsRecordReceiver` owners for
AES-128-GCM/SHA-256, AES-256-GCM/SHA-384, and ChaCha20-Poly1305/SHA-256. Protected constructors
require the suite hash's exact traffic-secret width, derive the AEAD key and 12-byte IV through
`silk/tls_hkdf`, allocate all direction storage once, and start a private sequence at zero.
Plaintext constructors frame the initial handshake records without fabricating a protected epoch.

The sender queues at most 16,384 content bytes into one record, exposes the stable unacknowledged
suffix through `pendingOutput`, and advances it only through a valid `ackWritten` prefix count.
The receiver's `feedInput` consumes an exact caller prefix, admits the five-byte header before body
bytes, stops after one complete record when input is coalesced, and publishes plaintext only after
authentication plus inner-type and padding validation. `record` returns an owner-borrowed view;
`consumeRecord` releases that view, while `readyContentType`, `readyLength`, and
`consumeRecordInto` permit an outer owner to inspect and copy the same authenticated record without
retaining a view. An undersized copy destination preserves the ready record. Empty application fragments are
valid, handshake fragments are nonempty, alerts contain exactly two bytes, and protected records
use outer type 23, legacy version `0x0303`, and the exact header as AEAD additional data.

Each protected direction stops before record 8,388,608. Nonces are the derived IV XOR the
left-zero-padded 64-bit sequence number. Invalid acknowledgments leave sender state unchanged;
header, authentication, inner-content, and receive key-use failures make the receiver terminal.
The actor performs framing and proves possession of installed traffic secrets only. It does not
perform a handshake, authenticate a server identity, validate certificates, select trust anchors,
drive network resources, reserve client KeyUpdate policy, or decide `close_notify` behavior.

### STDLIB-012 — authenticated bounded TLS 1.3 client

`silk/tls_client` composes the record directions, explicit `TrustSnapshot`, caller-supplied
`Instant`, HTTPS reference identity, bounded certificate path, selected signature primitives, and
TLS key schedule into one affine transport-independent client. `Client.make` consumes trust and
copies the validated reference and ALPN configuration; DNS uses one owned lowercase A-label for
both SNI and certificate identity, while IP references omit SNI. No protocol step reads ambient
trust or time, accepts a verification bypass, or substitutes deterministic entropy.

The byte driver exposes exact input consumption, a stable pending ciphertext suffix with explicit
acknowledgment, bounded plaintext reads and writes, KeyUpdate, directional close, and transport EOF.
It publishes `Authenticated` only after path, SAN identity, CertificateVerify, server Finished, and
complete acknowledgment of client Finished. Infallible authenticated getters then expose the exact
suite, group, optional ALPN, leaf DER, selected path indices and anchor, validation instant,
revocation status, and SAN match. There is no caller-supplied boolean authentication token.

The selected profile offers the three TLS 1.3 AEAD suites, X25519 with bounded P-256 retry, ECDSA
P-256/SHA-256 and RSA-PSS-RSAE/SHA-256 CertificateVerify, empty initial client-certificate decline,
bounded ticket discard, traffic-key updates before epoch exhaustion, and strict close-notify and
truncation handling. Typed failures preserve certificate decode, path, identity, and signature
causes. This is a deliberately selected TLS 1.3 and certificate profile, not complete browser Web
PKI, a socket adapter, resumption, TLS 1.2, or a physical secret-zeroization guarantee.
