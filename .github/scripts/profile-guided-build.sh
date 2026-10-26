#!/usr/bin/env bash
# Builds the compiler profile-guided, as rustc's release builds are. PRODUCER builds an instrumented
# compiler from SOURCE; the instrumented compiler checks a copy of WORKSPACE's compiler package and
# emits SOURCE's LLVM IR, recording a profile of both; PRODUCER then builds OUTPUT with Clang
# optimizing by that profile. Both builds take the same BUILD_ARGS, so the profile describes exactly
# the code OUTPUT is built from, and OUTPUT is still checked like any other build of SOURCE.
#
# usage: profile-guided-build.sh WORKDIR PRODUCER WORKSPACE SOURCE OUTPUT [BUILD_ARGS...]
# SILK_CLANG names the Clang to build with, and llvm-profdata must sit beside it. WORKSPACE is the
# source tree holding compiler/ and stdlib/; it is copied, never written. WORKDIR must not exist.
set -euo pipefail
if [ "$#" -lt 5 ]; then
  echo "usage: profile-guided-build.sh WORKDIR PRODUCER WORKSPACE SOURCE OUTPUT [BUILD_ARGS...]" >&2
  exit 2
fi
workdir=$1 producer=$2 workspace=$3 source=$4 output=$5
shift 5
clang=${SILK_CLANG:?SILK_CLANG must name the Clang to build with}
profdata="$(dirname "$clang")/llvm-profdata"
test -x "$profdata" || { echo "profile-guided-build: no llvm-profdata beside $clang" >&2; exit 1; }
mkdir "$workdir" "$workdir/profiles"
workdir=$(cd "$workdir" && pwd)

# The flags reach every Clang invocation, linking included, so the instrumented compiler links the
# profile runtime.
cat > "$workdir/clang-generate" <<EOF
#!/bin/sh
exec '$clang' -fprofile-generate -Wno-unused-command-line-argument "\$@"
EOF
cat > "$workdir/clang-use" <<EOF
#!/bin/sh
exec '$clang' '-fprofile-use=$workdir/compiler.profdata' -Wno-profile-instr-unprofiled \\
  -Wno-profile-instr-out-of-date -Wno-backend-plugin -Wno-unused-command-line-argument "\$@"
EOF
chmod +x "$workdir/clang-generate" "$workdir/clang-use"

SILK_CLANG="$workdir/clang-generate" "$producer" build "$source" -o "$workdir/instrumented" "$@"

# Training: a cold check of the compiler package, then the compiler's own IR. Neither runs Clang.
cp -R "$workspace" "$workdir/training"
(cd "$workdir/training/compiler" &&
  LLVM_PROFILE_FILE="$workdir/profiles/check-%p.profraw" \
    "$workdir/instrumented" check --stdlib ../stdlib --progress never > /dev/null)
LLVM_PROFILE_FILE="$workdir/profiles/emit-%p.profraw" \
  "$workdir/instrumented" build "$source" -o "$workdir/training.ll" --emit llvm-ir "$@"
"$profdata" merge -o "$workdir/compiler.profdata" "$workdir"/profiles/*.profraw

SILK_CLANG="$workdir/clang-use" "$producer" build "$source" -o "$output" "$@"
