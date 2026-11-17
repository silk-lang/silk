#!/usr/bin/env bash
# Builds a compiler instrumented with Tracy zones (https://github.com/wolfpld/tracy).
#
#   compiler/profiling/build-tracy.sh [output]
#
# SILK names the compiler that builds it (default: `silk` on PATH) and CLANG the clang it links
# with (default: `clang` on PATH; clang++ must sit beside it). The checkout is never modified: a
# copy of the compiler under .scratch/tracy-build enables `Profiler.enabled` and links the Tracy
# client, so ordinary builds stay uninstrumented.
set -euo pipefail

version=v0.14.1
commit=30997d5ca6bb632cc10807a1da8a6d3de0aeeb3c

repository=$(cd "$(dirname "$0")/../.." && pwd)
output=${1:-$repository/.scratch/silk-tracy}
case "$output" in /*) ;; *) output="$PWD/$output" ;; esac
silk=$(command -v "${SILK:-silk}")
clang=$(command -v "${CLANG:-clang}")
clangxx="$(dirname "$clang")/clang++"
tracy="$repository/.scratch/tracy-$version"
stage="$repository/.scratch/tracy-build"

case "$(uname -s)" in
  Linux) system=(stdc++ pthread dl) ;;
  Darwin) system=(c++) ;;
  *)
    echo "Unsupported host: $(uname -s)" >&2
    exit 1
    ;;
esac

if [ ! -d "$tracy" ]; then
  mkdir -p "$repository/.scratch"
  temporary=$(mktemp -d "$repository/.scratch/.tracy-download.XXXXXX")
  trap 'rm -rf "$temporary"' EXIT
  git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$version" https://github.com/wolfpld/tracy "$temporary/tracy"
  if [ "$(git -C "$temporary/tracy" rev-parse HEAD)" != "$commit" ]; then
    echo "Tracy $version is not commit $commit" >&2
    exit 1
  fi
  mv "$temporary/tracy" "$tracy"
fi

rm -rf "$stage"
mkdir -p "$stage"
# The compiler's path dependency comes along so the copy resolves like the checkout.
cp -R "$repository/compiler" "$repository/tomledit" "$stage/"

profiler="$stage/compiler/src/Profiler.silk"
if [ "$(grep -c '^pub const enabled: bool = false$' "$profiler")" != 1 ]; then
  echo "Expected one 'pub const enabled: bool = false' in compiler/src/Profiler.silk" >&2
  exit 1
fi
sed -i.off 's/^pub const enabled: bool = false$/pub const enabled: bool = true/' "$profiler"
rm "$profiler.off"

mkdir "$stage/compiler/tracy"
"$clangxx" -c -O2 -std=c++17 -DTRACY_ENABLE -I "$tracy/public" \
  "$tracy/public/TracyClient.cpp" -o "$stage/compiler/tracy/TracyClient.o"
"$clang" -c -O2 -DTRACY_ENABLE -I "$tracy/public" \
  "$repository/compiler/profiling/silk_tracy.c" -o "$stage/compiler/tracy/silk_tracy.o"
"${AR:-$(dirname "$clang")/llvm-ar}" rcs "$stage/compiler/tracy/libsilk_tracy.a" \
  "$stage/compiler/tracy/silk_tracy.o" "$stage/compiler/tracy/TracyClient.o"

# Instrumentation is an explicit compilation input; the package manifest stays unchanged.
python3 - "$stage" "$repository/stdlib" "${system[@]}" <<'PYCODE'
from pathlib import Path
import json, sys
stage = Path(sys.argv[1])
links = ['{kind="archive", value=' + json.dumps(str(stage / 'compiler/tracy/libsilk_tracy.a')) + ', weak=false, needed=false}']
links += ['{kind="library", value=' + json.dumps(name) + ', mode="dynamic", weak=false, needed=false}' for name in sys.argv[3:]]
text = f'manifest={json.dumps(str(stage / "compiler/silk.toml"))}\nstdlib={json.dumps(sys.argv[2])}\n'
text += '[settings]\nmodules=[]\n[settings.profile]\noptimization="speed"\ndebug=false\n'
text += '[settings.native]\nsources=[]\nlink=[' + ','.join(links) + ']\n'
(stage / 'definition.toml').write_text(text)
PYCODE
mkdir -p "$(dirname "$output")"
export SILK_CLANG="$clang"
"$silk" resolve --definition "$stage/definition.toml" --output "$stage/request.toml" --artifact "$output"
"$silk" compile --request "$stage/request.toml"
echo "Built $output; run it with TRACY_NO_EXIT=1 while the Tracy profiler or tracy-capture listens."
