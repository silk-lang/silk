#!/usr/bin/env bash
# The compiler workspace must compile identically from its ordinary build and its emitted request.
set -euo pipefail
compiler=$1
repository=$(cd "$(dirname "$0")/../.." && pwd)
output=$(mktemp -d)
trap 'rm -rf "$output"' EXIT
"$compiler" request-schema > "$output/request.schema.json"
cmp "$repository/stdlib/silk/build/request.schema.json" "$output/request.schema.json"
"$compiler" build "$repository/compiler/src/main.silk" -o "$output/compiler.ll" \
  --emit llvm-ir --stdlib "$repository/stdlib"
mv "$output/compiler.ll" "$output/expected.ll"
"$compiler" compile --request "$output/requests/compiler.ll.toml"
cmp "$output/expected.ll" "$output/compiler.ll"
