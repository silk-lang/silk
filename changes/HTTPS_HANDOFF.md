# Native HTTPS upgrade-history verification

PR [#1970](https://github.com/silk-lang/silk/pull/1970) remains a draft until the exact-head
Linux and selfhost gates pass. This replaces the original blocked-HTTPS handoff.

## Current status — 2026-10-18

Authenticated native HTTPS now works on macOS arm64 with the unmodified `/etc/ssl/cert.pem`,
including its annotations. Both `api.github.com` release metadata and tag-pinned
`raw.githubusercontent.com` content returned HTTP 200. No certificate or hostname check was
disabled. There is no external-tool transport fallback, fetched-authority pin, or empty-history
fallback.

The actual CLI now reaches the intended publication errors:

```text
silk changes --dir compiler since --from 0.0.0 --to 0.1.0-dev.8624+5081812 --json
Incomplete release history: a required TOML archive is not committed at the selected GitHub release tag.

silk changes --dir compiler since --from 0.0.0 --json
No published stable GitHub release is available for this repository; choose an explicit published --to version.
```

These are successful authenticated requests followed by explicit metadata/history failures.
They are not complete production upgrade-history success: the selected tag has no compiler
release archive, and the latest-stable endpoint returned no release. Do not manufacture records
from GitHub prose or infer a development build from the compiler's literal `0.1.0` version.

A complete controlled history query also passes over real native TLS. A local server supplies
release metadata, a stable archive, and its prerelease baseline archive. The test checks selected
tag URLs, the fetched predecessor, deduplication against the installed prerelease, and exact
Unicode/newline migration content. It routes the existing HTTP service to loopback; it does not
replace `HttpNative`, TLS, HTTP framing, metadata parsing, or the history walk.

Linux transport success is not yet claimed. Docker Desktop's local daemon accepted a socket but
hung on bounded capability probes. The conformance command is wired into the Linux N1 and native
target CI jobs; inspect their results on the PR's final head before marking it ready.

## Diagnosed causes and fixes

1. `NativeFileTrustSource` passed annotated platform bundles to the strict PEM decoder.
   `CertificateBundle.decodeAnnotatedPem` and `TrustSnapshot.fromAnnotatedPem` now import printable
   ASCII annotation lines between strict blocks. Native file trust uses this import path.
   `decodePem` and `fromPem` retain their strict contracts. All blocks must decode; malformed
   later certificates, unrelated PEM labels, suspect boundaries, and control bytes reject the
   entire import. Annotation bytes count toward the input limit, and original offsets survive.
2. The normalized-bundle failure was exactly `CertificatePath`, kind `Rejected`, reason
   `NoValidPath`, detail `UnsupportedAlgorithm`, location `Intermediate 0`, offset `31`.
   The captured Sectigo intermediate uses ECDSA/SHA-384; its issuer and the independently
   configured USERTrust ECC authority have P-384 keys. The new `silk.p384` verifier and profile
   admission validate those signatures. Independent RFC 6979 vectors cover the primitive;
   the captured chain is an offline path regression with a fixed instant and an independently
   configured root. Its positive assertion failed before the profile fix and passes afterward.
3. A real OpenSSL/Node server exposed a separate `ProtocolViolation Extension`: its
   EncryptedExtensions contained `supported_groups`, permitted by RFC 8446 section 4.2.7.
   The TLS client now accepts its bounded, nonempty, correctly framed preference vector and
   rejects a duplicate extension. The list is informational and cannot change the negotiated
   key share or bypass authentication.

`HttpError` retains the complete TLS connection or trust-source error through `Http`, `GitHub`,
and the command. CLI TLS diagnostics distinguish alerts, negotiation, identity, signature,
limits, I/O and timeout. Path diagnostics include primary reason, first rejected-candidate
reason, location and offset. No temporary debug logging remains.

## Verification completed on Darwin arm64

- Native compiler build: 29,086 symbols; zero unchecked root-package bodies; eight unchecked
  bodies across the closure, matching the prior feature's closure count.
- All 36 changes-library tests passed, 36 selected and executed.
- All 16 selected native corpus programs passed: new P-384 verification/path cases, certificate
  decoding/profile/path cases, owned trust snapshots, existing P-256 cases, all six authenticated
  TLS-client partitions, authenticated connection, and HTTP-over-TLS.
- P-384 checks include RFC 6979 SHA-384 signatures, high/low `s`, changed message/signature,
  off-curve/noncanonical/compressed/infinity keys, zero/out-of-range DER integers, noncanonical
  DER, wrong curve/algorithm parameters, and nonzero unused bits.
- Real TLS conformance passes plain/annotated explicit authority files, complete controlled
  history, malformed later trust certificates, untrusted issuers, wrong hostnames, expired
  certificates, forged certificate signatures, and HTTP 404 history errors. Authentication
  failures send no HTTP request to the server.
- Live native requests parse the real exact-release metadata, fetch its raw manifest, and
  return HTTP 404 for the absent archive. The untouched default bundle is used.
- Actual CLI smoke passes compiler/dependency baselines, explicit/default local targets,
  `--from`, explicit-version queries, Unicode/newline migrations, missing migrations as null,
  invalid/duplicate options, reversed/future targets, undeclared origins, and read-only behavior.
- Generated standard-library reference pages were regenerated from the source comments.
- Local formatting, lint, and tooling typecheck pass. A full new-head selfhost/fixpoint run is
  left to CI. No Linux success or readiness is implied by the Darwin results.

The measured borrow-gap update was generated with `check-borrow-gap.mjs update` from the
successful selected corpus log; unselected programs were retained. Its diff is:

| program | regions | stored-loans |
| ------- | ------: | -----------: |
| total   |   9 → 9 |      37 → 37 |

## Reproduce

Obtain the compatible native producer pinned in `compiler/native-seed.json`, verify its hash,
and use the repository's native build instructions. These paths refer to local artifacts:

```sh
build/integration/silk-upgrade build compiler/src/main.silk \
  -o build/integration/silk-https --stdlib stdlib \
  --clang /path/to/working/clang --optimization speed --debug false

build/integration/silk-https test --manifest-path changes/silk.toml \
  --root src/tests.silk --no-cache --stdlib stdlib

SILK_COMPILER="$PWD/build/integration/silk-https" SILK_CLANG=/path/to/working/clang \
  node .github/scripts/test-native-https.mjs --live
```

The conformance script needs Node, the workspace dependencies, and OpenSSL. It creates an
isolated test PKI, binds only loopback, compiles the real consumer, verifies rejection before
application data, and removes its temporary files. `--live` additionally checks GitHub metadata
and raw content. OpenSSL supplies only test certificates and the reference server's PKI; the
Silk executable performs all client transport and authentication natively.

On this machine Homebrew Clang's default SDK path was stale for standalone C fixtures. The
local wrapper used `--no-default-config -isysroot <xcrun --show-sdk-path>`; this is a toolchain
configuration repair, not a transport fallback.

## Remaining scope and publication requirements

Native DNS still has no overall acquisition deadline. The TLS handshake retains its 30-second
bound; HTTP exchange has no wall-time bound. Responses remain bounded to 8 MiB. Redirects,
proxies, authentication, retries and decompression remain outside this adapter.

P-384 support is certificate-path signature verification. It adds no signing, P-384 key agreement,
or P-384 TLS CertificateVerify negotiation. Existing TLS 1.3 suite and key-share selection remains
unchanged. Verification does not add revocation, certificate-transparency or OS keychain policy.

Before review readiness, inspect the exact-head Linux conformance and required CI results.
Public Silk history still needs complete authoritative TOML records committed at a published
release tag and a stable release for automatic latest-stable discovery. The controlled query
proves the complete transport workflow without claiming that missing public data exists.

## Implemented feature contract

```sh
# Recorded compiler version -> latest stable compiler
silk changes since

# Recorded compiler version -> an explicit compiler release
silk changes since --to 0.5.0 --json

# Installed dependency -> latest stable, or an explicit release
silk changes since mylib
silk changes since mylib --to 2.0.0 --json

# Local checkout override, usable without HTTPS
silk changes since --source ../silk/compiler --to 0.5.0
silk changes since mylib --source ../candidate --to 2.0.0

# Existing current-package history query
silk changes since 1.2.0 --to 1.4.0
```

These examples describe the interface; the named target versions must actually exist in the
selected source. The local workflow has been exercised against real generated release records.
**Automatic remote queries are implemented but have not succeeded against live GitHub.**

- No selector uses the project's `[package].silk-version`, not its package version or the
  running compiler's version. Missing recorded versions require `--from VERSION`.
- A dependency alias or unambiguous package name uses the installed dependency manifest's
  version. `--from` overrides compiler/dependency baselines.
- A version selector retains the current package's local-history behavior. It cannot also use
  `--from`.
- `--to` selects an exact SemVer target. Local targets cannot exceed the checkout's manifest
  version; targets older than the baseline are rejected.
- `--source` is relative to the consuming package's root and selects a local checkout of the
  same package. Without `--to`, this explicit checkout supplies its manifest version.
- JSON includes the resolved `package`, `from`, `to`, and `releases`. Missing migrations remain
  `null`. Queries neither update manifests nor consume pending changes.

### Remote discovery and publication contract

There is no Silk registry. The new implementation uses existing GitHub Releases and committed
TOML files, not a new archive format or an invented package endpoint.

Libraries declare this in their installed `silk.toml`:

```toml
[changes]
repository = "owner/repository"
directory = "packages/mylib" # Optional; omitted means the repository root.
```

Compiler discovery uses `silk-lang/silk`, directory `compiler`.

1. Default lookup requests `/repos/<owner>/<repo>/releases/latest`. The result must be a
   published, non-draft, non-prerelease release with a stable `v<VERSION>` tag.
2. Explicit lookup requests `/repos/<owner>/<repo>/releases/tags/v<VERSION>`, encoding URL
   components, including `+`. Explicit prereleases are allowed; tag identity must match exactly.
3. All required `.changes/releases/<version>.toml` files come from the selected tag through
   `raw.githubusercontent.com`. Predecessors and prerelease baselines are fetched from that
   same tag, never from the default branch.
4. Authors must commit the complete supported history before publishing the release. Missing
   records, wrong package/version identities, and incomplete chains remain errors.

A dedicated history release asset is not required by this design. Existing source snapshots
already include the package trees. No publishing workflow was changed in this follow-up.
