#!/bin/bash
# usage: exp.sh COMPILER file.silk  -> gap line and probe masks of emitted regions bodies
source /tmp/claude-0/-home-user-silk/d9ccf688-4f2f-5c3e-8b5f-ab0dafd01db4/scratchpad/env.sh
src=$(realpath "$2")
out=$(mktemp -d)
mkdir -p $out/memory
cp "$src" $out/memory/driver.silk
printf '[package]\nname = "corpus"\nroot = "main.silk"\n' > $out/silk.toml
(cd $out && "$1" build memory/driver.silk -o p.ll --emit llvm-ir --stdlib /home/user/silk/packages/compiler/stdlib --optimization none --debug false > log 2>&1; echo "exit $?")
grep -v "PROBE R3" $out/log | head -40
python3 /tmp/claude-0/-home-user-silk/d9ccf688-4f2f-5c3e-8b5f-ab0dafd01db4/scratchpad/tools/census.py $out/log | sed -n '1p;/top masks/,$p'
rm -rf $out
