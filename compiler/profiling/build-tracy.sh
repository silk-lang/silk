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
# The compiler's path dependency `../changes` comes along so the copy resolves like the checkout.
cp -R "$repository/compiler" "$repository/changes" "$stage/"

profiler="$stage/compiler/src/Profiler.silk"
if [ "$(grep -c '^const enabled: bool = false$' "$profiler")" != 1 ]; then
  echo "Expected one 'const enabled: bool = false' in compiler/src/Profiler.silk" >&2
  exit 1
fi
sed -i.off 's/^const enabled: bool = false$/const enabled: bool = true/' "$profiler"
rm "$profiler.off"

mkdir "$stage/compiler/tracy"
"$clangxx" -c -O2 -std=c++17 -DTRACY_ENABLE -I "$tracy/public" \
  "$tracy/public/TracyClient.cpp" -o "$stage/compiler/tracy/TracyClient.o"
"$clang" -c -O2 -DTRACY_ENABLE -I "$tracy/public" \
  "$repository/compiler/profiling/silk_tracy.c" -o "$stage/compiler/tracy/silk_tracy.o"
"${AR:-$(dirname "$clang")/llvm-ar}" rcs "$stage/compiler/tracy/libsilk_tracy.a" \
  "$stage/compiler/tracy/silk_tracy.o" "$stage/compiler/tracy/TracyClient.o"

# `[build]` is the manifest's last table, so appended keys extend it.
manifest="$stage/compiler/silk.toml"
if [ "$(grep '^\[' "$manifest" | tail -n 1)" != '[build]' ]; then
  echo "Expected [build] to be the last table of compiler/silk.toml" >&2
  exit 1
fi
{
  echo 'native-link-inputs = ['
  echo '  { static-archive = "tracy/libsilk_tracy.a" },'
  for library in "${system[@]}"; do
    echo "  { library = \"$library\", mode = \"dynamic\" },"
  done
  echo ']'
} >> "$manifest"

mkdir -p "$(dirname "$output")"
(cd "$stage/compiler" && "$silk" build src/main.silk -o "$output" --stdlib "$repository/stdlib" \
  --clang "$clang" --optimization speed --debug false)
echo "Built $output; run it with TRACY_NO_EXIT=1 while the Tracy profiler or tracy-capture listens."
