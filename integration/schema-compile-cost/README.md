# Request codec compile cost

This package compiles both TOML and JSON readers and writers for the standard library's `silk.build.request.Request`. It decodes a compiler build request in each format, writes each decoded request in the other format, and checks that both writers produced bytes.

To compare two standard libraries, use the same compiler, Clang, target, profile and CPU allocation for both. Run the following in a fresh directory for each measurement, alternating the order between trials.

```sh
cp -R "$REPO/integration/schema-compile-cost/src" "$REPO/integration/schema-compile-cost/silk.toml" .
XDG_CACHE_HOME="$PWD/cache" "$SILK" build --stdlib "$STDLIB" --progress plain
exe=build/x86_64-unknown-linux-gnu/dev/schema-compile-cost
"$exe"
awk -F '\t' '$2 == "function" {n++} END {print n}' "$exe.symbols"
```

Use the elapsed build time and the count from the emitted symbol map. The progress counter can include repeated visits to one function.
