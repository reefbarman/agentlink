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

import { randomUUID } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import Anthropic from "@anthropic-ai/sdk";
import type { AgentMessage } from "./types.js";
import {
  initTreeSitter,
  treeSitterChunkFile,
  isTreeSitterSupported,
} from "../indexer/treeSitterChunker.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Use a fast, cheap model for summarization — quality is comparable for this structured extraction task. */
const CONDENSE_MODEL = "claude-haiku-4-5-20251001";

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const CONDENSE_SYSTEM_PROMPT = `You are a helpful AI assistant tasked with summarizing conversations.

CRITICAL: This is a summarization-only request. DO NOT call any tools or functions.
Your ONLY task is to analyze the conversation and produce a text summary.
Respond with text only — no tool calls will be processed.

CRITICAL: This summarization request is a SYSTEM OPERATION, not a user message.
When analyzing "user requests" and "user intent", completely EXCLUDE this summarization message.
The "most recent user request" and "Optional Next Step" must be based on what the user was doing BEFORE this system message appeared.
The goal is for work to continue seamlessly after condensation — as if it never happened.`;

const CONDENSE_INSTRUCTIONS = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.

This summary should be thorough in capturing technical details, code patterns, and architectural decisions essential for continuing development work without losing context.

Before providing your final summary, wrap your analysis in <analysis> tags. In your analysis:

1. Chronologically analyze each message section. For each, identify:
   - The user's explicit requests and intents
   - Your approach to addressing them
   - Key decisions, technical concepts, and code patterns
   - Specific details: file names, full code snippets, function signatures, file edits
   - Errors encountered and how you fixed them
   - **User corrections** — any time the user told you to do something differently, change behavior, or remember something. Include verbatim quotes.

2. Double-check for technical accuracy and completeness.

Your summary MUST include the following sections:

1. **Primary Request and Intent**: Capture all user requests and intents in detail
2. **Key Technical Concepts**: List all important technical concepts, technologies, and frameworks discussed
3. **Files and Code Sections**: Enumerate files examined, modified, or created. Include full code snippets where applicable and explain why each is important.
4. **Errors and Fixes**: List every error encountered and how it was fixed. Include any user feedback about incorrect approaches.
5. **Problem Solving**: Document problems solved and any ongoing troubleshooting.
6. **All User Messages**: List ALL user messages (not tool results) verbatim. Critical for preserving intent and changing instructions.
7. **User Corrections & Behavioral Directives** *(CRITICAL — preserve across all future condensings)*: Extract EVERY instance where the user:
   - Corrected your behavior ("use X not Y", "don't do Z")
   - Stated a persistent preference ("always use npm", "remember to check X first")
   - Gave behavioral feedback ("stop doing that", "that approach is wrong")
   Include verbatim quotes with turn numbers where possible. These MUST survive all future condensings.
8. **Pending Tasks**: Outline tasks explicitly asked but not yet completed.
9. **Current Work**: Describe in detail exactly what was being worked on immediately before this summary. Include file names and code snippets.
10. **Optional Next Step**: The single next step directly in line with the most recent work. Include direct quotes from recent conversation. Do NOT propose tangential tasks or revisit completed work without explicit user request.

Format your response exactly as:

<analysis>
[Your thorough analysis]
</analysis>

