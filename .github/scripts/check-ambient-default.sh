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
cp "$fixture"/{observation,entries,counter,configured}.silk "$output/stdlib/silk/"

cat "$fixture/ownership.silk" >> "$output/stdlib/silk/concurrency/sync.silk"

for main in main entries-main ownership-main scoped-main table-main same-member-main cancellation-main scheduler-main thread-main pool-main; do
  mkdir "$output/$main"
  cp "$fixture/$main.silk" "$output/$main/main.silk"
  "$compiler" build "$output/$main/main.silk" --stdlib "$output/stdlib" --clang "$clang" -o "$output/$main/native"
  "$output/$main/native"
  if [[ $main == thread-main || $main == pool-main ]]; then
    project="$output/$main"
    mkdir "$project/src"
    cp "$project/main.silk" "$project/src/main.silk"
    cat > "$project/silk.toml" <<EOF
[package]
name = "$main"
version = "0.0.0"
silk-version = "0.0.0"
EOF
    cat > "$project/definition.toml" <<EOF
manifest = "$project/silk.toml"
name = "threaded"
artifact = "executable"
stdlib = "$output/stdlib"
[settings]
modules = []
[settings.profile]
target = "wasm32-unknown-unknown"
threading = "multi"
max-memory = 268435456
backend = "direct"
[settings.native]
sources = []
link = []
EOF
    "$compiler" resolve --definition "$project/definition.toml" --output "$project/threaded.toml" --artifact "$project/threaded.wasm"
    "$compiler" compile --request "$project/threaded.toml"
    node "$repository/stdlib/host/wasm-runner.mjs" "$project/threaded.wasm"
    continue
  fi
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

mkdir "$output/quiet"
cp "$fixture/quiet-main.silk" "$output/quiet/main.silk"
"$compiler" dump mir --all "$output/quiet/main.silk" --stdlib "$output/stdlib" > "$output/quiet.mir"
python3 - "$output/quiet.mir" <<'PYTEST'
from pathlib import Path
import sys
functions = Path(sys.argv[1]).read_text().split("\nfn ")
dispatcher, = (body for body in functions if body.startswith("silk/counter.Counter.add<any "))
assert " = ambientSlot" in dispatcher, "the provided service needs an indexed lookup"
assert " = null:" not in dispatcher, "a witness that cannot observe its service needs no slot masking"
PYTEST

mkdir "$output/rejected"
cp "$fixture/rejected-argument.silk" "$output/rejected/main.silk"
if "$compiler" build "$output/rejected/main.silk" --stdlib "$output/stdlib" --clang "$clang" -o "$output/rejected/native" > "$output/rejected.log" 2>&1; then
  echo 'static evaluation skipped an argument of a discarded ambient operation' >&2
  exit 1
fi
grep -F 'error[SEM0176]' "$output/rejected.log"

for rejected in rejected-provider rejected-parking rejected-concurrent; do
  cp "$fixture/$rejected.silk" "$output/rejected/main.silk"
  if "$compiler" build "$output/rejected/main.silk" --stdlib "$output/stdlib" --clang "$clang" -o "$output/rejected/provider" > "$output/provider.log" 2>&1; then
    echo "invalid ambient provider accepted in $rejected" >&2
    exit 1
  fi
  provide_line=$(grep -n 'Effect.provideAmbient' "$fixture/$rejected.silk" | cut -d: -f1)
  if [[ $rejected == rejected-concurrent ]]; then
    grep -E "rejected/main.silk:${provide_line}:[0-9]+: error\[SEM0121\].*Raw: Concurrent" "$output/provider.log"
  else
    grep -E "rejected/main.silk:${provide_line}:[0-9]+: error\[SEM0269\]" "$output/provider.log"
  fi
done

# A program can allocate, suspend, drive and drop executions without providing a service.
# Compare the emitted object with a build in which the capture branch is physically absent.
source="$repository/corpus/native/independent-execution-endpoint-drive/main.silk"
"$compiler" build "$source" --stdlib "$output/stdlib" --clang "$clang" -o "$output/drive"
"$output/drive"
cp -R "$output/stdlib" "$output/control-stdlib"
python3 - "$output/control-stdlib/silk/concurrency/execution.silk" <<'PY'
from pathlib import Path
import sys
source = Path(sys.argv[1])
lines = source.read_text().splitlines(keepends=True)
start, = [i for i, line in enumerate(lines) if line.strip() == "static if Intrinsic.ambientCount() > 0 {"]
end = next(i for i in range(start + 1, len(lines)) if lines[i] == "    }\n")
# Source locations in traps and diagnostics remain part of the code generation input.
lines[start:end + 1] = [" " * (len(line) - 1) + "\n" for line in lines[start:end + 1]]
source.write_text("".join(lines))
PY
"$compiler" build "$source" --stdlib "$output/control-stdlib" --clang "$clang" -o "$output/control"
cmp "$output/drive.units/"*.o "$output/control.units/"*.o
