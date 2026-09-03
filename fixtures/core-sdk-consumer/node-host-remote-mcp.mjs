import {
  CoreModelBackendRegistry,
  DefaultCoreModelRuntime,
  InMemoryAgentStateRepository,
  InMemoryAgentTurnLeaseProvider,
  createTurnInteractionTokenService,
} from "@agentlink/core";
import {
  createNodeHostAgent,
  createNodeHostMcpRemoteTools,
} from "@agentlink/node-host";

import assert from "node:assert/strict";

const MODEL = { providerId: "fixture", modelId: "fixture-model" };
const PRINCIPAL_A = { tenantId: "tenant", subjectId: "a" };
const PRINCIPAL_B = { tenantId: "tenant", subjectId: "b" };
const MCP_URL = "https://mcp.example.test/agentlink";
const CAPS = {
  supportsThinking: false,
  supportsCaching: false,
  supportsImages: false,
  supportsToolUse: true,
  contextWindow: 32_768,
  maxOutputTokens: 4_096,
};

class FixtureBackend {
  providerId = MODEL.providerId;
  displayName = "Fixture";
  condenseModel = MODEL.modelId;

  listModels() {
    return [
      {
        id: MODEL.modelId,
        displayName: "Fixture model",
        providerId: this.providerId,
        contextWindow: CAPS.contextWindow,
        maxOutputTokens: CAPS.maxOutputTokens,
        authenticated: true,
        availability: "ready",
      },
    ];
  }

  getCapabilities() {
    return CAPS;
  }

  async *stream(request) {
    const toolResult = request.messages.some(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some(
          (block) =>
            block.type === "tool_result" &&
            String(block.content).includes("remote evidence for a"),
        ),
    );
    if (toolResult) {
      yield { type: "text_delta", text: "Remote MCP evidence loaded" };
      yield {
        type: "model_stop",
        reason: "end_turn",
        assistantMessage: {
          role: "assistant",
          content: [{ type: "text", text: "Remote MCP evidence loaded" }],
        },
      };
      yield { type: "done" };
      return;
    }
    yield {
      type: "tool_done",
      toolCallId: "remote-tool-call",
      toolName: "records__lookup",
      input: { subjectId: "a" },
    };
    yield {
      type: "model_stop",
      reason: "tool_use",
      assistantMessage: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "remote-tool-call",
            name: "records__lookup",
            input: { subjectId: "a" },
          },
        ],
      },
    };
    yield { type: "done" };
  }

  async complete() {
    return { text: "fixture completion" };
  }
}

function createRuntime() {
  const registry = new CoreModelBackendRegistry();
  registry.register(new FixtureBackend());
  return new DefaultCoreModelRuntime(registry, {
    ownerId: "packed-mcp-fixture",
  });
}

const protocolCalls = [];
const underlyingFetches = [];
const networkAuthorizations = [];
globalThis.fetch = async () => {
  throw new Error("Packed MCP fixture must use only the injected fetch");
};
const serverResolutions = [];
const toolAuthorizations = [];

const mockMcpFetch = async (input, init = {}) => {
  const url = input instanceof Request ? input.url : String(input);
  underlyingFetches.push({
    url,
    method: init.method ?? "GET",
    redirect: init.redirect,
  });
  assert.equal(url, MCP_URL);
  assert.equal(init.redirect, "error");

  if ((init.method ?? "GET") === "GET") {
    return new Response(null, {
      status: 405,
      statusText: "Method Not Allowed",
    });
  }

  const message = JSON.parse(String(init.body));
  protocolCalls.push(message.method);
  if (message.method === "notifications/initialized") {
    return new Response(null, { status: 202 });
  }
  if (message.method === "initialize") {
    return Response.json({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "packed-mcp-fixture", version: "1.0.0" },
      },
    });
  }
  if (message.method === "tools/list") {
    return Response.json({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          {
            name: "lookup",
            description: "Load one principal-scoped remote record.",
            inputSchema: {
              type: "object",
              properties: { subjectId: { type: "string" } },
              required: ["subjectId"],
              additionalProperties: false,
            },
          },
        ],
      },
    });
  }
  if (message.method === "tools/call") {
    assert.equal(message.params.name, "lookup");
    assert.deepEqual(message.params.arguments, { subjectId: "a" });
    return Response.json({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [{ type: "text", text: "remote evidence for a" }],
      },
    });
  }
  throw new Error(`Unexpected MCP method: ${message.method}`);
};

const remoteTools = createNodeHostMcpRemoteTools({
  resolveServers: (request) => {
    serverResolutions.push(request);
    return request.principal.subjectId === "a"
      ? [
          {
            id: "records",
            transport: "streamable-http",
            url: MCP_URL,
          },
        ]
      : [];
  },
  authorizeNetwork: (request) => {
    networkAuthorizations.push(request);
    return (
      request.principal.subjectId === "a" &&
      request.serverId === "records" &&
      request.url.href === MCP_URL
    );
  },
  fetch: mockMcpFetch,
});

const deniedFetches = [];
const deniedTools = createNodeHostMcpRemoteTools({
  resolveServers: () => [
    { id: "denied", transport: "streamable-http", url: MCP_URL },
  ],
  authorizeNetwork: () => false,
  fetch: async (...args) => {
    deniedFetches.push(args);
    return new Response(null, { status: 500 });
  },
});
assert.deepEqual(
  await deniedTools({
    principal: PRINCIPAL_A,
    sessionId: "denied-session",
    turnId: "denied-turn",
  }),
  [],
);
assert.equal(deniedFetches.length, 0);

