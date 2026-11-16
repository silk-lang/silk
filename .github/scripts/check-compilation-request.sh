#!/usr/bin/env bash
# The compiler workspace must compile identically from its ordinary build and its emitted request.
set -euo pipefail
compiler=$1
repository=$(cd "$(dirname "$0")/../.." && pwd)
output=$(mktemp -d)
trap 'rm -rf "$output"' EXIT
"$compiler" request-schema > "$output/request.schema.json"
cmp "$repository/stdlib/silk/build/request.schema.json" "$output/request.schema.json"
node "$repository/compiler/scripts/CompilationBuild.ts" --compiler "$compiler" \
  --manifest "$repository/compiler/silk.toml" --output "$output/compiler.ll" \
  --emit llvm-ir --stdlib "$repository/stdlib"
mv "$output/compiler.ll" "$output/expected.ll"
"$compiler" compile --request "$output/compiler.ll.request.toml"
cmp "$output/expected.ll" "$output/compiler.ll"
