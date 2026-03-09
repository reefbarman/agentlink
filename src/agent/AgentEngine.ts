import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import type { AgentSession } from "./AgentSession.js";
import type { AgentEvent } from "./types.js";
import { THINKING_MODELS } from "./types.js";
import {
  getAgentTools,
  dispatchToolCall,
  READ_ONLY_TOOLS,
  type ToolDispatchContext,
} from "./toolAdapter.js";
import { handleToolError } from "../shared/types.js";
import type { ToolResult } from "../shared/types.js";
import {
  createAnthropicClient,
  refreshClaudeCredentials,
  type AuthSource,
} from "./clientFactory.js";
import {
  TODO_TOOL_NAME,
  todoTool,
  handleTodoWrite,
  type TodoToolInput,
} from "./todoTool.js";
import {
  summarizeConversation,
  injectSyntheticToolResults,
} from "./condense.js";

// Context window sizes for supported models (tokens)
const CONTEXT_WINDOWS: Record<string, number> = {
  "claude-opus-4-6": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-haiku-4-5-20251001": 200_000,
  "claude-haiku-4-5": 200_000,
};

const DEFAULT_CONTEXT_WINDOW = 200_000;
const MAX_API_RETRIES = 3;

/** Walk the error cause chain and join unique messages into one string. */
// (No equivalent exists elsewhere in the codebase.)
function buildErrorMessage(err: unknown): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  let e: unknown = err;
  while (e instanceof Error && !seen.has(e)) {
    seen.add(e);
    if (e.message) parts.push(e.message);
    e = (e as { cause?: unknown }).cause;
  }
  return [...new Set(parts)].join(": ");
}

/** Returns true for transient errors that are safe to retry. */
function isRetryableError(msg: string): boolean {
  return (
    msg.includes("rate_limit") ||
    msg.includes("overloaded") ||
    msg.includes("529") ||
    msg.includes("Connection error") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("ENOTFOUND") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("fetch failed")
  );
}

/** Custom error for auth failures, so the outer catch can mark them specially. */
class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}

/** Returns true for authentication errors (expired token, invalid key). */
function isAuthError(msg: string): boolean {
  return (
    msg.includes("authentication_error") ||
    msg.includes("invalid x-api-key") ||
    msg.includes("invalid api key") ||
    (msg.includes("401") && !msg.includes("tool"))
  );
}

function getContextWindow(model: string): number {
  return CONTEXT_WINDOWS[model] ?? DEFAULT_CONTEXT_WINDOW;
}

/** Internal result from a single tool call execution. */
interface ToolCallResult {
  tool_use_id: string;
  toolName: string;
  result: ToolResult;
  durationMs: number;
}

// Per-tool character limits for tool results kept in conversation history.
// Tools that self-paginate (read_file) get more headroom; repetitive/noisy
// tools get tighter caps. At ~4 chars/token:
const TOOL_RESULT_CHAR_LIMITS: Record<string, number> = {
  read_file: 80_000, // ~20k tokens — self-paginating; every line is high-value
  execute_command: 40_000, // ~10k tokens — VS Code terminal already caps at 200 lines
  search_files: 20_000, // ~5k tokens — results can be repetitive; agent can refine
  codebase_search: 20_000,
  list_files: 12_000, // ~3k tokens — just file paths
};
const DEFAULT_TOOL_RESULT_CHARS = 32_000; // ~8k tokens

// Truncated tool results are saved here so the agent can read_file the full
// output when needed. Allowlisted in handleReadFile to bypass the approval gate.
const AGENTLINK_TMP_DIR = "/tmp/agentlink-results";

/**
 * Snap a head slice back to the last newline within 15% of the budget,
 * so truncation always ends at a complete line.
 */
function headSlice(text: string, maxChars: number): string {
  const raw = text.slice(0, maxChars);
  const newlineIdx = raw.lastIndexOf("\n");
  if (newlineIdx > 0 && maxChars - newlineIdx <= maxChars * 0.15) {
    return raw.slice(0, newlineIdx + 1);
  }
  return raw;
}

/**
 * Snap a tail slice forward to the first newline within 15% of the budget,
 * so truncation always starts at a complete line.
 */
