#!/usr/bin/env bash
# Compile current compiler sources with an existing Linux N1 and current production DLL exports.
set -euo pipefail
compiler=$1
out=$2
mkdir -p "$out"
git rev-parse HEAD > "$out/source-commit.txt"
cp compiler/silk.toml "$out/original-silk.toml"
trap 'cp "$out/original-silk.toml" compiler/silk.toml' EXIT
# An older N1 knows only the exports present when it was compiled. Extract the .def strings
# from the compiler being built, without maintaining a fixture copy of the production supply.
python3 - "$out" <<'PY'
from pathlib import Path
import re
import subprocess
import sys
import textwrap
import tomllib
out = Path(sys.argv[1]).resolve()
source = Path('compiler/src/driver/WindowsLink.silk').read_text()
definitions = re.findall(r'fn (\w+)\(\) -> string<\x27static> \{\s*return """(.*?)"""', source, re.S)
libraries = []
for name, content in definitions:
    definition = textwrap.dedent(content).strip() + '\n'
    if not definition.startswith('LIBRARY '):
        continue
    path = out / (name + '.def')
    path.write_text(definition)
    library = out / (name + '.lib')
    subprocess.run(['llvm-dlltool', '-m', 'i386:x86-64', '-d', str(path), '-l', str(library)], check=True)
    libraries.append('{ static-archive = "' + library.as_posix() + '" }')
assert libraries, 'No production Windows import definitions found'
manifest = Path('compiler/silk.toml')
original = manifest.read_text()
assert 'native' not in tomllib.loads(original), 'Preserve newly authored native configuration explicitly'
manifest.write_text(original + '\n[native]\nlink = [' + ', '.join(libraries) + ']\n')
PY
"$compiler" build compiler/src/main.silk -o "$out/silk.exe" \
  --target x86_64-pc-windows-msvc --stdlib "$PWD/stdlib" --clang "$SILK_TEST_CLANG" \
  --optimization speed --debug false 2>&1 | tee "$out/build.log"
llvm-readobj --file-headers --coff-imports "$out/silk.exe" > "$out/pe.txt"
! grep 'Name: .*\.dll' "$out/pe.txt" | grep -viE 'Name: (kernel32|ntdll|bcryptprimitives|api-ms-win-core-synch-l1-2-0)\.dll'
