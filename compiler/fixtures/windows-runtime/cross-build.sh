#!/usr/bin/env bash
# Uses the already-built N1, never builds another compiler or runs the native corpus.
set -uo pipefail
compiler=$1
out=$2
mkdir -p "$out"
git rev-parse HEAD > "$out/source-commit.txt"
printf 'program\tcompile\tpe-imports\texecution\n' > "$out/results.tsv"
failed=0
for program in hello hello-speed storage host-check providers process console native-thread-spawn-join native-thread-cross-wake atomic-wait-notify native-termination-source-trap stderr-locked-message; do
  source="$PWD/compiler/fixtures/windows-runtime/$program.silk"
  optimization=none
  allowed_dlls='Name: (kernel32|ntdll)\.dll'
  case "$program" in
    process)
      source="$PWD/compiler/fixtures/windows-process/provider.silk"
      allowed_dlls='Name: (kernel32|ntdll|bcryptprimitives)\.dll'
      ;;
    hello-speed)
      source="$PWD/compiler/fixtures/windows-runtime/hello.silk"
      optimization=speed
      ;;
    native-termination-source-trap|stderr-locked-message)
      source="$PWD/corpus/native/$program/main.silk"
      ;;
    native-thread-*|atomic-*)
      source="$PWD/corpus/native/$program/main.silk"
      allowed_dlls='Name: (kernel32|ntdll|api-ms-win-core-synch-l1-2-0)\.dll'
      ;;
  esac
  package="$out/$program-package"
  mkdir -p "$package/src"
  cp "$source" "$package/src/main.silk"
  cat > "$package/silk.toml" <<EOF
[package]
name = "windows-$program-fixture"
version = "0.0.0"
silk-version = "0.0.0"
EOF
  source="$package/src/main.silk"
  if [ "$program" = console ]; then
    printf 'LIBRARY kernel32.dll\nEXPORTS\nSetStdHandle\nCreateConsoleScreenBuffer\nReadConsoleOutputCharacterW\nGetConsoleOutputCP\n' > "$package/fixture.def"
    cat >> "$package/silk.toml" <<'EOF'
[native]
link = [{ object = "companion.obj" }, { static-archive = "fixture.lib" }]
EOF
    if ! "$SILK_TEST_CLANG" --target=x86_64-pc-windows-msvc -O2 -ffreestanding -fno-stack-protector \
        -Wall -Wextra -Werror -c compiler/fixtures/windows-runtime/console-contract.c -o "$package/companion.obj" \
        || ! llvm-dlltool -m i386:x86-64 -d "$package/fixture.def" -l "$package/fixture.lib"; then
      printf 'console\tfail: console oracle\tnot-checked\tnot-checked\n' >> "$out/results.tsv"
      failed=1
      continue
    fi
  fi
  if [ "$program" = process ]; then
    printf 'LIBRARY kernel32.dll\nEXPORTS\nGetCommandLineW\nLocalFree\nGetEnvironmentVariableW\nGetStdHandle\nReadFile\nWriteFile\nGetCurrentProcess\nIsProcessInJob\nGetModuleFileNameW\nCreateProcessW\nCloseHandle\nSetEvent\nSleep\nExitProcess\n' > "$package/kernel32.def"
    printf 'LIBRARY shell32.dll\nEXPORTS\nCommandLineToArgvW\n' > "$package/shell32.def"
    if ! "$SILK_TEST_CLANG" --target=x86_64-pc-windows-msvc -O2 -ffreestanding -fno-stack-protector \
      -Wall -Wextra -Werror -c compiler/fixtures/windows-process/provider-child.c -o "$package/child.obj" \
      || ! llvm-dlltool -m i386:x86-64 -d "$package/kernel32.def" -l "$package/kernel32.lib" \
      || ! llvm-dlltool -m i386:x86-64 -d "$package/shell32.def" -l "$package/shell32.lib" \
      || ! lld-link /nodefaultlib /subsystem:console /entry:mainCRTStartup "$package/child.obj" \
        "$package/kernel32.lib" "$package/shell32.lib" "/out:$out/process-child.exe"; then
      printf 'process\tfail: child oracle\tnot-checked\tnot-checked\n' >> "$out/results.tsv"
      failed=1
      continue
    fi
  fi
  if [ "$program" = providers ]; then
    printf 'LIBRARY kernel32.dll\nEXPORTS\nCreatePipe\nCloseHandle\nSetStdHandle\n' > "$package/fixture.def"
    cat >> "$package/silk.toml" <<'EOF'
[native]
link = [{ object = "companion.obj" }, { static-archive = "fixture.lib" }]
EOF
    if ! "$SILK_TEST_CLANG" --target=x86_64-pc-windows-msvc -O2 -ffreestanding \
        -fno-stack-protector -Wall -Wextra -Werror -DSILK_PROVIDER_COMPANION \
        -c compiler/fixtures/windows-runtime/providers-contract.c -o "$package/companion.obj" \
        > "$out/providers-companion.log" 2>&1 \
        || ! llvm-dlltool -m i386:x86-64 -d "$package/fixture.def" -l "$package/fixture.lib"; then
      cat "$out/providers-companion.log"
      printf 'providers\tfail: companion\tnot-checked\tnot-checked\n' >> "$out/results.tsv"
      failed=1
      continue
    fi
    allowed_dlls='Name: (kernel32|ntdll|bcryptprimitives)\.dll'
  fi
  # Retain actual Silk output and the helpers its unoptimized object requires. This inventory
  # distinguishes emitted dependencies from the broader handwritten compiler-rt risk fixture.
  if "$compiler" build "$source" -o "$out/$program.ll" --emit llvm-ir --target x86_64-pc-windows-msvc \
      --stdlib "$PWD/stdlib" --optimization "$optimization" --debug false > "$out/$program-ir.log" 2>&1 \
      && "$SILK_TEST_CLANG" --target=x86_64-pc-windows-msvc -O0 -c "$out/$program.ll" -o "$out/$program.obj" \
        > "$out/$program-object.log" 2>&1; then
    llvm-nm --undefined-only "$out/$program.obj" > "$out/$program-undefined.txt"
  else
    cat "$out/$program-ir.log"
    failed=1
  fi
  if "$compiler" build "$source" -o "$out/$program.exe" --target x86_64-pc-windows-msvc \
      --stdlib "$PWD/stdlib" --clang "$SILK_TEST_CLANG" --optimization "$optimization" --debug false > "$out/$program-build.log" 2>&1; then
    if llvm-readobj --file-headers --coff-imports "$out/$program.exe" > "$out/$program-pe.txt" \
        && grep -q 'IMAGE_FILE_MACHINE_AMD64' "$out/$program-pe.txt" \
        && grep -q 'IMAGE_SUBSYSTEM_WINDOWS_CUI' "$out/$program-pe.txt" \
        && ! grep 'Name: .*\.dll' "$out/$program-pe.txt" | grep -viE "$allowed_dlls"; then
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
if bash compiler/fixtures/windows-filesystem/cross-build.sh "$compiler" "$out/windows-filesystem"; then
  printf 'filesystem\tpass\tpass\tnot-checked: requires real Windows\n' >> "$out/results.tsv"
else
  printf 'filesystem\tfail\tnot-checked\tnot-checked: cross-build failed\n' >> "$out/results.tsv"
  failed=1
fi
cat "$out/results.tsv"
exit "$failed"
