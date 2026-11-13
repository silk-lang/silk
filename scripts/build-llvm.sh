#!/usr/bin/env bash
# Builds the LLVM that Silk releases ship: one multicall `llvm` executable holding Clang, lld and
# llvm-ar, for the three targets Silk generates code for, with Clang's resource headers. The
# multicall binary runs the tool its file name names; the compiler makes the links (`clang`,
# `ld.lld`, `ld64.lld`, `wasm-ld`, `lld-link`, `llvm-ar`, `llvm-dlltool`) on first use
# (compiler/src/driver/BundledLlvm.silk), so the release archive carries none.
#
# usage: build-llvm.sh SOURCE OUTPUT
# SOURCE is an unpacked llvm-project source release; OUTPUT must not exist. The result is:
#   OUTPUT/bin/llvm (llvm.exe on Windows)
#   OUTPUT/lib/clang/<major>/include
#   OUTPUT/LICENSE.TXT
# CC and CXX choose the host compiler (default cc and c++). On Linux, run it on the oldest glibc
# the release supports (manylinux_2_28): the executable links libstdc++ statically and needs only
# glibc. On macOS, MACOSX_DEPLOYMENT_TARGET defaults to 12.0, Silk's own default deployment.
set -euo pipefail
if [ "$#" -ne 2 ]; then
  echo "usage: build-llvm.sh SOURCE OUTPUT" >&2
  exit 2
fi
# Native Windows tools need `D:/...` paths, which Git Bash's `pwd -W` gives.
native_pwd() { case "$(uname -s)" in MINGW* | MSYS*) pwd -W ;; *) pwd ;; esac; }
source=$(cd "$1" && native_pwd)
output=$2
if [ -e "$output" ]; then
  echo "build-llvm.sh: $output already exists" >&2
  exit 2
fi
build=${LLVM_BUILD_DIRECTORY:-$source/build-silk}
jobs=${LLVM_BUILD_JOBS:-$(getconf _NPROCESSORS_ONLN 2> /dev/null || nproc)}
suffix=

