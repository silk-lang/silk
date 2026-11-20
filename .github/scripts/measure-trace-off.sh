#!/usr/bin/env bash
# Usage: bash .github/scripts/measure-trace-off.sh COMPILER CLANG
# Exit 1 if any pair differs. A compiler error stops the experiment immediately.
set -euo pipefail
compiler=${1:?pass the compiler to measure}
clang=${2:?pass the path to clang}
repo=$(cd "$(dirname "$0")/../.." && pwd)
fixture="$repo/compiler/fixtures/trace-off"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp -R "$repo/stdlib" "$work/stdlib"
cp "$fixture/probe.silk" "$work/stdlib/silk/probe.silk"
different=0

# Keep the source path, output path and line offsets identical for debug info.
for target in native wasm; do
  for profile in debug release; do
    flags=(--stdlib "$work/stdlib" --clang "$clang")
    if [[ $profile == debug ]]; then
      flags+=(--optimization none --debug true)
    else
      flags+=(--optimization speed --debug false)
    fi
    if [[ $target == native ]]; then
      flags+=(--emit object)
    else
      flags+=(--target wasm32-unknown-unknown --backend direct)
    fi
    for variant in traced control; do
      if [[ $variant == traced ]]; then
        cp "$fixture/main.silk" "$work/main.silk"
      else
        sed -e '/^import silk\.probe /s/./ /g' -e '/let _guard = span(/s/./ /g' \
          "$fixture/main.silk" > "$work/main.silk"
      fi
      "$compiler" build "$work/main.silk" -o "$work/artifact" "${flags[@]}"
      if [[ $target == wasm ]]; then
        node "$repo/stdlib/host/wasm-runner.mjs" "$work/artifact"
      fi
      mv "$work/artifact" "$work/$variant"
    done
    result=identical
    if ! cmp -s "$work/traced" "$work/control"; then
      result=different
      different=1
    fi
    printf '%s %s: %s (control %s bytes, traced %s bytes)\n' "$target" "$profile" "$result" \
      "$(wc -c < "$work/control")" "$(wc -c < "$work/traced")"
  done
done
exit "$different"
