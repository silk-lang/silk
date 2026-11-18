#!/usr/bin/env bash
# Builds the compiler profile-guided, as rustc's release builds are. PRODUCER builds an instrumented
# compiler from MANIFEST; the instrumented compiler checks a copy of WORKSPACE's compiler package and
# emits MANIFEST's LLVM IR, recording a profile of both; PRODUCER then builds OUTPUT with Clang
# optimizing by that profile. Both builds take the same BUILD_ARGS, so the profile describes exactly
# the code OUTPUT is built from, and OUTPUT is still checked like any other build of MANIFEST.
#
# usage: profile-guided-build.sh WORKDIR PRODUCER WORKSPACE MANIFEST OUTPUT [BUILD_ARGS...]
# OUTPUT `-` stops after training: the profile is WORKDIR/compiler.profdata.
# SILK_CLANG names the Clang to build with, and llvm-profdata must sit beside it. WORKSPACE is the
# source tree holding compiler/ and stdlib/; it is copied, never written. WORKDIR must not exist.
set -euo pipefail
if [ "$#" -lt 5 ]; then
  echo "usage: profile-guided-build.sh WORKDIR PRODUCER WORKSPACE MANIFEST OUTPUT [BUILD_ARGS...]" >&2
  exit 2
fi
workdir=$1 producer=$2 workspace=$3 manifest=$4 output=$5
shift 5
builder=$(cd "$(dirname "$0")/../.." && pwd)/compiler/scripts/CompilationBuild.ts
manifest=$(cd "$(dirname "$manifest")" && pwd)/$(basename "$manifest")
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

SILK_CLANG="$workdir/clang-generate" node "$builder" --compiler "$producer" --manifest "$manifest" --output "$workdir/instrumented" "$@"

# Training: a cold check of the compiler package, then the compiler's own IR. Neither runs Clang.
cp -R "$workspace" "$workdir/training"
(cd "$workdir/training/compiler" &&
  LLVM_PROFILE_FILE="$workdir/profiles/check-%p.profraw" \
    "$workdir/instrumented" check --stdlib ../stdlib --progress never > /dev/null)
LLVM_PROFILE_FILE="$workdir/profiles/emit-%p.profraw" \
  node "$builder" --compiler "$workdir/instrumented" --manifest "$manifest" --output "$workdir/training.ll" --emit llvm-ir "$@"
"$profdata" merge -o "$workdir/compiler.profdata" "$workdir"/profiles/*.profraw

if [ "$output" != - ]; then SILK_CLANG="$workdir/clang-use" node "$builder" --compiler "$producer" --manifest "$manifest" --output "$output" "$@"; fi
