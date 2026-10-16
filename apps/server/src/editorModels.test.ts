import type {
  CoreModelBackend,
  CoreModelStreamEvent,
  CoreModelStreamRequest,
} from "@agentlink/core";
import {
  createOpenAICompatibleProvider,
  normalizeOpenAiCompatibleConnections,
} from "@agentlink/core/openai-compatible";
import { afterEach, describe, expect, it } from "vitest";

import {
  editorAgentLinkSettings,
  editorModelId,
  startEditorModelServer,
  type EditorModelServer,
} from "./editorModels.js";

const TOKEN = "t".repeat(43);

/** The assistant's backend, scripted: records each request it gets. */
function fakeBackend(
  script: (request: CoreModelStreamRequest) => CoreModelStreamEvent[],
) {
  const requests: CoreModelStreamRequest[] = [];
  const subjects: string[] = [];
  const backend: CoreModelBackend = {
    providerId: "codex",
    displayName: "Codex",
    condenseModel: "small",
    listModels: () => [],
    getCapabilities: (modelId) => {
      if (modelId !== "big") throw new Error("unknown model");
      return {
        supportsThinking: true,
        supportsCaching: false,
        supportsImages: true,
        supportsToolUse: true,
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
        reasoningEfforts: ["none", "low", "high"],
        defaultReasoningEffort: "high",
      };
    },
    async *stream(request, context) {
      requests.push(request);
      subjects.push(context.principal.subjectId);
      for (const event of script(request)) yield event;
    },
    async complete() {
      throw new Error("not used");
    },
  };
  return { backend, requests, subjects };
}

