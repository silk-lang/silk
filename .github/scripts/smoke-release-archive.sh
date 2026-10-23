#!/usr/bin/env bash
# Installs a release archive the way a user would and runs a new project through it: the compiler
# directly, then sew and the `silk` proxy forwarding to the same compiler as an installed toolchain.
# An installed `silk` finds `lib/silk/stdlib`, the clang on PATH and, on macOS, its SDK through
# xcrun discovery by itself.
# usage: smoke-release-archive.sh <archive> <version> <empty work directory>
set -euo pipefail
archive=$1
version=$2
work=$3
tar -xzf "$archive" -C "$work"
top=$(echo "$work"/silk-*)
test "$("$top/bin/silk" --version)" = "silk v$version"
test "$("$top/bin/sew" --version)" = "sew $version"
cd "$work"
env -u SILK_CLANG -u SDKROOT "$top/bin/silk" init hello
grep -Fx "silk-version = \"$version\"" hello/silk.toml
# `run` reports the build on standard error, so standard output is the program's own.
output=$(cd hello && env -u SILK_CLANG -u SDKROOT "$top/bin/silk" run)
test "$output" = 'Hello, world!'

# The archive's own layout is a toolchain in the store; sew and the proxy forward to it.
home="$work/home"
mkdir -p "$home/toolchains" "$home/bin"
cp -a "$top" "$home/toolchains/$version"
cp "$top/bin/sew" "$home/bin/sew"
ln "$home/bin/sew" "$home/bin/silk"
export SILK_HOME="$home"
unset SILK_TOOLCHAIN
test "$("$home/bin/sew" "+$version" --version)" = "silk v$version"
# An unreleased build is 0.0.0, which is no pin, so it is selected by SILK_TOOLCHAIN instead.
if [ "$version" = 0.0.0 ]; then export SILK_TOOLCHAIN="$version"; fi
(cd hello && "$home/bin/sew" use which) | grep -F "$version"
output=$(cd hello && env -u SILK_CLANG -u SDKROOT "$home/bin/sew" run)
test "$output" = 'Hello, world!'
output=$(cd hello && env -u SILK_CLANG -u SDKROOT "$home/bin/silk" run)
test "$output" = 'Hello, world!'
