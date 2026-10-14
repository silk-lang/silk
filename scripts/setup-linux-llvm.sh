#!/usr/bin/env bash
# The same verified host toolchain for local development and Linux CI.
set -euo pipefail

if [ "$(uname -s)" != Linux ]; then
  echo 'This installer requires Linux.' >&2
  exit 1
fi
case "$(uname -m)" in
  x86_64)
    asset=Linux-X64
    digest=df0e1ecf16caf3489a272a5eea4eec9b0d82878f6477fa309504f918a0006384
    ;;
  aarch64|arm64)
    asset=Linux-ARM64
    digest=805efad2bb91cb4967fa569e0881d10c0f69c04461cf671cccbae19f547acc34
    ;;
  *)
    echo "Unsupported LLVM host architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

destination=${1:-.scratch/llvm-22.1.8}
if [ ! -x "$destination/bin/clang" ]; then
  mkdir -p "$(dirname "$destination")"
  temporary=$(mktemp -d "$(dirname "$destination")/.llvm-download.XXXXXX")
  trap 'rm -rf "$temporary"' EXIT
  curl --fail --location --retry 3 \
    "https://github.com/llvm/llvm-project/releases/download/llvmorg-22.1.8/LLVM-22.1.8-$asset.tar.xz" \
    -o "$temporary/llvm.tar.xz"
  echo "$digest  $temporary/llvm.tar.xz" | sha256sum -c -
  mkdir "$temporary/install"
  tar -xf "$temporary/llvm.tar.xz" --strip-components=1 -C "$temporary/install"
  # A failed download or extraction never publishes a partial installation.
  mv -T "$temporary/install" "$destination"
fi
"$destination/bin/clang" --version
