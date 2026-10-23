# sew

sew is the one command people type for Silk. It owns what must behave the same in every project:
Silk versions (`sew use`, `sew set`), release notes (`sew change`) and sew itself
(`sew update self`). Every other command,
`sew build`, `sew test`, `sew lsp` and anything sew does not know, runs unchanged in the Silk
version the directory selects. The same program run as `silk` has no commands of its own and
forwards everything, so editors, scripts and habit reach the pinned compiler too.

```sh
sew use                    # install the version this project pins
sew use 0.1.0-dev.11       # install a version and make it your default (never edits a project)
sew use latest             # the newest stable release as your default (--dev: include dev releases)
sew set latest             # pin this project to the newest stable release; downloads nothing
sew use list               # installed versions; which one is selected, pinned and the default
sew use which              # the version selected here, and why
sew use uninstall 0.1.0-dev.11
sew +0.1.0-dev.11 build    # run one command with an installed version
sew update self            # update sew (--dev: to the newest dev release)
sew change minor "Reads now return a future."   # record a change for the next release
```

`sew change` also plans, cuts and queries releases (`status`, `version`, `release`, `snapshot`,
`since`, `recover`; see `sew change --help` and the repository README). It reads the `[release]`
table of `silk.toml`, or `[changes]`, its earlier spelling.

`list`, `which`, `use` and `set` take `--json`. The commands never prompt and report progress on
standard error. Exit statuses: 0 success, 1 failure, 2 usage or configuration error, 3 version
not installed, 4 download failed, 5 verification failed.

## Store

Installed versions live in `$SILK_HOME` (default `~/.silk`):

```text
~/.silk/
  bin/sew                      sew (install.sh, sew update self)
  bin/silk                     the same file, a second name
  settings.toml                default = "<version>", optional auto-install = true
  toolchains/<version>/bin/silk
  toolchains/<version>/lib/silk/stdlib
```

Any sew reads a store another sew wrote: the layout does not change between releases.

## Selection and forwarding

A command selects a version by the first of these that applies: `sew +<version>`,
`SILK_TOOLCHAIN`, `silk-version` in the nearest `silk.toml` (the workspace that lists the package
first, then the package; `0.0.0` means unpinned), and `default` in `settings.toml`. sew then
replaces itself with that version's `bin/silk`, passing the arguments unchanged (without
`+<version>`) and setting `SILK_TOOLCHAIN` to the full version and `SILK_HOME`. sew never parses
a forwarded command's flags. A first word one edit away from `use`, `set` or `update`, and from
every compiler command, is answered by sew with a suggestion instead of being forwarded.

A workspace's pin covers its members. When a member's own `silk-version` names another version,
sew prints a note naming both manifests and runs the workspace's version.

When nothing selects a version, or the selected one is not installed, sew exits with status 3 and
names the command that fixes it, unless `SILK_AUTO_INSTALL=1` or `auto-install = true` installs it
first. For `lsp`, so editors that only spawn the server do not see it crash, sew instead serves a
language server with no capabilities that answers `initialize`, shows the message as an error,
and exits on `exit`. A pin sew cannot read, such as syntax from a newer manifest format, is a
configuration error naming `sew update self`; sew never guesses what it means.

sew reads two things from a manifest: the root `silk-version`, and the release settings `sew change`
will use. Manifest changes for the compiler never need a sew update.

## Installing a version

`sew use` downloads `silk-<version>-<target>.tar.gz` and its `.minisig` from the GitHub release,
or from `$SILK_TOOLCHAIN_MIRROR/v<version>/` when set. Installation needs a valid signature by the
release key with the trusted comment `silk v<version> <archive>`, and a `bin/silk` whose SHA-256
matches the release's `native-seed.json`. The archive is unpacked into a hidden staging directory
under `toolchains/` and renamed into place, so an interrupted install leaves nothing half written.
Installs hold an `flock` on `$SILK_HOME/.install.lock`, so two concurrent installs of a release
download it once. The install holding the lock also removes staging directories that interrupted
installs left behind. A version directory without `bin/silk` does not count as installed: `sew use`
replaces it, and `sew use uninstall` removes it.

`latest` names the newest stable release and `dev` (or `latest --dev`) the newest release of any
kind. They read the GitHub release listing, retrying up to four times when it fails or comes back
empty. Pins and the default are always written as the full version.

## Updating sew

Every release archive carries `bin/sew` beside `bin/silk`, built from the same sources.
`sew update self` takes the newest stable release (the newest dev release while none is stable,
or always with `--dev`), checks the archive's signature, and replaces `bin/sew` and `bin/silk`
through a staging directory, so each name always holds a whole program. It installs no Silk
version. This and install.sh are the only ways sew changes. `sew update silk` changes nothing and
says how to move to a newer Silk instead.

## Develop

From this directory:

```sh
silk test --root src/tests.silk --no-cache --stdlib ../stdlib
silk build --stdlib ../stdlib --release
```
