/**
 * Strip ANSI escape sequences and VS Code shell integration markers from terminal output.
 * Adapted from Roo Code's TerminalProcess.ts patterns.
 */

/** Remove VS Code shell integration OSC sequences (633, 133, etc.) */
export function removeShellIntegrationSequences(text: string): string {
  return text
    .replace(/\x1B\]633;[^\x07\x1B]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B\]133;[^\x07\x1B]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B\][0-9]+;[^\x07\x1B]*(?:\x07|\x1B\\)/g, "");
}

/** Remove cursor movement and screen control sequences */
export function removeCursorSequences(text: string): string {
  return text
    .replace(/\x1B\[\d*[ABCDEFGHJ]/g, "")
    .replace(/\x1B\[su/g, "")
    .replace(/\x1B\[\d*[KJ]/g, "")
    .replace(/\x1B\[\?25[hl]/g, "")
    .replace(/\x1B\[\d*;\d*r/g, "");
}

/** Remove SGR color/style codes */
export function removeAnsiColors(text: string): string {
  return text.replace(/\x1B\[\d*(?:;\d+)*m/g, "");
}

/** Strip all ANSI/terminal escape sequences for clean text output */
export function stripAnsi(text: string): string {
  let result = removeShellIntegrationSequences(text);
  result = removeCursorSequences(result);
  result = removeAnsiColors(result);
  // Remove any remaining CSI sequences
  result = result.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
  return result;
}

/** Normalize terminal output: strip ANSI, trailing %, normalize line endings */
export function cleanTerminalOutput(text: string): string {
  let result = stripAnsi(text);
  // Normalize \r\n to \n
  result = result.replace(/\r\n/g, "\n");
  // Strip trailing % (zsh PROMPT_EOL_MARK for lines without trailing newline)
  result = result.replace(/%\s*$/, "");
  return result.trim();
}
