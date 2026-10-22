#!/usr/bin/env bash
# Installs the `gh stack` extension (github/gh-stack) in Claude Code cloud
# sessions. Those sessions block GitHub GraphQL and release downloads from
# github.com, so it is built from the Go module proxy with rest-api.patch,
# which ports its GraphQL calls to REST.
#
# Run from the SessionStart hook. It returns at once: a wrapper is installed
# first and the build runs in the background. `gh stack` waits for the build
# if it is still running (about a minute on a cold container).
set -euo pipefail

[ "${CLAUDE_CODE_REMOTE:-}" = true ] || exit 0

version=v0.2.1
here="$(cd "$(dirname "$0")" && pwd)"
prefix="$HOME/.local/share/gh-stack-rest"
ext_dir="$HOME/.local/share/gh/extensions/gh-stack"
lock="$prefix/build.lock"
log="$prefix/build.log"
bin="$prefix/gh-stack-$version"

mkdir -p "$prefix" "$ext_dir"

cat > "$ext_dir/gh-stack" <<EOF
#!/bin/sh
export GH_STACK_NO_UPDATE_NOTIFIER=1
if [ ! -x "$bin" ]; then
  flock -s "$lock" true
fi
if [ ! -x "$bin" ]; then
  echo "gh stack: build failed, see $log" >&2
  exit 1
fi
exec "$bin" "\$@"
EOF
chmod +x "$ext_dir/gh-stack"

[ -x "$bin" ] && exit 0

build() {
  set -euo pipefail
  local src
  src="$(mktemp -d)"
  cd "$src"
  local mod
  mod="$(go mod download -json "github.com/github/gh-stack@$version" | sed -n 's/^\t"Dir": "\(.*\)",$/\1/p')"
  cp -r "$mod/." .
  chmod -R u+w .
  patch -p1 < "$here/rest-api.patch"
  go build -o "$bin.tmp" .
  mv "$bin.tmp" "$bin"
  cd /
  rm -rf "$src"
}

# Take the lock before backgrounding so a `gh stack` call right after this
# script returns already waits on it.
exec 9> "$lock"
flock 9
(
  export -f build
  export here version bin
  bash -c build
) < /dev/null > "$log" 2>&1 &
disown
