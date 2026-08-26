/* oxlint-disable no-control-regex -- this entire file intentionally matches ANSI control characters */

/**
 * Strip ANSI escape sequences and VS Code shell integration markers from terminal output.
 * Adapted from Roo Code's TerminalProcess.ts patterns.
 */

/** Remove VS Code shell integration OSC sequences while preserving other renderable OSC sequences. */
export function removeVsCodeShellIntegrationSequences(text: string): string {
  return text
    .replace(/\x1B\]633;[^\x07\x1B]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B\]133;[^\x07\x1B]*(?:\x07|\x1B\\)/g, "");
}

/** Remove VS Code shell integration OSC sequences and other terminal control strings from clean text output. */
export function removeShellIntegrationSequences(text: string): string {
  return (
    removeVsCodeShellIntegrationSequences(text)
      // OSC strings may use arbitrary (not only numeric) selectors and end in BEL or ST.
      .replace(/(?:\x1B\]|\x9D)[^\x07\x1B\x9C]*(?:\x07|\x1B\\|\x9C)/g, "")
      // DCS, SOS, PM, and APC strings end in ST. Consume their payload rather than
      // stripping only the introducer and leaking metadata into cleaned output.
      .replace(
        /(?:\x1B[P^_X]|[\x90\x98\x9E\x9F])[^\x1B\x9C]*(?:\x1B\\|\x9C)/g,
        "",
      )
  );
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

/** Remove SGR color/style codes, including colon-delimited modern color parameters. */
export function removeAnsiColors(text: string): string {
  return text.replace(/\x1B\[[\x30-\x3F]*[\x20-\x2F]*m/g, "");
}

/** Strip all ANSI/terminal escape sequences for clean text output */
export function stripAnsi(text: string): string {
  let result = removeShellIntegrationSequences(text);
  result = removeCursorSequences(result);
  result = removeAnsiColors(result);
  // Remove any remaining ECMA-48 CSI sequences. Parameter bytes include
  // private markers and colon-delimited SGR forms; intermediate bytes are optional.
  result = result.replace(
    /(?:\x1B\[|\x9B)[\x30-\x3F]*[\x20-\x2F]*[\x40-\x7E]/g,
    "",
  );
  // Remove two-character and intermediate-byte ESC control sequences such as
  // keypad mode (ESC = / ESC >), save/restore cursor (ESC 7 / ESC 8), and
  // character-set selection. OSC metadata was removed above.
  result = result.replace(/\x1B[\x20-\x2F]*[\x30-\x7E]/g, "");
  // Remove remaining single-byte C1 controls after their multi-byte/string forms
  // have been consumed above.
  result = result.replace(/[\x80-\x9F]/g, "");
  return result;
}

/**
 * Resolve lone carriage-return updates with last-write semantics. Terminal tools
 * commonly use CR to redraw one logical line; clean text keeps only the final
 * rendered update rather than preserving every overwritten progress state.
 */
function normalizeCarriageReturns(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.slice(line.lastIndexOf("\r") + 1))
    .join("\n");
}

/** Preserve terminal-renderable output while removing VS Code shell integration protocol markers. */
export function cleanTerminalRawOutput(text: string): string {
  return removeVsCodeShellIntegrationSequences(text);
}

/** Normalize terminal output: strip ANSI, trailing %, normalize line endings */
export function cleanTerminalOutput(text: string): string {
  let result = stripAnsi(text);
  result = normalizeCarriageReturns(result);
  // Strip trailing % (zsh PROMPT_EOL_MARK for lines without trailing newline)
  result = result.replace(/%\s*$/, "");
  return result.trim();
}
