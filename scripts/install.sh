#!/usr/bin/env bash
# Installs a published AgentLink release.
#
#   curl -fsSL https://raw.githubusercontent.com/reefbarman/agentlink/main/scripts/install.sh | bash
#   ... | bash -s -- --surface desktop
#   ... | bash -s -- --surface cli --version 0.3.0
#
# Each surface has its own tag series (vX.Y.Z, desktop-vX.Y.Z, cli-vX.Y.Z), so
# releases are selected by tag prefix rather than GitHub's single "latest".
set -euo pipefail

REPO="reefbarman/agentlink"
DOWNLOAD_BASE="https://github.com/$REPO/releases/download"
SURFACE="vscode"
VERSION=""
ARCH_OVERRIDE=""
DRY_RUN=false

usage() {
  cat <<'EOF'
Usage: install.sh [--surface vscode|desktop|cli] [--version X.Y.Z] [--arch arm64|x64] [--dry-run]

  --surface   What to install (default: vscode)
                vscode   VS Code extension (VSIX) via the `code` command
                desktop  macOS Desktop preview: downloads and opens the DMG
                cli      macOS Apple Silicon CLI preview: ~/.local/bin/agentlink
  --version   Install this exact version instead of the newest release
  --arch      Override the detected architecture (Desktop only)
  --dry-run   Print the selected release and actions without installing

For the Node SDK, use scripts/install-sdk.mjs instead.
EOF
}

die() {
  echo "Error: $*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --surface) SURFACE="${2:-}"; shift 2 ;;
    --version) VERSION="${2:-}"; shift 2 ;;
    --arch) ARCH_OVERRIDE="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "Unknown argument: $1" ;;
  esac
done

VERSION="${VERSION#v}"
VERSION_PATTERN='[0-9]+\.[0-9]+\.[0-9]+'
if [ -n "$VERSION" ] && ! printf '%s' "$VERSION" | grep -Eq "^${VERSION_PATTERN}\$"; then
  die "--version must look like 1.2.3"
fi

OS="${AGENTLINK_INSTALL_OS:-$(uname -s)}"

mac_arch() {
  if [ -n "${AGENTLINK_INSTALL_ARCH:-}" ]; then
    echo "$AGENTLINK_INSTALL_ARCH"
  elif [ "$(uname -m)" = "arm64" ] \
    || [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then
    # sysctl reports Apple Silicon even from a Rosetta shell.
    echo "arm64"
  else
    echo "x64"
  fi
}

vscode_target() {
  if [ -n "${AGENTLINK_VSCE_TARGET:-}" ]; then
    echo "$AGENTLINK_VSCE_TARGET"
    return
  fi
  local platform arch
  case "$OS" in
    Darwin) platform="darwin" ;;
    Linux)
      if getconf GNU_LIBC_VERSION >/dev/null 2>&1; then platform="linux"; else platform="alpine"; fi
      ;;
    MINGW*|MSYS*|CYGWIN*) platform="win32" ;;
    *) die "Unsupported platform: $OS" ;;
  esac
  arch=$(code --version 2>/dev/null | tail -1 || true)
  [ -n "$arch" ] || arch=$(uname -m)
  case "$arch" in
    arm64|aarch64) arch="arm64" ;;
    x64|x86_64|amd64) arch="x64" ;;
    *)
      echo "Set AGENTLINK_VSCE_TARGET explicitly for remote or emulated extension hosts." >&2
      die "Unsupported VS Code architecture: $arch"
      ;;
  esac
  echo "${platform}-${arch}"
}

