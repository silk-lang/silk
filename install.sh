#!/bin/sh
# Installs the newest stable Silk compiler release, or an explicitly selected prerelease.
#
#   curl -fsSL https://raw.githubusercontent.com/silk-lang/silk/main/install.sh | sh
#
# Compiler releases are tagged `v<version>`, with one `silk-<version>-<target>.tar.gz` per target.
# The default matches `silk changes since`: GitHub's latest stable release, never a bootstrap
# seed or an automatically selected beta/rc. The compiler's SHA-256 and reported version are
# checked before installing into `$SILK_INSTALL` (default `~/.silk`):
# `bin/silk` beside its standard library in `lib/silk/stdlib`.
# Downloads made by curl carry no macOS quarantine mark, so Gatekeeper lets the compiler run.
#
# Environment:
#   SILK_INSTALL   install directory (default: ~/.silk)
#   SILK_RELEASE   explicit release tag, such as v0.1.0 or v0.2.0-beta.1
#   GITHUB_TOKEN   optional; raises the GitHub API rate limit
set -eu

repo=silk-lang/silk
install_dir=${SILK_INSTALL:-$HOME/.silk}
release=${SILK_RELEASE:-}

fail() {
  printf 'silk-install: %s\n' "$*" >&2
  exit 1
}

for tool in curl tar uname mktemp; do
  command -v "$tool" > /dev/null 2>&1 || fail "this installer needs $tool"
done

api() {
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    curl -fsSL -H 'Accept: application/vnd.github+json' -H "Authorization: Bearer $GITHUB_TOKEN" \
      "https://api.github.com/repos/$repo/$1"
  else
    curl -fsSL -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$repo/$1"
  fi
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

# GitHub's latest release excludes drafts and prereleases.
if [ -z "$release" ]; then
  metadata=$(api releases/latest) || fail "cannot find a stable compiler release; select a published prerelease with SILK_RELEASE"
  release=$(printf '%s\n' "$metadata" | grep -o '"tag_name": *"v[^"]*"' | cut -d'"' -f4) || true
  [ -n "$release" ] || fail "the latest release is not a v<version> compiler release"
else
  release_path=$(printf '%s' "$release" | sed 's/+/%2B/g')
  metadata=$(api "releases/tags/$release_path") || fail "cannot find release $release"
fi

# Preserve SemVer build metadata in a URL path.
release_path=$(printf '%s' "$release" | sed 's/+/%2B/g')
url=$(printf '%s\n' "$metadata" |
  grep -o "\"browser_download_url\": *\"[^\"]*/silk-[^/\"]*-$target\\.tar\\.gz\"" |
  head -n 1 | cut -d'"' -f4) || true
[ -n "$url" ] || fail "release $release has no archive for $target"
archive=${url##*/}
top=${archive%.tar.gz}
version=${release#v}
[ "$archive" = "silk-${version%%+*}-$target.tar.gz" ] ||
  fail "archive $archive does not match release $release"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

printf 'Downloading %s from %s\n' "$archive" "$release"
curl -fSL --progress-bar -o "$tmp/$archive" "$url" || fail "cannot download $url"
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
