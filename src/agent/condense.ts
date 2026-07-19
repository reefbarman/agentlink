/**
 * Context condensing for AgentLink.
 *
 * Implements the "fresh start" model:
 * - All messages get tagged with condenseParent (pointing to the summary's UUID)
 * - A new summary user-message is appended
 * - getEffectiveHistory() returns only the summary + messages after it
 * - Original messages are preserved in full history for potential rewind
 *
 * Key design decisions vs Roo Code:
 * - messages[0] (original task) is never tagged with condenseParent — always visible
 * - Summary includes a dedicated "User Corrections" block preserved across re-condensings
 * - generateFoldedFileContext() uses our existing tree-sitter infrastructure
 */

import { createHash, randomUUID } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import type {
  ContentBlock,
  ToolUseBlock,
  ToolResultBlock,
  TextBlock,
  ModelProvider,
  MessageParam,
} from "./providers/types.js";
import {
  CODEX_CONDENSE_MODEL,
  CODEX_CONDENSE_MODEL_FALLBACKS,
} from "./providers/index.js";

import type { AgentErrorActions, AgentMessage } from "./types.js";
import {
  initTreeSitter,
  treeSitterChunkFile,
  isTreeSitterSupported,
} from "../indexer/treeSitterChunker.js";
import { stripMemoryCandidateReminders } from "../shared/memoryCandidates.js";
import { estimateTokensFromChars } from "../util/tokenEstimation.js";
import { truncateMiddle } from "../util/truncateMiddle.js";
import {
  buildDeterministicFallbackSummary,
  extractCondenseResumeAnchor,
  renderDeterministicSections,
  type CondenseRecallAnchors,
} from "./condensePrompt.js";

export { renderDeterministicSections } from "./condensePrompt.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const CONDENSE_SYSTEM_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION.

