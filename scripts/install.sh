#!/usr/bin/env bash
set -euo pipefail

REPO="reefbarman/agentlink"
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

echo ""
echo "Done! Reload VS Code to activate AgentLink."
echo "Use 'AgentLink: Configure Agents' in the command palette to set up your agents."
