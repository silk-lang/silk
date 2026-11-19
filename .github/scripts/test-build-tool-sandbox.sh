#!/usr/bin/env bash
# Runs a build.silk tool step on this host's sandbox and checks what it confines: the step builds
# and its output becomes a module, while a write outside its output directory, a read of an
# undeclared file and a network connection each fail the build.
# Usage: test-build-tool-sandbox.sh <silkc> <stdlib>
set -euo pipefail
compiler=$1
stdlib=$2
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
mkdir -p "$root/app/tools"
cd "$root/app"
printf '[package]\nname = "app"\nsilk-version = "0.0.0"\nversion = "0.1.0"\nsource = "."\n' > silk.toml
printf '20' > base.txt
printf 'secret' > "$root/secret.txt"
cat > build.silk <<'SILK'
import silk.build.plan { Plan }
import silk.build.run { Run }
import silk.build.step { sourcePath }

static fn plan() -> Plan {
  let generate = Run.command("tools/gen.sh")
    |> Run.input(sourcePath("base.txt"))
    |> Run.output("generated.silk")
  return Plan.empty() |> Plan.module("generated_base", Run.result(&generate, "generated.silk"))
}

pub const PLAN: Plan = plan()
SILK
printf 'import generated_base\n\npub fn main() -> i32 {\n  return generated_base.BASE + 1\n}\n' > main.silk
tool() {
  printf '#!/bin/sh\n%s\nprintf "pub const BASE: i32 = %%s\\n" "$(cat "$1")" > "$2"\n' "$1" > tools/gen.sh
  chmod +x tools/gen.sh
}
build() { "$compiler" build --stdlib "$stdlib" > "$root/build.log" 2>&1; }
tool ':'
build || { cat "$root/build.log"; exit 1; }
status=0
"$(find build -type f -perm -u+x -name app | head -n 1)" || status=$?
test "$status" = 21
expect_refused() {
  tool "$1"
  if build; then
    echo "a sandboxed tool step was allowed to: $2"
    cat "$root/build.log"
    exit 1
  fi
  grep -q "build process failed with status 7" "$root/build.log" || { cat "$root/build.log"; exit 1; }
}
expect_refused "echo pwned > \"$root/app/pwned\" || exit 7" "write to the package directory"
test ! -e pwned
expect_refused "cat \"$root/secret.txt\" > /dev/null || exit 7" "read an undeclared file"
expect_refused "curl -s --max-time 5 -o /dev/null https://example.com || exit 7" "open a network connection"
echo "build tool sandbox confined writes, reads and the network"
