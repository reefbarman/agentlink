#!/usr/bin/env bash
set -euo pipefail

REPO="reefbarman/native-claude"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

echo "Fetching latest release from $REPO..."
ASSET_URL=$(curl -sL "https://api.github.com/repos/$REPO/releases/latest" \
  | grep '"browser_download_url".*\.vsix"' \
  | head -1 \
  | cut -d '"' -f 4)

if [ -z "$ASSET_URL" ]; then
  echo "Error: Could not find .vsix asset in latest release." >&2
  exit 1
fi

FILENAME=$(basename "$ASSET_URL")
echo "Downloading $FILENAME..."
curl -sL "$ASSET_URL" -o "$TMPDIR/$FILENAME"

echo "Installing extension..."
code --install-extension "$TMPDIR/$FILENAME" --force

echo ""
echo "Done! Reload VS Code to activate Native Claude."