case "$SURFACE" in
  vscode)
    if ! $DRY_RUN && ! command -v code >/dev/null 2>&1; then
      echo "Install it from VS Code's Command Palette: Shell Command: Install 'code' command in PATH." >&2
      die "Could not find the VS Code 'code' command."
    fi
    TARGET=$(vscode_target)
    case "$TARGET" in
      darwin-arm64|darwin-x64|linux-arm64|linux-x64|alpine-arm64|alpine-x64|win32-arm64|win32-x64) ;;
      *) die "Unsupported AgentLink VSIX target: $TARGET" ;;
    esac
    TAG_PREFIX="v"
    ASSET_PATTERN="agentlink-${VERSION_PATTERN}-${TARGET}\\.vsix"
    LABEL="VS Code extension ($TARGET)"
    ;;
  desktop)
    [ "$OS" = "Darwin" ] || die "The Desktop preview is available for macOS only."
    ARCH="${ARCH_OVERRIDE:-$(mac_arch)}"
    case "$ARCH" in arm64|x64) ;; *) die "Unsupported Desktop architecture: $ARCH" ;; esac
    TAG_PREFIX="desktop-v"
    ASSET_PATTERN="AgentLink-Desktop-${VERSION_PATTERN}-mac-${ARCH}\\.dmg"
    LABEL="Desktop preview (macOS $ARCH)"
    ;;
  cli)
    [ "$OS" = "Darwin" ] && [ "$(mac_arch)" = "arm64" ] \
      || die "The CLI preview is available for macOS Apple Silicon only."
    TAG_PREFIX="cli-v"
    ASSET_PATTERN="agentlink-cli-darwin-arm64-v${VERSION_PATTERN}\\.tar\\.gz"
    LABEL="CLI preview (macOS arm64)"
    ;;
  *) die "Unknown surface: $SURFACE (expected vscode, desktop, or cli)" ;;
esac

if [ -n "$VERSION" ]; then
  TAG_PATTERN="${TAG_PREFIX}${VERSION//./\\.}"
else
  TAG_PATTERN="${TAG_PREFIX}${VERSION_PATTERN}"
fi

# Release listing JSON, one page at a time. AGENTLINK_RELEASES_FILE replaces
# the API with a local fixture (used by tests).
release_page() {
  if [ -n "${AGENTLINK_RELEASES_FILE:-}" ]; then
    [ "$1" = "1" ] && cat "$AGENTLINK_RELEASES_FILE"
    return 0
  fi
  curl -fsSL --proto '=https' -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$REPO/releases?per_page=100&page=$1"
}

# Unauthenticated listings exclude drafts and are newest first, so the first
# matching download URL belongs to the newest published release of this surface.
ASSET_URL=""
URLS=""
for PAGE in 1 2 3 4 5 6 7 8 9 10; do
  JSON=$(release_page "$PAGE")
  PAGE_URLS=$(printf '%s' "$JSON" \
    | grep -oE '"browser_download_url": *"[^"]+"' \
    | sed -E 's/.*"(https:[^"]+)"$/\1/' || true)
  [ -n "$PAGE_URLS" ] || break
  ASSET_URL=$(printf '%s\n' "$PAGE_URLS" \
    | grep -E "^${DOWNLOAD_BASE//./\\.}/${TAG_PATTERN}/${ASSET_PATTERN}\$" \
    | head -1 || true)
  if [ -n "$ASSET_URL" ]; then
    URLS="$PAGE_URLS"
    break
  fi
done

if [ -z "$ASSET_URL" ]; then
  if [ -n "$VERSION" ]; then
    die "No published ${TAG_PREFIX}${VERSION} release has a $LABEL asset."
  fi
  die "No published release has a $LABEL asset."
fi

FILENAME=$(basename "$ASSET_URL")
TAG=$(basename "$(dirname "$ASSET_URL")")
RELEASE_BASE="$DOWNLOAD_BASE/$TAG"
CHECKSUM_URL=""
if printf '%s\n' "$URLS" | grep -qxF "$RELEASE_BASE/SHA256SUMS"; then
  CHECKSUM_URL="$RELEASE_BASE/SHA256SUMS"
elif printf '%s\n' "$URLS" | grep -qxF "$RELEASE_BASE/$FILENAME.sha256"; then
  CHECKSUM_URL="$RELEASE_BASE/$FILENAME.sha256"