function tailSlice(text: string, maxChars: number): string {
  const raw = text.slice(text.length - maxChars);
  const newlineIdx = raw.indexOf("\n");
  if (newlineIdx >= 0 && newlineIdx <= maxChars * 0.15) {
    return raw.slice(newlineIdx + 1);
  }
  return raw;
}

/**
 * Head+tail truncation with line-boundary snapping. Keeps the first and last
 * portions so both the start and end of output are visible (critical for
 * terminal output where errors appear at the end). Reports omitted tokens so
 * the agent can gauge how much was dropped. Saves full content to a tmp file
 * if toolUseId is provided so the agent can read_file the complete result.
 */
function truncateToolText(
  text: string,
  maxChars: number,
  toolUseId?: string,
): string {
  if (text.length <= maxChars) return text;

  const halfChars = Math.floor(maxChars * 0.5);
  const head = headSlice(text, halfChars);
  const tail = tailSlice(text, maxChars - halfChars);
  const omittedChars = text.length - head.length - tail.length;
  const omittedTokens = Math.ceil(omittedChars / 4);

  let notice = `\n\n[... ~${omittedTokens.toLocaleString()} tokens (~${omittedChars.toLocaleString()} chars) omitted from middle ...]`;

  if (toolUseId) {
    const tmpPath = path.join(AGENTLINK_TMP_DIR, `${toolUseId}.txt`);
    // Fire-and-forget — save full content without blocking the response
    fs.mkdir(AGENTLINK_TMP_DIR, { recursive: true })
      .then(() => fs.writeFile(tmpPath, text, "utf-8"))
      .catch(() => {});
    notice += `\nFull output saved to: ${tmpPath} — use read_file to access the complete result.`;
  }

  return `${head}${notice}\n\n${tail}`;
}

/** Convert our ToolResult content to Anthropic API tool_result content. */
function toolResultToContent(
  result: ToolResult,
  toolUseId: string,
  toolName: string,
): string | Anthropic.ToolResultBlockParam["content"] {
  const maxChars =
    TOOL_RESULT_CHAR_LIMITS[toolName] ?? DEFAULT_TOOL_RESULT_CHARS;
  const hasImage = result.content.some((c) => c.type === "image");
  if (!hasImage) {
    // Simple case: all text — join into a single string, then cap size.
    const joined = result.content
      .filter((c) => c.type === "text")
      .map((c) => (c as { type: "text"; text: string }).text)
      .join("\n");
    return truncateToolText(joined, maxChars, toolUseId);
  }
  // Mixed content: pass blocks so images are preserved; cap text blocks.
  return result.content.map((c) => {
    if (c.type === "text")
      return {
        type: "text" as const,
        text: truncateToolText(c.text, maxChars, toolUseId),
      };
    // image
    return {
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: (c as { type: "image"; data: string; mimeType: string })
          .mimeType as Anthropic.Base64ImageSource["media_type"],
        data: (c as { type: "image"; data: string; mimeType: string }).data,
      },
    };
  });
}

/**
 * Merge consecutive user messages before sending to the API.
 * Consecutive user messages can occur after condense (summary message followed
 * by a pending user message) or when the user interjects between tool batches.
 */
function mergeConsecutiveUserMessages(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];
  for (const msg of messages) {
    const last = result[result.length - 1];
    if (last?.role === "user" && msg.role === "user") {
      const toBlocks = (
        c: Anthropic.MessageParam["content"],
      ): Anthropic.ContentBlockParam[] =>
        Array.isArray(c)
          ? (c as Anthropic.ContentBlockParam[])
          : [{ type: "text", text: c as string }];
      last.content = [...toBlocks(last.content), ...toBlocks(msg.content)];
    } else {
      result.push({ role: msg.role, content: msg.content });
    }
  }
  return result;
}

/**
 * Add cache_control breakpoints to the last 2 user messages.
 * Multi-point caching: the second-to-last breakpoint hits the cache on the next
 * turn (the prefix before it is stable), while the last creates a new cache entry
 * so the turn after that also benefits. Net: every turn after the first gets at
 * least one cache hit, reducing costs significantly on long agentic runs.
 */
