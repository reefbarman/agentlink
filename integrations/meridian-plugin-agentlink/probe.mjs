/** Run with Bun from a source checkout; uses AgentLink's actual completion facade. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import {
  streamOpenAiCompatibleCompletion,
  collectOpenAiCompatibleCompletion,
} from "../../packages/core/src/openAiCompatible/completionFacade.ts";
import { TOOL_REGISTRY } from "../../src/shared/toolRegistry.ts";

const flags = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, ...value] = arg.replace(/^--/, "").split("=");
    return [key, value.join("=")];
  }),
);
const baseUrl = flags.url ?? "http://127.0.0.1:3456/v1";
const model = flags.model ?? "claude-opus-5-5";
const expectedDeferred = flags.deferred === "true";
assert.ok(
  flags["meridian-checkout"],
  "pass --meridian-checkout=/path/to/meridian",
);
const { readSessionStoreSnapshot } = await import(
  pathToFileURL(
    resolve(flags["meridian-checkout"], "src/proxy/sessionStore.ts"),
  )
);
const requireFromMeridian = createRequire(
  resolve(flags["meridian-checkout"], "package.json"),
);
const { getSessionMessages } = await import(
  pathToFileURL(requireFromMeridian.resolve("@anthropic-ai/claude-agent-sdk"))
);
const fixture = await mkdtemp(join(tmpdir(), "agentlink-meridian-probe-"));
const receipts = [randomUUID(), randomUUID()];
const paths = receipts.map((_, index) => join(fixture, `${index}.txt`));
await Promise.all(paths.map((path, index) => writeFile(path, receipts[index])));
const tools = [
  {
    name: "read_file",
    description: "Read a file's exact contents from a local path.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "set_task_status",
    description: "Finish the task by reporting both receipts in summary.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["completed"] },
        summary: { type: "string" },
      },
      required: ["status", "summary"],
    },
  },
  ...Object.keys(TOOL_REGISTRY)
    .filter((name) => name !== "read_file" && name !== "set_task_status")
    .slice(0, 36)
    .map((name) => ({
      name,
      description:
        "Not needed for this fixture. Use only read_file and set_task_status.",
      input_schema: { type: "object", properties: {} },
    })),
];
assert.equal(tools.length, 38);
const sessionId = `agentlink-plugin-probe-${randomUUID()}`;
const profile = {
  providerId: "openai-compatible:meridian-probe",
  baseUrl,
  profile: "generic",
  reasoningEffortMode: "reasoning_effort",
  meridianSessionAffinity: true,
  authRequired: Boolean(process.env.MERIDIAN_API_KEY),
  timeoutMs: 180000,
  models: {
    [model]: {
      id: model,
      model,
      capabilities: {
        supportsThinking: true,
        supportsCaching: true,
        supportsImages: false,
        supportsToolUse: true,
        contextWindow: 1000000,
        maxOutputTokens: 8192,
      },
    },
  },
};
const messages = [
  {
    role: "user",
    content: `Read both files ${JSON.stringify(paths)}. Request BOTH read_file calls together in your first response. Once their results arrive, call set_task_status with status completed and summary containing both exact receipts. Do not use any other tool. Keep prose minimal.`,
  },
];
const requestIds = [];
const sdkSessionIds = [];
const seenModelResponses = new Set();
const rounds = [];
let completed = false;
for (let round = 0; round < 4 && !completed; round++) {
  const started = Date.now();
  const response = await collectOpenAiCompatibleCompletion(
    streamOpenAiCompatibleCompletion({
      profile,
      apiKey: process.env.MERIDIAN_API_KEY,
      fetch: async (url, options) => {
        const result = await fetch(url, options);
        const id = result.headers.get("x-request-id");
        if (id) requestIds.push(id);
        return result;
      },
      request: {
        model,
        messages,
        tools,
        maxTokens: 8192,
        reasoningEffort: "high",
        systemPrompt: `You are AgentLink, a software engineering agent. Working directory: ${fixture}\nThe client executes all tools. Follow the fixture request exactly.`,
        providerHints: { sessionId },
        signal: AbortSignal.timeout(180000),
      },
    }),
  );
  const elapsedMs = Date.now() - started;
  const storedSession = Object.entries(readSessionStoreSnapshot()).find(
    ([key]) => key === sessionId || key.endsWith(`:${sessionId}`),
  )?.[1];
  assert.ok(
    storedSession?.claudeSessionId,
    "round must publish its SDK session",
  );
  sdkSessionIds.push(storedSession.claudeSessionId);
  const sdkHistory = await getSessionMessages(storedSession.claudeSessionId);
  const modelResponses = new Map();
  for (const row of sdkHistory) {
    const message = row.message;
    if (
      row.type !== "assistant" ||
      !message?.id ||
      seenModelResponses.has(message.id)
    )
      continue;
    const sdkResponse = modelResponses.get(message.id) ?? {
      blockTypes: [],
      outputTokens: message.usage?.output_tokens,
    };
    sdkResponse.blockTypes.push(
      ...(message.content ?? []).map((block) => block.type),
    );
    modelResponses.set(message.id, sdkResponse);
  }
  assert.ok(
    modelResponses.size > 0,
    "supported SDK API must expose model responses",
  );
  if (!expectedDeferred)
    assert.equal(
      modelResponses.size,
      1,
      "eager handoff must avoid hidden SDK generation",
    );
  for (const id of modelResponses.keys()) seenModelResponses.add(id);
  assert.ok(
    response.toolCalls.length > 0,
    "fixture must return actionable tools",
  );
  messages.push(response.assistantMessage);
  const results = [];
  for (const call of response.toolCalls) {
    if (call.name === "read_file") {
      assert.ok(
        paths.includes(call.input.path),
        "read must stay within fixture files",
      );
      results.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: await readFile(call.input.path, "utf8"),
      });
    } else {
      assert.equal(call.name, "set_task_status");
      assert.equal(call.input.status, "completed");
      assert.ok(
        receipts.every((receipt) => call.input.summary.includes(receipt)),
        "final marker must contain real results",
      );
      completed = true;
      results.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: "Task marked completed.",
      });
    }
  }
  if (round === 0)
    assert.equal(
      response.toolCalls.filter((call) => call.name === "read_file").length,
      2,
    );
  messages.push({ role: "user", content: results });
  rounds.push({
    elapsedMs,
    tools: response.toolCalls.map((call) => call.name),
    outputTokens: response.usage?.outputTokens,
    sdkResponses: [...modelResponses.values()],
  });
}
assert.ok(completed, "fixture must finish through AgentLink's final marker");
const telemetryHeaders = process.env.MERIDIAN_API_KEY
  ? { "x-api-key": process.env.MERIDIAN_API_KEY }
  : {};
const metrics = await (
  await fetch(
    `${baseUrl.replace(/\/v1\/?$/, "")}/telemetry/requests?limit=100`,
    { headers: telemetryHeaders },
  )
).json();
// Older Meridian OpenAI responses omit the internal request ID. Correlate via
// the published SDK session mapping instead of guessing from timestamps.
const rows = metrics.filter(
  (row) =>
    requestIds.includes(row.requestId) ||
    sdkSessionIds.includes(row.sdkSessionId),
);
rows.sort(
  (a, b) =>
    sdkSessionIds.indexOf(a.sdkSessionId) -
    sdkSessionIds.indexOf(b.sdkSessionId),
);
assert.equal(
  rows.length,
  rounds.length,
  "must correlate every facade request with Meridian telemetry",
);
assert.ok(rows.every((row) => row.hasDeferredTools === expectedDeferred));
assert.ok(
  rows.some((row) => row.isResume),
  "real tool-result round must resume",
);
const report = {
  label: flags.label ?? "probe",
  model,
  toolCount: tools.length,
  client:
    "AgentLink production OpenAI completion facade; synthetic schemas and local fixture handlers",
  rounds,
  telemetry: rows.map(
    ({
      requestId,
      sdkSessionId,
      hasDeferredTools,
      isResume,
      cacheHitRate,
      totalDurationMs,
      outputTokens,
    }) => ({
      requestId,
      sdkSessionId,
      hasDeferredTools,
      isResume,
      cacheHitRate,
      totalDurationMs,
      outputTokens,
    }),
  ),
};
if (flags.report)
  await writeFile(flags.report, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
