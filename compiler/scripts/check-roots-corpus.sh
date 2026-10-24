#!/bin/bash
# Runs `silk check --roots` on every corpus program, each as a one-module package, and prints the
# programs whose module check roots disagree with the whole-package check.
# Usage: compiler/scripts/check-roots-corpus.sh <silk> <stdlib> [jobs]
set -u
silk=$(realpath "$1")
stdlib=$(realpath "$2")
jobs=${3:-4}
corpus=$(realpath "$(dirname "$0")/../../corpus")
out=$(mktemp -d)
one() {
  case=$1
  work=$(mktemp -d)
  cp -r "$case"/. "$work"/
  rm -f "$work/outcome.json"
  printf '[package]\nname = "corpus-case"\nversion = "0.1.0"\nsource = "."\n' > "$work/silk.toml"
  name=$(echo "${case#"$corpus"/}" | tr / _)
  (cd "$work" && "$silk" check --roots --stdlib "$stdlib" > /dev/null 2> "$out/$name")
  rm -rf "$work"
}
export -f one
export silk stdlib corpus out
find "$corpus" -name main.silk -printf '%h\n' | sort | xargs -P "$jobs" -I{} bash -c 'one {}'
checked=$(grep -l '^silk-check-roots modules=' "$out"/* | wc -l)
differing=$(grep -L '^silk-check-roots .*differences=0$' $(grep -l '^silk-check-roots modules=' "$out"/*))
echo "check-roots: $checked programs compared"
status=0
for file in $differing; do
  echo "differs: $(basename "$file")"
  grep '^silk-check-roots only=' "$file"
  status=1
done
rm -rf "$out"
exit $status
