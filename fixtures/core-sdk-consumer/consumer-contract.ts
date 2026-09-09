import {
  createAgentClient,
  createAgentEngine,
  defineTool,
  type AgentEngine,
  type AgentPrincipal,
  type AgentSessionRepository,
  type AgentTurnLeaseProvider,
  type CoreModelRuntime,
} from "@agentlink/core";
import type { AgentClient } from "@agentlink/core/client";
import { createOpenAICompatibleProvider } from "@agentlink/core/openai-compatible";
import { createOpenAIResponsesProvider } from "@agentlink/core/openai-responses";
import { createCodexOAuthProvider } from "@agentlink/core/codex";
import {
  resolveCoreModelCatalogReadiness,
  type CoreModelCatalogEntry,
} from "@agentlink/protocol/model-catalog";
import { z } from "zod";
import {
  createNodeHostAgent,
  createNodeHostMcpRemoteTools,
} from "@agentlink/node-host";

interface FixturePrincipal extends AgentPrincipal {
  readonly tenantId: string;
  readonly subjectId: string;
}

const principal: FixturePrincipal = {
  tenantId: "tenant",
  subjectId: "subject",
};
const tool = defineTool<FixturePrincipal>({
  name: "fixture_tool",
  description: "Compile-only packed consumer tool",
  inputSchema: { type: "object", additionalProperties: false },
  effect: "read",
  handler: async (_input, context) => ({
    modelContent: context.principal.subjectId,
  }),
});
const descriptor: Pick<CoreModelCatalogEntry, "authenticated" | "readiness"> = {
  authenticated: true,
};
resolveCoreModelCatalogReadiness(descriptor);

const statelessProvider = createOpenAICompatibleProvider({
  id: "fixture-compatible",
  baseURL: "https://example.invalid/v1",
  noAuth: true,
  models: [
    {
      id: "fixture-compatible-model",
      contextWindow: 32_768,
      maxOutputTokens: 4_096,
      supportsToolUse: true,
      structuredOutput: "json_schema",
    },
  ],
});
const openAIResponses = createOpenAIResponsesProvider({
  apiKey: ({ principal: current }) => `key-${current.subjectId}`,
  modelIds: ["gpt-5.4-mini"],
});
const codexOAuth = createCodexOAuthProvider<FixturePrincipal>({
  modelIds: ["gpt-5.5"],
  credentialProvider: {
    resolveAuth: async ({ context }) => ({
      method: "oauth",
      bearerToken: `oauth-${context.principal.subjectId}`,
      canRefresh: false,
    }),
  },
});
void [openAIResponses, codexOAuth];

const statelessClient: AgentClient = createAgentClient({
  providers: [statelessProvider],
  defaultModel: {
    providerId: "fixture-compatible",
    modelId: "fixture-compatible-model",
  },
});
const inferredObject = statelessClient.generateObject({
  principal,
  prompt: "Compile-only typed output",
  schema: z.object({ suggestions: z.array(z.string()) }),
});
void inferredObject.then((result) => {
  const suggestions: string[] = result.object.suggestions;
  return suggestions;
});
const compileOnlyStream = statelessClient.streamText({
  principal,
  prompt: "Compile-only stream",
});
const compileOnlyRun = statelessClient.run({
  principal,
  input: { text: "Compile-only workflow", attachments: undefined },
  tools: [tool],
});
void [compileOnlyStream, compileOnlyRun];

export function composePackedConsumer(options: {
  readonly models: CoreModelRuntime;
  readonly sessions: AgentSessionRepository<FixturePrincipal>;
  readonly turnLeases: AgentTurnLeaseProvider<FixturePrincipal>;
}): AgentEngine<FixturePrincipal> {
  return createAgentEngine({
    ownerId: "packed-consumer",
    ...options,
    defaultModel: { providerId: "fixture", modelId: "fixture-model" },
    resolveInstructions: ({ principal: current }) =>
      `Serve ${current.tenantId}/${current.subjectId}`,
    resolveTools: ({ principal: current }) =>
      current.subjectId === principal.subjectId ? [tool] : [],
  });
}

const remoteMcpTools = createNodeHostMcpRemoteTools<FixturePrincipal>({
  resolveServers: ({ principal: current }) =>
    current.subjectId === principal.subjectId
      ? [
          {
            id: "records",
            transport: "streamable-http",
            url: "https://mcp.example.test/agentlink",
          },
        ]
      : [],
  authorizeNetwork: ({ principal: current, url }) =>
    current.subjectId === principal.subjectId &&
    url.origin === "https://mcp.example.test",
});

export function composePackedNodeHostConsumer(options: {
  readonly models: CoreModelRuntime;
  readonly sessions: AgentSessionRepository<FixturePrincipal>;
  readonly turnLeases: AgentTurnLeaseProvider<FixturePrincipal>;
}): AgentEngine<FixturePrincipal> {
  return createNodeHostAgent({
    ownerId: "packed-node-host-consumer",
    models: options.models,
    persistence: options,
    instructions: ({ principal: current }) =>
      `Serve ${current.tenantId}/${current.subjectId}`,
    tools: { resolveTools: remoteMcpTools },
    defaultModel: { providerId: "fixture", modelId: "fixture-model" },
  });
}