flags=(
  -G Ninja
  -DCMAKE_BUILD_TYPE=Release
  -DCMAKE_C_COMPILER="${CC:-cc}"
  -DCMAKE_CXX_COMPILER="${CXX:-c++}"
  -DLLVM_ENABLE_PROJECTS="clang;lld"
  -DLLVM_TARGETS_TO_BUILD="X86;AArch64;WebAssembly"
  -DLLVM_TOOL_LLVM_DRIVER_BUILD=ON
  -DLLVM_ENABLE_ASSERTIONS=OFF
  -DLLVM_ENABLE_ZLIB=OFF
  -DLLVM_ENABLE_ZSTD=OFF
  -DLLVM_ENABLE_LIBXML2=OFF
  -DLLVM_ENABLE_LIBEDIT=OFF
  -DLLVM_ENABLE_LIBPFM=OFF
  -DLLVM_ENABLE_CURL=OFF
  -DLLVM_ENABLE_HTTPLIB=OFF
  -DLLVM_ENABLE_BINDINGS=OFF
  -DLLVM_ENABLE_PLUGINS=OFF
  -DLLVM_INCLUDE_TESTS=OFF
  -DLLVM_INCLUDE_BENCHMARKS=OFF
  -DLLVM_INCLUDE_EXAMPLES=OFF
  -DLLVM_INCLUDE_DOCS=OFF
  -DLLVM_INCLUDE_UTILS=OFF
  -DCLANG_INCLUDE_TESTS=OFF
  -DCLANG_INCLUDE_DOCS=OFF
  -DCLANG_ENABLE_STATIC_ANALYZER=OFF
  -DCLANG_ENABLE_OBJC_REWRITER=OFF
  -DCLANG_PLUGIN_SUPPORT=OFF
  -DCLANG_BUILD_TOOLS=OFF
  -DLLD_BUILD_TOOLS=ON
  # Other tools that would join the multicall binary.
  -DLLVM_TOOL_DSYMUTIL_BUILD=OFF
  -DLLVM_TOOL_LLVM_CGDATA_BUILD=OFF
  -DLLVM_TOOL_LLVM_CXXFILT_BUILD=OFF
  -DLLVM_TOOL_LLVM_DEBUGINFOD_BUILD=OFF
  -DLLVM_TOOL_LLVM_DEBUGINFOD_FIND_BUILD=OFF
  -DLLVM_TOOL_LLVM_DWP_BUILD=OFF
  -DLLVM_TOOL_LLVM_GSYMUTIL_BUILD=OFF
  -DLLVM_TOOL_LLVM_IFS_BUILD=OFF
  -DLLVM_TOOL_LLVM_LIBTOOL_DARWIN_BUILD=OFF
  -DLLVM_TOOL_LLVM_LIPO_BUILD=OFF
  -DLLVM_TOOL_LLVM_ML_BUILD=OFF
  -DLLVM_TOOL_LLVM_MT_BUILD=OFF
  -DLLVM_TOOL_LLVM_NM_BUILD=OFF
  -DLLVM_TOOL_LLVM_OBJCOPY_BUILD=OFF
  -DLLVM_TOOL_LLVM_OBJDUMP_BUILD=OFF
  -DLLVM_TOOL_LLVM_RC_BUILD=OFF
  -DLLVM_TOOL_LLVM_READOBJ_BUILD=OFF
  -DLLVM_TOOL_LLVM_READTAPI_BUILD=OFF
  -DLLVM_TOOL_LLVM_SIZE_BUILD=OFF
  -DLLVM_TOOL_LLVM_SYMBOLIZER_BUILD=OFF
  -DLLVM_TOOL_SANCOV_BUILD=OFF
  -DCLANG_TOOL_CLANG_SCAN_DEPS_BUILD=OFF
  -DCLANG_TOOL_CLANG_INSTALLAPI_BUILD=OFF
)
case "$(uname -s)" in
  Linux)
    flags+=(-DLLVM_STATIC_LINK_CXX_STDLIB=ON "-DCMAKE_EXE_LINKER_FLAGS=-static-libgcc -Wl,--gc-sections"
      "-DCMAKE_CXX_FLAGS=-ffunction-sections -fdata-sections" "-DCMAKE_C_FLAGS=-ffunction-sections -fdata-sections")
    ;;
  Darwin)
    flags+=(-DCMAKE_OSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-12.0}" "-DCMAKE_EXE_LINKER_FLAGS=-Wl,-dead_strip")
    ;;
  MINGW* | MSYS*)
    # Git Bash inside an MSVC developer environment (vcvars64), with CC and CXX `cl`. The static
    # CRT keeps the executable free of the Visual C++ redistributable.
    flags+=(-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded -DLLVM_BUILD_LLVM_C_DYLIB=OFF)
    suffix=.exe
    ;;
esac
cmake -S "$source/llvm" -B "$build" "${flags[@]}"
ninja -C "$build" -j "$jobs" llvm-driver clang-resource-headers

mkdir -p "$output/bin"
output=$(cd "$output" && native_pwd)
cp "$build/bin/llvm$suffix" "$output/bin/llvm$suffix"
# An MSVC executable keeps its symbols in a separate PDB already.
if [ -z "$suffix" ]; then strip "$output/bin/llvm" 2> /dev/null || strip -x "$output/bin/llvm"; fi
major=$(sed -n 's/^ *set(LLVM_VERSION_MAJOR \([0-9]*\)).*/\1/p' "$source/cmake/Modules/LLVMVersion.cmake")
mkdir -p "$output/lib/clang/$major"
cp -R "$build/lib/clang/$major/include" "$output/lib/clang/$major/include"
cp "$source/llvm/LICENSE.TXT" "$output/LICENSE.TXT"
"$output/bin/llvm$suffix" clang --version
