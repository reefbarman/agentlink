#!/usr/bin/env bash
set -euo pipefail

REPO="reefbarman/agentlink"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

if [ -n "${AGENTLINK_VSCE_TARGET:-}" ]; then
  TARGET="$AGENTLINK_VSCE_TARGET"
else
  OS=$(uname -s)
  case "$OS" in
    Darwin) PLATFORM="darwin" ;;
    Linux)
      if getconf GNU_LIBC_VERSION >/dev/null 2>&1; then
        PLATFORM="linux"
      else
        PLATFORM="alpine"
      fi
      ;;
    MINGW*|MSYS*|CYGWIN*) PLATFORM="win32" ;;
    *)
      echo "Error: Unsupported platform: $OS" >&2
      exit 1
      ;;
  esac

  ARCH=$(code --version 2>/dev/null | tail -1 || true)
  if [ -z "$ARCH" ]; then
    ARCH=$(uname -m)
  fi
  case "$ARCH" in
    arm64|aarch64) ARCH="arm64" ;;
    x64|x86_64|amd64) ARCH="x64" ;;
    *)
      echo "Error: Unsupported VS Code architecture: $ARCH" >&2
      echo "Set AGENTLINK_VSCE_TARGET explicitly for remote or emulated extension hosts." >&2
      exit 1
      ;;
  esac
  TARGET="${PLATFORM}-${ARCH}"
fi

case "$TARGET" in
  darwin-arm64|darwin-x64|linux-arm64|linux-x64|alpine-arm64|alpine-x64|win32-arm64|win32-x64) ;;
  *)
    echo "Error: Unsupported AgentLink VSIX target: $TARGET" >&2
    exit 1
    ;;
esac

echo "Fetching latest $TARGET release from $REPO..."
RELEASE_JSON=$(curl -sL "https://api.github.com/repos/$REPO/releases/latest")
ASSET_URL=$(echo "$RELEASE_JSON" \
  | grep "\"browser_download_url\".*-${TARGET}\\.vsix\"" \
  | head -1 \
  | cut -d '"' -f 4 \
  || true)

if [ -z "$ASSET_URL" ]; then
  echo "Error: Could not find a $TARGET .vsix asset in the latest release." >&2
  exit 1
fi

FILENAME=$(basename "$ASSET_URL")
echo "Downloading $FILENAME..."
curl -sL "$ASSET_URL" -o "$TMPDIR/$FILENAME"

echo "Installing extension..."
code --install-extension "$TMPDIR/$FILENAME" --force

echo ""
echo "Done! Reload VS Code, then open the AgentLink activity bar to start coding."