function addMessageCacheBreakpoints(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  // Collect indices of the last 2 user messages (walking backwards)
  const userIndices: number[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userIndices.push(i);
      if (userIndices.length === 2) break;
    }
  }
  if (userIndices.length === 0) return messages;

  return messages.map((msg, idx) => {
    if (!userIndices.includes(idx)) return msg;
    // Normalize content to array so cache_control can be on the last block
    const blocks = Array.isArray(msg.content)
      ? (msg.content as unknown as Array<Record<string, unknown>>)
      : [{ type: "text", text: msg.content as string }];
    if (blocks.length === 0) return msg;
    const patched = [
      ...blocks.slice(0, -1),
      { ...blocks[blocks.length - 1], cache_control: { type: "ephemeral" } },
    ];
    return {
      role: msg.role,
      content: patched as unknown as Anthropic.ContentBlockParam[],
    };
  });
}

/**
 * Read OAuth token from Claude CLI credentials file (~/.claude/.credentials.json).
 */
export class AgentEngine {
  private client: Anthropic;
  private authSource: AuthSource;
  private apiKey?: string;
  private log?: (msg: string) => void;
  private toolCtx: ToolDispatchContext | null = null;

  constructor(apiKey?: string, log?: (msg: string) => void) {
    const result = createAnthropicClient(apiKey, log);
    this.client = result.client;
    this.authSource = result.authSource;
    this.apiKey = apiKey;
    this.log = log;
  }

  /**
   * Attempt to refresh CLI credentials (runs `claude -p` to force the SDK
   * to refresh the OAuth token), then re-create the Anthropic client.
   * Returns true if the client was successfully refreshed.
   */
  private refreshClient(): boolean {
    if (this.authSource !== "cli-credentials") return false;
    const refreshed = refreshClaudeCredentials(this.log);
    if (!refreshed) return false;
    try {
      const result = createAnthropicClient(this.apiKey, this.log);
      this.client = result.client;
      this.authSource = result.authSource;
      return true;
    } catch {
      return false;
    }
  }

  setToolContext(ctx: ToolDispatchContext): void {
    this.toolCtx = ctx;
  }

