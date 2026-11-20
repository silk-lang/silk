#!/usr/bin/env bash
# Usage: bash .github/scripts/measure-trace-off.sh COMPILER CLANG [probe|trace]
# Exit 1 if any pair differs. A compiler error stops the experiment immediately.
set -euo pipefail
compiler=${1:?pass the compiler to measure}
clang=${2:?pass the path to clang}
repo=$(cd "$(dirname "$0")/../.." && pwd)
fixture="$repo/compiler/fixtures/trace-off"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
stdlib="$work/stdlib"
cp -R "$repo/stdlib" "$stdlib"
mode=${3:-probe}
case $mode in
  probe)
    source="$fixture/main.silk"
    erase=(-e '/^import silk\.probe /s/./ /g' -e '/let _guard = span(/s/./ /g')
    cp "$fixture/probe.silk" "$stdlib/silk/probe.silk"
    ;;
  trace)
    source="$fixture/manual.silk"
    erase=(-e '/\/\/ observation[[:space:]]*$/s/./ /g')
    ;;
  *) echo "unknown identity fixture: $3" >&2; exit 2 ;;
esac
different=0

# Keep the source path, output path and line offsets identical for debug info.
for target in native wasm; do
  for profile in debug release; do
    mir_flags=(--stdlib "$stdlib")
    if [[ $profile == debug ]]; then
      mir_flags+=(--optimization none --debug true)
    else
      mir_flags+=(--optimization speed --debug false)
    fi
    if [[ $target == native ]]; then
      flags=("${mir_flags[@]}" --clang "$clang" --emit object)
    else
      mir_flags+=(--target wasm32-unknown-unknown)
      flags=("${mir_flags[@]}" --backend direct)
    fi
    for variant in traced control; do
      if [[ $variant == traced ]]; then
        cp "$source" "$work/main.silk"
      else
        sed "${erase[@]}" "$source" > "$work/main.silk"
      fi
      "$compiler" build "$work/main.silk" -o "$work/artifact" "${flags[@]}"
      if [[ $target == wasm ]]; then
        node "$repo/stdlib/host/wasm-runner.mjs" "$work/artifact"
      fi
      if [[ $mode == trace && $variant == traced ]]; then
        # Object symbols can be content hashes. Check their source identities and the
        # ambient-slot intrinsic in the target's entire reached MIR as well as the artifact.
        "$compiler" dump mir --all "$work/main.silk" "${mir_flags[@]}" > "$work/reached.mir"
        if grep -E 'silk[/.]trace[/.]| = ambientSlot' "$work/reached.mir" >&2; then
          echo "$target $profile: tracing or an ambient slot survived in reached MIR" >&2
          different=1
        fi
        if LC_ALL=C grep -aqE 'silk[/.]trace[/.]' "$work/artifact"; then
          echo "$target $profile: tracing symbol survived in the artifact" >&2
          different=1
        fi
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