CRITICAL: This is a summarization-only request. DO NOT call any tools or functions.
Respond with text only — no tool calls will be processed.`;

const CONDENSE_INSTRUCTIONS = `Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, file paths, code snippets, or references needed to continue
- All user corrections and behavioral directives (verbatim quotes)

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.
Wrap your summary in <summary> tags.`;

// ---------------------------------------------------------------------------
// Tool block → text conversion (for summarization API call)
// ---------------------------------------------------------------------------

export function toolUseToText(block: ToolUseBlock): string {
  let input: string;
  if (typeof block.input === "object" && block.input !== null) {
    input = Object.entries(block.input)
      .map(
        ([k, v]) =>
          `${k}: ${typeof v === "object" ? JSON.stringify(v, null, 2) : String(v)}`,
      )
      .join("\n");
  } else {
    input = String(block.input);
  }
  return `[Tool Use: ${block.name}]\n${input}`;
}

export function toolResultToText(block: ToolResultBlock): string {
  const errSuffix = block.is_error ? " (Error)" : "";
  if (typeof block.content === "string") {
    return `[Tool Result${errSuffix}]\n${block.content}`;
  }
  if (Array.isArray(block.content)) {
    const text = block.content
      .map((b) => {
        if (b.type === "text") return b.text;
        if (b.type === "image") return "[Image]";
        return `[${(b as { type: string }).type}]`;
      })
      .join("\n");
    return `[Tool Result${errSuffix}]\n${text}`;
  }
  return `[Tool Result${errSuffix}]`;
}

function convertToolBlocksToText(
  content: string | ContentBlock[],
): string | ContentBlock[] {
  if (typeof content === "string") return content;
  return content.map((block) => {
    if (block.type === "tool_use")
      return { type: "text" as const, text: toolUseToText(block) };
    if (block.type === "tool_result")
      return { type: "text" as const, text: toolResultToText(block) };
    return block;
  });
}

function stripMedia(content: string | ContentBlock[]): string | ContentBlock[] {
  if (typeof content === "string") return content;
  return content
    .filter((block) => block.type !== "thinking")
    .map((block) => {
      if (block.type === "image")
        return { type: "text" as const, text: "[Image]" };
      if (block.type === "document") {
        const title = (block as { title?: string }).title ?? "PDF";
        return { type: "text" as const, text: `[Document: ${title}]` };
      }
      return block;
    });
}

const MAX_TOOL_RESULT_TEXT_CHARS = 20_000;
const MAX_CONDENSE_MESSAGE_TEXT_CHARS = 60_000;
const MAX_CANONICAL_USER_MESSAGES = 48;
const MAX_CANONICAL_USER_MESSAGE_CHARS = 4_000;
const MAX_CANONICAL_USER_MESSAGES_CHARS = 32_000;
const INITIAL_CONDENSE_INPUT_TOKEN_BUDGET = 120_000;
const RETRY_CONDENSE_INPUT_TOKEN_BUDGETS = [64_000, 32_000] as const;

function normalizeToolResultText(text: string): string {
  return truncateMiddle(text, MAX_TOOL_RESULT_TEXT_CHARS);
}

function boundCondenseContent(
  content: string | ContentBlock[],
): string | ContentBlock[] {
  if (typeof content === "string") {
    return truncateMiddle(content, MAX_CONDENSE_MESSAGE_TEXT_CHARS);
  }
  const textChars = content.reduce(
    (total, block) => total + (block.type === "text" ? block.text.length : 16),
    0,
  );
  if (textChars <= MAX_CONDENSE_MESSAGE_TEXT_CHARS) return content;
  const text = content
    .map((block) =>
      block.type === "text"
        ? block.text
        : `[${(block as { type: string }).type}]`,
    )
    .join("\n\n");
  return [
    {
      type: "text" as const,
      text: truncateMiddle(text, MAX_CONDENSE_MESSAGE_TEXT_CHARS),
    },
  ];
}

function transformMessagesForCondensing(
  messages: AgentMessage[],
): AgentMessage[] {
  return messages.map((msg) => {
    const transformed = stripMedia(convertToolBlocksToText(msg.content));
    if (typeof transformed === "string") {
      return {
        ...msg,
        content: boundCondenseContent(
          msg.role === "user" && msg.isSummary
            ? transformed
            : normalizeToolResultText(transformed),
        ),
      };
    }
    const normalizedBlocks = transformed.map((block) =>
      block.type === "text"
        ? { ...block, text: normalizeToolResultText(block.text) }
        : block,
    );
    return {
      ...msg,
      content: boundCondenseContent(normalizedBlocks),
    };
  });
}

// ---------------------------------------------------------------------------
// Orphan tool result injection
// ---------------------------------------------------------------------------

/**
 * If condense is triggered mid-turn (assistant emitted tool_use but no tool_result yet),
 * ensure each assistant tool_use block has a matching tool_result in the immediate
 * next message. This satisfies strict provider adjacency requirements.
 */
export function injectSyntheticToolResults(
  messages: AgentMessage[],
): AgentMessage[] {
  const repaired = [...messages];

  for (let i = 0; i < repaired.length; i++) {
    const msg = repaired[i];
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

    const toolUseIds = msg.content
      .filter((block): block is ToolUseBlock => block.type === "tool_use")
      .map((block) => block.id);
    if (toolUseIds.length === 0) continue;

    const next = repaired[i + 1];
    const nextToolResultIds =
      next?.role === "user" && Array.isArray(next.content)
        ? new Set(
            next.content
              .filter(
                (block): block is ToolResultBlock =>
                  block.type === "tool_result",
              )
              .map((block) => block.tool_use_id),
          )
        : new Set<string>();

    const missingIds = toolUseIds.filter((id) => !nextToolResultIds.has(id));
    if (missingIds.length === 0) continue;

    const syntheticResults: ToolResultBlock[] = missingIds.map((id) => ({
      type: "tool_result" as const,
      tool_use_id: id,
      content: "Context condensation triggered. Tool execution deferred.",
      is_error: false,
    }));

    if (next?.role === "user") {
      const nextBlocks = Array.isArray(next.content)
        ? next.content
        : [{ type: "text" as const, text: next.content }];
      repaired[i + 1] = {
        ...next,
        content: [...syntheticResults, ...nextBlocks],
      };
      continue;
    }

    repaired.splice(i + 1, 0, {
      role: "user",
      content: syntheticResults,
    });
    i++;
  }

  return repaired;
}

/**
 * Final safety net before history is sent to a provider: every tool_result
 * must reference a tool_use in the run of user messages' immediately preceding
 * assistant message (providers merge consecutive user messages into one turn),
 * and each tool_use may be answered at most once.
 *
 * Drops orphaned tool_results and, when the same tool_use_id is answered more
 * than once (e.g. a synthetic result injected ahead of the real one), keeps
 * only the last occurrence — the real result is always appended after any
 * synthetic placeholder.
 */
export function enforceToolResultAdjacency(
  messages: AgentMessage[],
): AgentMessage[] {
  const result: AgentMessage[] = [];
  let pendingToolUseIds = new Set<string>();
  let userRun: AgentMessage[] = [];

  const flushUserRun = () => {
    if (userRun.length === 0) return;
    // Last tool_result block per tool_use_id within this run (by identity).
    const lastResultForId = new Map<string, ToolResultBlock>();
    for (const msg of userRun) {
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block.type === "tool_result") {
          lastResultForId.set(
            (block as ToolResultBlock).tool_use_id,
            block as ToolResultBlock,
          );
        }
      }
    }
    for (const msg of userRun) {
      if (!Array.isArray(msg.content)) {
        result.push(msg);
        continue;
      }
      const kept = msg.content.filter((block) => {
        if (block.type !== "tool_result") return true;
        const toolUseId = (block as ToolResultBlock).tool_use_id;
        return (
          pendingToolUseIds.has(toolUseId) && // not an orphan
          lastResultForId.get(toolUseId) === block // dedupe: keep last
        );
      });
      if (kept.length === 0) continue;
      result.push(
        kept.length === msg.content.length ? msg : { ...msg, content: kept },
      );
    }
    userRun = [];
  };

  for (const msg of messages) {
    if (msg.role === "assistant") {
      flushUserRun();
      pendingToolUseIds = new Set(
        Array.isArray(msg.content)
          ? msg.content
              .filter(
                (block): block is ToolUseBlock => block.type === "tool_use",
              )
              .map((block) => block.id)
          : [],
      );
      result.push(msg);
      continue;
    }
    userRun.push(msg);
  }
  flushUserRun();

  return result;
}

// ---------------------------------------------------------------------------
// Effective history (what gets sent to the API)
// ---------------------------------------------------------------------------

/**
 * Returns messages after the last summary (exclusive). If no summary, returns all.
 * This avoids recursively re-summarizing prior summary prose.
 */
export function getMessagesSinceLastSummary(
  messages: AgentMessage[],
): AgentMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].isSummary) return messages.slice(i + 1);
  }
  return messages;
}

/**
 * Filter full history down to what should be sent to the API.
 *
 * Rules:
 * - messages[0] is always included (original task — never condensed)
 * - If a summary exists, only messages from the summary onwards are sent
 *   (fresh-start model)
 * - Messages with condenseParent pointing to an existing summary are filtered out
 */
export function getEffectiveHistory(messages: AgentMessage[]): AgentMessage[] {
  if (messages.length === 0) return messages;

  const filterOrphanToolResults = (window: AgentMessage[]): AgentMessage[] => {
    const toolUseIds = new Set<string>();
    for (const msg of window) {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "tool_use") {
            toolUseIds.add((block as ToolUseBlock).id);
          }
        }
      }
    }

    return window
      .map((msg) => {
        if (msg.role === "user" && Array.isArray(msg.content)) {
          const kept = msg.content.filter((block) => {
            if (block.type === "tool_result") {
              return toolUseIds.has((block as ToolResultBlock).tool_use_id);
            }
            return true;
          });
          if (kept.length === 0) return null;
          if (kept.length !== msg.content.length) {
            return { ...msg, content: kept };
          }
        }
        return msg;
      })
      .filter((msg): msg is AgentMessage => msg !== null);
  };

  // Find the most recent summary
  let lastSummaryIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].isSummary) {
      lastSummaryIdx = i;
      break;
    }
  }

  if (lastSummaryIdx === -1) return messages; // no summary yet

  const fromSummary = filterOrphanToolResults(messages.slice(lastSummaryIdx));
  const summary = fromSummary[0];
  if (!summary?.isSummary) {
    return fromSummary;
  }

  const laterMessages = fromSummary.slice(1);
  const canonicalUserMessages = extractCanonicalUserMessages(messages);
  const pendingTasks = extractPendingTasksHeuristic(messages);
  const resumeAnchor = extractCondenseResumeAnchor({
    userMessages: canonicalUserMessages,
    pendingTasks,
  });

  const preservedContext = summary.preservedContext;

  const resumeContextMessage: AgentMessage = {
    role: "user",
    isResumeContext: true,
    content: [
      {
        type: "text",
        text: renderDeterministicSections({
          userMessages: canonicalUserMessages,
          pendingTasks,
          resumeAnchor,
          preservedContext,
        }),
      } satisfies TextBlock,
    ],
  };

  // Insert before the first real user prompt. Skip user messages that carry
  // tool_result blocks: inserting between an assistant tool_use and its
  // tool_result would break the adjacency the API requires (and trick
  // injectSyntheticToolResults into adding a duplicate result).
  const carriesToolResults = (msg: AgentMessage): boolean =>
    Array.isArray(msg.content) &&
    msg.content.some((block) => block.type === "tool_result");
  let insertionIndex = laterMessages.findIndex(
    (msg) => msg.role === "user" && !msg.isSummary && !carriesToolResults(msg),
  );
  if (insertionIndex === -1) {
    insertionIndex = 0;
  }

  return [
    summary,
    ...laterMessages.slice(0, insertionIndex),
    resumeContextMessage,
    ...laterMessages.slice(insertionIndex),
  ];
}

// ---------------------------------------------------------------------------
// Folded file context (tree-sitter structural extraction)
// ---------------------------------------------------------------------------

/**
 * Generate a condensed structural outline of files the agent has read.
 * Uses our existing tree-sitter chunker to extract function/class signatures.
 * Each file is wrapped in a <system-reminder> block.
 */
export async function generateFoldedFileContext(
  filePaths: string[],
  cwd: string,
  maxChars = 50_000,
): Promise<string[]> {
  if (filePaths.length === 0) return [];

  // Ensure tree-sitter is initialized
  try {
    await initTreeSitter();
  } catch {
    return []; // tree-sitter not available
  }

  const sections: string[] = [];
  let totalChars = 0;

  for (const filePath of filePaths) {
    if (totalChars >= maxChars) break;

    const absPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(cwd, filePath);

    if (!isTreeSitterSupported(absPath)) continue;

    try {
      const content = await fs.readFile(absPath, "utf-8");
      const relPath = path.isAbsolute(filePath)
        ? path.relative(cwd, absPath)
        : filePath;

      const chunks = await treeSitterChunkFile(content, absPath, relPath);
      if (chunks.length === 0) continue;

      // Build signature lines: "startLine--endLine | first_line_of_chunk"
      const sigLines = chunks
        .map((chunk) => {
          const firstLine = chunk.content.split("\n")[0].trim();
          if (!firstLine) return null;
          return `${chunk.startLine}--${chunk.endLine} | ${firstLine}`;
        })
        .filter((l): l is string => l !== null);

      if (sigLines.length === 0) continue;

      const section = `<system-reminder>\n## File Context: ${relPath}\n${sigLines.join("\n")}\n</system-reminder>`;

      if (totalChars + section.length > maxChars) {
        // Truncate to fit
        const remaining = maxChars - totalChars;
        if (remaining < 100) break;
        const truncated =
          section.slice(0, remaining - 20) +
          "\n... (truncated)\n</system-reminder>";
        sections.push(truncated);
        totalChars += truncated.length;
        break;
      }

      sections.push(section);
      totalChars += section.length;
    } catch {
      // Skip files that can't be read
    }
  }

  return sections;
}

