#!/usr/bin/env bash
# Check the programs cross-build-corpus.sh linked without a sysroot: each loads through
# <interpreter>, needs only libraries Silk's glibc stubs stand in for, and asks for no glibc
# symbol version newer than 2.28.
#
# usage: inspect-glibc-programs.sh <directory> <interpreter>
set -euo pipefail
root=$1
interpreter=$2
count=0
failures=0
for program in "$root"/*/program; do
  count=$((count + 1))
  headers=$(llvm-readelf --program-headers --dynamic --version-info "$program")
  problems=
  if ! grep -qF "[Requesting program interpreter: $interpreter]" <<< "$headers"; then
    problems="$problems interpreter"
  fi
  for library in $(grep -o 'Shared library: \[[^]]*\]' <<< "$headers" | sed 's/.*\[\(.*\)\]/\1/'); do
    case "$library" in
      libc.so.6 | libpthread.so.0 | libm.so.6 | libdl.so.2 | libgcc_s.so.1) ;;
      *) problems="$problems needs:$library" ;;
    esac
  done
  for version in $(grep -o 'GLIBC_2\.[0-9.]*' <<< "$headers" | sort -u); do
    minor=${version#GLIBC_2.}
    if [ "${minor%%.*}" -gt 28 ]; then problems="$problems $version"; fi
  done
  if [ -n "$problems" ]; then
    echo "FAIL ${program#"$root"/}:$problems"
    failures=$((failures + 1))
  fi
done
echo "Inspected $count programs linked without a sysroot, $failures failed"
test "$count" -gt 0
test "$failures" = 0