  async *run(
    session: AgentSession,
    opts?: { isBackground?: boolean },
  ): AsyncGenerator<AgentEvent> {
    const ac = session.createAbortController();
    // Capture signal locally — a subsequent run() call on the same session would
    // replace session._abortSignal via createAbortController(), causing session.isAborted
    // to return false in this (still-running) loop and allowing spurious API calls.
    const { signal } = ac;

    // Cache assembled tool list across turns — rebuild only when the tool set changes.
    // This keeps the cache_control marker on the last tool stable across turns so the
    // system prompt + tool prefix stays cached for the full session.
    // Compare by name fingerprint rather than count so MCP tool replacements (same
    // number, different names/schemas) correctly bust the cache.
    let cachedTools: ReturnType<typeof getAgentTools> | undefined;
    let cachedToolFingerprint = "";

    try {
      let retryCount = 0;
      while (true) {
        if (signal.aborted) break;

        // --- Auto-condense check ---
        // Run before each API call (except the very first) to keep context in bounds.
        if (session.autoCondense && session.lastInputTokens > 0) {
          const contextWindow = getContextWindow(session.model);
          const usedFraction = session.lastInputTokens / contextWindow;
          // Cache-aware threshold: when most tokens are cache reads (0.1x cost),
          // running near the context limit is much cheaper, so we can afford to
          // wait longer before paying the cost of a condense operation.
          // Scale the threshold up by up to +10% proportional to cache hit ratio.
          const cacheHitRatio =
            session.lastInputTokens > 0
              ? session.lastCacheReadTokens / session.lastInputTokens
              : 0;
          const effectiveThreshold = Math.min(
            session.autoCondenseThreshold + cacheHitRatio * 0.1,
            0.95,
          );
          if (usedFraction >= effectiveThreshold) {
            yield* this.condenseSession(session, true);
            if (signal.aborted) break;
            // Check for messages queued during condense — inject them now
            // so they're included in the next API call rather than waiting
            // until the next tool batch.
            const interjection = session.consumePendingInterjection();
            if (interjection) {
              session.addUserMessage(interjection.text);
              yield {
                type: "user_interjection" as const,
                text: interjection.text,
                queueId: interjection.queueId,
              };
            }
          }
        }

        const requestId = randomUUID();
        const startTime = Date.now();
        let timeToFirstToken = 0;

        const useThinking =
          THINKING_MODELS.has(session.model) && session.thinkingBudget > 0;

        // When thinking is enabled, max_tokens must exceed budget_tokens
        const maxTokens = useThinking
          ? Math.max(session.maxTokens, session.thinkingBudget + 4096)
          : session.maxTokens;

        // Include tools when dispatch context is available, filtered by mode
        const mcpToolDefs = this.toolCtx?.mcpHub?.getToolDefs() ?? [];
        const rawTools = this.toolCtx
          ? [
              ...getAgentTools(
                session.agentMode,
                mcpToolDefs,
                opts?.isBackground,
              ),
              todoTool,
            ]
          : undefined;

        // Rebuild with cache_control only when the tool set changes (MCP tools added/removed
        // or replaced). Fingerprint by sorted tool names so count-preserving replacements
        // (e.g. one MCP tool swapped for another) correctly bust the cache.
        // cache_control on the last tool tells the API to cache everything up to that point
        // (system prompt + all tools), so subsequent turns pay only 0.1x for that prefix.
        const fingerprint = rawTools
          ? rawTools
              .map((t) => t.name)
              .sort()
              .join(",")
          : "";
        if (rawTools && fingerprint !== cachedToolFingerprint) {
          cachedTools = rawTools.map((t, i) =>
            i === rawTools.length - 1
              ? { ...t, cache_control: { type: "ephemeral" as const } }
              : t,
          );
          cachedToolFingerprint = fingerprint;
        }
        const tools = rawTools ? cachedTools : undefined;

        const requestParams: Anthropic.MessageCreateParams = {
          model: session.model,
          // Structured system array so we can attach cache_control. The system prompt
          // is stable per session — caching it saves full input-token cost every turn.
          system: [
            {
              type: "text",
              text: session.systemPrompt,
              cache_control: { type: "ephemeral" },
            },
          ],
          // Strip AgentMessage-only fields (isSummary, condenseId, condenseParent) — the
          // Anthropic API rejects unknown properties on message objects.
          // Merge consecutive user messages then add cache breakpoints to the last 2
          // for multi-point caching (reduces input-token costs on long agentic runs).
          messages: addMessageCacheBreakpoints(
            mergeConsecutiveUserMessages(
              session
                .getMessages()
                .map(({ role, content }) => ({ role, content })),
            ),
          ),
          max_tokens: maxTokens,
          stream: true,
          ...(tools && tools.length > 0 ? { tools } : {}),
        };

        if (useThinking) {
          // Extended thinking — budget param
          (requestParams as unknown as Record<string, unknown>).thinking = {
            type: "enabled",
            budget_tokens: session.thinkingBudget,
          };
        }

        const contentBlocks: Anthropic.ContentBlock[] = [];
        // Track thinking blocks and text blocks being built
        const blockBuffers = new Map<
          number,
          {
            type: string;
            id?: string;
            text: string;
            name?: string;
            signature?: string;
          }
        >();

        let inputTokens = 0;
        let outputTokens = 0;
        let cacheReadTokens = 0;
        let cacheCreationTokens = 0;
        let firstTokenReceived = false;

        try {
          const stream = this.client.messages.stream(requestParams, {
            signal: ac.signal,
          });

          for await (const event of stream) {
            if (signal.aborted) break;

            if (!firstTokenReceived) {
              firstTokenReceived = true;
              timeToFirstToken = Date.now() - startTime;
            }

            switch (event.type) {
              case "content_block_start": {
                const block = event.content_block;
                const idx = event.index;

                if (block.type === "thinking") {
                  const thinkingId = randomUUID();
                  blockBuffers.set(idx, {
                    type: "thinking",
                    id: thinkingId,
                    text: "",
                  });
                  yield { type: "thinking_start", thinkingId };
                } else if (block.type === "text") {
                  blockBuffers.set(idx, { type: "text", text: "" });
                } else if (block.type === "tool_use") {
                  blockBuffers.set(idx, {
                    type: "tool_use",
                    id: block.id,
                    name: block.name,
                    text: "",
                  });
                  session.currentTool = block.name;
                  yield {
                    type: "tool_start",
                    toolCallId: block.id,
                    toolName: block.name,
                  };
                }
                break;
              }

              case "content_block_delta": {
                const idx = event.index;
                const buf = blockBuffers.get(idx);

                if (
                  event.delta.type === "thinking_delta" &&
                  buf?.type === "thinking"
                ) {
                  buf.text += event.delta.thinking;
                  yield {
                    type: "thinking_delta",
                    thinkingId: buf.id!,
                    text: event.delta.thinking,
                  };
                } else if (
                  event.delta.type === "text_delta" &&
                  buf?.type === "text"
                ) {
                  buf.text += event.delta.text;
                  yield { type: "text_delta", text: event.delta.text };
                } else if (
                  event.delta.type === "signature_delta" &&
                  buf?.type === "thinking"
                ) {
                  buf.signature =
                    (buf.signature ?? "") +
                    (event.delta as unknown as { signature: string }).signature;
                } else if (
                  event.delta.type === "input_json_delta" &&
                  buf?.type === "tool_use"
                ) {
                  buf.text += event.delta.partial_json;
                  yield {
                    type: "tool_input_delta",
                    toolCallId: buf.id!,
                    partialJson: event.delta.partial_json,
                  };
                }
                break;
              }

              case "content_block_stop": {
                const idx = event.index;
                const buf = blockBuffers.get(idx);

                if (buf?.type === "thinking") {
                  yield { type: "thinking_end", thinkingId: buf.id! };
                  contentBlocks.push({
                    type: "thinking",
                    thinking: buf.text,
                    signature: buf.signature ?? "",
                  } as unknown as Anthropic.ContentBlock);
                } else if (buf?.type === "text") {
                  contentBlocks.push({
                    type: "text",
                    text: buf.text,
                  } as Anthropic.TextBlock);
                } else if (buf?.type === "tool_use") {
                  contentBlocks.push({
                    type: "tool_use",
                    id: buf.id!,
                    name: buf.name!,
                    input: buf.text ? JSON.parse(buf.text) : {},
                  } as Anthropic.ToolUseBlock);
                }

                blockBuffers.delete(idx);
                break;
              }

              case "message_delta": {
                if (event.usage) {
                  outputTokens = event.usage.output_tokens;
                }
                break;
              }

              case "message_start": {
                if (event.message.usage) {
                  inputTokens = event.message.usage.input_tokens;
                  // The SDK types don't expose cache fields yet — cast to access them.
                  const u = event.message
                    .usage as typeof event.message.usage & {
                    cache_read_input_tokens?: number;
                    cache_creation_input_tokens?: number;
                  };
                  cacheReadTokens = u.cache_read_input_tokens ?? 0;
                  cacheCreationTokens = u.cache_creation_input_tokens ?? 0;
                }
                break;
              }
            }
          }
        } catch (streamErr: unknown) {
          if (signal.aborted) break;
          const streamErrMsg = buildErrorMessage(streamErr);

          // Orphaned tool_use blocks (e.g. from an aborted run) cause a 400.
          // Inject synthetic tool_results to repair the history and retry.
          if (
            streamErrMsg.includes("tool_use") &&
            streamErrMsg.includes("tool_result")
          ) {
            session.replaceMessages(
              injectSyntheticToolResults(session.getAllMessages()),
            );
            yield {
              type: "warning",
              message: `Repaired orphaned tool calls, retrying. Error: ${streamErrMsg}`,
            };
            continue;
          }

          // Auth errors: try refreshing CLI credentials before failing.
          if (
            isAuthError(streamErrMsg) &&
            this.authSource === "cli-credentials"
          ) {
            yield {
              type: "warning",
              message: "Authentication expired — refreshing credentials…",
            };
            if (this.refreshClient()) {
              yield {
                type: "warning",
                message: "Credentials refreshed — retrying request…",
              };
              continue;
            }
            // Refresh failed — fall through to throw
            throw new AuthenticationError(streamErrMsg);
          }

          // Transient network / rate-limit errors: auto-retry with backoff.
          if (isRetryableError(streamErrMsg) && retryCount < MAX_API_RETRIES) {
            retryCount++;
            const isRateLimit =
              streamErrMsg.includes("rate_limit") ||
              streamErrMsg.includes("overloaded");
            const delayMs = isRateLimit
              ? Math.min(retryCount * 15_000, 60_000)
              : Math.min(retryCount * 2_000, 10_000);
            yield {
              type: "warning",
              message: `${streamErrMsg} — retrying in ${delayMs / 1000}s (attempt ${retryCount}/${MAX_API_RETRIES})`,
            };
            await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
            if (signal.aborted) break;
            continue;
          }

          throw streamErr;
        }

        // Successful API response — reset retry counter.
        retryCount = 0;

        if (signal.aborted) break;

        const durationMs = Date.now() - startTime;
        session.addUsage(
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens,
        );

        // The API's input_tokens only counts tokens after the last cache breakpoint.
        // For context window tracking, report the total: uncached + cache reads + cache writes.
        const totalInputTokens =
          inputTokens + cacheReadTokens + cacheCreationTokens;

        yield {
          type: "api_request",
          requestId,
          model: session.model,
          inputTokens: totalInputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens,
          durationMs,
          timeToFirstToken,
        };

        // Extract tool_use blocks
        const toolUseBlocks = contentBlocks.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
        );

        if (toolUseBlocks.length === 0) {
          // No tool calls — append the assistant turn on its own and finish.
          session.appendAssistantTurn(contentBlocks);
          break;
        }

        if (!this.toolCtx) {
          // No dispatch context — append and finish without executing tools.
          session.appendAssistantTurn(contentBlocks);
          break;
        }

        // Session-scoped tool context: use session.id so that per-session approvals
        // (MCP, command, write) are isolated between foreground chat sessions rather
        // than shared via the static "agent" synthetic ID.
        const sessionCtx: ToolDispatchContext = {
          ...this.toolCtx,
          sessionId: session.id,
        };

        // Execute tools (parallel for read-only, sequential for write)
        session.status = "tool_executing";

        // Separate internal tools (todo_write) from dispatch tools
        const internalResults: ToolCallResult[] = [];
        const dispatchBlocks: Anthropic.ToolUseBlock[] = [];
        for (const block of toolUseBlocks) {
          if (block.name === TODO_TOOL_NAME) {
            const start = Date.now();
            const { content, todos } = handleTodoWrite(
              block.input as TodoToolInput,
            );
            internalResults.push({
              tool_use_id: block.id,
              toolName: block.name,
              result: {
                content: [
                  {
                    type: "text",
                    text:
                      typeof content === "string"
                        ? content
                        : JSON.stringify(content),
                  },
                ],
              },
              durationMs: Date.now() - start,
            });
            yield { type: "todo_update" as const, todos };
          } else {
            dispatchBlocks.push(block);
          }
        }

        const dispatchResults =
          dispatchBlocks.length > 0
            ? await this.executeToolCalls(dispatchBlocks, signal, sessionCtx)
            : [];

        // Merge results back in original order
        const toolResults = toolUseBlocks.map((block) => {
          const internal = internalResults.find(
            (r) => r.tool_use_id === block.id,
          );
          if (internal) return internal;
          return dispatchResults.find((r) => r.tool_use_id === block.id)!;
        });

        // Append assistant turn + tool results atomically — no async gap between
        // them so the session is never left with orphaned tool_use blocks.
        session.appendAssistantTurn(contentBlocks);
        session.appendToolResults(
          toolResults.map((tr) => ({
            type: "tool_result" as const,
            tool_use_id: tr.tool_use_id,
            content: toolResultToContent(
              tr.result,
              tr.tool_use_id,
              tr.toolName,
            ),
          })),
        );

        // Yield tool_result events (after history is updated)
        for (const tr of toolResults) {
          yield {
            type: "tool_result" as const,
            toolCallId: tr.tool_use_id,
            toolName: tr.toolName,
            result: tr.result.content,
            durationMs: tr.durationMs,
          };
        }

        // Inject any pending user interjection between tool batches
        if (!signal.aborted) {
          const interjection = session.consumePendingInterjection();
          if (interjection) {
            session.addUserMessage(interjection.text);
            yield {
              type: "user_interjection" as const,
              text: interjection.text,
              queueId: interjection.queueId,
            };
          }
        }

        session.status = "streaming";
      }
    } catch (err: unknown) {
      if (signal.aborted) return;
      // Retryable errors are handled inside the loop with auto-retry.
      // Anything reaching here is non-retryable or exhausted all retries.
      // Auth errors are marked retryable so the UI can offer a Retry button.
      const isAuth =
        err instanceof AuthenticationError ||
        isAuthError(buildErrorMessage(err));
      yield { type: "error", error: buildErrorMessage(err), retryable: isAuth };
      return;
    } finally {
      session.status = "idle";
    }

