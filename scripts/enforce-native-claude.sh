#!/usr/bin/env bash
# PreToolUse hook for Claude Code
# Blocks built-in tools when native-claude MCP equivalents should be used.
# Logs violations to ~/.claude/native-claude-violations.jsonl
#
# Install: Add to ~/.claude/settings.json (see README for details)
# Requires: jq

set -euo pipefail

# Read hook input from stdin
input=$(cat)
tool_name=$(echo "$input" | jq -r '.tool_name')

# Allow Read for non-text file types that native-claude can't handle
# (images, PDFs, notebooks — Claude's built-in Read handles these natively)
if [ "$tool_name" = "Read" ]; then
  file_path=$(echo "$input" | jq -r '.tool_input.file_path // ""')
  ext="${file_path##*.}"
  ext_lower=$(echo "$ext" | tr '[:upper:]' '[:lower:]')
  case "$ext_lower" in
    # Images (Claude is multimodal — built-in Read displays these visually)
    png|jpg|jpeg|gif|bmp|svg|webp|ico|tiff|tif|avif)  exit 0 ;;
    # PDFs (built-in Read supports pages parameter)
    pdf)  exit 0 ;;
    # Jupyter notebooks (built-in Read renders cells + outputs)
    ipynb)  exit 0 ;;
  esac
fi

# Map built-in tools to native-claude equivalents
case "$tool_name" in
  Read)     alt="read_file" ;;
  Edit)     alt="apply_diff or find_and_replace" ;;
  Write)    alt="write_file" ;;
  Bash)     alt="execute_command" ;;
  Glob)     alt="list_files" ;;
  Grep)     alt="search_files" ;;
  *)        exit 0 ;; # Not a blocked tool — allow
esac

# Log the violation
log_file="${HOME}/.claude/native-claude-violations.jsonl"
tool_input=$(echo "$input" | jq -c '.tool_input // {}')
timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
jq -n -c \
  --arg ts "$timestamp" \
  --arg tool "$tool_name" \
  --arg alt "$alt" \
  --argjson input "$tool_input" \
  '{timestamp: $ts, blocked_tool: $tool, suggested: $alt, tool_input: $input}' \
  >> "$log_file"

# Block with reason — Claude sees this and retries with the correct tool
jq -n \
  --arg reason "BLOCKED: Use native-claude \`$alt\` instead of built-in \`$tool_name\`. The native-claude MCP server provides VS Code-integrated equivalents with diff views, integrated terminal, and real diagnostics." \
  '{decision: "block", reason: $reason}'
