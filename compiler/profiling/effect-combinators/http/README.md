# Concurrent HTTP compiler comparison

This opt-in workload sends one batch of 4096 plain HTTP/1 requests through `NativeHttp.sendAll`
at concurrency 16. Every response has status 200 and thirty-two `x` bytes. The client checks every
byte. The Hyper client also prepares the batch first, limits active requests to 16, and retains
all responses until validation. Both clients use keep-alive connections to the same Hyper server.
The server runs outside the profiler. This is a fresh harness; it does not reproduce the old
handoff's machine, harness, or HTTPS measurements.

Build both Silk clients from the repository root against exactly the same stdlib:

```sh
BASELINE build compiler/profiling/effect-combinators/http/src/main.silk -o /tmp/http-before --stdlib stdlib --optimization speed --target aarch64-unknown-linux-gnu
CANDIDATE build compiler/profiling/effect-combinators/http/src/main.silk -o /tmp/http-after --stdlib stdlib --optimization speed --target aarch64-unknown-linux-gnu
```

Use the target of the Linux machine that will run the binaries. On that machine, build the
locked Rust package and start the server:

```sh
cargo build --release --locked --manifest-path compiler/profiling/effect-combinators/http/hyper/Cargo.toml --target-dir /tmp/effect-hyper
/tmp/effect-hyper/release/effect-http-hyper server > /tmp/effect-server.log 2>&1 &
server_pid=$!
trap 'kill "$server_pid"' EXIT
/tmp/http-before
/tmp/http-after
/tmp/effect-hyper/release/effect-http-hyper
```

All clients must exit zero. Profile them sequentially, reversing before/after order in a second
round. For each executable, use:

```sh
valgrind --tool=callgrind --callgrind-out-file=/tmp/client.callgrind CLIENT
valgrind --tool=cachegrind --cache-sim=yes --I1=32768,8,64 --D1=32768,8,64 --LL=8388608,16,64 --cachegrind-out-file=/tmp/client.cachegrind CLIENT
```

Give each client and round its own output paths. Divide instruction totals and simulated L1
misses by 4096. These are whole-process totals including batch construction and connection setup;
they are not hardware cache counters or wall-time throughput measurements.

To count out-of-line libc copies, build the optional shim and run each client separately from
Valgrind:

```sh
clang -shared -fPIC -O2 -fno-builtin compiler/profiling/effect-combinators/http/copy-count.c -ldl -o /tmp/copy-count.so
COPY_OUTPUT=/tmp/client.copies LD_PRELOAD=/tmp/copy-count.so CLIENT
python3 - <<'PY'
import struct
copy_calls, copy_bytes, move_calls, move_bytes = struct.unpack('=4Q', open('/tmp/client.copies', 'rb').read())
print('libc copy bytes/request:', (copy_bytes + move_bytes) / 4096)
PY
```

The shim misses copies LLVM expands into loads and stores. Its mapped output survives runtimes
that exit without calling C destructors. Do not use its instrumented execution for instruction,
cache, or timing comparisons.
