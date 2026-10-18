#!/bin/sh
# Installs the Silk compiler from the newest published build of main.
#
#   curl -fsSL https://raw.githubusercontent.com/silk-lang/silk/main/install.sh | sh
#
# A manually published build of main is a `native-seed-<commit>` release holding one
# `silk-<version>-<target>.tar.gz` archive per target. This script picks the newest one for the
# running host, checks its compiler against the release's `native-seed.json`, and unpacks it into
# `$SILK_INSTALL` (default `~/.silk`): `bin/silk` beside the standard library in `lib/silk/stdlib`.
# Downloads made by curl carry no macOS quarantine mark, so Gatekeeper lets the compiler run.
#
# Environment:
#   SILK_INSTALL   install directory (default: ~/.silk)
#   SILK_RELEASE   a release tag to install instead of the newest build of main
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

# The most recently published `native-seed-*` release. The releases API does not list them by date,
# so read every page and compare `published_at` (ISO 8601, so it sorts as text). Each release's
# `tag_name` precedes its `published_at`; a draft's `published_at` is null and never matches.
if [ -z "$release" ]; then
  page=1
  found=
  while [ "$page" -le 20 ]; do
    tags=$(api "releases?per_page=100&page=$page") || fail "cannot list releases from GitHub"
    tags=$(printf '%s\n' "$tags" |
      grep -o '"tag_name": *"[^"]*"\|"published_at": *"[^"]*"' |
      awk -F'"' '$2 == "tag_name" { tag = $4; next } tag ~ /^native-seed-/ { print $4, tag } { tag = "" }') || true
    [ -n "$tags" ] || break
    found=$(printf '%s\n%s\n' "$found" "$tags")
    page=$((page + 1))
  done
  release=$(printf '%s\n' "$found" | grep . | sort -r | head -n 1 | cut -d' ' -f2) || true
  [ -n "$release" ] || fail "no published build of main found"
fi

url=$(api "releases/tags/$release" 2> /dev/null |
  grep -o "\"browser_download_url\": *\"[^\"]*/silk-[^/\"]*-$target\\.tar\\.gz\"" |
  head -n 1 | cut -d'"' -f4) || true
[ -n "$url" ] || fail "release $release has no archive for $target"
archive=${url##*/}
top=${archive%.tar.gz}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

printf 'Downloading %s from %s\n' "$archive" "$release"
curl -fSL --progress-bar -o "$tmp/$archive" "$url" || fail "cannot download $url"
mkdir "$tmp/unpacked"
tar -xzf "$tmp/$archive" -C "$tmp/unpacked" || fail "cannot unpack $archive"
[ -f "$tmp/unpacked/$top/bin/silk" ] && [ -d "$tmp/unpacked/$top/lib/silk/stdlib" ] ||
  fail "$archive does not hold bin/silk and lib/silk/stdlib"

# A seed release names each target compiler's SHA-256; release archives without one skip the check.
if curl -fsSL -o "$tmp/native-seed.json" \
  "https://github.com/$repo/releases/download/$release/native-seed.json" 2> /dev/null; then
  expected=$(tr -d ' \t\r\n' < "$tmp/native-seed.json" | grep -o "\"$target\":{[^}]*}" |
    grep -o '"sha256":"[0-9a-f]*"' | cut -d'"' -f4) || true
  [ -n "$expected" ] || fail "native-seed.json of $release names no compiler for $target"
  actual=$(sha256 "$tmp/unpacked/$top/bin/silk")
  [ "$actual" = "$expected" ] || fail "bin/silk has SHA-256 $actual, but $release names $expected"
fi

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
