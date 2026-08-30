import type {
  ContextBreakdownItem,
  RequestContextBreakdown,
  ToolResultContextAttribution,
} from "@agentlink/protocol/context-diagnostics";

import type { AgentMessage } from "./types.js";
import type { ContentBlock } from "./providers/types.js";
import { createHash } from "crypto";

export interface ContextDoctorInput {
  model: string;
  mode: string;
  lastInputTokens: number;
  lastOutputTokens: number;
  lastCacheReadTokens: number;
  contextBreakdown: RequestContextBreakdown;
  toolResultContextAttributions: readonly ToolResultContextAttribution[];
  omittedToolResultContextAttributions: number;
  messages: readonly AgentMessage[];
}

export interface ContextDoctorToolResultFinding {
  toolCallId: string;
  toolName: string;
  chars: number;
  estimatedTokens: number;
  repeatCount: number;
}

export interface ContextDoctorReport {
  model: string;
  mode: string;
  promptProfile: string;
  promptSections: ContextBreakdownItem[];
  toolResultFindings: ContextDoctorToolResultFinding[];
  repeatedToolResultGroups: number;
  latestCondenseEstimate?: number;
  currentInputTokens: number;
  markdown: string;
}

function formatTokens(tokens: number): string {
  return Math.max(0, Math.round(tokens)).toLocaleString("en-US");
}

function contentText(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter(
      (block): block is Extract<ContentBlock, { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("\n");
}

const RETAINED_RESULT_HASH_PATTERN = /^SHA-256: ([a-f0-9]{64})$/m;

function canonicalToolResultHash(text: string): string {
  return (
    RETAINED_RESULT_HASH_PATTERN.exec(text)?.[1] ??
    createHash("sha256").update(text).digest("hex")
  );
}

function collectToolResultFindings(messages: readonly AgentMessage[]): {
  findings: ContextDoctorToolResultFinding[];
  repeatedGroupCount: number;
} {
  const toolNames = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content))
      continue;
    for (const block of message.content) {
      if (block.type === "tool_use") toolNames.set(block.id, block.name);
    }
  }

  const results: Array<{
    toolCallId: string;
    toolName: string;
    text: string;
    hash: string;
  }> = [];
  for (const message of messages) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type !== "tool_result") continue;
      const text = contentText(block.content);
      results.push({
        toolCallId: block.tool_use_id,
        toolName: toolNames.get(block.tool_use_id) ?? "unknown",
        text,
        hash: canonicalToolResultHash(text),
      });
    }
  }

  const repeatCounts = new Map<string, number>();
  for (const result of results) {
    repeatCounts.set(result.hash, (repeatCounts.get(result.hash) ?? 0) + 1);
  }
  return {
    findings: results
      .map((result) => ({
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        chars: result.text.length,
        estimatedTokens: Math.ceil(result.text.length / 4),
        repeatCount: repeatCounts.get(result.hash) ?? 1,
      }))
      .sort(
        (left, right) =>
          right.estimatedTokens - left.estimatedTokens ||
          left.toolCallId.localeCompare(right.toolCallId),
      )
      .slice(0, 10),
    repeatedGroupCount: [...repeatCounts.values()].filter((count) => count > 1)
      .length,
  };
}

function getLatestCondenseEstimate(
  messages: readonly AgentMessage[],
): number | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const estimate = messages[index]?.uiHint?.condense?.newInputTokens;
    if (estimate !== undefined) return estimate;
  }
  return undefined;
}

