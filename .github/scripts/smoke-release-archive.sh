#!/usr/bin/env bash
# Installs a release archive the way a user would and runs a new project through it: the compiler
# `bin/silkc` directly, then the silk tool `bin/silk` forwarding to the same compiler as an
# installed toolchain. An installed compiler finds `lib/silk/stdlib`, the clang on PATH and, on
# macOS, its SDK through xcrun discovery by itself.
# usage: smoke-release-archive.sh <archive> <version> <empty work directory>
set -euo pipefail
archive=$1
version=$2
work=$3
tar -xzf "$archive" -C "$work"
top=$(echo "$work"/silk-*)
test -x "$top/bin/silk"
test "$("$top/bin/silkc" --version)" = "silk v$version"
cd "$work"
env -u SILK_CLANG -u SDKROOT "$top/bin/silkc" init hello
grep -Fx "silk-version = \"$version\"" hello/silk.toml
# `run` reports the build on standard error, so standard output is the program's own.
output=$(cd hello && env -u SILK_CLANG -u SDKROOT "$top/bin/silkc" run)
test "$output" = 'Hello, world!'

# The archive's own layout, less the tool, is a toolchain in the store; the tool forwards to it.
home="$work/home"
mkdir -p "$home/toolchains" "$home/bin"
cp -a "$top" "$home/toolchains/$version"
rm "$home/toolchains/$version/bin/silk"
cp "$top/bin/silk" "$home/bin/silk"
export SILK_HOME="$home"
unset SILK_TOOLCHAIN
test "$("$home/bin/silk" "+$version" --version)" = "silk v$version"
# An unreleased build is 0.0.0, which is no pin, so it is selected by SILK_TOOLCHAIN instead.
if [ "$version" = 0.0.0 ]; then export SILK_TOOLCHAIN="$version"; fi
(cd hello && "$home/bin/silk" use which) | grep -F "$version"
output=$(cd hello && env -u SILK_CLANG -u SDKROOT "$home/bin/silk" run)
test "$output" = 'Hello, world!'
