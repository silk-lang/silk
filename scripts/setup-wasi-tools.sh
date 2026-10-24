#!/usr/bin/env bash
# Pinned host tools used by WASI acceptance tests on Linux x86-64.
set -euo pipefail
if [ "$(uname -s)-$(uname -m)" != Linux-x86_64 ]; then
  echo 'This installer supports Linux x86-64. Install wasm-tools and Wasmtime for your host separately.' >&2
  exit 1
fi
destination=${1:-.scratch/wasi-tools}
mkdir -p "$destination"
temporary=$(mktemp -d "$destination/.download.XXXXXX")
trap 'rm -rf "$temporary"' EXIT
fetch() {
  local url=$1 name=$2 digest=$3
  curl --fail --location --retry 3 "$url" -o "$temporary/$name"
  echo "$digest  $temporary/$name" | sha256sum -c -
}
fetch https://github.com/bytecodealliance/wasmtime/releases/download/v50.0.0/wasmtime-v50.0.0-x86_64-linux.tar.xz wasmtime.tar.xz 77c19ee0437991f9ac7837b9c269d9c7076744f85dad263fea5214cc2723c7ff
fetch https://github.com/bytecodealliance/wasm-tools/releases/download/v1.262.0/wasm-tools-1.262.0-x86_64-linux.tar.gz wasm-tools.tar.gz 655b8df67d54c3ef9b52fc237c4e94bbfbb5f5f43825245cb0940a7002a9ed65
fetch https://github.com/bytecodealliance/wasmtime/releases/download/v50.0.0/wasi_snapshot_preview1.command.wasm wasi_snapshot_preview1.command.wasm b3de00ac47528237211c6404b4a7e4235a67878665dc3e8853071908c3127a85
tar -xf "$temporary/wasmtime.tar.xz" -C "$temporary"
tar -xf "$temporary/wasm-tools.tar.gz" -C "$temporary"
install -m 755 "$temporary/wasmtime-v50.0.0-x86_64-linux/wasmtime" "$destination/wasmtime"
install -m 755 "$temporary/wasm-tools-1.262.0-x86_64-linux/wasm-tools" "$destination/wasm-tools"
install -m 644 "$temporary/wasi_snapshot_preview1.command.wasm" "$destination/wasi_snapshot_preview1.command.wasm"
printf 'WASI tools installed in %s\n' "$destination"
