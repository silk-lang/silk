#!/bin/sh
# Installs a stable or dev Silk compiler release, or an explicitly selected version.
#
#   curl -fsSL https://raw.githubusercontent.com/silk-lang/silk/main/install.sh | sh
#
# Compiler releases are tagged `v<version>`, with one `silk-<version>-<target>.tar.gz` per target.
# Auto selection prefers stable and uses dev only before a stable release exists.
# SILK_CHANNEL=dev follows published dev snapshots; drafts and bootstrap seeds are excluded.
# The compiler's SHA-256, reported version and embedded change snapshot are checked before
# installing `bin/silk` beside `lib/silk/stdlib` into `$SILK_INSTALL` (default `~/.silk`).
# When minisign is installed, the archive's signature must verify against the release key below.
# Downloads made by curl carry no macOS quarantine mark, so Gatekeeper lets the compiler run.
#
# Environment:
#   SILK_INSTALL   install directory (default: ~/.silk)
#   SILK_RELEASE   exact release tag, such as v0.1.0-dev.2+a1b2c3d4e5f6
#   SILK_CHANNEL   auto (default), stable, or dev; SILK_RELEASE selects an exact version
#   GITHUB_TOKEN   optional; raises the GitHub API rate limit
set -eu

repo=silk-lang/silk
# The release signing key, also published as minisign.pub at the repository root.
minisign_public_key=RWPLACEHOLDERPLACEHOLDERPLACEHOLDERPLACEHOLDERPLACEHOLDE
install_dir=${SILK_INSTALL:-$HOME/.silk}
release=${SILK_RELEASE:-}
channel=${SILK_CHANNEL:-auto}

fail() {
  printf 'silk-install: %s\n' "$*" >&2
  exit 1
}

for tool in curl tar uname mktemp cmp; do
  command -v "$tool" > /dev/null 2>&1 || fail "this installer needs $tool"
done

case "$channel" in
  auto | stable | dev) ;;
  *) fail "SILK_CHANNEL must be auto, stable, or dev" ;;
esac
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

# Keep 404 distinct: authorization failures and network errors must not switch channels.
api() {
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    status=$(curl -sS -o "$tmp/response.json" -w '%{http_code}' \
      -H 'Accept: application/vnd.github+json' -H "Authorization: Bearer $GITHUB_TOKEN" \
      "https://api.github.com/repos/$repo/$1") || fail "cannot reach the GitHub release API"
  else
    status=$(curl -sS -o "$tmp/response.json" -w '%{http_code}' \
      -H 'Accept: application/vnd.github+json' \
      "https://api.github.com/repos/$repo/$1") || fail "cannot reach the GitHub release API"
  fi
  case "$status" in
    200) cat "$tmp/response.json" ;;
    404) return 4 ;;
    *) fail "GitHub release API returned HTTP $status" ;;
  esac
}

select_dev() {
  : > "$tmp/dev-tags"
  page=1
  while :; do
    listing=$(api "releases?per_page=100&page=$page") || fail "cannot discover dev releases"
    printf '%s\n' "$listing" |
      grep -Eo '"tag_name"[[:space:]]*:[[:space:]]*"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-dev\.[1-9][0-9]*\+[a-f0-9]{12}"' |
      cut -d'"' -f4 | cut -c2- >> "$tmp/dev-tags" || true
    count=$(printf '%s\n' "$listing" | grep -o '"tag_name"' | wc -l | tr -d ' ')
    [ "$count" -ge 100 ] || break
    page=$((page + 1))
  done
  # POSIX numeric keys order core and dev counter; no platform-specific sort -V.
  LC_ALL=C sort -t. -k1,1nr -k2,2nr -k3,3nr -k4,4nr "$tmp/dev-tags" > "$tmp/sorted-dev-tags"
  while IFS= read -r candidate; do
    encoded=$(printf '%s' "$candidate" | sed 's/+/%2B/g')
    metadata=$(api "releases/tags/v$encoded") || fail "cannot inspect dev release v$candidate"
    if printf '%s\n' "$metadata" | grep -Eq '"draft"[[:space:]]*:[[:space:]]*false' &&
      printf '%s\n' "$metadata" | grep -Eq '"prerelease"[[:space:]]*:[[:space:]]*true'; then
      release="v$candidate"
      return 0
    fi
  done < "$tmp/sorted-dev-tags"
  fail "no published dev compiler release is available"
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
  metadata=$(api "releases/tags/$release_path") || fail "cannot find release $release"
elif [ "$channel" = dev ]; then
  select_dev
elif metadata=$(api releases/latest); then
  release=$(printf '%s\n' "$metadata" | grep -o '"tag_name": *"v[^"]*"' | cut -d'"' -f4) || true
  [ -n "$release" ] || fail "the latest release is not a v<version> compiler release"
  printf '%s\n' "$metadata" | grep -Eq '"prerelease"[[:space:]]*:[[:space:]]*false' ||
    fail "the latest release is not stable"
  core=${release%%+*}
  case "$core" in *-*) fail "the latest release is not stable" ;; esac
