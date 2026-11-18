/**
 * Live first-turn routing eval. Not part of `npm test`; run with
 * `npm run eval:routing` (see vitest.eval.config.mts).
 *
 * Builds AgentLink's real system prompt and inline tool catalog for this
 * repository, sends each golden task to an OpenAI-compatible chat completions
 * endpoint, and grades the first response's tool calls. Tools are never
 * executed.
 *
 * Environment:
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
 *
 * When a reply contains only todo_write calls, the eval answers them with a
 * stub result and also grades the next reply: single-call models cannot open
 * the TODO list the prompt asks for and act in the same reply. Codex
 * responses-lite models (gpt-6.x sol/astra on OAuth) are single-call: the
 * backend rejects parallel_tool_calls=true with HTTP 400 (checked 2026-11-18).
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
import type { CoreReasoningEffort } from "@agentlink/protocol/model-catalog";
import { describe, expect, it } from "vitest";
import {
  buildModeInstructionBlock,
  buildPromptArtifacts,
} from "../agent/systemPrompt.js";
import { getAgentTools } from "../agent/toolAdapter.js";
import { todoTool } from "../agent/todoTool.js";
import { BUILT_IN_MODES, buildUnionAgentMode } from "../agent/modes.js";
import { createNativeToolDisclosureSnapshot } from "../core/tools/nativeToolDisclosure.js";
import {
  GOLDEN_TASKS,
  gradeGoldenTask,
  isTodoOnlyReply,
  todoStubResult,
  type GoldenTask,
  type GoldenTaskGrade,
  type ObservedToolCall,
} from "./goldenTasks.js";

const env = process.env;
const baseUrl = env.AGENTLINK_EVAL_BASE_URL?.replace(/\/+$/, "");
const model = env.AGENTLINK_EVAL_MODEL;
const transport =
  env.AGENTLINK_EVAL_TRANSPORT === "codex" ? "codex" : "chat-completions";
const family =
  transport === "codex" || env.AGENTLINK_EVAL_FAMILY === "openai"
    ? "openai"
    : "anthropic";
const reasoningEffort =
  env.AGENTLINK_EVAL_REASONING_EFFORT?.trim() || undefined;
const configured =
  Boolean(model) &&
  (transport === "codex"
    ? Boolean(env.AGENTLINK_EVAL_API_KEY)
    : Boolean(baseUrl));
const forcedProfile =
  env.AGENTLINK_EVAL_PROMPT_PROFILE === "reasoning" ||
  env.AGENTLINK_EVAL_PROMPT_PROFILE === "compatibility"
    ? env.AGENTLINK_EVAL_PROMPT_PROFILE
    : undefined;
let resolvedProfile = "unknown";
const runs = Math.max(1, Number(env.AGENTLINK_EVAL_RUNS ?? 2) || 2);
const minPassRate = Number(env.AGENTLINK_EVAL_PASS_RATE ?? 0.8);
const selectedIds = env.AGENTLINK_EVAL_TASKS?.split(",").map((id) => id.trim());
// Vitest runs from the repository root; the root tsconfig emits CommonJS, so
// import.meta is unavailable here.
const repoRoot = process.cwd();
const label = env.AGENTLINK_EVAL_LABEL || model;

function harnessRevision(): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
  } catch {
    return undefined;
  }
}

interface RunResult extends GoldenTaskGrade {
  taskId: string;
  run: number;
  text: string;
  /** First-response tool calls with inputs, for diagnosing failures. */
  calls: ObservedToolCall[];
  /** The first reply was only todo_write, so the next reply was graded too. */
  followUp?: boolean;
  durationMs: number;
  error?: string;
}

