#!/usr/bin/env bash
# Compile a host program with an existing Linux N1 and current production DLL exports.
set -euo pipefail
compiler=$1
out=$2
package=${3:-compiler}
case "$package" in compiler|tool) ;; *) echo "unsupported host package: $package" >&2; exit 2 ;; esac
mkdir -p "$out"
out=$(cd "$out" && pwd)
export SILK_CLANG="$SILK_TEST_CLANG"
git rev-parse HEAD > "$out/source-commit.txt"
# Extract imports from the source being built and declare them in the compilation definition.
python3 - "$out" "$package" <<'PY'
from pathlib import Path
import json
import re
import subprocess
import sys
import textwrap
out = Path(sys.argv[1]).resolve()
package = Path(sys.argv[2]).resolve()
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
    libraries.append('{kind="archive", value=' + json.dumps(str(library)) + ', weak=false, needed=false}')
assert libraries, 'No production Windows import definitions found'
programs = [('silk', 'main.silk', 'speed')]
if package.name == 'tool':
    programs += [('host-files', 'fixtures/WindowsHostFiles.silk', 'none'), ('install', 'fixtures/WindowsInstall.silk', 'none')]
for name, root, optimization in programs:
    text = f'manifest={json.dumps(str(package / "silk.toml"))}\nstdlib={json.dumps(str(Path("stdlib").resolve()))}\n'
    text += f'[settings]\nroot={json.dumps(str(package / "src" / root))}\nmodules=[]\n'
    text += f'[settings.profile]\ntarget="x86_64-pc-windows-msvc"\noptimization="{optimization}"\ndebug=false\n'
    text += '[settings.native]\nsources=[]\nlink=[' + ','.join(libraries) + ']\n'
    (out / (name + '.definition.toml')).write_text(text)
PY
programs=(silk)
if [ "$package" = tool ]; then programs+=(host-files install); fi
for program in "${programs[@]}"; do
  "$compiler" resolve --definition "$out/$program.definition.toml" --output "$out/$program.request.toml" --artifact "$out/$program.exe"
  "$compiler" compile --request "$out/$program.request.toml" 2>&1 | tee "$out/$program-build.log"
done
llvm-readobj --file-headers --coff-imports "$out/silk.exe" > "$out/pe.txt"
! grep 'Name: .*\.dll' "$out/pe.txt" | grep -viE 'Name: (kernel32|ntdll|bcryptprimitives|ws2_32|crypt32|api-ms-win-core-synch-l1-2-0)\.dll'
