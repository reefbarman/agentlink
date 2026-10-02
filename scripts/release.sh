#!/usr/bin/env bash
set -euo pipefail

BUMP="patch"
INSTALL=false

usage() {
  echo "Usage: $0 [--major|--minor|--patch] [--install]"
  echo "  --major    Bump major version and record it as release intent"
  echo "  --minor    Bump minor version and record it as release intent"
  echo "  --patch    Bump patch version (default; a local reservation CI may raise)"
  echo "  --install  Install the VSIX into VS Code after building"
  echo "Only the VS Code extension version changes. See .release/README.md."
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

# Patch bumps are ordinary dogfood reservations that CI reuses. Minor/major
# bumps are explicit release intent: record the exact target so the release
# coordinator publishes it rather than treating it as an accidental jump.
if [[ "$BUMP" != "patch" ]]; then
  mkdir -p .release/intents
  node -e 'require("fs").writeFileSync(".release/intents/vscode.json", JSON.stringify({ version: process.argv[1], recordedBy: "scripts/release.sh" }, null, 2) + "\n")' "${NEW_VERSION#v}"
  echo "Recorded release intent ${NEW_VERSION#v} in .release/intents/vscode.json; commit it with the version bump."
  if [[ "$BUMP" == "major" ]]; then
    echo "WARNING: committing this intent authorises a public VS Code major release (${NEW_VERSION#v})." >&2
  fi
else
  echo "Patch bumps are local reservations; the release coordinator reuses ${NEW_VERSION} or raises it to a minor if the published changes warrant one."
fi

TARGET=$(node scripts/package-retrieval-runtime.mjs --print-target)
echo "Packaging retrieval runtime for $TARGET"

# Build, package, and verify one platform-specific VSIX for the current host.
mkdir -p releases
VSIX="releases/agentlink-${NEW_VERSION#v}-${TARGET}.vsix"
npm run package -- "$VSIX"

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
