# Handoff: unblock native HTTPS for upgrade history

## Status and goal

PR [#1970](https://github.com/silk-lang/silk/pull/1970), branch
`julia/integrate-native-changes`, is intentionally a **draft**. The user asked to push the
working progress and hand off the HTTPS issue rather than switch transports.

Implement secure, working native HTTPS for automatic compiler/dependency upgrade queries.
Do not disable certificate or hostname verification, trust a certificate merely because the
server supplied it, silently return an empty history, or introduce a curl fallback without
agreement. No standard-library TLS code has been changed in this feature so far.

Read the repository's `AGENTS.md` first. Keep `bootstrap/` frozen and preserve unrelated local
changes. The working tree had unrelated entries in `PAPERCUTS.md` and untracked `.turbo/`,
`apps/`, `packages/`, and `examples/tiny-language/`; they are not part of this feature.

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

## Code map

| File                                   | Responsibility                                                                                                             |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `changes/src/Command.silk`             | Optional selector and `--to` parsing, local/remote dispatch, native provider installation, resolved JSON output.           |
| `changes/src/Dependency.silk`          | Compiler/dependency baselines, local target bounds, declared remote origins.                                               |
| `changes/src/History.silk`             | One shared predecessor walk/dedup algorithm through `Source<E, ?R>`; local filesystem wrapper and common archive decoding. |
| `changes/src/GitHub.silk`              | Release metadata, safe URL construction, tag-pinned remote TOML reader.                                                    |
| `changes/src/Http.silk`                | Replaceable HTTP service returning owned status/body data.                                                                 |
| `changes/src/HttpNative.silk`          | Current native HTTPS adapter and PEM trust selection; the integration blocker is here or in its stdlib dependencies.       |
| `changes/src/tests/GitHubCases.silk`   | Discovery/protocol/history boundaries using a replacement HTTP provider, not live TLS proof.                               |
| `changes/src/tests/WorkflowCases.silk` | Real release lifecycle, compiler baseline, explicit target, override, and failure scenarios.                               |

Native transport uses `http_client_native.withConnection`, `NativeTransport`, request/exchange
callbacks, native DNS/sockets, host clocks/random, and `NativeFileTrustSource`. It performs no
external-tool invocation. Responses are bounded to 8 MiB; HTTP statuses are returned as values.
The native DNS API rejects an overall deadline for hostname resolution, so acquisition has no
overall deadline. TLS retains its 30-second handshake bound; HTTP exchange has no wall-time
bound. Redirects, proxy discovery, authentication, retries, and decompression are not implemented.

## Observed failures: two distinct layers

Observed on macOS arm64, 2026-10-18. `SSL_CERT_FILE` was unset for the first case.

### 1. The default macOS bundle fails to load

```sh
build/integration/silk-upgrade changes --dir compiler since \
  --from 0.0.0 --to 0.1.0-dev.8624+5081812 --json
```

Observed exit status **1**:

```text
silk changes: Could not load the PEM trust bundle; set SSL_CERT_FILE to a readable regular PEM bundle of trusted authorities.
```

The selected file is `/etc/ssl/cert.pem`. It contains comments and human-readable certificate
annotations outside its 128 `BEGIN CERTIFICATE` / `END CERTIFICATE` blocks. Its first line is:

```text
# $OpenBSD: cert.pem,v 1.22.2.1 2021/09/30 18:28:20 deraadt Exp $
```

`NativeFileTrustSource.loadCurrent` passes the entire file to `TrustSnapshot.fromPem`, which
uses the strict `CertificateBundle.decodePem` decoder. The default path is a regular file;
`/etc` itself is a macOS symlink. The adapter already separates the trusted native parent root
from the portable filename to avoid traversing `/etc` with the portable no-follow policy.

### 2. Plain PEM gets past loading but still fails TLS

Extracting the same certificate blocks, without adding an authority or disabling verification,
gets past the first error. The following reproduces the diagnostic experiment from the repo root:

```sh
python3 - <<'PY'
import os
from pathlib import Path
import re
import subprocess
import tempfile

compiler = Path("build/integration/silk-upgrade").resolve()
source = Path("/etc/ssl/cert.pem").read_text()
certificates = re.findall(
    r"-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----", source, re.S
)
with tempfile.TemporaryDirectory(prefix="silk-tls-probe-", dir="/private/tmp") as directory:
    bundle = Path(directory) / "authorities.pem"
    bundle.write_text("\n".join(certificates) + "\n")
    result = subprocess.run(
        [str(compiler), "changes", "--dir", "compiler", "since", "--from", "0.0.0",
         "--to", "0.1.0-dev.8624+5081812", "--json"],
        env={**os.environ, "SSL_CERT_FILE": str(bundle)},
        timeout=60,
    )
    print("exit:", result.returncode)
PY
```

Observed exit status **1**:

```text
silk changes: TLS authentication or communication failed; certificate and hostname verification are required.
```

This normalization is a diagnostic experiment, **not an implemented production fix**.
`HttpNative` currently collapses nested `ConnectionError` details into that message, so the
exact second failure has not yet been isolated.

### Independently observed peer certificate profile

This reference-client command succeeded with certificate and hostname verification enabled:

```sh
openssl s_client -connect api.github.com:443 -servername api.github.com \
  -showcerts -verify_hostname api.github.com -verify_return_error </dev/null
```

The returned chain included:

| Certificate                                                                  | Public key | Certificate signature |
| ---------------------------------------------------------------------------- | ---------- | --------------------- |
| `*.github.com`                                                               | P-256      | ECDSA/SHA-256         |
| Sectigo Public Server Authentication CA DV E36                               | P-256      | ECDSA/SHA-384         |
| Sectigo Public Server Authentication Root E46, cross-signed by USERTrust ECC | P-384      | ECDSA/SHA-384         |

`certificate_profile.silk` currently admits P-256 and 2048–4096-bit RSA keys.
**[INFERENCE]** Unsupported P-384/ECDSA-SHA-384 path processing is a strong candidate for the
second failure. It is not yet established as the exact nested TLS error or the only remaining
issue. Server chain selection may also differ between the reference client and Silk's ClientHello.

## Next investigation and fix

1. Keep the two reproductions separate. Inspect the nested `ConnectionError.Tls` / `TlsError`
   before changing certificate policy. In particular, preserve `CertificatePath`'s
   `ValidationError.reason`, `detailReason`, and `location`; distinguish it from peer alerts,
   unsupported negotiation, timeout, or other handshake failures.
2. Decide the proper owner for importing annotated platform CA bundles. Preserve strict PEM
   decoding where that is its documented contract. Do not simply skip malformed certificates
   or weaken verification to make the system file load.
3. Diagnose and fix the actual TLS/path compatibility gap. If elliptic-curve/signature support
   must expand, use independent known-answer and rejection tests, not only a successful live
   handshake. Keep trust anchored in configured authorities; do not pin a fetched intermediate
   as an ad-hoc workaround.
4. Exercise both `api.github.com` and `raw.githubusercontent.com`; their certificate chains can
   differ. Keep ordinary HTTP failures distinct from TLS failures.
5. Add deterministic tests at the owning stdlib boundary. Existing prerecorded/in-memory HTTP
   and TLS corpus fixtures demonstrate composition, not live GitHub compatibility.
6. Finish the live transport checks below, update the handoff/PR with exact results, and only then
   consider marking the PR ready.

Useful stdlib starting points:

- `stdlib/silk/native_file_trust_source.silk`: configured open, bounded read, close, strict decode.
- `stdlib/silk/trust_snapshot.silk`: `fromPem` and owned anchors.
- `stdlib/silk/certificate.silk`: certificate bundle decoding APIs.
- `stdlib/silk/http_client_native.silk`: native acquisition and connection cleanup.
- `stdlib/silk/tls_connection.silk`: scoped authentication and `ConnectionError`.
- `stdlib/silk/tls_client.silk`: advertised profile, handshake, `TlsError`.
- `stdlib/silk/certificate_profile.silk`: key/signature/extension admission.
- `stdlib/silk/certificate_path.silk`: bounded path selection and structured rejection evidence.
- `corpus/native/http-client-tls/main.silk`: existing prerecorded authenticated exchange.

## Verification already completed

- Native compiler build with the new HTTP stack passed: 29,015 symbols, zero unchecked
  root-package bodies; eight unchecked bodies across the complete closure were reported.
- All **36** changes-library tests passed, 36 selected and executed, in 183 ms runtime. The test
  build reported one unchecked root-package body, as before this feature.
- Actual CLI smoke against generated release histories passed: compiler default baseline,
  compiler/dependency `--to`, compiler `--from`, preserved explicit-version queries, exact
  migration text including Unicode/newlines, duplicate/missing options, reversed/future targets,
  and refusal of undeclared dependency origins.
- Queries left project/compiler manifests unchanged and did not create pending state.
- The old compiler rejected the new compiler-default/`--to` workflow; the new binary returned
  the expected bounded release records for the same fixture.
- Live default-bundle and normalized-bundle probes failed exactly as recorded above.
- No successful live native HTTPS query, Linux transport check, full new-head selfhost run, or
  end-to-end remote upgrade-history success is claimed.

Build and test commands used from the repository root:

```sh
build/llvm/aarch64-apple-darwin/release/silk-compiler build compiler/src/main.silk \
  -o build/integration/silk-upgrade --stdlib stdlib \
  --clang /opt/homebrew/opt/llvm/bin/clang --optimization speed --debug false

build/llvm/aarch64-apple-darwin/release/silk-compiler test \
  --manifest-path changes/silk.toml --root src/tests.silk --no-cache --stdlib stdlib
```

Those producer/output paths are local build artifacts, not committed binaries. Another machine
must obtain a compatible native producer using the repository's normal seed/build instructions.
Temporary smoke fixtures and normalized certificate files are not required; recreate them from
this handoff rather than depending on paths from the previous session.

## Publication prerequisites separate from HTTPS

Even after TLS succeeds, missing release history must remain an explicit error:

- No `compiler/.changes/releases/` directory exists in the inspected checkout. Do not fabricate
  historical migration notes or convert GitHub release prose into authoritative TOML.
- The inspected publishing workflows generate development prereleases. Automatic lookup is
  deliberately latest **stable**, not the installer's newest-development-build policy. Live
  stable-release availability has not been established by these failed native requests.
- Current compiler `release()` still returns the literal `0.1.0`; development release tags use
  a separate generated version. Do not infer an exact dev build from `package.silk-version`.
- Existing tags may have no structured history. A successful HTTPS 404 for a required archive is
  a correct incomplete-history failure, not evidence that the transport is still broken.

## Acceptance before ready-for-review

- Authenticated native GETs reach GitHub metadata and raw content on supported Darwin/Linux
  profiles using the documented trust configuration, without bypasses or an unapproved fallback.
- Supported platform PEM bundles and explicit `SSL_CERT_FILE` configurations work; malformed
  trust input, an untrusted issuer, wrong hostname, and invalid/expired certificates still fail.
- The actual nested TLS blocker has a focused regression test at its owning boundary.
- Real metadata is parsed and unavailable releases/records produce the intended typed failures.
- A complete controlled history query proves metadata selection, record fetching, and migration
  filtering through the real transport; if public Silk history is still unavailable, document
  that data prerequisite explicitly rather than claiming full live production success.
- All 36 library cases and local CLI upgrade scenarios remain valid. Follow `AGENTS.md` for final
  main integration, CI checks, and any measured borrow-gap updates; never hand-edit the gap file.
