#!/usr/bin/env bash
# Native companion for the filesystem provider, invoked by the shared Windows cross-build.
set -euo pipefail
compiler=$1
out=$2
repo=$PWD
clang=${SILK_TEST_CLANG:-clang}
mkdir -p "$out/package/src"
out=$(cd "$out" && pwd)
cp "$repo/compiler/fixtures/windows-filesystem/provider.silk" "$out/package/src/main.silk"
mkdir -p "$out/package/src/driver"
cp "$repo/compiler/src/driver/CommandPath.silk" "$out/package/src/driver/"
cp "$repo/compiler/src/driver/HostRename.silk" "$repo/compiler/src/driver/DetachedWriter.silk" "$out/package/src/driver/"
mkdir -p "$out/package/src/documentation"
cp "$repo/compiler/src/documentation/Publication.silk" "$out/package/src/documentation/"
"$clang" --target=x86_64-pc-windows-msvc -O2 -ffreestanding -fno-stack-protector \
  -c "$repo/compiler/fixtures/windows-filesystem/contract.c" -o "$out/package/contract.obj"
llvm-dlltool -m i386:x86-64 -d "$repo/compiler/fixtures/windows-filesystem/kernel32.def" -l "$out/package/fixture-kernel32.lib"
cat > "$out/package/silk.toml" <<'MANIFEST'
[package]
name = "windows-filesystem-contract"
version = "0.0.0"
silk-version = "0.0.0"

[native]
link = [
  { object = "contract.obj" },
  { static-archive = "fixture-kernel32.lib" },
]
MANIFEST
"$compiler" build "$out/package/src/main.silk" -o "$out/provider.exe" --target x86_64-pc-windows-msvc \
  --stdlib "$repo/stdlib" --clang "$clang" --optimization none --debug false \
  > "$out/provider-build.log" 2>&1 || { cat "$out/provider-build.log"; exit 1; }
llvm-readobj --file-headers --coff-imports "$out/provider.exe" > "$out/provider-pe.txt"
grep -q 'IMAGE_FILE_MACHINE_AMD64' "$out/provider-pe.txt"
grep -q 'IMAGE_SUBSYSTEM_WINDOWS_CUI' "$out/provider-pe.txt"
grep -qi 'Name: ntdll.dll' "$out/provider-pe.txt"
if grep -i 'Name: .*\.dll' "$out/provider-pe.txt" | grep -viE 'Name: (kernel32|ntdll)\.dll'; then
  echo 'Unexpected DLL dependency in filesystem provider' >&2
  exit 1
fi
printf '%s\n' 'Built provider.exe; execution remains not-checked until run.ps1 -SilkExecutable.'
