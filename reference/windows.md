# Silk on Windows

The Windows target is `x86_64-pc-windows-msvc`. The compiler and runtime call Windows system
DLLs directly and require no C runtime. Native execution and self-hosting are tested on
Windows Server 2025 x64. Install LLVM 22 or newer, including Clang and LLD, and put its `bin`
directory on `PATH`, or set `SILK_CLANG` to `clang.exe`.

## Install a published release

Once a release carries Windows assets, run this in PowerShell:

```powershell
irm https://raw.githubusercontent.com/silk-lang/silk/main/install.ps1 | iex
```

The installer uses `$env:SILK_HOME`, or `$env:USERPROFILE/.silk`. It installs `bin/silk.exe`
and a versioned compiler and standard library below `toolchains`. Add the home's `bin`
directory to your user `PATH`. Administrator privileges are unnecessary.

Set `SILK_RELEASE` to an exact tag such as `v1.2.3`, or use `SILK_CHANNEL=dev` for the latest
published development release. The default channel prefers a stable release and falls back
to development releases only before a stable release exists. `GITHUB_TOKEN` is optional and
is sent only to the GitHub API.

Before running downloaded code, the installer verifies the ZIP's SHA-256 against GitHub's
asset metadata. If `minisign` is installed, it also requires a valid release-key signature and
the exact trusted release comment. When GitHub supplies no digest, minisign verification is
required. The extracted compiler must match `native-seed.json`, report the selected version,
and carry a change snapshot identical to the published snapshot.

`silk use <version>` installs additional signed toolchains. `silk update self` updates the
tool and always checks the archive's minisign signature. On Windows, self-update retains
`.silk-previous.exe` beside the tool while the original image remains mapped. A later update
removes that retained link; if an older process still prevents removal, the current tool stays
unchanged. Publication is serialized with `.update.lock`.
The PowerShell installer uses the same tool backup and lock. Reinstalling a compiler version
retains its old directory at `toolchains/.silk-previous-toolchain` until the next installation,
so running compiler images are not removed during staging cleanup.

## mise

Use mise's GitHub backend with the Windows ZIP and its installed `bin` directory:

```toml
[tools."github:silk-lang/silk"]
version = "latest"
asset_pattern = "silk-{{ version }}-x86_64-pc-windows-msvc.zip"
strip_components = 1
bin_path = "bin"
```

Pin an explicit published Windows version for reproducible environments. mise verifies GitHub's
asset digest and keeps the compiler, tool, and standard library together. This configuration is
for Windows x86_64; do not reuse its asset pattern for Unix or ARM targets. Update the managed
installation through mise.

## Scoop

Each release generates `silk.json` from the exact Windows ZIP, including its SHA-256. Install
that manifest directly, substituting the release tag:

```powershell
scoop install https://github.com/silk-lang/silk/releases/download/v1.2.3/silk.json
```

A Scoop bucket maintainer can put the published manifest at `bucket/silk.json`. It contains
`checkver` and `autoupdate` entries for stable releases. A direct manifest URL does not register
an official bucket; use a newly published manifest to update such an installation. No bucket
repository is created by this feature. Both `silk.exe` and `silkc.exe` are exposed, and their
standard library stays beside them.

## Current filesystem scope

Native host tools accept explicit drive paths, such as `C:\work\project`. Internally the
machine namespace uses `/C:/work/project`; ordinary confined filesystem paths still use `/`.
Host paths preserve canonical WTF-8, including unpaired UTF-16 surrogates. Directory listings
preserve names and case; paths are not globally lowercased.

The current native filesystem provider requires local NTFS. Following reparse points inside a
confined root, UNC and device roots, non-NTFS filesystems, and directory durability are explicit
unsupported outcomes. Deleting a known final symlink or junction does not traverse its target.
These restrictions are tracked separately from the validated native compiler and release chain.
