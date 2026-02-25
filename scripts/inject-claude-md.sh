#!/usr/bin/env bash
set -euo pipefail

# Injects the contents of a file into ~/.claude/CLAUDE.md wrapped in boundary
# comments. If boundary markers already exist, replaces the existing block.
# Otherwise appends.
#
# Usage: inject-claude-md.sh <content-file>

if [ $# -ne 1 ] || [ ! -f "$1" ]; then
  echo "Usage: $0 <content-file>" >&2
  exit 1
fi

CONTENT_FILE="$1"
CLAUDE_DIR="$HOME/.claude"
CLAUDE_MD="$CLAUDE_DIR/CLAUDE.md"
BEGIN_MARKER="<!-- BEGIN native-claude -->"
END_MARKER="<!-- END native-claude -->"

# Build the bounded block
BOUNDED_BLOCK="$BEGIN_MARKER
$(cat "$CONTENT_FILE")
$END_MARKER"

mkdir -p "$CLAUDE_DIR"

if [ ! -f "$CLAUDE_MD" ]; then
  # No CLAUDE.md yet — create with just the bounded block
  printf '%s\n' "$BOUNDED_BLOCK" > "$CLAUDE_MD"
  echo "Created $CLAUDE_MD with native-claude instructions."

elif grep -qF "$BEGIN_MARKER" "$CLAUDE_MD"; then
  # Markers exist — replace content between them (inclusive)
  # Use awk to replace the block: skip lines from BEGIN to END, insert new block at BEGIN
  awk -v block="$BOUNDED_BLOCK" -v begin="$BEGIN_MARKER" -v end="$END_MARKER" '
    $0 == begin { print block; skip=1; next }
    $0 == end   { skip=0; next }
    !skip       { print }
  ' "$CLAUDE_MD" > "$CLAUDE_MD.tmp"
  mv "$CLAUDE_MD.tmp" "$CLAUDE_MD"
  echo "Updated native-claude section in $CLAUDE_MD."

else
  # No markers — append
  printf '\n%s\n' "$BOUNDED_BLOCK" >> "$CLAUDE_MD"
  echo "Appended native-claude instructions to $CLAUDE_MD."
fi
