#!/bin/bash
# run.sh <seed> <dir>: Silk vs Rust formatting for one generated program
seed=$1; w=$2/p$seed; mkdir -p $w/src
printf '[package]\nname = "nf"\nversion = "0.1.0"\nroot = "src/main.silk"\n' > $w/silk.toml
python3 -I $(dirname $0)/gen.py $seed $w/src/main.silk $w/ref.rs
rustc -O -o $w/ref $w/ref.rs 2> $w/rustc.err || { echo "RUSTC-FAILED $seed $(grep -m1 error $w/rustc.err)"; exit; }
$w/ref > $w/expected.txt
(cd $w && timeout 300 silk run --quiet > silk.out 2> silk.err; echo $? > status)
cmp -s $w/silk.out $w/expected.txt || echo "MISMATCH $seed status=$(cat $w/status) $(grep -m1 'error' $w/silk.err) diffs=$(diff $w/silk.out $w/expected.txt | grep -c '^<')"
