import { createAgentClient, defineTool } from "@agentlink/core";

import assert from "node:assert/strict";
import { createCodexOAuthProvider } from "@agentlink/core/codex";
import { createOpenAIResponsesProvider } from "@agentlink/core/openai-responses";
import { z } from "zod";

const principal = { tenantId: "fixture", subjectId: "responses" };
const requests = [];

function response(text, toolName) {
  const output = toolName
    ? [
        {
          type: "function_call",
          call_id: "call-lookup",
          name: toolName,
          arguments: '{"query":"packed"}',
        },
      ]
    : [
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text, annotations: [] }],
        },
      ];
  const events = toolName
    ? [
        { type: "response.output_item.added", item: output[0] },
        { type: "response.output_item.done", item: output[0], output_index: 0 },
      ]
    : [{ type: "response.output_text.delta", delta: text }];
  events.push({
    type: "response.completed",
    response: {
      id: `response-${requests.length}`,
      status: "completed",
      output,
      usage: { input_tokens: 4, output_tokens: 2 },
    },
  });
  return new Response(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

const fetch = async (input, init) => {
  const request = new Request(input, init);
  const body = await request.json();
  requests.push({
    url: request.url,
    authorization: request.headers.get("authorization"),
    body,
  });
  if (requests.length === 1) return response('{"suggestions":["OpenAI"]}');
  if (requests.length === 2) return response(undefined, "lookup");
  return response("codex tool complete");
};

const openAI = createAgentClient({
  providers: [
    createOpenAIResponsesProvider({
      apiKey: ({ principal: current }) => `api-${current.subjectId}`,
      modelIds: ["gpt-5.4-mini"],
      fetch,
    }),
  ],
  defaultModel: { providerId: "openai", modelId: "gpt-5.4-mini" },
});
const object = await openAI.generateObject({
  principal,
  prompt: "Return suggestions",
  schemaName: "suggestions",
  schema: z.object({ suggestions: z.array(z.string()) }),
  maxOutputTokens: 256,
});

const codex = createAgentClient({
  providers: [
    createCodexOAuthProvider({
      modelIds: ["gpt-5.5"],
      credentialProvider: {
        resolveAuth: async ({ context }) => ({
          method: "oauth",
          bearerToken: `oauth-${context.principal.subjectId}`,
          accountId: "account-fixture",
          canRefresh: false,
        }),
      },
      fetch,
    }),
  ],
  defaultModel: { providerId: "codex", modelId: "gpt-5.5" },
});
const tool = defineTool({
  name: "lookup",
  description: "Look up synthetic packed data",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  },
  effect: "read",
  handler: async ({ query }) => ({ modelContent: `found ${query}` }),
});
const run = await codex.run({
  principal,
  input: { text: "Use lookup" },
  tools: [tool],
});

assert.deepEqual(object.object, { suggestions: ["OpenAI"] });
assert.equal(run.status, "completed");
assert.equal(
  run.status === "completed" ? run.text : undefined,
  "codex tool complete",
);
assert.equal(requests.length, 3);
assert.equal(requests[0].url, "https://api.openai.com/v1/responses");
assert.equal(requests[0].authorization, "Bearer api-responses");
assert.equal(requests[0].body.model, "gpt-5.4-mini");
assert.equal(requests[0].body.store, false);
assert.equal(requests[0].body.max_output_tokens, 256);
assert.equal(requests[0].body.text.format.type, "json_schema");
assert.equal(
  requests[1].url,
  "https://chatgpt.com/backend-api/codex/responses",
);
assert.equal(requests[1].authorization, "Bearer oauth-responses");
assert.equal("max_output_tokens" in requests[1].body, false);
assert.equal("previous_response_id" in requests[1].body, false);

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    openAIObject: object.object.suggestions[0],
    codexRun: run.status,
    codexTools: run.toolOutcomes.length,
    requests: requests.length,
    sessionsRequired: false,
  })}\n`,
);
