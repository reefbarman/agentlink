/* oxlint-disable no-control-regex -- terminal normalization intentionally removes control characters */

import type {
  TerminalInteractivePromptDetection,
  TerminalInteractivePromptKind,
} from "../core/capabilities/terminal.js";

import { stripAnsi } from "../util/ansi.js";

export const INTERACTIVE_PROMPT_MAX_INPUT_CHARS = 8192;

const MAX_LOGICAL_LINES = 6;
const MAX_EVIDENCE_CHARS = 240;

export type InteractivePromptKind = TerminalInteractivePromptKind;
export type InteractivePromptDetection = TerminalInteractivePromptDetection;

interface PromptPattern {
  kind: InteractivePromptKind;
  confidence: InteractivePromptDetection["confidence"];
  pattern: RegExp;
  scope: "tail-line" | "recent-lines";
}

const PROMPT_PATTERNS: readonly PromptPattern[] = [
  {
    kind: "confirmation",
    confidence: "high",
    pattern:
      /(?:\[(?:y\s*\/\s*n|yes\s*\/\s*no)\]|\((?:y\s*\/\s*n|yes\s*\/\s*no)\))\s*[:?]?\s*$/i,
    scope: "tail-line",
  },
  {
    kind: "confirmation",
    confidence: "high",
    pattern:
      /\b(?:trust|confirm|continue|proceed|choose|select|enter|allow|install|accept)\b[^\n]{0,160}[?:]\s*(?:yes|y)\s*\/\s*(?:no|n)(?:\s*\/\s*(?:all|a))?\s*$/i,
    scope: "tail-line",
  },
  {
    kind: "confirmation",
    confidence: "high",
    pattern: /(?:^|\b)(?:continue|are you sure)\?\s*$/i,
    scope: "tail-line",
  },
  {
    kind: "press_enter",
    confidence: "high",
    pattern: /(?:^|\b)press\s+(?:enter|return)\b[^\n]*$/i,
    scope: "tail-line",
  },
  {
    kind: "confirmation",
    confidence: "high",
    pattern: /(?:^|\b)enter\s+(?:yes|no|y|n)\b[^\n]*$/i,
    scope: "tail-line",
  },
  {
    kind: "input_request",
    confidence: "high",
    pattern: /^(?:enter|input|provide|type)\b[^\n]{0,200}[:?]\s*$/i,
    scope: "tail-line",
  },
  {
    kind: "choice_request",
    confidence: "high",
    pattern: /^(?:choose|select)\b[^\n]{0,200}[:?]\s*$/i,
    scope: "tail-line",
  },
  {
    kind: "waiting_for_input",
    confidence: "high",
    pattern: /\bwaiting\s+for\s+(?:input|confirmation)\b[^\n]*$/i,
    scope: "tail-line",
  },
  {
    kind: "choice_request",
    confidence: "observation",
    pattern: /\b(?:choose|select)\b[^\n]*\b(?:option|number)\b\s*[:?]?\s*$/i,
    scope: "tail-line",
  },
  {
    kind: "custom_code_preservation",
    confidence: "observation",
    pattern: /\bcustom code preservation\b/i,
    scope: "recent-lines",
  },
];

function normalizeTerminalTail(output: string): string[] {
  const bounded = output.slice(-INTERACTIVE_PROMPT_MAX_INPUT_CHARS);
  const normalized = stripAnsi(bounded)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  return normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-MAX_LOGICAL_LINES);
}

function displaySafeEvidence(value: string): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= MAX_EVIDENCE_CHARS) return singleLine;
  return `…${singleLine.slice(-(MAX_EVIDENCE_CHARS - 1))}`;
}

export function detectInteractivePrompt(
  output: string,
): InteractivePromptDetection | undefined {
  const lines = normalizeTerminalTail(output);
  const tailLine = lines.at(-1);
  if (!tailLine) return undefined;
  const recentLines = lines.join("\n");

  for (const candidate of PROMPT_PATTERNS) {
    const value = candidate.scope === "tail-line" ? tailLine : recentLines;
    const match = candidate.pattern.exec(value);
    if (!match) continue;
    return {
      kind: candidate.kind,
      confidence: candidate.confidence,
      evidence: displaySafeEvidence(
        candidate.scope === "tail-line" ? tailLine : match[0],
      ),
    };
  }
  return undefined;
}
