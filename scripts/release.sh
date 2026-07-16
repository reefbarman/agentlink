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
  echo "Installing $VSIX to all profiles..."
  
  # 1. Install to the default profile
  echo "Installing to [Default] profile..."
  code --install-extension "$VSIX" --force

  # 2. Determine VS Code user data directory based on OS
  USER_DIR=""
  if [[ "$OSTYPE" == "darwin"* ]]; then
    USER_DIR="$HOME/Library/Application Support/Code/User"
  elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    USER_DIR="$HOME/.config/Code/User"
  fi

  # 3. Install to each custom profile. Profile directories under User/profiles are
  # opaque IDs; the human-readable names `code --profile` expects live in
  # globalStorage/storage.json under userDataProfiles.
  STORAGE_JSON="$USER_DIR/globalStorage/storage.json"
  if [[ -n "$USER_DIR" && -f "$STORAGE_JSON" ]]; then
    node -e '
      const profiles = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).userDataProfiles ?? [];
      for (const p of profiles) if (p.name) console.log(p.name);
    ' "$STORAGE_JSON" | while IFS= read -r profile; do
      echo "Installing to [$profile] profile..."
      code --profile "$profile" --install-extension "$VSIX" --force
    done
  fi

  echo "Installed successfully across all profiles. Reload VS Code to activate."
fi