    // Don't emit done if aborted — ChatViewProvider already posted agentDone on stop,
    // and a second done event could interrupt a new run that's already in progress.
    if (signal.aborted) return;

    yield {
      type: "done",
      totalInputTokens: session.totalInputTokens,
      totalOutputTokens: session.totalOutputTokens,
      totalCacheReadTokens: session.totalCacheReadTokens,
      totalCacheCreationTokens: session.totalCacheCreationTokens,
    };
  }

  /**
   * Execute tool calls with parallel read-only and sequential write strategy.
   * Results are returned in the same order as the original tool_use blocks.
   */
  private async executeToolCalls(
    calls: Anthropic.ToolUseBlock[],
    signal: AbortSignal,
    ctx: ToolDispatchContext,
  ): Promise<Array<ToolCallResult>> {
    const resultSlots = new Array<ToolCallResult | null>(calls.length).fill(
      null,
    );

    // Partition into read-only (parallel) and write (sequential)
    const readOnlyIndices: number[] = [];
    const writeIndices: number[] = [];
    for (let i = 0; i < calls.length; i++) {
      if (READ_ONLY_TOOLS.has(calls[i].name)) {
        readOnlyIndices.push(i);
      } else {
        writeIndices.push(i);
      }
    }

    // Execute read-only tools in parallel
    await Promise.all(
      readOnlyIndices.map(async (i) => {
        if (signal.aborted) return;
        const call = calls[i];
        const start = Date.now();
        try {
          const result = await dispatchToolCall(
            call.name,
            call.input as Record<string, unknown>,
            ctx,
          );
          resultSlots[i] = {
            tool_use_id: call.id,
            toolName: call.name,
            result,
            durationMs: Date.now() - start,
          };
        } catch (err) {
          resultSlots[i] = {
            tool_use_id: call.id,
            toolName: call.name,
            result: handleToolError(err),
            durationMs: Date.now() - start,
          };
        }
      }),
    );

    // Execute write tools sequentially
    for (const i of writeIndices) {
      if (signal.aborted) break;
      const call = calls[i];
      const start = Date.now();
      try {
        const result = await dispatchToolCall(
          call.name,
          call.input as Record<string, unknown>,
          ctx,
        );
        resultSlots[i] = {
          tool_use_id: call.id,
          toolName: call.name,
          result,
          durationMs: Date.now() - start,
        };
      } catch (err) {
        resultSlots[i] = {
          tool_use_id: call.id,
          toolName: call.name,
          result: handleToolError(err),
          durationMs: Date.now() - start,
        };
      }
    }

    // Return results in original order, filling any gaps (from abort) with errors
    return resultSlots.map(
      (slot, i) =>
        slot ?? {
          tool_use_id: calls[i].id,
          toolName: calls[i].name,
          result: {
            content: [
              { type: "text", text: JSON.stringify({ error: "Aborted" }) },
            ],
          },
          durationMs: 0,
        },
    );
  }

  /**
   * Condense the session's conversation history.
   * Yields condense or condense_error events. Updates session.messages on success.
   */
  async *condenseSession(
    session: AgentSession,
    isAutomatic: boolean,
  ): AsyncGenerator<AgentEvent> {
    yield { type: "condense_start", isAutomatic };

    const prevInputTokens = session.lastInputTokens;

    const result = await summarizeConversation(
      {
        messages: session.getAllMessages(),
        client: this.client,
        systemPrompt: session.systemPrompt,
        isAutomatic,
        filesRead: [...session.filesRead],
        cwd: session.cwd,
      },
      prevInputTokens,
    );

    if (result.error) {
      yield { type: "condense_error", error: result.error };
      return;
    }

    session.replaceMessages(result.messages);
    // Reset lastInputTokens to estimated post-condense value so we don't immediately re-trigger
    session.lastInputTokens = result.newInputTokens;
    // Clear stale cache-read ratio; post-condense estimate has no cache-read component.
    session.lastCacheReadTokens = 0;

    yield {
      type: "condense",
      summary: result.summary,
      prevInputTokens: result.prevInputTokens,
      newInputTokens: result.newInputTokens,
    };
  }
}
