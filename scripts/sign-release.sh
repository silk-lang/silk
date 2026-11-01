#!/usr/bin/env bash
# Signs release assets with the project's minisign key: writes <file>.minisig beside each file.
#
#   MINISIGN_SECRET_KEY=... scripts/sign-release.sh <tag> <file>...
#
# The trusted comment `silk <tag> <file>` binds each signature to its release and asset name,
# so a signature cannot be replayed onto another file or an older release. Fixed comments and
# Ed25519 make the output deterministic, so a re-run produces byte-identical signatures.
set -euo pipefail

[ "$#" -ge 2 ] || { echo 'usage: sign-release.sh <tag> <file>...' >&2; exit 2; }
[ -n "${MINISIGN_SECRET_KEY:-}" ] || { echo 'MINISIGN_SECRET_KEY is not set' >&2; exit 1; }
root=$(cd "$(dirname "$0")/.." && pwd)
public_key=$(sed -n 2p "$root/minisign.pub")
grep -qxF "minisign_public_key=$public_key" "$root/install.sh" ||
  { echo 'install.sh does not embed the key in minisign.pub' >&2; exit 1; }
grep -qxF "\$SilkMinisignPublicKey = '$public_key'" "$root/install.ps1" ||
  { echo 'install.ps1 does not embed the key in minisign.pub' >&2; exit 1; }

tag=$1
shift
key=$(mktemp)
trap 'rm -f "$key"' EXIT
printf '%s\n' "$MINISIGN_SECRET_KEY" > "$key"
for file in "$@"; do
  name=$(basename "$file")
  minisign -S -s "$key" -m "$file" -x "$file.minisig" \
    -c 'signature from the Silk release key' -t "silk $tag $name" < /dev/null > /dev/null
  test "$(minisign -V -p "$root/minisign.pub" -m "$file" -x "$file.minisig" -Q)" = "silk $tag $name"
done
