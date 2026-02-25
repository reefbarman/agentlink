#!/usr/bin/env bash
set -euo pipefail

BUMP="patch"
INSTALL=false

usage() {
  echo "Usage: $0 [--major|--minor|--patch] [--install]"
  echo "  --major    Bump major version"
  echo "  --minor    Bump minor version"
  echo "  --patch    Bump patch version (default)"
  echo "  --install  Install the VSIX into VS Code after building"
  exit 1
}

for arg in "$@"; do
  case "$arg" in
    --major) BUMP="major" ;;
    --minor) BUMP="minor" ;;
    --patch) BUMP="patch" ;;
    --install) INSTALL=true ;;
    --help|-h) usage ;;
    *) echo "Unknown option: $arg"; usage ;;
  esac
done

cd "$(dirname "$0")/.."

# Bump version (--no-git-tag-version to avoid creating a commit/tag)
NEW_VERSION=$(npm version "$BUMP" --no-git-tag-version)
echo "Bumped version to $NEW_VERSION"

# Build
npm run build

# Package VSIX into releases/
mkdir -p releases
npx @vscode/vsce package --no-dependencies --allow-star-activation --out releases/
VSIX=$(ls -t releases/*.vsix | head -1)
echo "Built $VSIX"

if $INSTALL; then
  echo "Installing $VSIX..."
  code --install-extension "$VSIX" --force
  echo "Installed. Reload VS Code to activate."

  # Inject CLAUDE.md instructions
  echo ""
  echo "Updating ~/.claude/CLAUDE.md..."
  bash "$(dirname "$0")/inject-claude-md.sh" "$(dirname "$0")/../CLAUDE.md.example"
fi