// ---------------------------------------------------------------------------
// Main: summarizeConversation
// ---------------------------------------------------------------------------

export interface SummarizeOptions {
  messages: AgentMessage[];
  provider: ModelProvider;
  activeModel?: string;
  systemPrompt: string;
  isAutomatic: boolean;
  filesRead?: string[];
  cwd?: string;
  preservedContext?: {
    toolNames: string[];
    mcpServerNames?: string[];
    activeSkills?: string[];
  };
}

export interface SummarizeResult {
  messages: AgentMessage[];
  /** Full summary text (for debug/evaluation) */
  summary: string;
  prevInputTokens: number;
  newInputTokens: number;
  /** Non-fatal validator/retry warnings */
  validationWarnings?: string[];
  /** Structured condense metadata for debugging/forensics */
  metadata?: {
    inputMessageCount: number;
    sourceUserMessageCount: number;
    hadPriorSummaryInInput: boolean;
    sourceHash: string;
    providerId: string;
    condenseModel: string;
    modelCandidates: string[];
    skippedModelCandidates?: Array<{
      model: string;
      reason: string;
    }>;
    selectedModel: string;
    latestUserMessage: string;
    currentTask: string;
    pendingTasks: string[];
    canonicalUserMessages: string[];
    requestMessageCount: number;
    effectiveHistoryMessageCount: number;
    effectiveHistoryRoles: string[];
  };
  error?: string;
  errorRetryable?: boolean;
  errorCode?: string;
  errorActions?: AgentErrorActions;
}

