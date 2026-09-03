import {
  createAgentEngine,
  defineTool,
  type AgentEngine,
  type AgentPrincipal,
  type AgentSessionRepository,
  type AgentTurnLeaseProvider,
  type CoreModelRuntime,
} from "@agentlink/core";
import {
  resolveCoreModelCatalogReadiness,
  type CoreModelCatalogEntry,
} from "@agentlink/protocol/model-catalog";
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