export function buildContextDoctorReport(
  input: ContextDoctorInput,
): ContextDoctorReport {
  const promptSections = [...input.contextBreakdown.prompt.sections].sort(
    (left, right) =>
      right.estimatedTokens - left.estimatedTokens ||
      left.label.localeCompare(right.label),
  );
  const {
    findings: toolResultFindings,
    repeatedGroupCount: repeatedToolResultGroups,
  } = collectToolResultFindings(input.messages);
  const latestCondenseEstimate = getLatestCondenseEstimate(input.messages);
  const prompt = input.contextBreakdown.prompt;
  const tools = input.contextBreakdown.tools;
  const ledger = input.contextBreakdown.contextLedger;
  const lines = [
    "# Context Doctor",
    "",
    `- Model: \`${input.model}\``,
    `- Mode: \`${input.mode}\``,
    `- Prompt profile: \`${prompt.profile ?? "unknown"}\` (${prompt.profileSource ?? "source unavailable"})`,
    `- Current provider input: **${formatTokens(input.lastInputTokens)} tokens**`,
    `- Last output: ${formatTokens(input.lastOutputTokens)} tokens`,
    `- Last cache read: ${formatTokens(input.lastCacheReadTokens)} tokens`,
    "",
    "## Prompt sections",
    "",
    ...(promptSections.length > 0
      ? promptSections.map(
          (section) =>
            `- ${section.label}: **${formatTokens(section.estimatedTokens)} tokens** (${section.chars.toLocaleString("en-US")} chars${section.count === undefined ? "" : `, ${section.count} items`})`,
        )
      : ["- No prompt-section measurements are available."]),
    `- Total prompt: **${formatTokens(prompt.estimatedTokens)} tokens** (${prompt.totalChars.toLocaleString("en-US")} chars)`,
    "",
    "## Tool schemas",
    "",
    ...(tools
      ? [
          `- Total: **${formatTokens(tools.estimatedTokens)} tokens** across ${tools.totalToolCount} tools`,
          `- Native/meta: ${formatTokens(tools.native.estimatedTokens)} tokens across ${tools.native.count ?? 0} tools`,
          `- MCP: ${formatTokens(tools.mcp.estimatedTokens)} tokens across ${tools.mcp.totalToolCount} tools on ${tools.mcp.totalServerCount} servers`,
          ...tools.mcp.servers.map(
            (server) =>
              `  - ${server.serverName}: ${formatTokens(server.estimatedTokens)} tokens across ${server.toolCount} tools`,
          ),
        ]
      : ["- No tool-schema measurement is available yet."]),
    "",
    "## Request context ledger",
    "",
    ...(ledger
      ? [
          `- Context window: ${formatTokens(ledger.contextWindowTokens)} tokens`,
          `- Hard input limit: ${formatTokens(ledger.hardInputLimitTokens)} tokens`,
          `- Allocated input: **${formatTokens(ledger.allocatedInputTokens)} tokens**`,
          `- Remaining input: **${formatTokens(ledger.remainingInputTokens)} tokens**`,
          `- Output reservation: ${formatTokens(ledger.outputReservationTokens)} tokens`,
          `- Safety buffer: ${formatTokens(ledger.safetyBufferTokens)} tokens`,
          `- Overflow: ${formatTokens(ledger.overflowTokens)} tokens`,
          ...ledger.layers.map(
            (layer) =>
              `  - ${layer.layer}: ${formatTokens(layer.allocatedTokens)} / ${formatTokens(layer.requestedTokens)} tokens${layer.omittedTokens > 0 ? ` (${formatTokens(layer.omittedTokens)} omitted)` : ""}`,
          ),
        ]
      : [
          "- No completed request ledger is available yet. Send one message, then rerun `/context-doctor`.",
        ]),
    "",
    "## Largest retained tool results",
    "",
    ...(toolResultFindings.length > 0
      ? toolResultFindings.map(
          (finding) =>
            `- \`${finding.toolName}\` call \`${finding.toolCallId}\`: **${formatTokens(finding.estimatedTokens)} tokens** (${finding.chars.toLocaleString("en-US")} chars)${finding.repeatCount > 1 ? `, repeated ${finding.repeatCount}× exactly` : ""}`,
        )
      : [
          "- No retained tool results are present in the effective session history.",
        ]),
    ...(input.toolResultContextAttributions.length > 0 ||
    input.omittedToolResultContextAttributions > 0
      ? [
          `- Pending request attribution: ${input.toolResultContextAttributions.length} retained results${input.omittedToolResultContextAttributions > 0 ? ` (${input.omittedToolResultContextAttributions} omitted from bounded detail)` : ""}`,
        ]
      : []),
    "",
    "## Condensation",
    "",
    ...(latestCondenseEstimate === undefined
      ? ["- No completed condensation estimate is present in session history."]
      : [
          `- Latest post-condense estimate: ${formatTokens(latestCondenseEstimate)} tokens`,
          `- Current provider input: ${formatTokens(input.lastInputTokens)} tokens`,
          "- The current input may include later turns; an exact first-post-condense actual comparison is not yet retained.",
        ]),
    "",
    "## Diagnostics not yet instrumented",
    "",
    "- Compatibility-versus-reasoning profile A/B delta",
    "- Duplicate/conflicting directives and migration recommendations",
    "- Stale or contested memory records and conflict details",
    "- Index health, stale source revisions, retrieval backend version, and retrieval-store health",
    "",
    "This report is read-only and does not rewrite instructions, memory, skills, or settings.",
  ];

  return {
    model: input.model,
    mode: input.mode,
    promptProfile: prompt.profile ?? "unknown",
    promptSections,
    toolResultFindings,
    repeatedToolResultGroups,
    latestCondenseEstimate,
    currentInputTokens: input.lastInputTokens,
    markdown: lines.join("\n"),
  };
}
