#!/bin/sh
# usage: selfbuild.sh <worktree> <output>
export PATH=/home/julia/silk/.scratch/llvm-22.1.8/bin:$PATH SILKC_CLANG=/home/julia/silk/.scratch/llvm-22.1.8/bin/clang
cd "$1" && /home/julia/silk-tools/silkc-2d109766 build "$1/compiler/src/main.silk" -o "$2" --stdlib "$1/packages/compiler/stdlib" --optimization speed > "$2.log" 2>&1
echo "exit $?" >> "$2.log"
