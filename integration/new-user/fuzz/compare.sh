#!/bin/bash
# compare.sh <generator.py> <seed> <workdir>: generates a program and its expected output, runs it
# with the `silk` on PATH in debug and release, and prints a MISMATCH line for each difference.
generator=$1; seed=$2; w=$3/p$seed
mkdir -p "$w/src"
printf '[package]\nname = "fz"\nversion = "0.1.0"\nroot = "src/main.silk"\n' > "$w/silk.toml"
python3 -I "$generator" "$seed" "$w/src/main.silk" "$w/expected.txt"
for mode in debug release; do
  flag=""; [ $mode = release ] && flag=--release
  (cd "$w" && timeout 120 silk run --quiet $flag > $mode.out 2> $mode.err; echo $? > $mode.status)
  if ! cmp -s "$w/$mode.out" "$w/expected.txt"; then
    echo "MISMATCH seed=$seed mode=$mode status=$(cat "$w/$mode.status") $(grep -m1 'error\|trap\|unsupported' "$w/$mode.err")"
  fi
done
