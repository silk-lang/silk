#!/bin/sh
# Installs silk, the Silk front door, with a stable or dev Silk release, or an explicitly selected
# version.
#
#   curl -fsSL https://raw.githubusercontent.com/silk-lang/silk/main/install.sh | sh
#
# Compiler releases are tagged `v<version>`, with one `silk-<version>-<target>.tar.gz` per target.
# Auto selection prefers stable and uses dev only before a stable release exists.
# SILK_CHANNEL=dev follows published dev snapshots; drafts and bootstrap seeds are excluded.
# The compiler's SHA-256, reported version and embedded change snapshot are checked before
# installing it as the toolchain `$SILK_HOME/toolchains/<version>` (`SILK_HOME` defaults to
# `~/.silk`), and `settings.toml` makes it the default. The release's compiler is `bin/silkc`; its
# `bin/silk`, the silk tool, is installed as `$SILK_HOME/bin/silk`, and runs the version a project's
# `silk-version` pins inside it and the default outside. Other versions stay installed;
# `silk use list` shows them. Releases from before the compiler was renamed `silkc` hold the
# compiler as `bin/silk`, and `$SILK_HOME/bin/silk` links to it.
# When minisign is installed, the archive's signature must verify against the release key below.
# Downloads made by curl carry no macOS quarantine mark, so Gatekeeper lets the compiler run.
#
# Environment:
#   SILK_HOME      toolchain home (default: ~/.silk)
#   SILK_RELEASE   exact release tag, such as v0.1.0-dev.2+a1b2c3d4e5f6
#   SILK_CHANNEL   auto (default), stable, or dev; SILK_RELEASE selects an exact version
#   GITHUB_TOKEN   optional; raises the GitHub API rate limit
set -eu

repo=silk-lang/silk
# The release signing key, also published as minisign.pub at the repository root.
minisign_public_key=RWQefAo9Dbb8LrlLPaqWdRNlX5th2l7r+4WYhxRNbe5K5URDUht1XUDs
silk_home=${SILK_HOME:-$HOME/.silk}
release=${SILK_RELEASE:-}
channel=${SILK_CHANNEL:-auto}

fail() {
  printf 'silk-install: %s\n' "$*" >&2
  exit 1
}

for tool in curl tar uname mktemp cmp ln; do
  command -v "$tool" > /dev/null 2>&1 || fail "this installer needs $tool"
done

case "$channel" in
  auto | stable | dev) ;;
  *) fail "SILK_CHANNEL must be auto, stable, or dev" ;;
esac
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

# api PATH OUTPUT writes the response body to OUTPUT. A 404 returns 4 so callers can tell a
# missing release apart from every other failure, which must never switch channels.
# Network and server errors are retried; a rate limit fails and says when it resets.
api() {
  request=1
  while :; do
    if [ -n "${GITHUB_TOKEN:-}" ]; then
      status=$(curl -sS -D "$tmp/headers" -o "$2" -w '%{http_code}' \
        -H 'Accept: application/vnd.github+json' -H "Authorization: Bearer $GITHUB_TOKEN" \
        "https://api.github.com/repos/$repo/$1") || status=000
    else
      status=$(curl -sS -D "$tmp/headers" -o "$2" -w '%{http_code}' \
        -H 'Accept: application/vnd.github+json' \
        "https://api.github.com/repos/$repo/$1") || status=000
    fi
    case "$status" in
      200) return 0 ;;
      404) return 4 ;;
      403 | 429)
        rate_limited && fail_rate_limited
        fail "GitHub release API returned HTTP $status for $1$(api_message "$2")"
        ;;
      000 | 5??)
        if [ "$request" -ge 4 ]; then
          [ "$status" != 000 ] || fail "cannot reach the GitHub release API"
          fail "GitHub release API returned HTTP $status for $1; try again in a few minutes"
        fi
        sleep "$request"
        request=$((request + 1))
        ;;
      *) fail "GitHub release API returned HTTP $status for $1$(api_message "$2")" ;;
    esac
  done
}

# GitHub reports both the primary limit (remaining 0) and secondary limits (retry-after).
rate_limited() {
  grep -Eiq '^x-ratelimit-remaining:[[:space:]]*0[[:space:]]*$|^retry-after:' "$tmp/headers"
}

