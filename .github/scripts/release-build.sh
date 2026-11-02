#!/usr/bin/env bash
# Builds one target's release binaries from an exact source snapshot: the compiler as `silkc` and
# the silk tool as `silk` (`.exe` on Windows), and the compiler's LLVM IR as `compiler.ll`, all
# with the release profile. The Linux release job runs it with N1 for every target; each target's
# runner then checks the result with release-check.sh. Everything that reaches the bytes is fixed here: the flags, the output names (a link
# records them), the profile and the platform supply (`SDKROOT` is ignored, so a Mac links against
# Silk's libSystem stub as Linux does).
#
# usage: release-build.sh COMPILER TARGET SNAPSHOT PROFILE OUTPUT
# PROFILE is the Clang profile (`.profdata`) the compiler is optimized by, or `-` for none; the
# tool is never profile guided. SILK_CLANG names the Clang to build with. OUTPUT must not exist.
set -euo pipefail
if [ "$#" -ne 5 ]; then
  echo "usage: release-build.sh COMPILER TARGET SNAPSHOT PROFILE OUTPUT" >&2
  exit 2
fi
compiler=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
target=$2 snapshot=$3 profile=$4 output=$5
clang=${SILK_CLANG:?SILK_CLANG must name the Clang to build with}
suffix=
if [ "$target" = x86_64-pc-windows-msvc ]; then suffix=.exe; fi
mkdir "$output"
output=$(cd "$output" && pwd)
snapshot=$(cd "$snapshot" && pwd)
args=(--target "$target" --stdlib ../stdlib --optimization speed --debug false)

compilerClang=$clang
if [ "$profile" != - ]; then
  profile=$(cd "$(dirname "$profile")" && pwd)/$(basename "$profile")
  # The flags profile-guided-build.sh optimizes with, on every Clang invocation.
  mkdir "$output/.clang"
  cat > "$output/.clang/clang-use" <<EOF
#!/bin/sh
exec '$clang' '-fprofile-use=$profile' -Wno-profile-instr-unprofiled \\
  -Wno-profile-instr-out-of-date -Wno-backend-plugin -Wno-unused-command-line-argument "\$@"
EOF
  chmod +x "$output/.clang/clang-use"
  compilerClang=$output/.clang/clang-use
fi

(cd "$snapshot/compiler" && env -u SDKROOT SILK_CLANG="$compilerClang" "$compiler" build src/main.silk \
  -o "$output/silkc$suffix" "${args[@]}")
(cd "$snapshot/compiler" && env -u SDKROOT "$compiler" build src/main.silk -o "$output/compiler.ll" --emit llvm-ir "${args[@]}")
(cd "$snapshot/tool" && env -u SDKROOT SILK_CLANG="$clang" "$compiler" build src/main.silk -o "$output/silk$suffix" "${args[@]}")
rm -rf "$output/.clang" "$output"/*.units "$output"/*.symbols
