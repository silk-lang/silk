---
title: Platform supplies
---

Platform supplies are physical toolchain inputs. They do not participate in source selection or the
logical compilation profile. A native build resolves its supply before publishing a final link
identity, and subsequent stages consume that immutable selection.

A direct supply request takes precedence over an artifact pin, then a project pin. Automatic
selection uses the winning pin, or native discovery only for a declared compatible host target.
Explicit requests name the target, SDK/sysroot and linker, with named compatible compiler-support
roots where needed. An invalid explicit supply fails; it never falls back to host discovery.
Managed supplies are recognized but unsupported. Resolution does not download or install tools.

Darwin supplies distinguish SDK metadata, libSystem, frameworks, linker and consumed headers.
SDKROOT, when supplied, must identify a valid SDK; otherwise discovery queries selected developer
tools using xcrun and DEVELOPER_DIR. The SDK must admit ARM64 and the requested deployment.
The default ARM64 deployment is 11.0.0. Resolution never raises a requested deployment silently.
GNU/Linux supplies distinguish glibc libraries/scripts, startup and support objects, interpreter,
search roots, compiler/linker and consumed headers. The selected toolchain supplies search and
component information; explicit sysroots are inspected, not forwarded opaquely. Components from
other installations require explicit compatible provenance. A libc-none plan adds no CRT/libc or
interpreter; the artifact's explicit entry policy still governs startup.

A resolved supply records consulted environment values, exact queries/results, full tool versions,
paths and content digests. Clang's implicit configuration and ambient include/library overrides are
not additional configuration channels. Changing ambient discovery state after resolution does not
change an existing snapshot. Changed selected bytes fail consumption and require re-resolution.

The final plan records ordered concrete objects, archives, libraries, recursive scripts/references,
frameworks and stubs, runtime objects, selected linker and loader-entry source. Named library and
framework searches finish before complete identity publication. Actual linker archive extraction,
group, weak and dynamic import semantics govern symbol resolution. Unsupported physical input forms
fail with component origins; missing and duplicate symbol failures retain linker output and the
complete input set.

Semantic and object identities remain independent of equivalent SDK/sysroot locations. Final
identity includes ordered selected contents and flags; paths distinguish identity only where they
are emitted, including interpreter, rpath and install/import names. Complete accounting permits
native final-cache reuse under the permanent admission rule. Incomplete native plans remain
ineligible. Runtime C objects account for compiler bytes and their frozen preprocessed translation
unit and consumed headers; headers unused by an operation do not affect its identity.

Required conformance covers Darwin ARM64 and GNU/Linux x86-64 and ARM64 with pinned tools and
platform baselines, real compile/link/inspection and separately compiled C fixtures, debug and
optimized boundaries, and execution on available runners. Missing tools or skipped designated cases
fail required lanes. LTO is not admitted by the compilation profile. Managed installation, new libc
families, OS operation implementations and startup implementations belong to other capabilities.

A project can pin a physical installation independently of its logical target profile:

```toml
[build]
platform-supply = { kind = "explicit", target = "aarch64-apple-darwin", root = "/opt/SDKs/MacOSX15.5.sdk", linker = "/opt/llvm/bin/ld64.lld", origin = "pinned macOS SDK" }
```

The `build-exe` command also accepts `--platform-supply` with the same record encoded as JSON.
Manifest paths resolve relative to the manifest directory. GNU compiler-support installations use
`support = [{ root = "...", target = "x86_64-unknown-linux-gnu", origin = "pinned GCC support" }]`.
A successful final native build writes an inspectable `<artifact>.link.json` companion containing
the frozen supply, concrete command, input origins and digests, consumed C translations, and entry
policy. This companion describes the physical build; it is not a portable supply installation.