fail_rate_limited() {
  reset=$(tr -d '\r' < "$tmp/headers" | sed -n 's/^[Xx]-[Rr]ate[Ll]imit-[Rr]eset:[[:space:]]*\([0-9][0-9]*\).*/\1/p' | tail -n 1)
  retry_in=
  if [ -n "$reset" ]; then
    retry_in=$(( (reset - $(date +%s) + 59) / 60 ))
    [ "$retry_in" -ge 1 ] || retry_in=1
    retry_in=" for about $retry_in more minute$([ "$retry_in" = 1 ] || echo s)"
  fi
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    fail "GitHub API rate limit reached for this GITHUB_TOKEN$retry_in; try again later"
  fi
  fail "GitHub API rate limit reached for unauthenticated requests from this network$retry_in; try again later, or set GITHUB_TOKEN to raise the limit"
}

# The "message" field of a GitHub error response, for error reports.
api_message() {
  message=$(tr -d '\r\n' < "$1" | sed -n 's/.*"message"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  [ -z "$message" ] || printf ': %s' "$message"
}

select_dev() {
  : > "$tmp/dev-tags"
  page=1
  while :; do
    # GitHub's release listing sometimes answers 200 with an empty list, most often right after
    # a release is published. An empty first page is retried rather than read as "no releases".
    attempt=1
    while :; do
      api "releases?per_page=100&page=$page" "$tmp/listing.json" || fail "cannot list the releases of $repo"
      count=$(grep -o '"tag_name"' "$tmp/listing.json" | wc -l | tr -d ' ')
      [ "$count" = 0 ] && [ "$page" = 1 ] || break
      [ "$attempt" -lt 5 ] ||
        fail "GitHub keeps returning an empty release list for $repo; try again in a minute"
      sleep "$attempt"
      attempt=$((attempt + 1))
    done
    grep -Eo '"tag_name"[[:space:]]*:[[:space:]]*"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-dev\.[1-9][0-9]*\+[a-f0-9]{12}"' "$tmp/listing.json" |
      cut -d'"' -f4 | cut -c2- >> "$tmp/dev-tags" || true
    [ "$count" -ge 100 ] || break
    page=$((page + 1))
  done
  # POSIX numeric keys order core and dev counter; no platform-specific sort -V.
  LC_ALL=C sort -t. -k1,1nr -k2,2nr -k3,3nr -k4,4nr "$tmp/dev-tags" > "$tmp/sorted-dev-tags"
  while IFS= read -r candidate; do
    encoded=$(printf '%s' "$candidate" | sed 's/+/%2B/g')
    api "releases/tags/v$encoded" "$tmp/metadata.json" || fail "cannot inspect dev release v$candidate"
    if grep -Eq '"draft"[[:space:]]*:[[:space:]]*false' "$tmp/metadata.json" &&
      grep -Eq '"prerelease"[[:space:]]*:[[:space:]]*true' "$tmp/metadata.json"; then
      release="v$candidate"
      return 0
    fi
  done < "$tmp/sorted-dev-tags"
  fail "$repo has no published dev compiler release"
}

sha256() {
  if command -v sha256sum > /dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Darwin)
    # A shell under Rosetta reports x86_64 on an Apple silicon Mac.
    if [ "$arch" = x86_64 ] && [ "$(sysctl -n sysctl.proc_translated 2> /dev/null || echo 0)" = 1 ]; then
      arch=arm64
    fi
    case "$arch" in
      arm64 | aarch64) target=aarch64-apple-darwin ;;
      *) fail "Silk has no build for Intel Macs yet" ;;
    esac
    ;;
  Linux)
    case "$arch" in
      x86_64 | amd64) target=x86_64-unknown-linux-gnu ;;
      aarch64 | arm64) target=aarch64-unknown-linux-gnu ;;
      *) fail "Silk has no build for Linux on $arch yet" ;;
    esac
    ;;
  *) fail "Silk has no build for $os yet" ;;
esac

if [ -n "$release" ]; then
  release_path=$(printf '%s' "$release" | sed 's/+/%2B/g')
  api "releases/tags/$release_path" "$tmp/metadata.json" || fail "$repo has no release $release"
elif [ "$channel" = dev ]; then
  select_dev
elif api releases/latest "$tmp/metadata.json"; then
  release=$(grep -o '"tag_name": *"v[^"]*"' "$tmp/metadata.json" | cut -d'"' -f4) || true
  [ -n "$release" ] || fail "the latest release is not a v<version> compiler release"
  grep -Eq '"prerelease"[[:space:]]*:[[:space:]]*false' "$tmp/metadata.json" ||
    fail "the latest release is not stable"
  core=${release%%+*}
  case "$core" in *-*) fail "the latest release is not stable" ;; esac
