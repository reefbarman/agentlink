import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import type { AgentPrincipal } from "@agentlink/core";
import {
  MAX_MCP_ELICITATION_DESCRIPTION_LENGTH,
  normalizeMcpElicitationSchema,
  validateAndCoerceMcpElicitationValues,
  type McpFormElicitationInput,
} from "@agentlink/protocol/mcp-elicitation";

export interface NodeHostMcpElicitationContext<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly principal: TPrincipal;
  readonly sessionId: string;
  readonly turnId: string;
  readonly signal?: AbortSignal;
}

export interface NodeHostMcpFormElicitationRequest<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
>
  extends NodeHostMcpElicitationContext<TPrincipal>, McpFormElicitationInput {}

export type NodeHostMcpFormElicitationResponse =
  | { readonly action: "accept"; readonly content: Record<string, unknown> }
  | { readonly action: "cancel" }
  | { readonly action: "decline" };

export type NodeHostMcpFormElicitationHandler<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> = (
  request: NodeHostMcpFormElicitationRequest<TPrincipal>,
) =>
  | NodeHostMcpFormElicitationResponse
  | Promise<NodeHostMcpFormElicitationResponse>;

export function createNodeHostMcpClient<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
>(options: {
  readonly clientName: string;
  readonly clientVersion: string;
  readonly serverName: string;
  readonly context: NodeHostMcpElicitationContext<TPrincipal>;
  readonly onElicitation?: NodeHostMcpFormElicitationHandler<TPrincipal>;
}): Client {
  const client = new Client(
    { name: options.clientName, version: options.clientVersion },
    {
      capabilities: options.onElicitation
        ? { elicitation: { form: { applyDefaults: true } } }
        : {},
    },
  );
  if (!options.onElicitation) return client;

  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    const params = request.params;
    if (params.mode === "url") {
      return { action: "decline" as const };
    }
    if (options.context.signal?.aborted) {
      return { action: "cancel" as const };
    }
    const normalized = normalizeMcpElicitationSchema(params.requestedSchema);
    if (!normalized.ok) {
      return { action: "decline" as const };
    }
    try {
      const response = await waitForElicitation(
        options.onElicitation!({
          ...options.context,
          serverName: options.serverName,
          message: boundedText(
            params.message ?? "Please provide the required input.",
            MAX_MCP_ELICITATION_DESCRIPTION_LENGTH,
          ),
          fields: normalized.schema.fields,
        }),
        options.context.signal,
      );
      if (!response) {
        return { action: "cancel" as const };
      }
      if (response.action === "cancel") {
        return { action: "cancel" as const };
      }
      if (response.action === "decline") {
        return { action: "decline" as const };
      }
      const validation = validateAndCoerceMcpElicitationValues(
        normalized.schema.fields,
        response.content,
      );
      return validation.ok
        ? { action: "accept" as const, content: validation.values }
        : { action: "decline" as const };
    } catch {
      return { action: "cancel" as const };
    }
  });
  return client;
}

async function waitForElicitation(
  response:
    | NodeHostMcpFormElicitationResponse
    | Promise<NodeHostMcpFormElicitationResponse>,
  signal: AbortSignal | undefined,
): Promise<NodeHostMcpFormElicitationResponse | undefined> {
  const pending = Promise.resolve(response);
  if (!signal) return await pending;
  if (signal.aborted) return undefined;
  return await new Promise((resolve, reject) => {
    const onAbort = () => resolve(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function boundedText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}
