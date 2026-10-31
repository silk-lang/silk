#!/usr/bin/env bash
# Diagnostic source controls: one N1 binary, isolated source trees, unchanged replay budgets.
set -euo pipefail
compiler=$1
out=$2
baseline=$3
mkdir -p "$out"
git rev-parse HEAD > "$out/source-commit.txt"
git rev-parse "$baseline" > "$out/baseline-commit.txt"
for variant in baseline feature without-encoder-body; do
  root="$out/$variant"
  mkdir -p "$root"
  revision=HEAD
  if [ "$variant" = baseline ]; then revision=$baseline; fi
  git archive "$revision" stdlib compiler/fixtures/stdlib-root compiler/fixtures/replay | tar -x -C "$root"
  cp "$root/compiler/fixtures/stdlib-root/"{silk.toml,stdlib_check.silk} "$root/stdlib/"
  if [ "$variant" = without-encoder-body ]; then
    python3 - "$root/stdlib/silk/platform/windows/wtf8.silk" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
source = path.read_text()
signature = 'pub effect fn encode(units: &[u16]) -> Bytes ! OutOfMemoryError ? &mut Allocator {'
assert source.count(signature) == 1
start = source.index(signature) + len(signature)
end = source.index('\n  }\n', start)
path.write_text(source[:start] + '\n    fail OutOfMemoryError {}' + source[end:])
PY
  fi
  (
    cd "$root/stdlib"
    "$compiler" check --stdlib "$root/stdlib" --replay "$root/compiler/fixtures/replay/stdlib.toml" --differential
  ) > "$out/$variant.log" 2>&1
  if [ "$variant" != without-encoder-body ]; then
    (
      cd "$root/stdlib"
      "$compiler" check --stdlib "$root/stdlib" --replay "$root/compiler/fixtures/replay/stdlib-long.toml"
    ) > "$out/$variant-long.log" 2>&1
  fi
done
cat "$out/"*.log
