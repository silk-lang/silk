#!/usr/bin/env bash
# Build with the test declarations owned by std without exporting them from the shipped library.
set -euo pipefail
compiler=$1
clang=$2
repository=$(cd "$(dirname "$0")/../.." && pwd)
fixture="$repository/compiler/fixtures/ambient-services"
output=$(mktemp -d)
trap 'rm -rf "$output"' EXIT
cp -R "$repository/stdlib" "$output/stdlib"
cp "$fixture/observation.silk" "$fixture/entries.silk" "$output/stdlib/silk/"

cat "$fixture/ownership.silk" >> "$output/stdlib/silk/concurrency/sync.silk"

for main in main entries-main ownership-main; do
  mkdir "$output/$main"
  cp "$fixture/$main.silk" "$output/$main/main.silk"
  "$compiler" build "$output/$main/main.silk" --stdlib "$output/stdlib" --clang "$clang" -o "$output/$main/native"
  "$output/$main/native"
  "$compiler" build "$output/$main/main.silk" --stdlib "$output/stdlib" --target wasm32-unknown-unknown --backend direct -o "$output/$main/program.wasm"
  node - "$output/$main/program.wasm" <<'JS'
const { readFileSync } = require('node:fs')
const { strictEqual } = require('node:assert')
const program = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(process.argv[2])))
strictEqual(program.exports.main(), 0)
JS
done

"$compiler" dump mir "$output/main/main.silk" --stdlib "$output/stdlib" > "$output/main.mir"
grep -F 'call silk/observation.Observation for Configured.record<i32>' "$output/main.mir"
if grep -Eq 'ambientSlot|threadSlot<' "$output/main.mir"; then
  echo 'a default-only ambient call reached a thread-local slot' >&2
  exit 1
fi