const redirectFetches = [];
const redirectedTools = createNodeHostMcpRemoteTools({
  resolveServers: () => [
    { id: "redirected", transport: "streamable-http", url: MCP_URL },
  ],
  authorizeNetwork: () => true,
  fetch: async (...args) => {
    redirectFetches.push(args);
    return new Response(null, {
      status: 302,
      headers: { location: "https://other.example.test/mcp" },
    });
  },
});
assert.deepEqual(
  await redirectedTools({
    principal: PRINCIPAL_A,
    sessionId: "redirect-session",
    turnId: "redirect-turn",
  }),
  [],
);
assert.equal(redirectFetches.length, 1);

const directlyResolved = await remoteTools({
  principal: PRINCIPAL_A,
  sessionId: "direct-session",
  turnId: "direct-turn",
});
assert.equal(directlyResolved.length, 1);
const fetchCountBeforeMismatch = underlyingFetches.length;
const mismatch = await directlyResolved[0].execute(
  { subjectId: "a" },
  {
    principal: PRINCIPAL_B,
    sessionId: "direct-session",
    turnId: "direct-turn",
    model: { model: MODEL, source: "runtime" },
    signal: undefined,
  },
);
assert.equal(mismatch.isError, true);
assert.match(mismatch.modelContent, /mcp_remote_turn_mismatch/);
assert.equal(underlyingFetches.length, fetchCountBeforeMismatch);
const crossPrincipalInvocationBlocked =
  mismatch.isError && underlyingFetches.length === fetchCountBeforeMismatch;

const state = new InMemoryAgentStateRepository();
let turnCounter = 0;
const agent = createNodeHostAgent({
  ownerId: "packed-node-host-mcp",
  models: createRuntime(),
  persistence: {
    sessions: state,
    turnLeases: new InMemoryAgentTurnLeaseProvider(),
  },
  interactions: {
    interactions: state,
    interactionTokens: createTurnInteractionTokenService({
      secret: "0123456789abcdef0123456789abcdef",
      createResponseId: () => "packed-mcp-response",
    }),
    authorizeToolCall: (request) => {
      toolAuthorizations.push(request);
      return { decision: "allow" };
    },
  },
  instructions: ({ principal }) =>
    `Use only MCP records authorized for ${principal.subjectId}.`,
  tools: { resolveTools: remoteTools },
  defaultModel: MODEL,
  createTurnId: () => `packed-mcp-turn-${++turnCounter}`,
  maxOutputTokens: 512,
  limits: { maxModelCalls: 4, maxToolCalls: 2 },
});

async function collect(stream) {
  const events = [];
  for (;;) {
    const next = await stream.next();
    if (next.done) return { events, result: next.value };
    events.push(next.value);
  }
}

await agent.sessions.create({
  principal: PRINCIPAL_A,
  sessionId: "mcp-session",
});
const { events, result } = await collect(
  agent.sessions.runTurn({
    principal: PRINCIPAL_A,
    sessionId: "mcp-session",
    input: { text: "Load my remote record", attachments: undefined },
    model: MODEL,
  }),
);
assert.equal(result.status, "completed");
assert.equal(result.text, "Remote MCP evidence loaded");
assert.deepEqual(
  toolAuthorizations.map(
    ({ principal, sessionId, turnId, toolName, effect }) => ({
      principal,
      sessionId,
      turnId,
      toolName,
      effect,
    }),
  ),
  [
    {
      principal: PRINCIPAL_A,
      sessionId: "mcp-session",
      turnId: "packed-mcp-turn-1",
      toolName: "records__lookup",
      effect: "external",
    },
  ],
);
assert.ok(
  events.some(
    (event) =>
      event.type === "tool.completed" &&
      event.toolName === "records__lookup" &&
      event.displayContent?.server === "records" &&
      event.displayContent?.tool === "lookup",
  ),
);
assert.ok(
  serverResolutions.some(
    (request) =>
      request.principal.subjectId === "a" &&
      request.sessionId === "mcp-session" &&
      request.turnId === "packed-mcp-turn-1",
  ),
);
const networkAuthorizationCovered =
  networkAuthorizations.length > 0 &&
  networkAuthorizations.length === underlyingFetches.length &&
  underlyingFetches.every(
    (fetch, index) =>
      networkAuthorizations[index]?.serverId === "records" &&
      networkAuthorizations[index]?.url.href === fetch.url,
  );
assert.equal(networkAuthorizationCovered, true);
assert.ok(protocolCalls.includes("initialize"));
assert.ok(protocolCalls.includes("tools/list"));
assert.equal(
  protocolCalls.filter((method) => method === "tools/call").length,
  1,
);

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    result: result.status,
    remoteToolCalls: protocolCalls.filter((method) => method === "tools/call")
      .length,
    networkAuthorizationCovered,
    deniedDestinationFetches: deniedFetches.length,
    redirectsRejected: redirectFetches.length === 1,
    crossPrincipalInvocationBlocked,
    toolAuthorization: toolAuthorizations[0]?.toolName,
  })}\n`,
);
