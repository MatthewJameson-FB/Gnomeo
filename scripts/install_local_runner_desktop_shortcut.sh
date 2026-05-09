#!/bin/bash

set -u

REPO_ROOT="/Users/matthewjameson/Gnomeo"
SOURCE="$REPO_ROOT/START_GNOMEO_LOCAL_RUNNER.command"
DESKTOP_DIR="$HOME/Desktop"
DEST="$DESKTOP_DIR/Gnomeo Local Runner.command"

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

[ -f "$SOURCE" ] || fail "Missing source launcher: $SOURCE"
mkdir -p "$DESKTOP_DIR"

if [ -e "$DEST" ] && ! cmp -s "$SOURCE" "$DEST"; then
  fail "Desktop shortcut already exists and is different: $DEST. Remove it or rename it before installing a new copy."
fi

cp "$SOURCE" "$DEST"
chmod +x "$DEST"

printf 'Installed Desktop launcher: %s\n' "$DEST"