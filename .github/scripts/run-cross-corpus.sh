#!/usr/bin/env bash
# Run the programs cross-build-corpus.sh wrote, each in its own empty directory, and require the
# exit code and standard output the corpus expects.
#
# usage: run-cross-corpus.sh <directory> [launcher...]
set -euo pipefail
root=$(cd "$1" && pwd)
shift
failures=0
total=0
# macOS ships no `timeout`.
limit=
if command -v timeout > /dev/null; then limit="timeout 120"; fi
for directory in "$root"/*/; do
  name=$(basename "$directory")
  total=$((total + 1))
  scratch=$(mktemp -d)
  logs=$(mktemp -d)
  chmod +x "$directory/program"
  status=0
  (cd "$scratch" && $limit ${1+"$@"} "$directory/program" > "$logs/stdout" 2> "$logs/stderr") || status=$?
  expected=$(cat "$directory/exit-code")
  if [ "$status" != "$expected" ]; then
    echo "FAIL $name: exit $status, expected $expected"
    sed 's/^/  /' "$logs/stderr" | head -20
    failures=$((failures + 1))
  elif [ -f "$directory/expected.stdout" ] && ! cmp -s "$directory/expected.stdout" "$logs/stdout"; then
    echo "FAIL $name: standard output differs"
    diff "$directory/expected.stdout" "$logs/stdout" | head -20 || true
    failures=$((failures + 1))
  fi
  rm -rf -- "$scratch" "$logs"
done
echo "Ran $total cross-built programs, $failures failed"
test "$total" -gt 0
test "$failures" = 0
