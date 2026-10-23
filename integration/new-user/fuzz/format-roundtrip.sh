#!/bin/bash
# roundtrip.sh <package> <workdir>: formats a copy of a package that checks clean, then checks the
# formatted copy is stable, still checks, and runs with the same output.
src=$1; w=$2/$(basename $(dirname $src))-$(basename $src)
rm -rf "$w"; mkdir -p "$w"; cp -r "$src/silk.toml" "$src/src" "$w/" 2>/dev/null || exit 0
cd "$w"
timeout 60 silk check --quiet > /dev/null 2>&1 || exit 0
timeout 30 silk run --quiet > before.out 2> /dev/null < /dev/null; b=$?
cp -r src src.orig
timeout 60 silk format > fmt1.log 2>&1 || { echo "FORMAT-FAILED $w $(head -1 fmt1.log)"; exit 0; }
cp -r src src.once
timeout 60 silk format > fmt2.log 2>&1
diff -r src.once src > /dev/null || echo "NOT-IDEMPOTENT $w"
timeout 60 silk check --quiet > check.log 2>&1 || echo "BROKE-CHECK $w $(grep -m1 'error\[' check.log)"
timeout 30 silk run --quiet > after.out 2> /dev/null < /dev/null; a=$?
[ $a = $b ] && cmp -s before.out after.out || echo "CHANGED-OUTPUT $w status $b->$a"
