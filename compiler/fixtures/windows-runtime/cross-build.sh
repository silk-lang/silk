#!/usr/bin/env bash
# Uses the already-built N1, never builds another compiler or runs the native corpus.
set -uo pipefail
compiler=$1
out=$2
mkdir -p "$out"
git rev-parse HEAD > "$out/source-commit.txt"
printf 'program\tcompile\tpe-imports\texecution\n' > "$out/results.tsv"
failed=0
for program in hello storage host-check; do
  source="$PWD/compiler/fixtures/windows-runtime/$program.silk"
  # Retain actual Silk output and the helpers its unoptimized object requires. This inventory
  # distinguishes emitted dependencies from the broader handwritten compiler-rt risk fixture.
  if "$compiler" build "$source" -o "$out/$program.ll" --emit llvm-ir --target x86_64-pc-windows-msvc \
      --stdlib "$PWD/stdlib" --optimization none --debug false > "$out/$program-ir.log" 2>&1 \
      && "$SILK_TEST_CLANG" --target=x86_64-pc-windows-msvc -O0 -c "$out/$program.ll" -o "$out/$program.obj" \
        > "$out/$program-object.log" 2>&1; then
    llvm-nm --undefined-only "$out/$program.obj" > "$out/$program-undefined.txt"
  else
    cat "$out/$program-ir.log"
    failed=1
  fi
  if "$compiler" build "$source" -o "$out/$program.exe" --target x86_64-pc-windows-msvc \
      --stdlib "$PWD/stdlib" --clang "$SILK_TEST_CLANG" --optimization none --debug false > "$out/$program-build.log" 2>&1; then
    if llvm-readobj --file-headers --coff-imports "$out/$program.exe" > "$out/$program-pe.txt" \
        && grep -q 'IMAGE_FILE_MACHINE_AMD64' "$out/$program-pe.txt" \
        && grep -q 'IMAGE_SUBSYSTEM_WINDOWS_CUI' "$out/$program-pe.txt" \
        && ! grep 'Name: .*\.dll' "$out/$program-pe.txt" | grep -viE 'Name: (kernel32|ntdll)\.dll'; then
      printf '%s\tpass\tpass\tnot-checked: requires real Windows\n' "$program" >> "$out/results.tsv"
    else
      printf '%s\tpass\tfail\tnot-checked: invalid PE\n' "$program" >> "$out/results.tsv"
      failed=1
    fi
  else
    printf '%s\tfail\tnot-checked\tnot-checked: compilation failed\n' "$program" >> "$out/results.tsv"
    cat "$out/$program-build.log"
    failed=1
  fi
done
cat "$out/results.tsv"
exit "$failed"