else
  status=$?
  [ "$status" = 4 ] && [ "$channel" = auto ] ||
    fail "cannot find a stable compiler release; use SILK_CHANNEL=dev or SILK_RELEASE"
  select_dev
fi
printf '%s\n' "$metadata" | grep -Eq '"draft"[[:space:]]*:[[:space:]]*false' ||
  fail "draft releases cannot be installed"
case "$release" in v[0-9]*) ;; *) fail "not a compiler release tag: $release" ;; esac
reported_tag=$(printf '%s\n' "$metadata" | grep -o '"tag_name": *"[^"]*"' | cut -d'"' -f4) || true
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
[ -f "$tmp/unpacked/$top/bin/silk" ] && [ -d "$tmp/unpacked/$top/lib/silk/stdlib" ] ||
  fail "$archive does not hold bin/silk and lib/silk/stdlib"

# Every compiler release publishes a verified per-target pin; never silently skip verification.
curl -fsSL -o "$tmp/native-seed.json" \
  "https://github.com/$repo/releases/download/$release_path/native-seed.json" ||
  fail "cannot download native-seed.json for $release"
expected=$(tr -d ' \t\r\n' < "$tmp/native-seed.json" | grep -o "\"$target\":{[^}]*}" |
  grep -o '"sha256":"[0-9a-f]*"' | cut -d'"' -f4) || true
[ -n "$expected" ] || fail "native-seed.json of $release names no compiler for $target"
actual=$(sha256 "$tmp/unpacked/$top/bin/silk")
[ "$actual" = "$expected" ] || fail "bin/silk has SHA-256 $actual, but $release names $expected"
[ "$("$tmp/unpacked/$top/bin/silk" --version)" = "silk v$version" ] ||
  fail "the compiler does not report the requested version $version"
[ -f "$tmp/unpacked/$top/lib/silk/changes-snapshot.toml" ] ||
  fail "the compiler archive has no published change snapshot"
curl -fsSL -o "$tmp/changes-snapshot.toml" \
  "https://github.com/$repo/releases/download/$release_path/changes-snapshot.toml" ||
  fail "cannot download the published change snapshot for $release"
cmp -s "$tmp/changes-snapshot.toml" "$tmp/unpacked/$top/lib/silk/changes-snapshot.toml" ||
  fail "the embedded change snapshot differs from the published release"

# Replace only what an earlier install put there, so stale standard-library files go away.
mkdir -p "$install_dir/bin" "$install_dir/lib"
rm -rf "$install_dir/bin/silk" "$install_dir/lib/silk"
mv "$tmp/unpacked/$top/bin/silk" "$install_dir/bin/silk"
mv "$tmp/unpacked/$top/lib/silk" "$install_dir/lib/silk"
chmod 0755 "$install_dir/bin/silk"
printf '%s\n' "$release" > "$install_dir/release"

printf '\nInstalled %s to %s/bin/silk\n' "$("$install_dir/bin/silk" --version 2> /dev/null || echo silk)" "$install_dir"

# Silk compiles through Clang; an older Clang may not read its LLVM 22 bitcode.
clang=${SILK_CLANG:-clang}
if ! command -v "$clang" > /dev/null 2>&1; then
  printf '\nSilk needs Clang 22 or newer to build programs. Put it on PATH, or set SILK_CLANG to it.\n'
else
  clang_version=$("$clang" --version 2> /dev/null | head -n 1)
  case "$clang_version" in
    *"Apple clang"*) old=yes ;;
    *)
      major=$(printf '%s\n' "$clang_version" | sed -n 's/.*version \([0-9][0-9]*\).*/\1/p')
      if [ -n "$major" ] && [ "$major" -ge 22 ]; then old=no; else old=yes; fi
      ;;
  esac
  if [ "$old" = yes ]; then
    printf '\nSilk needs Clang 22 or newer, but %s is: %s\n' "$clang" "$clang_version"
    printf 'Put LLVM 22 on PATH, or set SILK_CLANG to its clang.\n'
  fi
fi

case ":$PATH:" in
  *":$install_dir/bin:"*) ;;
  *)
    case "${SHELL:-}" in
      */zsh) rc='~/.zshrc' ;;
      */bash) if [ "$os" = Darwin ]; then rc='~/.bash_profile'; else rc='~/.bashrc'; fi ;;
      *) rc='your shell profile' ;;
    esac
    printf '\nAdd Silk to your PATH by adding this line to %s:\n\n' "$rc"
    printf '  export PATH="%s/bin:$PATH"\n\n' "$install_dir"
    ;;
esac
