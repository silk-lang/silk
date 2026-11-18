# Request codec compile cost

This package compiles both TOML and JSON readers and writers for the standard library's `silk.build.request.Request`. It decodes a compiler build request in each format, writes each decoded request in the other format, and checks that both writers produced bytes.

For the end-to-end comparison, build each revision's compiler with its pinned seed and use it with that revision's standard library. To isolate the effect of a standard-library change, repeat both builds with one compiler. Keep Clang, target, profile and CPU allocation the same. Warm each variant once, then run the command below in a fresh directory for each measurement. Repeat the order baseline, candidate, candidate, baseline.

```sh
cp -R "$REPO/integration/schema-compile-cost/src" "$REPO/integration/schema-compile-cost/silk.toml" .
/usr/bin/time -p env XDG_CACHE_HOME="$PWD/cache" SILK_HOME="$PWD/silk-home" SILK_NATIVE_CACHE_DIR="$PWD/native-cache" \
  "$SILK" build --stdlib "$STDLIB" --progress plain
exe=build/x86_64-unknown-linux-gnu/dev/schema-compile-cost
"$exe"
awk -F '\t' '$2 == "function" {n++} END {print n}' "$exe.symbols"
```

Report the `real` time from starting `silk build` through linking the executable, and the function count from the emitted symbol map. Running the executable afterward checks the two codecs. Measuring encoding or decoding throughput requires timing the executable separately. The progress counter can include repeated visits to one function.

For a JSON-only or TOML-only measurement, keep that format's request literal and decoder, encode the resulting Request with the same format, and check the sink's byte count. Remove the other format's import and calls in both variants.
