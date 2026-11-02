# The silk tool

`silk` is the one command people type for Silk. It owns what must behave the same in every
project: Silk versions (`silk use`, `silk set`), release notes (`silk change`) and itself
(`silk update self`). Every other command, `silk build`, `silk test`, `silk lsp` and anything the
tool does not know, runs unchanged in the compiler, `silkc`, of the Silk version the directory
selects. So editors, scripts and habit reach the pinned compiler too.

```sh
silk use                    # install the version this project pins
silk use 0.1.0-dev.11       # install a version and make it your default (never edits a project)
silk use latest             # the newest stable release as your default (--dev: include dev releases)
silk set latest             # pin this project to the newest stable release; downloads nothing
silk use list               # installed versions; which one is selected, pinned and the default
silk use which              # the version selected here, and why
silk use uninstall 0.1.0-dev.11
silk +0.1.0-dev.11 build    # run one command with an installed version
silk update self            # update the tool (--dev: to the newest dev release)
silk change minor "Reads now return a future."   # record a change for the next release
```

`silk change` also plans, cuts and queries releases (`status`, `version`, `release`, `snapshot`,
`since`, `recover`; see `silk change --help` and the repository README). It reads the `[release]`
table of `silk.toml`.

`silk help` lists the project commands and the tool's own; `silk help <command>` of a project
command is the compiler's. `silk --version` is forwarded too, so it reports the Silk version the
directory selects.

`list`, `which`, `use` and `set` take `--json`. The commands never prompt and report progress on
standard error. Exit statuses: 0 success, 1 failure, 2 usage or configuration error, 3 version
not installed, 4 download failed, 5 verification failed.

## Store

Installed versions live in `$SILK_HOME` (default `~/.silk`):

```text
~/.silk/
  bin/silk                      the tool (install.sh, silk update self)
  settings.toml                 default = "<version>", optional auto-install = true
  toolchains/<version>/bin/silkc
  toolchains/<version>/lib/silk/stdlib
```

Versions released before the compiler was renamed hold it as `toolchains/<version>/bin/silk`;
the tool runs those too. Any version of the tool reads a store another wrote: the layout does not
change between releases.

## Selection and forwarding

A command selects a version by the first of these that applies: `silk +<version>`,
`SILK_TOOLCHAIN`, `silk-version` in the nearest `silk.toml` (the workspace that lists the package
first, then the package; `0.0.0` means unpinned), and `default` in `settings.toml`. The tool then
replaces itself with that version's `bin/silkc`, passing the arguments unchanged (without
`+<version>`) and setting `SILK_TOOLCHAIN` to the full version and `SILK_HOME`. It never parses a
forwarded command's flags. A first word one edit away from `use`, `set`, `update` or `change`,
and from no compiler command, is answered with a suggestion instead of being forwarded.

A workspace's pin covers its members. When a member's own `silk-version` names another version,
the tool prints a note naming both manifests and runs the workspace's version.

When nothing selects a version, or the selected one is not installed, the tool exits with status 3
and names the command that fixes it, unless `SILK_AUTO_INSTALL=1` or `auto-install = true`
installs it first. For `lsp`, a missing toolchain or a failed automatic install instead answers
`initialize` with a JSON-RPC error (`code: -32000`) containing the failure reason and
`data: { "retry": false }`. It never reports successful initialization or advertises capabilities.
Other requests receive ServerNotInitialized (`-32002`); the process exits with status 1 on `exit`
or EOF. Fix the reported problem, then restart the language server. A pin the tool cannot read,
such as syntax from a newer manifest format, is a configuration error naming `silk update self`;
the tool never guesses what it means.

The tool reads two things from a manifest: the root `silk-version`, and the release settings
`silk change` will use. Manifest changes for the compiler never need a tool update.

## Installing a version

`silk use` downloads `silk-<version>-<target>.tar.gz` and its `.minisig` from the GitHub release,
or from `$SILK_TOOLCHAIN_MIRROR/v<version>/` when set. Installation needs a valid signature by the
release key with the trusted comment `silk v<version> <archive>`, and a compiler (`bin/silkc`, or
`bin/silk` in earlier releases) whose SHA-256 matches the release's `native-seed.json`. The archive
is unpacked into a hidden staging directory under `toolchains/` and renamed into place, so an
interrupted install leaves nothing half written. The toolchain keeps no copy of the tool.
Installs hold an `flock` on `$SILK_HOME/.install.lock`, so two concurrent installs of a release
download it once. The install holding the lock also removes staging directories that interrupted
installs left behind. A version directory without a compiler does not count as installed:
`silk use` replaces it, and `silk use uninstall` removes it.

`latest` names the newest stable release and `dev` (or `latest --dev`) the newest release of any
kind. They read the GitHub release listing, retrying up to four times when it fails or comes back
empty. Pins and the default are always written as the full version.

## Updating the tool

Every release archive carries the tool as `bin/silk` beside the compiler `bin/silkc`, built from
the same sources. `silk update self` takes the newest stable release (the newest dev release while
none is stable, or always with `--dev`), checks the archive's signature, and replaces `bin/silk`
through a staging directory, so the name always holds a whole program. It also removes the
`bin/sew` that dev releases before the rename installed. It installs no Silk version. This and
install.sh are the only ways the tool changes. `silk update silk` changes nothing and says how to
move to a newer Silk instead.

## Develop

From this directory:

```sh
silkc test --root src/tests.silk --no-cache --stdlib ../stdlib
silkc build --stdlib ../stdlib --release
```
