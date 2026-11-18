---
title: Platform supplies
---

Platform supplies are physical toolchain inputs. They do not participate in source selection or the
logical compilation profile. A native build resolves its supply before publishing a final link
identity, and subsequent stages consume that immutable selection.

`Compilation.platform` supplies an explicit SDK/sysroot and linker, with compatible compiler-support
roots where needed. Resolution captures automatic discovery in the request before compilation.
An invalid explicit supply fails. Compilation reads the selected installation and does not fetch
packages, run tasks or discover a different SDK.

Darwin supplies distinguish SDK metadata, libSystem, frameworks, linker and consumed headers.
SDKROOT, when supplied, must identify a valid SDK; otherwise discovery queries selected developer
tools using xcrun and DEVELOPER_DIR, on a macOS host only. When xcrun is missing or cannot answer
(without developer tools, `/usr/bin/xcrun` only offers to install them), discovery takes the SDK at
`/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk`, else at Xcode's default location; when
neither exists the refusal names `xcode-select --install` and SDKROOT. One SDK serves both macOS
architectures, so an Apple silicon Mac discovers it for `x86_64-apple-darwin` too. The SDK must
admit the target's architecture (`arm64` or `x86_64`) in its settings and libSystem stub, and the
requested deployment. The default deployment is 11.0.0, raised to the SDK's minimum when a newer
SDK drops it. Resolution never raises a written deployment.
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

A host links an executable for its own target, for wasm32, for Windows, for macOS, or for
GNU/Linux. Every native link passes the target triple to Clang. A Linux link uses the `ld.lld`
beside Clang; a macOS link against Silk's libSystem stub, or for another architecture or host,
uses `ld64.lld`, and a native one against an SDK Apple's `ld`. A Windows link passes `/Brepro`, so
its image carries a content hash in place of the link time. An explicit supply's `linker` wins over both. The link stamp covers the supply's
root, linker, deployment and the digests of the SDK files it read, so a replaced SDK relinks.

A macOS link needs no SDK. An automatic request without `SDKROOT` uses Silk's own libSystem stub
on every host, a Mac included, unless the link declares inputs (objects, archives, libraries,
frameworks or C sources): those need the SDK a Mac discovers, and only on another host do they
fall back to the stub. A program therefore links to the
same bytes on every host, as a GNU/Linux program does. The stub is a TAPI text file that names
`/usr/lib/libSystem.B.dylib` and the symbols Silk programs bind there, for both macOS
architectures. The compiler writes it into the link's scratch directory and links with
`ld64.lld`, `-nostdlib` and `-lSystem` against it alone. The default deployment is then 12.0; a
written deployment must be 11.0.0 or later. The stub's digest is part of the link stamp. It has no
frameworks or other libraries, so a `Plan.linkFramework` or `Compilation.linkFramework` input needs a real SDK through
`SDKROOT`, a `native` request or an explicit supply. A `native` request always discovers the SDK
and never falls back to the stub.

A dynamically linked `libc = "gnu"` executable needs no sysroot on any host. Unless an explicit
supply is declared, the compiler writes stub shared libraries for glibc 2.28 (`libc.so.6`,
`libpthread.so.0`, `libm.so.6`, `libdl.so.2`, and the `libgcc_s.so.1` unwinder entries trap
reports use) with their symbol versions, plus its own `_start`, and links with `-nostdlib`,
`ld.lld` and the target's interpreter. Atomics are compiled inline, since no libgcc is linked. The
program runs on glibc 2.28 or later. The stubs define only what glibc 2.28 exports, so the
standard library reads file metadata through the `newfstatat` system call and starts a child in a
working directory with `fork`. A link with declared link inputs or `-static` still needs the
target's libraries: natively the host toolchain supplies them, and a cross link without an
explicit supply stops and says how to declare one. The link stamp covers the digest of the stub
table and startup source.

The standard library's `f64` and `f32` math never calls libm, and its result bits are the same on
every host. A program that declares a libm function itself, such as
`unsafe extern "C" fn log2(value: f64) -> f64`, binds glibc's `GLIBC_2.2.5` versions of `exp`,
`exp2`, `log`, `log2` and `pow`: they check their argument for `errno` and then run the same code
as the newer versions, so they return the same bits. Those bits can still differ between machines:
on x86-64, glibc picks a fused multiply-add implementation when the processor has FMA, which
rounds a few results the other way. In glibc 2.39 that covers `asin`, `acos`, `atan`, `atan2`,
`exp`, `expm1`, `log`, `log1p`, `log2`, `pow`, `sin`, `cos`, `sincos`, `tan`, `expf`, `exp2f`,
`logf`, `log2f`, `powf`, `sinf`, `cosf` and `sincosf`. Output that must not depend on the host,
such as compressed bytes chosen by a cost model, needs the standard library's functions or a test
on both kinds of processor.

A command can pin a physical installation through `Compilation.platform(Deferred<Platform>)`.
`Platform` contains absolute `sysroot` and `linker` paths and a `support` list whose entries contain
`root` and `target`. These fields are serialized in the compilation request. For example:

```toml
[platform]
sysroot = "/opt/SDKs/MacOSX15.5.sdk"
linker = "/opt/llvm/bin/ld64.lld"
support = []
```

Request paths are absolute. A successful native link writes an inspectable `<artifact>.link.json`
companion containing its concrete command, selected inputs, digests and entry policy. This records
the physical build; it is not a portable SDK installation.
