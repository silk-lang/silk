#!/usr/bin/env bash
# Diagnostic source controls: one N1 binary, isolated source trees, unchanged replay budgets.
set -euo pipefail
compiler=$1
out=$2
baseline=$3
mkdir -p "$out"
git rev-parse HEAD > "$out/source-commit.txt"
git rev-parse "$baseline" > "$out/baseline-commit.txt"
for variant in baseline feature without-encoder-body without-encoder-and-path-bodies; do
  root="$out/$variant"
  mkdir -p "$root"
  revision=HEAD
  if [ "$variant" = baseline ]; then revision=$baseline; fi
  git archive "$revision" stdlib compiler/fixtures/stdlib-root compiler/fixtures/replay | tar -x -C "$root"
  cp "$root/compiler/fixtures/stdlib-root/"{silk.toml,stdlib_check.silk} "$root/stdlib/"
  if [[ "$variant" == without-encoder* ]]; then
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
  if [ "$variant" = without-encoder-and-path-bodies ]; then
    python3 - "$root/stdlib/silk/platform/windows/path.silk" <<'PY'
from pathlib import Path
import re
import sys
path = Path(sys.argv[1])
source = path.read_text()
for name in ('fromNative', 'fromNativeBytes', 'toNativeBytes', 'resolve', 'resolveBytes'):
    matches = list(re.finditer(r'pub effect fn ' + name + r'\([^)]*\)[^{]*\{', source))
    assert len(matches) == 1, name
    start = matches[0].end()
    end = source.index('\n  }\n', start)
    source = source[:start] + '\n    fail OutOfMemoryError {}' + source[end:]
path.write_text(source)
PY
  fi
  (
    cd "$root/stdlib"
    "$compiler" check --stdlib "$root/stdlib" --replay "$root/compiler/fixtures/replay/stdlib.toml" --differential
  ) > "$out/$variant.log" 2>&1
  if [ "$variant" = baseline ] || [ "$variant" = feature ]; then
    (
      cd "$root/stdlib"
      "$compiler" check --stdlib "$root/stdlib" --replay "$root/compiler/fixtures/replay/stdlib-long.toml"
    ) > "$out/$variant-long.log" 2>&1
  fi
done
cat "$out/"*.log