describe("editor models", () => {
  let server: EditorModelServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  const start = async (backend: CoreModelBackend, open = true) => {
    server = await startEditorModelServer({
      backends: [backend],
      models: () => [{ providerId: "codex", modelId: "big" }],
      authorize: (token) =>
        open && token === TOKEN ? "0123456789ab" : undefined,
      listen: { host: "127.0.0.1", port: 0 },
      log: () => undefined,
    });
    return `http://127.0.0.1:${server.port}/editor-models/${TOKEN}/v1`;
  };

  /** AgentLink's own OpenAI-compatible client, as the editor uses it. */
  const client = (baseURL: string) =>
    createOpenAICompatibleProvider({
      id: "assistant",
      baseURL,
      noAuth: true,
      reasoningEffortMode: "reasoning_effort",
      models: [
        {
          id: "assistant-codex-big",
          model: "codex/big",
          contextWindow: 200_000,
          maxOutputTokens: 32_000,
          supportsToolUse: true,
          supportsThinking: true,
          reasoningEfforts: ["low", "high"],
          supportsImages: true,
        },
      ],
    });

  const collect = async (events: AsyncIterable<CoreModelStreamEvent>) => {
    const seen: CoreModelStreamEvent[] = [];
    for await (const event of events) seen.push(event);
    return seen;
  };

  it("serves AgentLink's client with the assistant's model, tools included", async () => {
    const fake = fakeBackend((request) =>
      request.messages.length === 1
        ? [
            { type: "thinking_start", thinkingId: "t" },
            { type: "thinking_delta", thinkingId: "t", text: "secret" },
            { type: "text_delta", text: "Reading it." },
            { type: "tool_start", toolCallId: "call_1", toolName: "read_file" },
            {
              type: "tool_input_delta",
              toolCallId: "call_1",
              partialJson: '{"pa',
            },
            {
              type: "tool_done",
              toolCallId: "call_1",
              toolName: "read_file",
              input: { path: "README.md" },
            },
            {
              type: "model_stop",
              reason: "tool_use",
              assistantMessage: { role: "assistant", content: [] },
            },
            { type: "usage", inputTokens: 10, outputTokens: 5 },
            { type: "done" },
          ]
        : [
            { type: "text_delta", text: "It says hello." },
            {
              type: "model_stop",
              reason: "end_turn",
              assistantMessage: { role: "assistant", content: [] },
            },
            { type: "done" },
          ],
    );
    const remote = client(await start(fake.backend));
    const context = {
      principal: { tenantId: "local", subjectId: "editor" },
      authContext: undefined,
    };
    const tools = [
      {
        name: "read_file",
        description: "Read a file",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" } },
        },
      },
    ];
    const first = await collect(
      remote.stream(
        {
          model: "assistant-codex-big",
          systemPrompt: "You are AgentLink.",
          messages: [{ role: "user", content: "What is in the README?" }],
          maxTokens: 1_000,
          reasoningEffort: "low",
          tools,
        },
        context,
      ),
    );
    expect(fake.requests[0]).toMatchObject({
      model: "big",
      systemPrompt: "You are AgentLink.",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "What is in the README?" }],
        },
      ],
      maxTokens: 1_000,
      reasoningEffort: "low",
      tools: [{ name: "read_file", input_schema: { type: "object" } }],
    });
    expect(fake.subjects).toEqual(["editor-task-0123456789ab"]);
    // Thinking stays on the assistant; text and the whole tool call arrive.
    expect(JSON.stringify(first)).not.toContain("secret");
    expect(first.filter((e) => e.type === "text_delta")).toEqual([
      { type: "text_delta", text: "Reading it." },
    ]);
    expect(first.find((e) => e.type === "tool_done")).toMatchObject({
      toolCallId: "call_1",
      toolName: "read_file",
      input: { path: "README.md" },
    });
    expect(first.find((e) => e.type === "model_stop")).toMatchObject({
      reason: "tool_use",
    });
    expect(first.find((e) => e.type === "usage")).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
    });

    // The tool result goes back as the assistant's own tool_result.
    const second = await collect(
      remote.stream(
        {
          model: "assistant-codex-big",
          systemPrompt: "You are AgentLink.",
          messages: [
            { role: "user", content: "What is in the README?" },
            {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "secret", signature: "" },
                { type: "text", text: "Reading it." },
                {
                  type: "tool_use",
                  id: "call_1",
                  name: "read_file",
                  input: { path: "README.md" },
                },
              ],
            },
            {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "call_1",
                  content: "hello",
                },
              ],
            },
          ],
          maxTokens: 1_000,
          tools,
        },
        context,
      ),
    );
    expect(fake.requests[1]!.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "What is in the README?" }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Reading it." },
          {
            type: "tool_use",
            id: "call_1",
            name: "read_file",
            input: { path: "README.md" },
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "hello" },
        ],
      },
    ]);
    expect(second.filter((e) => e.type === "text_delta")).toEqual([
      { type: "text_delta", text: "It says hello." },
    ]);
  });

  it("refuses a closed editor's token and unknown models", async () => {
    const fake = fakeBackend(() => []);
    const base = await start(fake.backend, false);
    const closed = await fetch(`${base}/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "codex/big", messages: [] }),
    });
    expect(closed.status).toBe(401);
    await server!.close();
    const open = await start(fake.backend);
    const unknown = await fetch(`${open}/chat/completions`, {
      method: "POST",
      body: JSON.stringify({
        model: "codex/other",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({
      error: { code: "model_not_found" },
    });
    expect(fake.requests).toHaveLength(0);
    const models = await fetch(`${open}/models`);
    expect(await models.json()).toMatchObject({
      data: [{ id: "codex/big" }],
    });
  });

  it("reports a failure mid-stream to the client as an error", async () => {
    const backend: CoreModelBackend = {
      ...fakeBackend(() => []).backend,
      async *stream() {
        yield { type: "text_delta", text: "Start" };
        throw new Error("provider went away");
      },
    };
    const remote = client(await start(backend));
    await expect(
      collect(
        remote.stream(
          {
            model: "assistant-codex-big",
            systemPrompt: "",
            messages: [{ role: "user", content: "hi" }],
            maxTokens: 100,
          },
          {
            principal: { tenantId: "local", subjectId: "editor" },
            authContext: undefined,
          },
        ),
      ),
    ).rejects.toThrow(/provider went away/u);
  });

  it("writes settings AgentLink accepts, with the first model as the default", () => {
    const { backend } = fakeBackend(() => []);
    const settings = editorAgentLinkSettings({
      baseUrl: `http://assistant:7900/editor-models/${TOKEN}/v1`,
      backends: [backend],
      models: [
        { providerId: "codex", modelId: "big", displayName: "Big" },
        // Not served by any backend: left out.
        { providerId: "claude", modelId: "opus" },
      ],
      noProxy: ["assistant"],
    });
    const normalized = normalizeOpenAiCompatibleConnections(
      settings["agentlink.openaiCompatible.connections"],
    );
    expect(normalized.issues).toEqual([]);
    expect(normalized.connections[0]!.models).toEqual([
      expect.objectContaining({
        id: "assistant-codex-big",
        model: "codex/big",
        displayName: "Big",
      }),
    ]);
    expect(normalized.connections[0]!.models[0]!.capabilities).toMatchObject({
      supportsImages: true,
      supportsThinking: true,
      reasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "high",
    });
    expect(settings["agentlink.modeModelPreferences"]).toMatchObject({
      code: editorModelId({ providerId: "codex", modelId: "big" }),
    });
    expect(settings["agentlink.disabledProviders"]).toEqual(["codex"]);
    expect(settings["http.noProxy"]).toEqual(["assistant"]);
  });
});
