/**
 * Shared live-model client for the evals in this folder (routing, TODO
 * decision points). Builds AgentLink's real system prompt and inline tool
 * catalog for this repository, sends a conversation to the configured model,
 * and returns its reply. Tools are never executed: callers answer tool calls
 * with canned results when they need another turn.
 *
 * Environment (shared by every eval):
 * - AGENTLINK_EVAL_BASE_URL  OpenAI-compatible base URL, e.g. http://127.0.0.1:3456/v1
 * - AGENTLINK_EVAL_MODEL     Model id sent to the endpoint
 * - AGENTLINK_EVAL_API_KEY   Bearer token (optional for local bridges)
 * - AGENTLINK_EVAL_FAMILY    "anthropic" (default) or "openai" prompt tuning
 * - AGENTLINK_EVAL_PROMPT_PROFILE "compatibility" or "reasoning" to force a
 *                            prompt profile (default: AgentLink's own choice,
 *                            which is compatibility for non-Codex providers)
 * - AGENTLINK_EVAL_RUNS      Runs per task (default 2)
 * - AGENTLINK_EVAL_TASKS     Comma-separated task ids to run (default all)
 * - AGENTLINK_EVAL_PASS_RATE Minimum overall pass rate, 0-1 (default 0.8)
 * - AGENTLINK_EVAL_LABEL     Display label recorded in the report (default: model)
 * - AGENTLINK_EVAL_REPORT_DIR Report directory (default telemetry-reports/evals)
 * - AGENTLINK_EVAL_TRANSPORT "chat-completions" (default) or "codex". Codex
 *                            sends AgentLink's production Codex Responses
 *                            request to the ChatGPT subscription backend with
 *                            AGENTLINK_EVAL_API_KEY as the OAuth access token;
 *                            AGENTLINK_EVAL_BASE_URL is not used.
 * - AGENTLINK_EVAL_CODEX_ACCOUNT_ID ChatGPT account ID header for codex
 * - AGENTLINK_EVAL_REASONING_EFFORT Reasoning effort for codex (default: the
 *                            model's AgentLink default)
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  createOpenAiResponsesClient,
  executeCodexResolvedCompletion,
  getCodexEndpointConfig,
  translateCodexMessages,
} from "@agentlink/core/codex";
import type { CoreModelMessage } from "@agentlink/core/model-runtime";
import { translateOpenAiCompatibleMessages } from "@agentlink/core/openai-compatible";
import type { CoreReasoningEffort } from "@agentlink/protocol/model-catalog";
import {
  buildModeInstructionBlock,
  buildPromptArtifacts,
} from "../agent/systemPrompt.js";
import { getAgentTools } from "../agent/toolAdapter.js";
import { todoTool } from "../agent/todoTool.js";
import { BUILT_IN_MODES, buildUnionAgentMode } from "../agent/modes.js";
import { createNativeToolDisclosureSnapshot } from "../core/tools/nativeToolDisclosure.js";
import type { ObservedToolCall } from "./goldenTasks.js";

const env = process.env;
const baseUrl = env.AGENTLINK_EVAL_BASE_URL?.replace(/\/+$/, "");
const transport =
  env.AGENTLINK_EVAL_TRANSPORT === "codex" ? "codex" : "chat-completions";
const forcedProfile =
  env.AGENTLINK_EVAL_PROMPT_PROFILE === "reasoning" ||
  env.AGENTLINK_EVAL_PROMPT_PROFILE === "compatibility"
    ? env.AGENTLINK_EVAL_PROMPT_PROFILE
    : undefined;
const model = env.AGENTLINK_EVAL_MODEL;

export const evalConfig = {
  model,
  transport,
  family:
    transport === "codex" || env.AGENTLINK_EVAL_FAMILY === "openai"
      ? ("openai" as const)
      : ("anthropic" as const),
  reasoningEffort: env.AGENTLINK_EVAL_REASONING_EFFORT?.trim() || undefined,
  configured:
    Boolean(model) &&
    (transport === "codex"
      ? Boolean(env.AGENTLINK_EVAL_API_KEY)
      : Boolean(baseUrl)),
  runs: Math.max(1, Number(env.AGENTLINK_EVAL_RUNS ?? 2) || 2),
  minPassRate: Number(env.AGENTLINK_EVAL_PASS_RATE ?? 0.8),
  selectedIds: env.AGENTLINK_EVAL_TASKS?.split(",").map((id) => id.trim()),
  label: env.AGENTLINK_EVAL_LABEL || model,
};

// Vitest runs from the repository root; the root tsconfig emits CommonJS, so
// import.meta is unavailable here.
const repoRoot = process.cwd();
let resolvedProfile = "unknown";

/** The prompt profile AgentLink chose for the last built prompt. */
export function evalPromptProfile(): string {
  return resolvedProfile;
}

