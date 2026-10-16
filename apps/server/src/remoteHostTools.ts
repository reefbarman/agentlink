import {
  defineTool,
  type AgentPrincipal,
  type AgentResolvedModelSelection,
  type HostToolEffect,
  type HostToolResolver,
  type HostToolResult,
} from "@agentlink/core";

import { HttpError } from "./httpJson.js";
import type { RunnerHttpClient, RunnerRouteHandler } from "./runnerProtocol.js";

/**
 * Host tools for a session runner, kept on the control plane: a task's web
 * tools need the egress policy key and the Codex sign-in, which never enter
 * a runner. The runner lists them each turn and forwards each call. Only
 * tools that need no approval cross (approval tools stay with chats on the
 * control plane).
 */

interface WireHostTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly effect: HostToolEffect;
  readonly parallelSafe: boolean;
  readonly presentation?: unknown;
}

export function hostToolProxyRoutes(options: {
  readonly resolve: HostToolResolver;
  readonly principal: AgentPrincipal;
}): Record<string, RunnerRouteHandler> {
  const resolve = async (body: Record<string, unknown>) => {
    const { sessionId, turnId } = body;
    if (typeof sessionId !== "string" || typeof turnId !== "string") {
      throw new HttpError(400, "tool_request_invalid");
    }
    const tools = await options.resolve({
      principal: options.principal,
      sessionId,
      turnId,
      input: { text: "", attachments: undefined },
    });
    return {
      sessionId,
      turnId,
      tools: tools.filter((tool) => tool.authorization === "none"),
    };
  };
  return {
    "/tools/list": async (body) =>
      (await resolve(body)).tools.map((tool): WireHostTool => ({
        name: tool.definition.name,
        description: tool.definition.description,
        inputSchema: tool.definition.input_schema,
        effect: tool.effect,
        parallelSafe: tool.parallelSafe,
        ...(tool.presentation ? { presentation: tool.presentation } : {}),
      })),
    "/tools/call": async (body, { signal }) => {
      const { sessionId, turnId, tools } = await resolve(body);
      const tool = tools.find((item) => item.definition.name === body.name);
      if (!tool) throw new HttpError(404, "tool_not_found");
      const input =
        body.input &&
        typeof body.input === "object" &&
        !Array.isArray(body.input)
          ? (body.input as Record<string, unknown>)
          : {};
      return await tool.execute(input, {
        principal: options.principal,
        sessionId,
        turnId,
        model: body.model as AgentResolvedModelSelection,
        signal,
      });
    },
  };
}

/** The runner's resolver: the control plane's tools, called through it. */
export function remoteHostTools(client: RunnerHttpClient): HostToolResolver {
  return async (request) => {
    const listed = await client.call<WireHostTool[]>("/tools/list", {
      sessionId: request.sessionId,
      turnId: request.turnId,
    });
    return listed.map((tool) =>
      defineTool({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as never,
        effect: tool.effect,
        parallelSafe: tool.parallelSafe,
        authorization: "none",
        ...(tool.presentation
          ? { presentation: tool.presentation as never }
          : {}),
        handler: async (input, context) =>
          await client.call<HostToolResult>(
            "/tools/call",
            {
              name: tool.name,
              input,
              sessionId: context.sessionId,
              turnId: context.turnId,
              model: context.model,
            },
            context.signal,
          ),
      }),
    );
  };
}