else
  status=$?
  [ "$status" = 4 ] && [ "$channel" = auto ] ||
    fail "$repo has no stable compiler release yet; use SILK_CHANNEL=dev or SILK_RELEASE"
  select_dev
fi
grep -Eq '"draft"[[:space:]]*:[[:space:]]*false' "$tmp/metadata.json" ||
  fail "draft releases cannot be installed"
case "$release" in v[0-9]*) ;; *) fail "not a compiler release tag: $release" ;; esac
reported_tag=$(grep -o '"tag_name": *"[^"]*"' "$tmp/metadata.json" | cut -d'"' -f4) || true
[ "$reported_tag" = "$release" ] || fail "GitHub returned a different release tag"

# The full version, including +commit metadata, names the archive and its top directory.
release_path=$(printf '%s' "$release" | sed 's/+/%2B/g')
version=${release#v}
archive="silk-$version-$target.tar.gz"
encoded_archive=$(printf '%s' "$archive" | sed 's/+/%2B/g')
top=${archive%.tar.gz}
url="https://github.com/$repo/releases/download/$release_path/$encoded_archive"

printf 'Downloading %s from %s\n' "$archive" "$release"
curl -fSL --progress-bar -o "$tmp/$archive" "$url" || fail "cannot download $url"
if command -v minisign > /dev/null 2>&1; then
  # A missing signature fails too: deleting it must not downgrade verification.
  curl -fsSL -o "$tmp/$archive.minisig" "$url.minisig" ||
    fail "cannot download the signature of $archive"
  comment=$(minisign -V -P "$minisign_public_key" -m "$tmp/$archive" -x "$tmp/$archive.minisig" -Q) ||
    fail "$archive is not signed by the Silk release key"
  [ "$comment" = "silk $release $archive" ] ||
    fail "the signature of $archive belongs to a different release or file: $comment"
  printf 'Verified the minisign signature of %s\n' "$archive"
else
  printf 'minisign is not installed; skipping the signature check of %s\n' "$archive"
fi
mkdir "$tmp/unpacked"
tar -xzf "$tmp/$archive" -C "$tmp/unpacked" || fail "cannot unpack $archive"
# The compiler is `bin/silkc`, beside the silk tool `bin/silk`; earlier releases hold only the
# compiler, as `bin/silk`.
compiler=bin/silkc
[ -f "$tmp/unpacked/$top/$compiler" ] || compiler=bin/silk
[ -f "$tmp/unpacked/$top/$compiler" ] && [ -d "$tmp/unpacked/$top/lib/silk/stdlib" ] ||
  fail "$archive does not hold bin/silkc and lib/silk/stdlib"

# Every compiler release publishes a verified per-target pin; never silently skip verification.
curl -fsSL -o "$tmp/native-seed.json" \
  "https://github.com/$repo/releases/download/$release_path/native-seed.json" ||
  fail "cannot download native-seed.json for $release"
expected=$(tr -d ' \t\r\n' < "$tmp/native-seed.json" | grep -o "\"$target\":{[^}]*}" |
  grep -o '"sha256":"[0-9a-f]*"' | cut -d'"' -f4) || true
[ -n "$expected" ] || fail "native-seed.json of $release names no compiler for $target"
actual=$(sha256 "$tmp/unpacked/$top/$compiler")
[ "$actual" = "$expected" ] || fail "$compiler has SHA-256 $actual, but $release names $expected"
[ "$("$tmp/unpacked/$top/$compiler" --version)" = "silk v$version" ] ||
  fail "the compiler does not report the requested version $version"
[ -f "$tmp/unpacked/$top/lib/silk/changes-snapshot.toml" ] ||
  fail "the compiler archive has no published change snapshot"
curl -fsSL -o "$tmp/changes-snapshot.toml" \
  "https://github.com/$repo/releases/download/$release_path/changes-snapshot.toml" ||
  fail "cannot download the published change snapshot for $release"
cmp -s "$tmp/changes-snapshot.toml" "$tmp/unpacked/$top/lib/silk/changes-snapshot.toml" ||
  fail "the embedded change snapshot differs from the published release"

# Stage beside the toolchains so the final rename stays on one file system. A reinstall replaces
# the whole directory, so stale standard-library files go away.
toolchains="$silk_home/toolchains"
toolchain="$toolchains/$version"
mkdir -p "$toolchains" "$silk_home/bin"
staging="$toolchains/.install-$$"
rm -rf "$staging"
mv "$tmp/unpacked/$top" "$staging" || fail "cannot stage the toolchain in $toolchains"
chmod 0755 "$staging/$compiler"
# The toolchain keeps only the compiler; the tool moves to `$SILK_HOME/bin`.
tool=
if [ "$compiler" = bin/silkc ] && [ -f "$staging/bin/silk" ]; then
  tool="$tmp/silk"
  mv "$staging/bin/silk" "$tool" || fail "cannot stage the silk tool"
  chmod 0755 "$tool"
fi
rm -rf "$toolchain"
mv "$staging" "$toolchain" || fail "cannot move the toolchain into $toolchain"

# The tool is a real file beside the store, staged and renamed into place so the name always holds
# a whole program. Its first command runs the installed compiler, which checks that it forwards.
# A release from before the rename has no tool; `bin/silk` links to its compiler instead. The
# `bin/sew` an earlier release installed goes either way.
if [ -n "$tool" ]; then
  cp "$tool" "$silk_home/bin/.silk-$$" || fail "cannot copy silk to $silk_home/bin"
  chmod 0755 "$silk_home/bin/.silk-$$"
  [ "$(SILK_HOME="$silk_home" SILK_TOOLCHAIN="$version" "$silk_home/bin/.silk-$$" --version)" = "silk v$version" ] || {
    rm -f "$silk_home/bin/.silk-$$"
    fail "the silk tool does not run the installed compiler $version"
  }
  mv -f "$silk_home/bin/.silk-$$" "$silk_home/bin/silk" || fail "cannot install $silk_home/bin/silk"
else
  ln -sfn "$toolchain/$compiler" "$silk_home/bin/silk" || fail "cannot link $silk_home/bin/silk"
fi
rm -f "$silk_home/bin/sew"

# Make the toolchain the default, keeping `auto-install`.
auto_install=
if [ -f "$silk_home/settings.toml" ] &&
  grep -Eq '^[[:space:]]*auto-install[[:space:]]*=[[:space:]]*true[[:space:]]*(#.*)?$' "$silk_home/settings.toml"; then
  auto_install='auto-install = true'
fi
{
  printf '# Written by install.sh.\ndefault = "%s"\n' "$version"
  [ -z "$auto_install" ] || printf '%s\n' "$auto_install"
} > "$silk_home/settings.toml.$$"
mv "$silk_home/settings.toml.$$" "$silk_home/settings.toml"

printf '\nInstalled %s to %s\n' "$("$toolchain/$compiler" --version 2> /dev/null || echo silk)" "$toolchain"
if [ -n "$tool" ]; then
  printf 'It is the default Silk version. Installed the silk tool to %s/bin/silk.\n' "$silk_home"
  printf 'silk runs each project with the Silk version it pins: silk build, silk test, silk run.\n'
  printf 'Update the tool with: silk update self\n'
else
  printf 'It is the default toolchain; %s/bin/silk links to its compiler. This release has no silk tool.\n' "$silk_home"
fi

# Silk hands Clang LLVM 22 bitcode, which older Clang misreads.
clang=${SILK_CLANG:-clang}
if ! command -v "$clang" > /dev/null 2>&1; then
  printf '\nSilk needs Clang 22 or newer to build programs. Put it on PATH, or set SILK_CLANG to it.\n'
else
  clang_version=$("$clang" --version 2> /dev/null | head -n 1)
  major=$(printf '%s\n' "$clang_version" | sed -n 's/.*clang version \([0-9][0-9]*\).*/\1/p')
  if [ -z "$major" ] || [ "$major" -lt 22 ]; then
    printf '\nSilk needs Clang 22 or newer, but %s is: %s\n' "$clang" "$clang_version"
    printf 'Put LLVM 22 or newer on PATH, or set SILK_CLANG to its clang.\n'
  fi
fi

case ":$PATH:" in
  *":$silk_home/bin:"*) ;;
  *)
    case "${SHELL:-}" in
      */zsh) rc='~/.zshrc' ;;
      */bash) if [ "$os" = Darwin ]; then rc='~/.bash_profile'; else rc='~/.bashrc'; fi ;;
      *) rc='your shell profile' ;;
    esac
    printf '\nAdd Silk to your PATH by adding this line to %s:\n\n' "$rc"
    printf '  export PATH="%s/bin:$PATH"\n\n' "$silk_home"
    ;;
esac
