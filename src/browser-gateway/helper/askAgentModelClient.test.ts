import { describe, expect, it, vi } from "vitest";
import type * as OpenAIResponses from "openai/resources/responses/responses";

import { BrowserGatewayAskAgentModelClient } from "./askAgentModelClient.js";
import type { CoreModelStreamEvent } from "../../core/modelRuntime.js";
import type { BrowserGatewayModelCredentialRecord } from "../browserGatewayModelCredentialCache.js";

describe("BrowserGatewayAskAgentModelClient", () => {
  const baseCredential = {
    providerId: "openai-codex",
    bearerToken: "token",
    accountLabel: "acct@example.com",
    grantedByOwnerId: "vscode-owner",
    modelScopes: ["chat"],
    grantedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    canRefresh: true,
  } satisfies Omit<BrowserGatewayModelCredentialRecord, "method">;

  const userMessages = [
    {
      id: "u1",
      role: "user" as const,
      content: "hello",
      timestamp: 1,
      blocks: [{ type: "text" as const, text: "hello" }],
    },
  ];

  async function captureRequestBody(
    method: "oauth" | "apiKey",
    memoryContext?: string,
  ) {
    let capturedBody: unknown;
    const client = new BrowserGatewayAskAgentModelClient({
      sessionId: "session-1",
      createClient: () =>
        ({
          responses: {
            create: async (body: unknown) => {
              capturedBody = body;
              return (async function* () {
                yield { type: "response.output_text.delta", delta: "ok" };
              })();
            },
          },
        }) as never,
    });

    await client.complete({
      credential: { ...baseCredential, method },
      model: "gpt-5.5",
      reasoningEffort: "high",
      messages: userMessages,
      memoryContext,
    });

    return capturedBody as Record<string, unknown>;
  }

  it("omits max_output_tokens for OAuth ChatGPT/Codex backend requests", async () => {
    const body = await captureRequestBody("oauth");

    expect(body.model).toBe("gpt-5.5");
    expect(body.reasoning).toEqual({ effort: "high", summary: "detailed" });
    expect(body.max_output_tokens).toBeUndefined();
  });

  it("keeps max_output_tokens for public API key requests", async () => {
    const body = await captureRequestBody("apiKey");

    expect(body.model).toBe("gpt-5.5");
    expect(body.max_output_tokens).toBe(2048);
  });

  it("translates Ask Agent media attachments into model input parts", async () => {
    let capturedBody: unknown;
    const client = new BrowserGatewayAskAgentModelClient({
      sessionId: "session-1",
      createClient: () =>
        ({
          responses: {
            create: async (body: unknown) => {
              capturedBody = body;
              return (async function* () {
                yield { type: "response.output_text.delta", delta: "ok" };
              })();
            },
          },
        }) as never,
    });

    await client.complete({
      credential: { ...baseCredential, method: "oauth" },
      model: "gpt-5.5",
      messages: [
        {
          id: "u-media",
          role: "user",
          content: "What is in these?",
          timestamp: 1,
          blocks: [{ type: "text", text: "What is in these?" }],
          media: {
            images: [
              {
                name: "screenshot.png",
                mimeType: "image/png",
                base64: "abc123",
              },
            ],
            documents: [
              {
                name: "notes.txt",
                mimeType: "text/plain",
                base64: "bm90ZXM=",
              },
            ],
          },
        },
      ],
    });

    expect((capturedBody as Record<string, unknown>).input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "What is in these?" },
          {
            type: "input_image",
            image_url: "data:image/png;base64,abc123",
            detail: "auto",
          },
          {
            type: "input_file",
            filename: "notes.txt",
            file_data: "data:text/plain;base64,bm90ZXM=",
          },
        ],
      },
    ]);
  });

  it("drops unsupported media-only turns instead of sending an empty user input", async () => {
    let capturedBody: unknown;
    const client = new BrowserGatewayAskAgentModelClient({
      sessionId: "session-1",
      createClient: () =>
        ({
          responses: {
            create: async (body: unknown) => {
              capturedBody = body;
              return (async function* () {
                yield { type: "response.output_text.delta", delta: "ok" };
              })();
            },
          },
        }) as never,
    });

    await client.complete({
      credential: { ...baseCredential, method: "oauth" },
      model: "gpt-5.5",
      messages: [
        {
          id: "u-media-unsupported",
          role: "user",
          content: "",
          timestamp: 1,
          blocks: [],
          media: {
            images: [
              {
                name: "diagram.svg",
                mimeType: "image/svg+xml",
                base64: "abc123",
              },
            ],
          },
        },
      ],
    });

    expect((capturedBody as Record<string, unknown>).input).toEqual([]);
  });

  it("drops unsupported document media types before model translation", async () => {
    let capturedBody: unknown;
    const client = new BrowserGatewayAskAgentModelClient({
      sessionId: "session-1",
      createClient: () =>
        ({
          responses: {
            create: async (body: unknown) => {
              capturedBody = body;
              return (async function* () {
                yield { type: "response.output_text.delta", delta: "ok" };
              })();
            },
          },
        }) as never,
    });

    await client.complete({
      credential: { ...baseCredential, method: "oauth" },
      model: "gpt-5.5",
      messages: [
        {
          id: "u-media-docs",
          role: "user",
          content: "Review these docs",
          timestamp: 1,
          blocks: [{ type: "text", text: "Review these docs" }],
          media: {
            documents: [
              {
                name: "notes.txt",
                mimeType: "text/plain",
                base64: "bm90ZXM=",
              },
              {
                name: "archive.zip",
                mimeType: "application/zip",
                base64: "emlw",
              },
            ],
          },
        },
      ],
    });

    expect((capturedBody as Record<string, unknown>).input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "Review these docs" },
          {
            type: "input_file",
            filename: "notes.txt",
            file_data: "data:text/plain;base64,bm90ZXM=",
          },
        ],
      },
    ]);
  });

  it("appends conversation memory to instructions without adding a user input item", async () => {
    const memoryContext =
      "<conversation-memory>\n- [session:abc] Prior summary\n</conversation-memory>";
    const body = await captureRequestBody("oauth", memoryContext);

    expect(body.instructions).toEqual(expect.stringContaining(memoryContext));
    expect(body.instructions).toEqual(
      expect.stringContaining("Conversation memory, when present"),
    );
    expect(body.input).toEqual([
      {
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      },
    ]);
    expect(JSON.stringify(body.input)).not.toContain("Prior summary");
  });

  it("instructs Ask Agent to use web search proactively when available", async () => {
    const body = await captureRequestBody("oauth");

    expect(body.instructions).toEqual(
      expect.stringContaining("Use web search very proactively"),
    );
    expect(body.instructions).toEqual(
      expect.stringContaining("freshness-sensitive answers"),
    );
  });

  it("omits blank memory context from instructions", async () => {
    const body = await captureRequestBody("oauth", "   ");

    expect(body.instructions).not.toContain("<conversation-memory>");
  });

  it("advertises local Ask Agent tools by default", async () => {
    const body = await captureRequestBody("oauth");
    const toolNames = (
      (body.tools as Array<{ name?: string }> | undefined) ?? []
    )
      .map((tool) => tool.name)
      .filter(Boolean);

    expect(toolNames).toEqual([
      "ask_user",
      "todo_write",
      "set_task_status",
      "read_file",
      "list_files",
      "search_files",
      "generate_image",
    ]);
    const generateImageTool = (
      (body.tools as Array<{ name?: string }> | undefined) ?? []
    ).find((tool) => tool.name === "generate_image");
    expect(generateImageTool).toBeDefined();
    const generateImageParameters = generateImageTool as {
      parameters?: { properties?: Record<string, unknown> };
    };
    expect(generateImageParameters.parameters?.properties).not.toHaveProperty(
      "output_path",
    );
    expect(generateImageParameters.parameters?.properties).not.toHaveProperty(
      "reference_image_paths",
    );
    expect(toolNames).not.toContain("execute_command");
    expect(toolNames).not.toContain("write_file");
  });

  it("routes VS Code Codex provider IDs through the Codex completion path", async () => {
    let capturedBody: unknown;
    const client = new BrowserGatewayAskAgentModelClient({
      sessionId: "session-1",
      createClient: () =>
        ({
          responses: {
            create: async (body: unknown) => {
              capturedBody = body;
              return (async function* () {
                yield { type: "response.output_text.delta", delta: "ok" };
              })();
            },
          },
        }) as never,
    });

    const result = await client.completeWithToolCalls({
      credential: {
        ...baseCredential,
        providerId: "codex",
        method: "oauth",
      },
      model: "gpt-5.5",
      messages: userMessages,
    });

    expect(result).toEqual({ text: "ok", toolCalls: [] });
    expect((capturedBody as Record<string, unknown>).model).toBe("gpt-5.5");
  });

  it("routes Anthropic credentials through the Anthropic stream provider", async () => {
    const events: CoreModelStreamEvent[] = [
      { type: "text_delta", text: "Need input." },
      {
        type: "tool_done",
        toolCallId: "call_question",
        toolName: "ask_user",
        input: {
          context: "Need a decision.",
          questions: [{ id: "choice", type: "yes_no", question: "Continue?" }],
        },
      },
    ];
    const stream = vi.fn(async function* () {
      yield* events;
    });
    const client = new BrowserGatewayAskAgentModelClient({
      sessionId: "session-1",
      createClient: () => {
        throw new Error("codex_client_should_not_be_created");
      },
      createAnthropicProvider: () => ({
        condenseModel: "claude-haiku-4-5-20251001",
        stream,
      }),
    });

    const result = await client.completeWithToolCalls({
      credential: {
        ...baseCredential,
        providerId: "anthropic",
        method: "apiKey",
      },
      model: "claude-sonnet-4-5",
      reasoningEffort: "high",
      messages: userMessages,
      memoryContext: "<conversation-memory>remember this</conversation-memory>",
    });

    expect(result).toEqual({
      text: "Need input.",
      toolCalls: [
        {
          id: "call_question",
          name: "ask_user",
          input: {
            context: "Need a decision.",
            questions: [
              { id: "choice", type: "yes_no", question: "Continue?" },
            ],
          },
        },
      ],
    });
    expect(stream).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-sonnet-4-5",
        reasoningEffort: "high",
        systemPrompt: expect.stringContaining("<conversation-memory>"),
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "user" }),
        ]),
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "ask_user" }),
        ]),
      }),
    );
  });

  it("returns streamed tool calls alongside text", async () => {
    const client = new BrowserGatewayAskAgentModelClient({
      sessionId: "session-1",
      createClient: () =>
        ({
          responses: {
            create: async () =>
              (async function* () {
                yield {
                  type: "response.output_text.delta",
                  delta: "Need input.",
                };
                yield {
                  type: "response.output_item.added",
                  item: {
                    type: "function_call",
                    call_id: "call_question",
                    name: "ask_user",
                  },
                };
                yield {
                  type: "response.output_item.done",
                  item: {
                    type: "function_call",
                    call_id: "call_question",
                    name: "ask_user",
                    arguments: JSON.stringify({
                      context: "Need a decision.",
                      questions: [
                        {
                          id: "choice",
                          type: "yes_no",
                          question: "Continue?",
                        },
                      ],
                    }),
                  },
                };
              })(),
          },
        }) as never,
    });

    const result = await client.completeWithToolCalls({
      credential: { ...baseCredential, method: "oauth" },
      model: "gpt-5.5",
      messages: userMessages,
    });

    expect(result.text).toBe("Need input.");
    expect(result.toolCalls).toEqual([
      {
        id: "call_question",
        name: "ask_user",
        input: {
          context: "Need a decision.",
          questions: [{ id: "choice", type: "yes_no", question: "Continue?" }],
        },
      },
    ]);
  });

  it("normalizes auth failures thrown while creating a response", async () => {
    const client = new BrowserGatewayAskAgentModelClient({
      sessionId: "session-1",
      createClient: () =>
        ({
          responses: {
            create: async () => {
              throw { status: 401 };
            },
          },
        }) as never,
    });

    await expect(
      client.complete({
        credential: { ...baseCredential, method: "oauth" },
        model: "gpt-5.5",
        messages: userMessages,
      }),
    ).rejects.toThrow("browser_gateway_ask_agent_model_auth_failed");
  });

  it("normalizes auth failures thrown while reading a response stream", async () => {
    const client = new BrowserGatewayAskAgentModelClient({
      sessionId: "session-1",
      createClient: () =>
        ({
          responses: {
            create: async () =>
              ({
                [Symbol.asyncIterator]() {
                  return {
                    next: async (): Promise<
                      IteratorResult<OpenAIResponses.ResponseStreamEvent>
                    > => {
                      throw { status: 403 };
                    },
                  };
                },
              }) satisfies AsyncIterable<OpenAIResponses.ResponseStreamEvent>,
          },
        }) as never,
    });

    await expect(
      client.complete({
        credential: { ...baseCredential, method: "oauth" },
        model: "gpt-5.5",
        messages: userMessages,
      }),
    ).rejects.toThrow("browser_gateway_ask_agent_model_auth_failed");
  });
});