fi

echo "Selected $TAG: $FILENAME"
if [ -n "$CHECKSUM_URL" ]; then
  echo "Checksum: $(basename "$CHECKSUM_URL")"
elif [ "$SURFACE" = "cli" ]; then
  die "$TAG has no checksum; refusing to install the CLI."
else
  echo "Checksum: none published for $TAG (older release); skipping verification."
fi

if $DRY_RUN; then
  echo "Dry run: would download $ASSET_URL and install the $LABEL."
  exit 0
fi

sha256() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

download() {
  curl -fL --proto '=https' --proto-redir '=https' --connect-timeout 30 --show-error -o "$2" "$1"
}

verify() {
  [ -n "$CHECKSUM_URL" ] || return 0
  local sums="$1.checksums" expected actual
  download "$CHECKSUM_URL" "$sums"
  expected=$(awk -v name="$FILENAME" \
    'NF == 1 || $2 == name || $2 == "*" name { print $1; exit }' "$sums")
  rm -f "$sums"
  printf '%s' "$expected" | grep -Eq '^[0-9a-fA-F]{64}$' \
    || die "$(basename "$CHECKSUM_URL") has no valid entry for $FILENAME."
  actual=$(sha256 "$1")
  [ "$(printf '%s' "$expected" | tr 'A-F' 'a-f')" = "$actual" ] \
    || die "Checksum mismatch for $FILENAME."
  echo "Verified SHA-256 checksum."
}

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

echo "Downloading $FILENAME..."
download "$ASSET_URL" "$WORKDIR/$FILENAME"
verify "$WORKDIR/$FILENAME"

case "$SURFACE" in
  vscode)
    code --install-extension "$WORKDIR/$FILENAME" --force
    echo ""
    echo "Done! Reload VS Code, then open the AgentLink activity bar to start coding."
    ;;

  desktop)
    DOWNLOADS="$HOME/Downloads"
    mkdir -p "$DOWNLOADS"
    mv "$WORKDIR/$FILENAME" "$DOWNLOADS/$FILENAME"
    open "$DOWNLOADS/$FILENAME"
    echo ""
    echo "Opened $DOWNLOADS/$FILENAME. Drag AgentLink to Applications."
    echo "This preview is unsigned and not notarised. On first launch, right-click AgentLink, choose Open, and confirm."
    ;;

  cli)
    BIN="$HOME/.local/bin"
    LIB="$HOME/.local/lib/agentlink"
    LINK="$BIN/agentlink"
    PREVIOUS=""
    if [ -e "$LINK" ] || [ -L "$LINK" ]; then
      CURRENT=$(readlink "$LINK" || true)
      case "$CURRENT" in
        "$LIB"/cli-preview.*/agentlink-cli-darwin-arm64/bin/agentlink)
          PREVIOUS="${CURRENT%/agentlink-cli-darwin-arm64/bin/agentlink}"
          ;;
        *) die "An agentlink command already exists at $LINK and was not installed by this script. No files were replaced." ;;
      esac
    fi
    mkdir -p "$BIN" "$LIB"
    STAGE=$(mktemp -d "$LIB/cli-preview.XXXXXX")
    tar -xzf "$WORKDIR/$FILENAME" -C "$STAGE"
    [ -x "$STAGE/agentlink-cli-darwin-arm64/bin/agentlink" ] || {
      rm -rf "$STAGE"
      die "The archive does not contain agentlink-cli-darwin-arm64/bin/agentlink."
    }
    ln -sfn "$STAGE/agentlink-cli-darwin-arm64/bin/agentlink" "$LINK"
    echo ""
    echo "Installed $TAG at $LINK"
    [ -z "$PREVIOUS" ] || echo "The previous preview remains at $PREVIOUS; delete it once the new version works."
    echo "Add ~/.local/bin to PATH if needed, then run: agentlink --help"
    echo "This preview is unsigned and not notarised. macOS may block its first launch."
    ;;
esac
