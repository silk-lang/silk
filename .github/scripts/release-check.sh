#!/usr/bin/env bash
# Checks one target's release archive on that target: the archive's compiler emits its own LLVM
# IR, which must be the IR N1 emitted on Linux (a self-host fixpoint of the shipped bytes on real
# hardware). With `tool`, it also rebuilds the silk tool, which must be the archive's bytes: one
# full link on the target proves the link is deterministic and takes nothing from the host's SDK.
# Writes the target's chain receipt and seed candidate under OUTPUT/candidate.
#
# usage: release-check.sh TOP TARGET SNAPSHOT CROSS N1_SHA256 PROFILE_GUIDED OUTPUT [tool]
# TOP is the unpacked archive, CROSS the cross job's directory (its <target>/compiler.ll.sha256),
# PROFILE_GUIDED true or false. The tool rebuild needs SILK_CLANG. OUTPUT must not exist.
set -euo pipefail
if [ "$#" -lt 7 ] || [ "$#" -gt 8 ]; then
  echo "usage: release-check.sh TOP TARGET SNAPSHOT CROSS N1_SHA256 PROFILE_GUIDED OUTPUT [tool]" >&2
  exit 2
fi
top=$(cd "$1" && pwd)
target=$2 snapshot=$(cd "$3" && pwd) cross=$(cd "$4" && pwd) n1=$5 profileGuided=$6
mkdir "$7"
output=$(cd "$7" && pwd)
root=$(cd "$(dirname "$0")/../.." && pwd)
suffix=
if [ "$target" = x86_64-pc-windows-msvc ]; then suffix=.exe; fi
args=(--target "$target" --stdlib ../stdlib --optimization speed --debug false)
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

(cd "$snapshot/compiler" && env -u SDKROOT "$top/bin/silkc$suffix" build src/main.silk -o "$output/compiler.ll" \
  --emit llvm-ir "${args[@]}")
status=0
producerIr=$(cat "$cross/$target/compiler.ll.sha256")
outputIr=$(sha "$output/compiler.ll")
if [ "$producerIr" != "$outputIr" ]; then
  echo "::error title=Compiler IR differs::N1 on Linux emitted $producerIr for $target, the archive's compiler $outputIr"
  status=1
fi
if [ "${8:-}" = tool ]; then
  (cd "$snapshot/tool" && env -u SDKROOT SILK_CLANG="${SILK_CLANG:?the tool rebuild needs SILK_CLANG}" \
    "$top/bin/silkc$suffix" build src/main.silk -o "$output/silk$suffix" "${args[@]}")
  rm -rf "$output"/*.units "$output"/*.symbols
  if ! cmp "$output/silk$suffix" "$top/bin/silk$suffix"; then
    echo "::error title=Tool rebuild differs::$target did not rebuild the archive's silk tool byte for byte"
    status=1
  fi
fi
node "$root/compiler/scripts/SourceSnapshot.mjs" verify "$snapshot" > /dev/null
if [ "$status" != 0 ]; then exit 1; fi
rm "$output/compiler.ll"

version=$(cat "$cross/version.txt")
compilerSha=$(sha "$top/bin/silkc$suffix")
jq -n --arg target "$target" --slurpfile snapshot "$snapshot/input-snapshot.json" --argjson pgo "$profileGuided" \
  --arg n1 "$n1" --arg n2 "$compilerSha" --arg producerIr "$producerIr" --arg outputIr "$outputIr" \
  '{schemaVersion: 2, status: "passed", target: $target,
    profile: {optimization: "speed", debug: false, profileGuided: $pgo},
    inputs: ($snapshot[0] | {sourceCommit, normalizedDigest, archiveSha256, files, projection: (.projection // null)}),
    origin: "linux-cross-target-ir-fixpoint",
    producer: {generation: "N1", sha256: $n1}, output: {generation: "N2", sha256: $n2},
    fixpoint: {producerIrSha256: $producerIr, outputIrSha256: $outputIr}}' > "$output/chain-receipt.json"
mkdir "$output/candidate"
cp "$top/bin/silkc$suffix" "$output/candidate/silk-compiler-$target$suffix"
cp "$output/chain-receipt.json" "$output/candidate/chain-receipt-$target.json"
node "$root/compiler/scripts/NativeSeed.mjs" candidate "$output/chain-receipt.json" "${GITHUB_RUN_ID:?}" "v$version" \
  > "$output/candidate/native-seed-$target.json"
