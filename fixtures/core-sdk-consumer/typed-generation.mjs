import assert from "node:assert/strict";
import { createAgentClient } from "@agentlink/core/client";
import { createOpenAICompatibleProvider } from "@agentlink/core/openai-compatible";
import { defineTool } from "@agentlink/core";
import { z } from "zod";

const principal = { tenantId: "fixture", subjectId: "packed-consumer" };
const model = {
  providerId: "fixture-compatible",
  modelId: "fixture-compatible-model",
};
const requests = [];
const responses = [
  { kind: "text", text: "plain text" },
  { kind: "text", text: '{"suggestions":["One","Two"]}' },
  { kind: "text", text: '{"allowed":true}' },
  { kind: "text", text: "streamed text" },
  { kind: "tool", name: "lookup" },
  { kind: "text", text: "tool complete" },
];

function responseFor(next) {
  const choice =
    next.kind === "tool"
      ? {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call-lookup",
                type: "function",
                function: {
                  name: next.name,
                  arguments: '{"query":"packed"}',
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        }
      : {
          index: 0,
          delta: { content: next.text },
          finish_reason: "stop",
        };
  return new Response(
    `data: ${JSON.stringify({
      id: `fixture-response-${requests.length}`,
      model: model.modelId,
      choices: [choice],
      usage: { prompt_tokens: 8, completion_tokens: 4 },
    })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

const provider = createOpenAICompatibleProvider({
  id: model.providerId,
  baseURL: "https://example.invalid/v1",
  apiKey: ({ principal: current }) => `fixture-${current.subjectId}`,
  supportsStoreFalse: true,
  models: [
    {
      id: model.modelId,
      contextWindow: 32_768,
      maxOutputTokens: 4_096,
      supportsToolUse: true,
      structuredOutput: "json_schema",
    },
  ],
  fetch: async (_input, init) => {
    requests.push({
      body: JSON.parse(String(init?.body)),
      authorization: new Headers(init?.headers).get("authorization"),
    });
    const next = responses.shift();
    if (!next) throw new Error("fixture response queue exhausted");
    return responseFor(next);
  },
});
const client = createAgentClient({
  providers: [provider],
  defaultModel: model,
});

const text = await client.generateText({
  principal,
  prompt: "Return plain text",
});
const native = await client.generateObject({
  principal,
  prompt: "Return suggestions",
  schema: z.object({ suggestions: z.array(z.string()).min(1).max(5) }),
  schemaName: "suggestions",
});
const prompted = await client.generateObject({
  principal,
  prompt: "Return a moderation flag",
  schema: z.object({ allowed: z.boolean() }),
  outputMode: "prompt",
});

const streamedEvents = [];
const streamed = client.streamText({
  principal,
  prompt: "Stream plain text",
  temperature: 0.2,
});
let streamedResult;
for (;;) {
  const next = await streamed.next();
  if (next.done) {
    streamedResult = next.value;
    break;
  }
  streamedEvents.push(next.value);
}

const tool = defineTool({
  name: "lookup",
  description: "Look up public synthetic fixture data",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  },
  effect: "read",
  authorization: "required",
  handler: async ({ query }) => ({
    modelContent: JSON.stringify({ query, privateValue: 42 }),
    displayContent: { status: "looked up" },
  }),
});
const run = await client.run({
  principal,
  input: { text: "Use the lookup tool", attachments: undefined },
  tools: [tool],
  authorizeToolCall: async () => ({ decision: "allow" }),
});

assert.equal(text.text, "plain text");
assert.deepEqual(native.object, { suggestions: ["One", "Two"] });
assert.deepEqual(prompted.object, { allowed: true });
assert.equal(streamedResult?.text, "streamed text");
assert.equal(
  streamedEvents.filter((event) => event.type === "text.delta").length,
  1,
);
assert.equal(run.status, "completed");
assert.equal(
  run.status === "completed" ? run.text : undefined,
  "tool complete",
);
assert.equal(run.attempts, 2);
assert.deepEqual(run.toolOutcomes, [
  {
    type: "completed",
    toolCallId: "call-lookup",
    toolName: "lookup",
    effect: "read",
    displayContent: { status: "looked up" },
  },
]);
assert.equal("privateHistory" in run, false);
assert.equal(requests.length, 6);
assert.equal(requests[0].authorization, "Bearer fixture-packed-consumer");
assert.equal(requests[0].body.store, false);
assert.equal(requests[1].body.response_format.type, "json_schema");
assert.equal(requests[1].body.response_format.json_schema.name, "suggestions");
assert.equal("response_format" in requests[2].body, false);
assert.equal(requests[3].body.temperature, 0.2);
assert.equal(requests[4].body.tools[0].function.name, "lookup");
assert.equal(text.attempts, 1);
assert.equal(native.attempts, 1);
assert.equal(prompted.attempts, 1);

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    text: text.text,
    nativeSuggestions: native.object.suggestions.length,
    promptAllowed: prompted.object.allowed,
    streamedText: streamedResult?.text,
    toolRun: run.status,
    toolOutcomes: run.toolOutcomes.length,
    requests: requests.length,
    sessionsRequired: false,
  })}\n`,
);