/** One model reply, plus a way to answer its calls and get the next reply. */
export interface EvalTurn {
  calls: ObservedToolCall[];
  text: string;
  answer(results: string[]): Promise<EvalTurn>;
}

async function buildPromptAndTools(mode: string) {
  const { systemPrompt, promptProfile } = await buildPromptArtifacts(
    mode,
    repoRoot,
    {
      // The real provider ID, so prompt profile and provider tuning match
      // what a Codex session in VS Code gets.
      providerId: transport === "codex" ? "codex" : "openai-compatible:eval",
      modelFamily: evalConfig.family,
      model,
      ...(forcedProfile && model
        ? { promptProfileOverrides: { [model]: forcedProfile } }
        : {}),
      modeInstructionPlacement: "conversation",
      composeEnabled: true,
      approveForMe: true,
    },
  );
  resolvedProfile = promptProfile.profile;
  const modeBlock = await buildModeInstructionBlock(mode, repoRoot);
  const unionMode = buildUnionAgentMode(BUILT_IN_MODES);
  const tools = createNativeToolDisclosureSnapshot([
    ...getAgentTools(
      unionMode,
      [],
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      ["search", "fetch"],
      true,
    ),
    todoTool,
  ]).inlineTools;
  return { systemPrompt, modeBlock, tools };
}

/**
 * Prefixes the first user message with the mode block, as a VS Code session
 * with conversation-placed mode instructions does.
 */
function withModeBlock(
  messages: readonly CoreModelMessage[],
  modeBlock: string,
): CoreModelMessage[] {
  const [first, ...rest] = messages;
  if (first?.role !== "user") {
    throw new Error("An eval conversation must start with a user message.");
  }
  const content =
    typeof first.content === "string"
      ? `${modeBlock}\n\n${first.content}`
      : [{ type: "text" as const, text: modeBlock }, ...first.content];
  return [{ ...first, content }, ...rest];
}

/** The user message that answers every call in a reply, in order. */
function toolResultsMessage(
  calls: readonly { id: string }[],
  results: readonly string[],
): CoreModelMessage {
  return {
    role: "user",
    content: calls.map((call, index) => ({
      type: "tool_result" as const,
      tool_use_id: call.id,
      content: results[index] ?? "",
    })),
  };
}

