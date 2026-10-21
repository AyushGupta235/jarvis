#!/bin/sh
# Build Jarvis from this checkout and make it the one you run: ~/Applications/Jarvis.app, the `jarvis`
# CLI and jarvisd. Your sessions keep running throughout (tmux and rich-session hosts outlive the app
# and the daemon). Run it after pulling or after changing Jarvis's code: `pnpm install:local`.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
APP="$HOME/Applications/Jarvis.app"
BUILT="$ROOT/apps/desktop/release/mac-arm64/Jarvis.app"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
BUNDLE_ID=dev.jarvis.app

step() { printf '\033[35m→\033[0m %s\n' "$1"; }
running() { [ "$(osascript -e "application id \"$BUNDLE_ID\" is running" 2>/dev/null)" = "true" ]; }

cd "$ROOT"
step "Installing dependencies"
pnpm install --silent

step "Building and packaging ($(git rev-parse --short HEAD)$(git diff --quiet HEAD -- . ':!*.md' || echo ', with uncommitted changes'))"
pnpm package >/dev/null

if running; then
  step "Quitting Jarvis (sessions keep running)"
  osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null
  i=0
  while running && [ $i -lt 40 ]; do sleep 0.25; i=$((i + 1)); done
  if running; then
    echo "Jarvis did not quit. Quit it yourself and run this again." >&2
    exit 1
  fi
fi

step "Installing $APP"
mkdir -p "$HOME/Applications"
rm -rf "$APP"
cp -R "$BUILT" "$APP"
"$LSREGISTER" -f "$APP"
# Keep Spotlight and Launchpad pointing at the installed copy, not the build output in the repo.
"$LSREGISTER" -u "$BUILT" 2>/dev/null || true

step "Linking the jarvis CLI"
mkdir -p "$HOME/.local/bin"
ln -sf "$ROOT/apps/cli/dist/jarvis.cjs" "$HOME/.local/bin/jarvis"

step "Restarting jarvisd"
node "$ROOT/apps/cli/dist/jarvis.cjs" daemon restart

step "Opening Jarvis"
open "$APP"
node "$ROOT/apps/cli/dist/jarvis.cjs" daemon status