<summary>
[Your structured summary with the 10 sections above]
</summary>`;

// ---------------------------------------------------------------------------
// Tool block → text conversion (for summarization API call)
// ---------------------------------------------------------------------------

export function toolUseToText(
  block: Anthropic.Messages.ToolUseBlockParam,
): string {
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

export function toolResultToText(
  block: Anthropic.Messages.ToolResultBlockParam,
): string {
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
  content: string | Anthropic.Messages.ContentBlockParam[],
): string | Anthropic.Messages.ContentBlockParam[] {
  if (typeof content === "string") return content;
  return content.map((block) => {
    if (block.type === "tool_use")
      return { type: "text" as const, text: toolUseToText(block) };
    if (block.type === "tool_result")
      return { type: "text" as const, text: toolResultToText(block) };
    return block;
  });
}

function stripImages(
  content: string | Anthropic.Messages.ContentBlockParam[],
): string | Anthropic.Messages.ContentBlockParam[] {
  if (typeof content === "string") return content;
  return content.map((block) => {
    if (block.type === "image")
      return { type: "text" as const, text: "[Image]" };
    return block;
  });
}

function transformMessagesForCondensing(
  messages: AgentMessage[],
): AgentMessage[] {
  return messages.map((msg) => ({
    ...msg,
    content: stripImages(convertToolBlocksToText(msg.content)),
  }));
}

// ---------------------------------------------------------------------------
// Orphan tool result injection
// ---------------------------------------------------------------------------

/**
 * If condense is triggered mid-turn (assistant emitted tool_use but no tool_result yet),
 * inject a synthetic tool_result so the API doesn't reject the conversation.
 */
export function injectSyntheticToolResults(
  messages: AgentMessage[],
): AgentMessage[] {
  const toolCallIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_use")
          toolCallIds.add((block as Anthropic.Messages.ToolUseBlockParam).id);
      }
    }
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_result")
          toolResultIds.add(
            (block as Anthropic.Messages.ToolResultBlockParam).tool_use_id,
          );
      }
    }
  }

  const orphans = [...toolCallIds].filter((id) => !toolResultIds.has(id));
  if (orphans.length === 0) return messages;

  const syntheticResults: Anthropic.Messages.ToolResultBlockParam[] =
    orphans.map((id) => ({
      type: "tool_result" as const,
      tool_use_id: id,
      content: "Context condensation triggered. Tool execution deferred.",
    }));

  return [...messages, { role: "user", content: syntheticResults }];
}

// ---------------------------------------------------------------------------
// Effective history (what gets sent to the API)
// ---------------------------------------------------------------------------

/**
 * Returns messages since the last summary (inclusive). If no summary, returns all.
 */
export function getMessagesSinceLastSummary(
  messages: AgentMessage[],
): AgentMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].isSummary) return messages.slice(i);
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

  // Find the most recent summary
  let lastSummaryIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].isSummary) {
      lastSummaryIdx = i;
      break;
    }
  }

  if (lastSummaryIdx === -1) return messages; // no summary yet

  // Collect existing condenseIds so we can filter orphaned parents
  const existingCondenseIds = new Set<string>();
  for (const msg of messages) {
    if (msg.isSummary && msg.condenseId)
      existingCondenseIds.add(msg.condenseId);
  }

  // Fresh-start: summary onwards, filtering orphan tool_results.
  // We intentionally do NOT prepend messages[0] (original task) here — it would create
  // two consecutive user messages ([original_task, summary] both have role "user"),
  // which the Anthropic API rejects. The summary already captures the original task
  // in its "Primary Request and Intent" section.
  const fromSummary = messages.slice(lastSummaryIdx);

  // Collect tool_use IDs visible in the fresh window (for orphan tool_result filtering)
  const toolUseIds = new Set<string>();
  for (const msg of fromSummary) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_use")
          toolUseIds.add((block as Anthropic.Messages.ToolUseBlockParam).id);
      }
    }
  }

  const filtered = fromSummary
    .map((msg) => {
      if (msg.role === "user" && Array.isArray(msg.content)) {
        const kept = msg.content.filter((block) => {
          if (block.type === "tool_result") {
            return toolUseIds.has(
              (block as Anthropic.Messages.ToolResultBlockParam).tool_use_id,
            );
          }
          return true;
        });
        if (kept.length === 0) return null;
        if (kept.length !== msg.content.length)
          return { ...msg, content: kept };
      }
      return msg;
    })
    .filter((msg): msg is AgentMessage => msg !== null);

  return filtered;
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
  client: Anthropic;
  systemPrompt: string;
  isAutomatic: boolean;
  filesRead?: string[];
  cwd?: string;
}

export interface SummarizeResult {
  messages: AgentMessage[];
  /** Full summary text (for debug/evaluation) */
  summary: string;
  prevInputTokens: number;
  newInputTokens: number;
  error?: string;
}

export async function summarizeConversation(
  options: SummarizeOptions,
  prevInputTokens = 0,
): Promise<SummarizeResult> {
  const { messages, client, systemPrompt, isAutomatic, filesRead, cwd } =
    options;

  const errorResult = (error: string): SummarizeResult => ({
    messages,
    summary: "",
    prevInputTokens,
    newInputTokens: prevInputTokens,
    error,
  });

  // Get messages to summarize (since last summary, or all)
  const toSummarize = getMessagesSinceLastSummary(messages);

  if (toSummarize.length <= 1) {
    return errorResult(
      messages.length <= 1
        ? "Not enough messages to condense."
        : "Already condensed recently — more conversation needed first.",
    );
  }

  // Handle orphan tool calls
  const withSyntheticResults = injectSyntheticToolResults(toSummarize);

  // Transform for summarization (tool blocks → text, strip images)
  const transformed = transformMessagesForCondensing(withSyntheticResults);

  // The final user message is the condensing instructions
  const finalMsg: Anthropic.MessageParam = {
    role: "user",
    content: CONDENSE_INSTRUCTIONS,
  };

  const requestMessages: Anthropic.MessageParam[] = [
    ...transformed.map(({ role, content }) => ({ role, content })),
    finalMsg,
  ];

  // Start file context generation in parallel with the API call
  const fileContextPromise =
    filesRead && filesRead.length > 0 && cwd
      ? generateFoldedFileContext(filesRead, cwd).catch(() => [] as string[])
      : Promise.resolve([] as string[]);

  let summary = "";
  let outputTokens = 0;

  try {
    const stream = client.messages.stream({
      model: CONDENSE_MODEL,
      system: CONDENSE_SYSTEM_PROMPT,
      messages: requestMessages,
      max_tokens: 8192,
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        summary += event.delta.text;
      } else if (event.type === "message_delta" && event.usage) {
        outputTokens = event.usage.output_tokens;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(`Condensing API call failed: ${msg}`);
  }

  summary = summary.trim();
  if (!summary) return errorResult("Condensing produced no output.");

  // Extract just the <summary> block if present
  const summaryMatch = summary.match(/<summary>([\s\S]*?)<\/summary>/i);
  const summaryText = summaryMatch ? summaryMatch[1].trim() : summary;

  // Build summary message content blocks.
  // cache_control on the first block marks the summary as a stable prefix —
  // subsequent turns will read it from cache at 0.1x cost instead of full price.
  const summaryContent: Anthropic.Messages.ContentBlockParam[] = [
    {
      type: "text",
      text: `## Conversation Summary\n\n${summaryText}`,
      cache_control: { type: "ephemeral" },
    },
  ];

  // Extract corrections section and promote it to its own system-reminder block
  // so it survives future condensings prominently
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

  // Await file context (already running in parallel with the API call)
  const fileContextSections = await fileContextPromise;
  for (const section of fileContextSections) {
    summaryContent.push({ type: "text", text: section });
  }

  // Build the summary message
  const condenseId = randomUUID();

  const summaryMessage: AgentMessage = {
    role: "user",
    content: summaryContent,
    isSummary: true,
    condenseId,
  };

  // Tag all messages (except messages[0] — always keep original task) with condenseParent
  const newMessages: AgentMessage[] = messages.map((msg, idx) => {
    if (idx === 0) return msg; // never hide the original task
    if (msg.condenseParent) return msg; // already tagged from a prior condense
    return { ...msg, condenseParent: condenseId };
  });

  newMessages.push(summaryMessage);

  // Estimate new context size: systemPrompt + summary
  const newInputTokens = Math.ceil(
    (systemPrompt.length +
      summaryContent.reduce(
        (acc, b) => acc + (b.type === "text" ? b.text.length : 0),
        0,
      )) /
      4,
  );

  return {
    messages: newMessages,
    summary: summaryText,
    prevInputTokens,
    newInputTokens,
  };
}