function extractCanonicalUserMessages(messages: AgentMessage[]): string[] {
  const extracted = messages
    .filter((m) => m.role === "user" && !m.isSummary && !m.isResumeContext)
    .map((m) => {
      if (typeof m.content === "string") {
        return stripMemoryCandidateReminders(m.content).trim();
      }
      if (!Array.isArray(m.content)) {
        return "";
      }
      return m.content
        .filter((block): block is TextBlock => block.type === "text")
        .map((block) => stripMemoryCandidateReminders(block.text).trim())
        .filter((text) => text.length > 0)
        .join("\n")
        .trim();
    })
    .filter((t) => t.length > 0)
    .map((text) => truncateMiddle(text, MAX_CANONICAL_USER_MESSAGE_CHARS));
  if (extracted.length === 0) return extracted;

  const first = extracted[0];
  const recent: string[] = [];
  let remainingChars = Math.max(
    0,
    MAX_CANONICAL_USER_MESSAGES_CHARS - first.length,
  );
  for (
    let index = extracted.length - 1;
    index > 0 && recent.length < MAX_CANONICAL_USER_MESSAGES - 2;
    index -= 1
  ) {
    const text = extracted[index];
    if (text.length > remainingChars) break;
    recent.unshift(text);
    remainingChars -= text.length;
  }

  const selectedCount = 1 + recent.length;
  if (selectedCount === extracted.length) return [first, ...recent];
  return [
    first,
    `[... ${extracted.length - selectedCount} earlier user messages omitted; use search_session_history for the full transcript ...]`,
    ...recent,
  ];
}

export function extractCondenseRecallAnchors(
  messages: AgentMessage[],
): CondenseRecallAnchors {
  const filePaths: string[] = [];
  const errors: string[] = [];
  const toolNames: string[] = [];
  const commandCalls = new Map<string, { command: string; failed: boolean }>();
  const commandsInOrder: string[] = [];
  const seen = {
    filePaths: new Set<string>(),
    errors: new Set<string>(),
    toolNames: new Set<string>(),
  };

  const addUnique = (
    target: string[],
    seenValues: Set<string>,
    value: string,
    limit: number,
  ) => {
    const normalized = value.replace(/\s+/g, " ").trim().slice(0, 240);
    if (!normalized || seenValues.has(normalized) || target.length >= limit)
      return;
    seenValues.add(normalized);
    target.push(normalized);
  };
  const inspectText = (text: string) => {
    const bounded = text.slice(0, MAX_TOOL_RESULT_TEXT_CHARS);
    for (const match of bounded.matchAll(
      /(?:^|[\s'"`(])((?:\.{0,2}\/|\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9_-]+)/g,
    )) {
      addUnique(filePaths, seen.filePaths, match[1], 8);
    }
    for (const line of bounded.split("\n")) {
      if (
        /\b(error|failed|failure|exception|non-zero|exit(?:ed)? (?:with )?code [1-9]\d*)\b/i.test(
          line,
        )
      ) {
        addUnique(errors, seen.errors, line, 6);
      }
    }
  };

  for (const message of messages) {
    if (message.runtimeError) inspectText(message.runtimeError.message);
    if (typeof message.content === "string") {
      inspectText(message.content);
      continue;
    }
    for (const block of message.content) {
      if (block.type === "text") {
        inspectText(block.text);
        continue;
      }
      if (block.type === "tool_use") {
        addUnique(toolNames, seen.toolNames, block.name, 8);
        inspectText(JSON.stringify(block.input));
        if (block.name === "execute_command") {
          const command =
            typeof block.input.command === "string"
              ? block.input.command.trim()
              : "";
          if (command) {
            commandCalls.set(block.id, { command, failed: false });
            commandsInOrder.push(block.id);
            inspectText(command);
          }
        }
        continue;
      }
      if (block.type !== "tool_result") continue;
      const resultText = toolResultContentText(block.content);
      inspectText(resultText);
      const commandCall = commandCalls.get(block.tool_use_id);
      if (
        commandCall &&
        (block.is_error ||
          /(?:\b(?:non-zero|exit(?:ed)? (?:with )?code [1-9]\d*)\b|"exit_code"\s*:\s*[1-9]\d*)/i.test(
            resultText,
          ))
      ) {
        commandCall.failed = true;
      }
    }
  }

  const commandStatus = new Map<string, boolean>();
  for (const id of commandsInOrder) {
    const entry = commandCalls.get(id);
    if (!entry) continue;
    commandStatus.set(
      entry.command,
      (commandStatus.get(entry.command) ?? false) || entry.failed,
    );
  }
  const commands = [...commandStatus]
    .slice(0, 6)
    .map(([command, failed]) =>
      `${failed ? "[failed] " : ""}${command}`.slice(0, 240),
    );

  const anchors: CondenseRecallAnchors = {
    filePaths,
    errors,
    commands,
    toolNames,
  };
  let remaining = 2_000;
  for (const values of [
    anchors.filePaths,
    anchors.errors,
    anchors.commands,
    anchors.toolNames,
  ]) {
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index];
      if (value.length + 2 <= remaining) {
        remaining -= value.length + 2;
        continue;
      }
      values.splice(index);
      break;
    }
  }
  return anchors;
}

