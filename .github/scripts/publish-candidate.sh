#!/usr/bin/env bash
# Publish bytes verified by every target lane. Both stable/dev and explicit previews use this gate.
set -euo pipefail
: "${SOURCE_COMMIT:?}" "${VERSION:?}" "${GITHUB_RUN_ID:?}"
jq -s --arg tag "v$VERSION" --arg sha "$SOURCE_COMMIT" --arg run "$GITHUB_RUN_ID" \
  '{schemaVersion: 2, seeds: (map(.seeds) | add | with_entries(.value |=
    (.tag = $tag | .sourceCommit = $sha | .runId = $run)))}' \
  native-seed-*.json > native-seed.json
rm native-seed-*.json
tag="v$VERSION"
files=(native-seed.json input-snapshot.json authored-inputs.tar)
if [ -f changes-snapshot.toml ]; then files+=(changes-snapshot.toml); fi
# Only the installable binaries are signed: pins and receipts are compared modulo run ids, not byte for byte.
signed=()
for target in x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu aarch64-apple-darwin x86_64-apple-darwin x86_64-pc-windows-msvc; do
  asset="silk-compiler-$target"
  if [ "$target" = x86_64-pc-windows-msvc ]; then asset+=.exe; fi
  node "$GITHUB_WORKSPACE/compiler/scripts/NativeSeed.mjs" outputs native-seed.json "$target" > /dev/null
  receipt="chain-receipt-$target.json"
  test "$(jq -er --arg target "$target" '.seeds[$target].tag' native-seed.json)" = "$tag"
  test "$(jq -er --arg target "$target" '.seeds[$target].sourceCommit' native-seed.json)" = "$SOURCE_COMMIT"
  sha=$(jq -er --arg target "$target" '.seeds[$target].sha256' native-seed.json)
  echo "$sha  $asset" | sha256sum -c -
  test "$sha" = "$(jq -er .output.sha256 "$receipt")"
  test "$(jq -er .target "$receipt")" = "$target"
  test "$(jq -er .fixpoint.producerIrSha256 "$receipt")" = "$(jq -er .fixpoint.outputIrSha256 "$receipt")"
  test "$(jq -er .inputs.normalizedDigest "$receipt")" = "$(jq -er .normalizedDigest input-snapshot.json)"
  test "$(jq -er .inputs.sourceCommit "$receipt")" = "$SOURCE_COMMIT"
  test "$(jq -er .inputs.archiveSha256 "$receipt")" = "$(jq -er .archiveSha256 input-snapshot.json)"
  # The installable archive must carry this exact compiler.
  top="silk-$VERSION-$target"
  if [ "$target" = x86_64-pc-windows-msvc ]; then
    archives=("$top.zip")
    unzip -t "${archives[0]}" > /dev/null
    test "$(unzip -p "${archives[0]}" "$top/bin/silkc.exe" | sha256sum | cut -d' ' -f1)" = "$sha"
    unzip -Z1 "${archives[0]}" | grep -Fx "$top/bin/silk.exe" > /dev/null
    if [ -f changes-snapshot.toml ]; then unzip -p "${archives[0]}" "$top/lib/silk/changes-snapshot.toml" > "$RUNNER_TEMP/embedded-snapshot.toml"; fi
  else
    archives=("$top.tar.gz")
    test "$(tar -xzOf "${archives[0]}" "$top/bin/silkc" | sha256sum | cut -d' ' -f1)" = "$sha"
    tar -tzf "${archives[0]}" | grep -Fx "$top/bin/silk" > /dev/null
    if [ -f changes-snapshot.toml ]; then tar -xzOf "${archives[0]}" "$top/lib/silk/changes-snapshot.toml" > "$RUNNER_TEMP/embedded-snapshot.toml"; fi
  fi
  if [ -f changes-snapshot.toml ]; then cmp changes-snapshot.toml "$RUNNER_TEMP/embedded-snapshot.toml"; fi
  files+=("$asset" "$receipt" "${archives[0]}")
  signed+=("$asset" "${archives[0]}")
done
node "$GITHUB_WORKSPACE/compiler/scripts/ScoopManifest.mjs" "$VERSION" \
  "silk-$VERSION-x86_64-pc-windows-msvc.zip" silk.json
files+=(silk.json)
signed+=(silk.json)
# The docs site's playground: the compiler for wasm32-wasip1, the stdlib and the examples.
playground="silk-$VERSION-playground.tar.gz"
tar -xzOf "$playground" "${playground%.tar.gz}/manifest.json" | jq -e --arg version "$VERSION" '.version == $version' > /dev/null
files+=("$playground")
"$GITHUB_WORKSPACE/scripts/sign-release.sh" "$tag" "${signed[@]}"
for file in "${signed[@]}"; do files+=("$file.minisig"); done
node "$GITHUB_WORKSPACE/compiler/scripts/CompilerRelease.mjs" publish \
  "$RUNNER_TEMP/compiler-release.json" "$PWD" "${files[@]}"
{
  echo "### Silk $VERSION"
  echo "Release: \`$tag\`"
  echo '```json'
  cat native-seed.json
  echo '```'
} >> "$GITHUB_STEP_SUMMARY"
