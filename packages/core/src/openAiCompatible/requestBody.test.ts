import { describe, expect, it } from "vitest";

import type { CoreModelMessage } from "../modelRuntime.js";
import type { NormalizedOpenAiCompatibleConnection } from "./config.js";
import { OpenAiCompatibleBackend } from "./backend.js";
import type { OpenAiCompatibleRuntimeModel } from "./types.js";
import { buildOpenAiCompatibleChatRequest } from "./translation.js";
import { encodeOpenAiCompatibleRequestBody } from "./requestBody.js";

const capabilities = {
  supportsThinking: false,
  supportsCaching: false,
  supportsImages: true,
  supportsDocuments: true,
  supportsToolUse: true,
  contextWindow: 200_000,
  maxOutputTokens: 4_096,
};

const model: OpenAiCompatibleRuntimeModel = {
  id: "vision",
  model: "wire/vision",
  capabilities,
};

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PDF =
  "JVBERi0xLjQKJcfsj6IKMSAwIG9iago8PD4+CmVuZG9iagp0cmFpbGVyCjw8Pj4KJSVFT0YK";

function messages(): CoreModelMessage[] {
  return [
    {
      role: "user",
      content: [
        { type: "text", text: 'Compare these "tiles", ünïcode café 🧱 ok?' },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: PNG },
        },
        {
          type: "document",
          title: 'spec "v2".pdf',
          source: { type: "base64", media_type: "application/pdf", data: PDF },
        },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "call_1", name: "screenshot", input: {} },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_1",
          content: [
            { type: "text", text: "captured" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/webp", data: PNG },
            },
          ],
        },
        { type: "text", text: "continue" },
      ],
    },
  ];
}

function build(input: CoreModelMessage[] = messages()) {
  return buildOpenAiCompatibleChatRequest({
    providerId: "openai-compatible:test",
    profile: "generic",
    reasoningEffortMode: "none",
    model,
    systemPrompt: "system",
    messages: input,
    maxTokens: 128,
  });
}

function decode(body: string | Uint8Array): string {
  return typeof body === "string" ? body : new TextDecoder().decode(body);
}

describe("encodeOpenAiCompatibleRequestBody", () => {
  it("writes media-bearing requests as bytes identical to JSON.stringify", () => {
    const request = build();
    const encoded = encodeOpenAiCompatibleRequestBody(request);

    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(decode(encoded)).toBe(JSON.stringify(request));
    const parsed = JSON.parse(decode(encoded));
    expect(parsed.messages[1].content[1]).toEqual({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${PNG}` },
    });
    expect(parsed.messages[1].content[2]).toEqual({
      type: "file",
      file: {
        filename: 'spec "v2".pdf',
        file_data: `data:application/pdf;base64,${PDF}`,
      },
    });
  });

  it("keeps text-only requests as a plain JSON string", () => {
    const request = build([{ role: "user", content: "hello" }]);
    expect(encodeOpenAiCompatibleRequestBody(request)).toBe(
      JSON.stringify(request),
    );
  });

  it("escapes media payloads that are not plain base64", () => {
    const request = build([
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: 'AA\nBB"CC',
            },
          },
        ],
      },
    ]);
    expect(decode(encodeOpenAiCompatibleRequestBody(request))).toBe(
      JSON.stringify(request),
    );
  });

  it("sends image requests to fetch as the encoded bytes", async () => {
    const connection: NormalizedOpenAiCompatibleConnection = {
      id: "test",
      providerId: "openai-compatible:test",
      displayName: "Test",
      baseUrl: "https://example.invalid/v1",
      profile: "generic",
      reasoningEffortMode: "none",
      timeoutMs: 10_000,
      allowInsecureHttp: false,
      models: [{ ...model, displayName: "Vision" }],
      runtimeProfile: {
        providerId: "openai-compatible:test",
        baseUrl: "https://example.invalid/v1",
        profile: "generic",
        reasoningEffortMode: "none",
        timeoutMs: 10_000,
        authRequired: false,
        models: { vision: model },
      },
    };
    const bodies: unknown[] = [];
    const backend = new OpenAiCompatibleBackend({
      connection,
      fetch: async (_input, init) => {
        bodies.push(init?.body);
        return new Response(
          'data: {"id":"r","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      },
    });

    await backend.complete(
      {
        model: "vision",
        systemPrompt: "system",
        messages: messages(),
        maxTokens: 128,
      },
      {
        principal: { tenantId: "t", subjectId: "s" },
        authContext: undefined,
      },
    );

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toBeInstanceOf(Uint8Array);
    const sent = JSON.parse(decode(bodies[0] as Uint8Array));
    expect(sent.messages[1].content[1].image_url.url).toBe(
      `data:image/png;base64,${PNG}`,
    );
  });
});