function parseArguments(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function sendCodex(
  systemPrompt: string,
  tools: Awaited<ReturnType<typeof buildPromptAndTools>>["tools"],
  client: ReturnType<typeof createOpenAiResponsesClient>,
  messages: CoreModelMessage[],
): Promise<EvalTurn> {
  const result = await executeCodexResolvedCompletion({
    client,
    authMethod: "oauth",
    model,
    instructions: systemPrompt,
    input: translateCodexMessages(messages),
    state: { store: false },
    tools,
    ...(evalConfig.reasoningEffort
      ? { reasoningEffort: evalConfig.reasoningEffort as CoreReasoningEffort }
      : {}),
    maxRetries: 1,
  });
  return {
    calls: result.toolCalls.map((call) => ({
      name: call.name,
      input: call.input,
    })),
    text: result.text,
    answer: async (results) =>
      await sendCodex(systemPrompt, tools, client, [
        ...messages,
        // Carries the provider's replay items, as a real session would.
        result.assistantMessage as CoreModelMessage,
        toolResultsMessage(result.toolCalls, results),
      ]),
  };
}

async function sendChatCompletions(
  systemPrompt: string,
  tools: Awaited<ReturnType<typeof buildPromptAndTools>>["tools"],
  messages: CoreModelMessage[],
): Promise<EvalTurn> {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(env.AGENTLINK_EVAL_API_KEY
        ? { authorization: `Bearer ${env.AGENTLINK_EVAL_API_KEY}` }
        : {}),
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [
        { role: "system", content: systemPrompt },
        ...translateOpenAiCompatibleMessages({
          providerId: "openai-compatible:eval",
          messages,
          supportsImages: false,
        }),
      ],
      tools: tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema,
        },
      })),
      tool_choice: "auto",
    }),
  });
  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`,
    );
  }
  const body = (await response.json()) as {
    choices?: {
      message?: {
        content?: string | null;
        tool_calls?: {
          id?: string;
          function?: { name?: string; arguments?: unknown };
        }[];
      };
    }[];
  };
  const message = body.choices?.[0]?.message;
  const toolCalls = (message?.tool_calls ?? []).map((call, index) => ({
    id: call.id ?? `call_${index}`,
    name: call.function?.name ?? "",
    input: parseArguments(call.function?.arguments),
  }));
  const text = message?.content ?? "";
  return {
    calls: toolCalls.map(({ name, input }) => ({ name, input })),
    text,
    answer: async (results) =>
      await sendChatCompletions(systemPrompt, tools, [
        ...messages,
        {
          role: "assistant",
          content: [
            ...(text ? [{ type: "text" as const, text }] : []),
            ...toolCalls.map((call) => ({
              type: "tool_use" as const,
              id: call.id,
              name: call.name,
              input: call.input,
            })),
          ],
        } as CoreModelMessage,
        toolResultsMessage(toolCalls, results),
      ]),
  };
}

/**
 * Sends a conversation (starting with a user message, in AgentLink's internal
 * message format) and returns the model's next reply. Scripted assistant
 * tool calls and results in `messages` are replayed as history.
 */
export async function startEvalConversation(
  mode: string,
  messages: readonly CoreModelMessage[],
): Promise<EvalTurn> {
  const { systemPrompt, modeBlock, tools } = await buildPromptAndTools(mode);
  const conversation = withModeBlock(messages, modeBlock);
  if (transport !== "codex") {
    return await sendChatCompletions(systemPrompt, tools, conversation);
  }
  const auth = {
    method: "oauth" as const,
    bearerToken: env.AGENTLINK_EVAL_API_KEY ?? "",
    accountId: env.AGENTLINK_EVAL_CODEX_ACCOUNT_ID || undefined,
    canRefresh: false,
  };
  const client = createOpenAiResponsesClient(
    auth,
    getCodexEndpointConfig(auth, randomUUID()),
  );
  return await sendCodex(systemPrompt, tools, client, conversation);
}

export function harnessRevision(): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Writes `<kind>-<timestamp>.json` with the shared report header (model,
 * transport, prompt profile, revision) plus the eval's own fields. Returns
 * the repository-relative path.
 */
export async function writeEvalReport(
  kind: string,
  fields: Record<string, unknown>,
): Promise<string> {
  const reportDir = env.AGENTLINK_EVAL_REPORT_DIR
    ? path.resolve(repoRoot, env.AGENTLINK_EVAL_REPORT_DIR)
    : path.join(repoRoot, "telemetry-reports", "evals");
  await fs.mkdir(reportDir, { recursive: true });
  const reportPath = path.join(
    reportDir,
    `${kind}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
  await fs.writeFile(
    reportPath,
    JSON.stringify(
      {
        schemaVersion: 2,
        kind,
        generatedAt: new Date().toISOString(),
        label: evalConfig.label,
        model,
        family: evalConfig.family,
        transport,
        reasoningEffort: evalConfig.reasoningEffort ?? null,
        promptProfile: resolvedProfile,
        harnessRevision: harnessRevision(),
        runs: evalConfig.runs,
        ...fields,
      },
      null,
      2,
    ),
  );
  return path.relative(repoRoot, reportPath);
}
