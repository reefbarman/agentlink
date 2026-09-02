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