function toolResultContentText(content: ToolResultBlock["content"]): string {
  if (typeof content === "string") return content;
  return content
    .flatMap((block) => {
      if (block.type === "text") return [block.text];
      if (block.type === "tool_result")
        return [toolResultContentText(block.content)];
      return [];
    })
    .join("\n");
}

function extractPendingTasksHeuristic(messages: AgentMessage[]): string[] {
  const userTexts = extractCanonicalUserMessages(messages);
  const candidates: string[] = [];
  for (const text of userTexts.slice(-8)) {
    const lower = text.toLowerCase();
    if (
      /(todo|next|left|implement|fix|add|finish|continue|do that|lets do that|let's do that)/.test(
        lower,
      )
    ) {
      candidates.push(text);
    }
  }
  return [...new Set(candidates)].slice(-6);
}

function sourceWindowHash(
  messages: AgentMessage[],
  priorSummary?: string,
): string {
  const basis = [
    priorSummary ? `prior-summary:${priorSummary}` : "prior-summary:none",
    ...messages.map(
      (m) =>
        `${m.role}:${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`,
    ),
  ].join("\n---\n");
  return createHash("sha256").update(basis).digest("hex").slice(0, 16);
}

const MAX_PRIOR_SUMMARY_CHARS = 20_000;

function extractPriorConversationSummary(
  messages: AgentMessage[],
): string | undefined {
  const priorSummary = [...messages]
    .reverse()
    .find((message) => message.isSummary);
  if (!priorSummary) return undefined;

  const text =
    typeof priorSummary.content === "string"
      ? priorSummary.content
      : priorSummary.content
          .filter((block): block is TextBlock => block.type === "text")
          .map((block) => block.text)
          .find((blockText) => blockText.startsWith("## Conversation Summary"));
  if (!text) return undefined;

  const summary = text.replace(/^## Conversation Summary\s*/i, "").trim();
  return summary ? truncateMiddle(summary, MAX_PRIOR_SUMMARY_CHARS) : undefined;
}

function extractSummaryText(raw: string): string {
  const summary = raw.trim();
  if (!summary) return "";
  const summaryMatch = summary.match(/<summary>([\s\S]*?)<\/summary>/i);
  return summaryMatch ? summaryMatch[1].trim() : summary;
}

function estimateMessageTextChars(messages: MessageParam[]): number {
  return messages.reduce<number>((total, msg) => {
    if (typeof msg.content === "string") {
      return total + msg.content.length;
    }

    return (
      total +
      msg.content.reduce<number>((acc, block) => {
        switch (block.type) {
          case "text":
            return acc + block.text.length;
          case "tool_use":
            return (
              acc + block.name.length + JSON.stringify(block.input).length + 32
            );
          case "tool_result":
            return (
              acc +
              (typeof block.content === "string"
                ? block.content.length
                : Array.isArray(block.content)
                  ? block.content.reduce(
                      (inner, contentBlock) =>
                        inner +
                        (contentBlock.type === "text"
                          ? contentBlock.text.length
                          : 16),
                      0,
                    )
                  : 0) +
              32
            );
          case "thinking":
            return acc + block.thinking.length;
          case "image":
          case "document":
            return acc + 256;
          case "web_activity": {
            const activity = block.activity;
            const citationChars = (activity.citations ?? []).reduce(
              (citationTotal, citation) =>
                citationTotal +
                citation.url.length +
                (citation.title?.length ?? 0) +
                (citation.citedText?.length ?? 0),
              0,
            );
            return (
              acc +
              (activity.query?.length ?? 0) +
              (activity.url?.length ?? 0) +
              citationChars +
              64
            );
          }
        }
      }, 0)
    );
  }, 0);
}

function estimateCondenseInputTokens(args: {
  systemPrompt: string;
  messages: MessageParam[];
}): number {
  return estimateTokensFromChars(
    args.systemPrompt.length + estimateMessageTextChars(args.messages),
  );
}

function fitCondenseSourceWindow(
  messages: AgentMessage[],
  maxInputTokens: number,
  buildRequestMessages: (sourceMessages: AgentMessage[]) => MessageParam[],
  systemPrompt: string,
): { sourceMessages: AgentMessage[]; requestMessages: MessageParam[] } {
  if (messages.length <= 1) {
    return {
      sourceMessages: messages,
      requestMessages: buildRequestMessages(messages),
    };
  }

  let low = 0;
  let high = messages.length - 1;
  let bestStart = messages.length - 1;
  let bestRequest = buildRequestMessages(messages.slice(bestStart));

  while (low <= high) {
    const start = Math.floor((low + high) / 2);
    const sourceMessages = messages.slice(start);
    const requestMessages = buildRequestMessages(sourceMessages);
    const estimatedTokens = estimateCondenseInputTokens({
      systemPrompt,
      messages: requestMessages,
    });
    if (estimatedTokens <= maxInputTokens) {
      bestStart = start;
      bestRequest = requestMessages;
      high = start - 1;
    } else {
      low = start + 1;
    }
  }

  return {
    sourceMessages: messages.slice(bestStart),
    requestMessages: bestRequest,
  };
}

function isContextWindowExceededError(message: string): boolean {
  return /context window|maximum context length|input (exceeds|is too long)|maximum context/i.test(
    message,
  );
}

/**
 * Detect a bare 400 with no body — typically caused by an oversized HTTP
 * request payload hitting a proxy/CDN limit before the model can parse it.
 */
function isBarePayloadError(message: string): boolean {
  return /400 status code \(no body\)/i.test(message);
}

/** Errors that suggest the condense input is too large and should be shrunk. */
function isShrinkableError(message: string): boolean {
  return isContextWindowExceededError(message) || isBarePayloadError(message);
}

function getCodexCondenseModelCandidates(args: {
  activeModel?: string;
  provider: ModelProvider;
  requestMessages: MessageParam[];
  systemPrompt: string;
}): {
  modelCandidates: string[];
  skippedModelCandidates: Array<{ model: string; reason: string }>;
} {
  const unique = (models: Array<string | undefined>) =>
    [...new Set(models)].filter((model): model is string => Boolean(model));
  const skippedModelCandidates: Array<{ model: string; reason: string }> = [];
  const estimatedInputTokens = estimateCondenseInputTokens({
    systemPrompt: args.systemPrompt,
    messages: args.requestMessages,
  });

  const activeModel =
    args.activeModel && args.activeModel.startsWith("gpt-")
      ? args.activeModel
      : undefined;

  const cheapModel = CODEX_CONDENSE_MODEL;
  const cheapWindow = args.provider.getCapabilities(cheapModel).contextWindow;
  const estimatedRequestTokens = estimatedInputTokens + 8192;
  const cheapSafeLimit = Math.floor(cheapWindow * 0.8);
  const cheapFitsSafely = estimatedRequestTokens <= cheapSafeLimit;

  if (!cheapFitsSafely) {
    skippedModelCandidates.push({
      model: cheapModel,
      reason: `Estimated condense request ~${estimatedRequestTokens.toLocaleString()} tokens exceeds safe budget for ${cheapModel} (${cheapSafeLimit.toLocaleString()} tokens).`,
    });
  }

  const ordered = cheapFitsSafely
    ? unique([cheapModel, activeModel, ...CODEX_CONDENSE_MODEL_FALLBACKS])
    : unique([
        activeModel,
        ...CODEX_CONDENSE_MODEL_FALLBACKS.filter(
          (model) => model !== cheapModel,
        ),
      ]);

  const modelCandidates = ordered.filter((model) => {
    if (model !== cheapModel) return true;
    return cheapFitsSafely;
  });

  return {
    modelCandidates,
    skippedModelCandidates,
  };
}

export async function summarizeConversation(
  options: SummarizeOptions,
  prevInputTokens = 0,
): Promise<SummarizeResult> {
  const { messages, provider, activeModel, systemPrompt, preservedContext } =
    options;

  const errorResult = (
    error: string,
    options?: {
      retryable?: boolean;
      code?: string;
      actions?: AgentErrorActions;
    },
  ): SummarizeResult => ({
    messages,
    summary: "",
    prevInputTokens,
    newInputTokens: prevInputTokens,
    error,
    errorRetryable: options?.retryable,
    errorCode: options?.code,
    errorActions: options?.actions,
  });

  const toSummarize = getMessagesSinceLastSummary(messages);
  if (toSummarize.length <= 1) {
    return errorResult(
      messages.length <= 1
        ? "Not enough messages to condense."
        : "Already condensed recently — more conversation needed first.",
    );
  }

  const priorSummary = extractPriorConversationSummary(messages);
  const hadPriorSummaryInInput = Boolean(priorSummary);
  const canonicalUserMessages = extractCanonicalUserMessages(toSummarize);
  const pendingTasks = extractPendingTasksHeuristic(toSummarize);
  const resumeAnchor = extractCondenseResumeAnchor({
    userMessages: canonicalUserMessages,
    pendingTasks,
  });
  const recallAnchors = extractCondenseRecallAnchors(toSummarize);
  const deterministicSections = renderDeterministicSections({
    userMessages: canonicalUserMessages,
    pendingTasks,
    resumeAnchor,
    recallAnchors,
    preservedContext,
  });

  const priorSummarySection = priorSummary
    ? `\n\n<prior-checkpoint-summary>\nThis is the previous checkpoint summary. Treat it as source material to preserve and consolidate with the new transcript delta; do not merely append or quote it.\n\n${priorSummary}\n</prior-checkpoint-summary>`
    : "";
  const finalMsg: MessageParam = {
    role: "user",
    content: `${CONDENSE_INSTRUCTIONS}${priorSummarySection}\n\n${deterministicSections}`,
  };

  const buildRequestMessages = (
    sourceMessages: AgentMessage[],
  ): MessageParam[] => {
    const withSyntheticResults = injectSyntheticToolResults(sourceMessages);
    const transformed = transformMessagesForCondensing(withSyntheticResults);
    const raw: MessageParam[] = [
      ...transformed.map(({ role, content }) => ({ role, content })),
      finalMsg,
    ];

    // Merge consecutive same-role messages. After tool blocks are converted to
    // text, the conversation can end up with adjacent user or assistant messages
    // which the Codex Responses API rejects as a 400.
    const merged: MessageParam[] = [];
    for (const msg of raw) {
      const prev = merged[merged.length - 1];
      if (prev && prev.role === msg.role) {
        const prevBlocks: ContentBlock[] =
          typeof prev.content === "string"
            ? [{ type: "text", text: prev.content }]
            : prev.content;
        const curBlocks: ContentBlock[] =
          typeof msg.content === "string"
            ? [{ type: "text", text: msg.content }]
            : msg.content;
        prev.content = [...prevBlocks, ...curBlocks];
      } else {
        merged.push({ ...msg });
      }
    }
    return merged;
  };

  const validationWarnings: string[] = [];
  let {
    sourceMessages: condenseSourceMessages,
    requestMessages,
  }: {
    sourceMessages: AgentMessage[];
    requestMessages: MessageParam[];
  } = fitCondenseSourceWindow(
    toSummarize,
    INITIAL_CONDENSE_INPUT_TOKEN_BUDGET,
    buildRequestMessages,
    CONDENSE_SYSTEM_PROMPT,
  );
  if (condenseSourceMessages.length < toSummarize.length) {
    validationWarnings.push(
      `Condense source exceeded the ${INITIAL_CONDENSE_INPUT_TOKEN_BUDGET.toLocaleString()}-token request budget; using the newest ${condenseSourceMessages.length.toLocaleString()} of ${toSummarize.length.toLocaleString()} unsummarized messages. Older messages remain available through search_session_history.`,
    );
  }
  let summaryText = "";
  let deterministicFallbackAfterSizeRejection = false;
  const getModelSelection = (messagesForRequest: MessageParam[]) =>
    provider.id === "codex"
      ? getCodexCondenseModelCandidates({
          activeModel,
          provider,
          requestMessages: messagesForRequest,
          systemPrompt: CONDENSE_SYSTEM_PROMPT,
        })
      : {
          modelCandidates: [provider.condenseModel],
          skippedModelCandidates: [] as Array<{
            model: string;
            reason: string;
          }>,
        };
  let { modelCandidates, skippedModelCandidates } =
    getModelSelection(requestMessages);
  let selectedModel = modelCandidates[0] ?? provider.condenseModel;

  // 3-minute timeout for the condense API call. Falls back to deterministic summary.
  const CONDENSE_TIMEOUT_MS = 3 * 60 * 1000;

  const completeOnce = async (): Promise<{
    text: string;
    error?: string;
    retryable?: boolean;
    code?: string;
    actions?: AgentErrorActions;
  }> => {
    let lastError = "";
    let lastErrorMeta:
      | {
          retryable?: boolean;
          code?: string;
          actions?: AgentErrorActions;
        }
      | undefined;

    for (const model of modelCandidates) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), CONDENSE_TIMEOUT_MS);
        try {
          const result = await provider.complete({
            model,
            systemPrompt: CONDENSE_SYSTEM_PROMPT,
            messages: requestMessages,
            maxTokens: 8192,
            temperature: 0,
            reasoningEffort: "low",
            signal: controller.signal,
          });
          selectedModel = model;
          return { text: result.text };
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          return {
            text: "",
            error: `Condensing timed out after ${CONDENSE_TIMEOUT_MS / 1000}s`,
          };
        }
        const msg = err instanceof Error ? err.message : String(err);
        lastError = msg;
        const errObj = err as {
          status?: number;
          retryable?: boolean;
          code?: string;
          actions?: AgentErrorActions;
        };
        lastErrorMeta = {
          retryable: errObj.retryable,
          code: errObj.code,
          actions: errObj.actions,
        };
        const shouldRetry =
          provider.id === "codex" &&
          (/model is not supported|unsupported model|invalid model/i.test(
            msg,
          ) ||
            isContextWindowExceededError(msg) ||
            isBarePayloadError(msg));
        if (!shouldRetry) {
          return {
            text: "",
            error: `Condensing API call failed: ${msg}`,
            ...lastErrorMeta,
          };
        }
      }
    }

    return {
      text: "",
      error: `Condensing API call failed: ${lastError}`,
      ...lastErrorMeta,
    };
  };

  let first = await completeOnce();
  if (first.error && isShrinkableError(first.error)) {
    for (const tokenBudget of RETRY_CONDENSE_INPUT_TOKEN_BUDGETS) {
      const fitted = fitCondenseSourceWindow(
        toSummarize,
        tokenBudget,
        buildRequestMessages,
        CONDENSE_SYSTEM_PROMPT,
      );
      const currentTokens = estimateCondenseInputTokens({
        systemPrompt: CONDENSE_SYSTEM_PROMPT,
        messages: requestMessages,
      });
      const fittedTokens = estimateCondenseInputTokens({
        systemPrompt: CONDENSE_SYSTEM_PROMPT,
        messages: fitted.requestMessages,
      });
      if (fittedTokens >= currentTokens) continue;
      condenseSourceMessages = fitted.sourceMessages;
      requestMessages = fitted.requestMessages;
      ({ modelCandidates, skippedModelCandidates } =
        getModelSelection(requestMessages));
      selectedModel = modelCandidates[0] ?? provider.condenseModel;
      validationWarnings.push(
        `Condense request too large (${isBarePayloadError(first.error) ? "payload limit" : "context window"}); retried within a ${tokenBudget.toLocaleString()}-token budget using the newest ${condenseSourceMessages.length.toLocaleString()} unsummarized messages.`,
      );
      first = await completeOnce();
      if (!first.error || !isShrinkableError(first.error)) {
        break;
      }
    }
  }
  if (first.error && isShrinkableError(first.error)) {
    validationWarnings.push(
      "Condense provider rejected the minimum bounded request; using deterministic handoff sections so the session can continue.",
    );
    deterministicFallbackAfterSizeRejection = true;
    first = { text: "" };
  }
  if (first.error) {
    return errorResult(first.error, {
      retryable: first.retryable,
      code: first.code,
      actions: first.actions,
    });
  }
  summaryText = extractSummaryText(first.text) || first.text.trim();
  if (!summaryText) {
    // API succeeded but produced no usable text — fall back to deterministic summary.
    summaryText = buildDeterministicFallbackSummary({
      userMessages: canonicalUserMessages,
      pendingTasks,
      resumeAnchor,
      priorSummary,
    });
    if (!deterministicFallbackAfterSizeRejection) {
      validationWarnings.push(
        "Model returned empty summary; using deterministic fallback.",
      );
    }
  }

  const summaryContent: ContentBlock[] = [
    {
      type: "text",
      text: deterministicSections,
    } satisfies TextBlock,
    {
      type: "text",
      text: `## Conversation Summary\n\n${summaryText}`,
    } satisfies TextBlock,
  ];

  const correctionsMatch = summaryText.match(
    /\*\*User Corrections[^*]*\*\*([\s\S]*?)(?=\n\*\*|\n\d+\.|$)/i,
  );
  if (correctionsMatch) {
    const corrections = correctionsMatch[1].trim();
    if (corrections && corrections.length > 20) {
      summaryContent.push({
        type: "text",
        text: `<system-reminder>\n## Persistent User Corrections & Preferences\n${corrections}\n</system-reminder>`,
      });
    }
  }

  const condenseId = randomUUID();
  const summaryMessage: AgentMessage = {
    role: "user",
    content: summaryContent,
    isSummary: true,
    condenseId,
    preservedContext,
  };

  const newMessages: AgentMessage[] = messages.map((msg, idx) => {
    if (idx === 0) return msg;
    if (msg.condenseParent) return msg;
    return { ...msg, condenseParent: condenseId };
  });

  newMessages.push(summaryMessage);

  const newInputTokens = estimateTokensFromChars(
    systemPrompt.length +
      summaryContent.reduce(
        (acc, b) => acc + (b.type === "text" ? b.text.length : 0),
        0,
      ),
  );

  const effectiveHistory = getEffectiveHistory(newMessages);

  return {
    messages: newMessages,
    summary: summaryText,
    prevInputTokens,
    newInputTokens,
    validationWarnings,
    metadata: {
      inputMessageCount: condenseSourceMessages.length,
      sourceUserMessageCount: canonicalUserMessages.length,
      hadPriorSummaryInInput,
      sourceHash: sourceWindowHash(condenseSourceMessages, priorSummary),
      providerId: provider.id,
      condenseModel: provider.condenseModel,
      modelCandidates,
      skippedModelCandidates:
        skippedModelCandidates.length > 0 ? skippedModelCandidates : undefined,
      selectedModel,
      latestUserMessage: resumeAnchor.latestUserMessage,
      currentTask: resumeAnchor.currentTask,
      pendingTasks,
      canonicalUserMessages,
      requestMessageCount: requestMessages.length,
      effectiveHistoryMessageCount: effectiveHistory.length,
      effectiveHistoryRoles: effectiveHistory.map((msg) => {
        if (msg.isSummary) return `${msg.role}:summary`;
        if (msg.isResumeContext) return `${msg.role}:resume`;
        return msg.role;
      }),
    },
  };
}
