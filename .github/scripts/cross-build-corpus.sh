#!/usr/bin/env bash
# Cross-build the self-contained native corpus programs for another target with an existing N1,
# as packages whose manifest names the target's platform supply, or none when it is empty. Writes
# one directory per program under <output>: the executable `program`, `exit-code` and any
# `expected.stdout`.
#
# usage: cross-build-corpus.sh <compiler> <target> <output> <platform-supply TOML or ''> [programs...]
# Without programs, every corpus program that needs no C units, splices, profiles, runs,
# libraries or components and completes normally is built.
set -euo pipefail
compiler=$1
target=$2
mkdir -p "$3"
output=$(cd "$3" && pwd)
supply=$4
shift 4
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
if [ "$#" -gt 0 ]; then
  printf '%s\n' "$@" > "$work/programs"
else
  python3 - > "$work/programs" <<'PY'
import json
import os
from pathlib import Path
allowed = {'main.silk', 'outcome.json', 'expected.stdout', 'reference.silk'}
for directory in sorted(Path('corpus/native').iterdir()):
    outcome = directory / 'outcome.json'
    if not outcome.is_file() or not set(os.listdir(directory)) <= allowed:
        continue
    # The corpus harness expands `/*@splice ...*/` markers; these programs need it.
    if '/*@' in (directory / 'main.silk').read_text():
        continue
    data = json.loads(outcome.read_text())
    if set(data) == {'expected', 'schemaVersion'} and data['expected'].get('kind') == 'completes':
        print(directory.name)
PY
fi
build() {
  local name=$1
  local package="$work/$name"
  mkdir -p "$package" "$output/$name"
  cp "corpus/native/$name/main.silk" "$package/main.silk"
  printf '[package]\nname = "corpus"\nversion = "0.0.0"\nsource = "."\n' > "$package/silk.toml"
  if [ -n "$supply" ]; then printf '\n[native]\nplatform-supply = %s\n' "$supply" >> "$package/silk.toml"; fi
  if ! "$compiler" build "$package/main.silk" -o "$output/$name/program" --target "$target" --stdlib "$PWD/stdlib" \
    --optimization none --debug false > "$package/build.log" 2>&1; then
    echo "FAIL $name"
    sed 's/^/  /' "$package/build.log"
    rm -rf -- "$output/$name"
    return 1
  fi
  python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["expected"]["exitCode"])' \
    "corpus/native/$name/outcome.json" > "$output/$name/exit-code"
  if [ -f "corpus/native/$name/expected.stdout" ]; then cp "corpus/native/$name/expected.stdout" "$output/$name/"; fi
  echo "BUILT $name"
}
export -f build
export compiler target output supply work
status=0
xargs -P "$(getconf _NPROCESSORS_ONLN)" -I{} bash -c 'build "$1"' _ {} < "$work/programs" > "$work/log" || status=$?
grep -v '^BUILT ' "$work/log" || true
echo "Built $(grep -c '^BUILT ' "$work/log" || true) of $(wc -l < "$work/programs") programs for $target"
exit "$status"