async function buildPromptAndTools(task: GoldenTask) {
  const { systemPrompt, promptProfile } = await buildPromptArtifacts(
    task.mode,
    repoRoot,
    {
      // The real provider ID, so prompt profile and provider tuning match
      // what a Codex session in VS Code gets.
      providerId: transport === "codex" ? "codex" : "openai-compatible:eval",
      modelFamily: family,
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
  const modeBlock = await buildModeInstructionBlock(task.mode, repoRoot);
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
  return {
    systemPrompt,
    userContent: `${modeBlock}\n\n${task.prompt}`,
    tools,
  };
}

async function buildRequest(task: GoldenTask, messages: unknown[]) {
  const { systemPrompt, tools } = await buildPromptAndTools(task);
  return {
    model,
    max_tokens: 4096,
    messages: [{ role: "system", content: systemPrompt }, ...messages],
    tools: tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    })),
    tool_choice: "auto",
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

/** One model reply, plus a way to answer its calls and get the next reply. */
interface Turn {
  calls: ObservedToolCall[];
  text: string;
  answer(results: string[]): Promise<Turn>;
}

type CodexMessages = Parameters<typeof translateCodexMessages>[0];

async function startCodex(task: GoldenTask): Promise<Turn> {
  const { systemPrompt, userContent, tools } = await buildPromptAndTools(task);
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
  const send = async (messages: CodexMessages): Promise<Turn> => {
    const result = await executeCodexResolvedCompletion({
      client,
      authMethod: "oauth",
      model,
      instructions: systemPrompt,
      input: translateCodexMessages(messages),
      state: { store: false },
      tools,
      ...(reasoningEffort
        ? { reasoningEffort: reasoningEffort as CoreReasoningEffort }
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
        await send([
          ...messages,
          // Carries the provider's replay items, as a real session would.
          result.assistantMessage,
          {
            role: "user",
            content: result.toolCalls.map((call, index) => ({
              type: "tool_result" as const,
              tool_use_id: call.id,
              content: results[index] ?? "",
            })),
          },
        ] as CodexMessages),
    };
  };
  return await send([{ role: "user", content: userContent }]);
}

async function startChatCompletions(task: GoldenTask): Promise<Turn> {
  const { userContent } = await buildPromptAndTools(task);
  const send = async (messages: unknown[]): Promise<Turn> => {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(env.AGENTLINK_EVAL_API_KEY
          ? { authorization: `Bearer ${env.AGENTLINK_EVAL_API_KEY}` }
          : {}),
      },
      body: JSON.stringify(await buildRequest(task, messages)),
    });
    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`,
      );
    }
    const body = (await response.json()) as {
      choices?: {
        message?: {
          role?: string;
          content?: string | null;
          tool_calls?: {
            id?: string;
            function?: { name?: string; arguments?: unknown };
          }[];
        };
      }[];
    };
    const message = body.choices?.[0]?.message;
    const toolCalls = message?.tool_calls ?? [];
    return {
      calls: toolCalls.map((call) => ({
        name: call.function?.name ?? "",
        input: parseArguments(call.function?.arguments),
      })),
      text: message?.content ?? "",
      answer: async (results) =>
        await send([
          ...messages,
          { ...message, role: "assistant" },
          ...toolCalls.map((call, index) => ({
            role: "tool",
            tool_call_id: call.id,
            content: results[index] ?? "",
          })),
        ]),
    };
  };
  return await send([{ role: "user", content: userContent }]);
}

async function runTask(task: GoldenTask, run: number): Promise<RunResult> {
  const startedAt = Date.now();
  const base = { taskId: task.id, run, text: "", calls: [] };
  try {
    const first =
      transport === "codex"
        ? await startCodex(task)
        : await startChatCompletions(task);
    // A reply that only opens the TODO list is following the prompt; grade
    // the first real action, which single-call models can't put in the same
    // reply.
    const followUp = isTodoOnlyReply(first.calls)
      ? await first.answer(
          first.calls.map((call) => todoStubResult(call.input)),
        )
      : undefined;
    const calls = [...first.calls, ...(followUp?.calls ?? [])];
    return {
      ...base,
      ...gradeGoldenTask(task, calls),
      calls,
      followUp: followUp !== undefined,
      text: [first.text, followUp?.text]
        .filter(Boolean)
        .join("\n")
        .slice(0, 300),
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ...base,
      pass: false,
      tools: [],
      reasons: ["request failed"],
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

describe.skipIf(!configured)("first-turn routing eval", () => {
  it(
    "routes golden tasks to the expected tools",
    async () => {
      const tasks = GOLDEN_TASKS.filter(
        (task) => !selectedIds || selectedIds.includes(task.id),
      );
      const results = await Promise.all(
        tasks.flatMap((task) =>
          Array.from({ length: runs }, (_, run) => runTask(task, run + 1)),
        ),
      );

      const rows = tasks.map((task) => {
        const taskResults = results.filter((r) => r.taskId === task.id);
        const passed = taskResults.filter((r) => r.pass).length;
        return {
          task: task.id,
          pass: `${passed}/${taskResults.length}`,
          tools: taskResults.map((r) => r.tools.join("+") || "-").join(" | "),
          failures: [
            ...new Set(
              taskResults.flatMap((r) => (r.error ? [r.error] : r.reasons)),
            ),
          ].join("; "),
        };
      });
      console.table(rows);

      const passRate =
        results.filter((r) => r.pass).length / Math.max(1, results.length);
      const reportDir = env.AGENTLINK_EVAL_REPORT_DIR
        ? path.resolve(repoRoot, env.AGENTLINK_EVAL_REPORT_DIR)
        : path.join(repoRoot, "telemetry-reports", "evals");
      await fs.mkdir(reportDir, { recursive: true });
      const reportPath = path.join(
        reportDir,
        `routing-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
      );
      await fs.writeFile(
        reportPath,
        JSON.stringify(
          {
            schemaVersion: 2,
            generatedAt: new Date().toISOString(),
            label,
            model,
            family,
            transport,
            reasoningEffort: reasoningEffort ?? null,

            followUps: results.filter((r) => r.followUp).length,
            promptProfile: resolvedProfile,
            harnessRevision: harnessRevision(),
            runs,
            passRate,
            rows,
            results,
          },
          null,
          2,
        ),
      );
      console.log(
        `Routing pass rate ${(passRate * 100).toFixed(1)}% (${model}, ${resolvedProfile} prompt); report: ${path.relative(repoRoot, reportPath)}`,
      );

      expect(passRate).toBeGreaterThanOrEqual(minPassRate);
    },
    10 * 60_000,
  );
});
