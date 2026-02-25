#!/usr/bin/env bash
set -euo pipefail

REPO="reefbarman/native-claude"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

echo "Fetching latest release from $REPO..."
RELEASE_JSON=$(curl -sL "https://api.github.com/repos/$REPO/releases/latest")
ASSET_URL=$(echo "$RELEASE_JSON" \
  | grep '"browser_download_url".*\.vsix"' \
  | head -1 \
  | cut -d '"' -f 4)
TAG=$(echo "$RELEASE_JSON" \
  | grep '"tag_name"' \
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

# Inject CLAUDE.md instructions
echo ""
echo "Updating ~/.claude/CLAUDE.md..."
RAW_BASE="https://raw.githubusercontent.com/$REPO/${TAG:-main}"
CLAUDE_EXAMPLE="$TMPDIR/CLAUDE.md.example"
INJECT_SCRIPT="$TMPDIR/inject-claude-md.sh"
curl -sL "$RAW_BASE/CLAUDE.md.example" -o "$CLAUDE_EXAMPLE"
curl -sL "$RAW_BASE/scripts/inject-claude-md.sh" -o "$INJECT_SCRIPT"
if [ -s "$CLAUDE_EXAMPLE" ] && [ -s "$INJECT_SCRIPT" ]; then
  bash "$INJECT_SCRIPT" "$CLAUDE_EXAMPLE"
else
  echo "Warning: Could not fetch CLAUDE.md files from repo. Skipping CLAUDE.md update."
fi

echo ""
echo "Done! Reload VS Code to activate Native Claude."
