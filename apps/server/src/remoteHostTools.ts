import {
  defineTool,
  type AgentPrincipal,
  type AgentResolvedModelSelection,
  type HostToolEffect,
  type HostToolResolver,
  type HostToolResult,
} from "@agentlink/core";

import type {
  WorkspaceApprovalHostTools,
  WorkspaceHostToolApproval,
} from "@agentlink/workspace-host";

import { HttpError } from "./httpJson.js";
import { hashTool } from "./mcpRegistry.js";
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

/**
 * What the owner saw on an approval card: the tool and the summary and
 * display content the control plane prepared for it. The runner shows the
 * card, but these come from the control plane's own `prepare`.
 */
export interface RunnerApprovalCard {
  readonly toolName: string;
  readonly summary: string;
  readonly displayContent?: unknown;
}

/**
 * What a runner's sessions may run of the control plane's approval tools
 * (MCP calls). The runner holds the session and shows the card, but it is
 * never trusted to say the owner approved: `prepare` records exactly what
 * the control plane prepared for that session (the input that will run and
 * the card it produced for it), the owner's Allow approves only the grant
 * whose card is the one the owner answered, and a call runs only if it
 * matches an approved grant, once. So a runner cannot prepare A, prepare
 * B, show A's card and run B.
 */
export interface RunnerApprovalGrants {
  /** Record a prepared call; `approved` for one the host allows outright. */
  expect(
    sessionId: string,
    toolName: string,
    input: Readonly<Record<string, unknown>>,
    approved: boolean,
    card?: RunnerApprovalCard,
  ): void;
  /**
   * The owner decided the session's pending card. Allow approves the one
   * undecided grant prepared with exactly that card, or nothing when there
   * is no card or the card does not identify exactly one grant. Either
   * decision drops the session's other undecided grants.
   */
  decide(
    sessionId: string,
    decision: "allow" | "deny",
    card?: RunnerApprovalCard,
  ): void;
  /** Use up the matching approved grant; false when there is none. */
  take(
    sessionId: string,
    toolName: string,
    input: Readonly<Record<string, unknown>>,
  ): boolean;
}

const MAX_GRANTS_PER_SESSION = 10;

export function createRunnerApprovalGrants(): RunnerApprovalGrants {
  const grants = new Map<
    string,
    Array<{ readonly key: string; readonly card?: string; approved: boolean }>
  >();
  const keyOf = (toolName: string, input: Readonly<Record<string, unknown>>) =>
    hashTool({ toolName, input });
  const cardOf = (card: RunnerApprovalCard) =>
    hashTool({
      toolName: card.toolName,
      input: {
        summary: card.summary,
        // A card read back over JSON has no undefined fields.
        displayContent: card.displayContent ?? null,
      },
    });
  return {
    expect(sessionId, toolName, input, approved, card) {
      const list = grants.get(sessionId) ?? [];
      list.push({
        key: keyOf(toolName, input),
        ...(card ? { card: cardOf(card) } : {}),
        approved,
      });
      grants.set(sessionId, list.slice(-MAX_GRANTS_PER_SESSION));
    },
    decide(sessionId, decision, card) {
      const list = grants.get(sessionId);
      if (!list) return;
      const undecided = list.filter((grant) => !grant.approved);
      if (decision === "allow" && card) {
        const shown = cardOf(card);
        const matching = undecided.filter((grant) => grant.card === shown);
        // Two prepared calls with the same card are ambiguous: neither runs.
        if (matching.length === 1) matching[0]!.approved = true;
      }
      grants.set(
        sessionId,
        list.filter((grant) => grant.approved),
      );
    },
    take(sessionId, toolName, input) {
      const list = grants.get(sessionId) ?? [];
      const key = keyOf(toolName, input);
      const index = list.findIndex(
        (grant) => grant.approved && grant.key === key,
      );
      if (index < 0) return false;
      list.splice(index, 1);
      return true;
    },
  };
}

/**
 * Approval tools for a runner (`/approval-tools/*`): their names and
 * definitions, `prepare` (decision and card), `validate` before a decided
 * card runs, and `call`, which runs only a granted call.
 */
export function approvalToolProxyRoutes(options: {
  readonly tools: WorkspaceApprovalHostTools;
  readonly principal: AgentPrincipal;
  readonly grants: RunnerApprovalGrants;
}): Record<string, RunnerRouteHandler> {
  const { tools, grants } = options;
  const names = new Set(tools.toolNames);
  const ids = (body: Record<string, unknown>) => {
    const { sessionId, turnId } = body;
    if (typeof sessionId !== "string" || typeof turnId !== "string") {
      throw new HttpError(400, "tool_request_invalid");
    }
    return { sessionId, turnId };
  };
  const inputOf = (body: Record<string, unknown>) =>
    body.input && typeof body.input === "object" && !Array.isArray(body.input)
      ? (body.input as Record<string, unknown>)
      : {};
  const nameOf = (body: Record<string, unknown>) => {
    const name = body.toolName;
    if (typeof name !== "string" || !names.has(name)) {
      throw new HttpError(404, "tool_not_found");
    }
    return name;
  };
  const resolve = async (sessionId: string, turnId: string) =>
    (
      await tools.resolveTools({
        principal: options.principal,
        sessionId,
        turnId,
        input: { text: "", attachments: undefined },
      })
    ).filter((tool) => names.has(tool.definition.name));
  return {
    "/approval-tools/names": async () => [...names],
    "/approval-tools/list": async (body) => {
      const { sessionId, turnId } = ids(body);
      return (await resolve(sessionId, turnId)).map((tool): WireHostTool => ({
        name: tool.definition.name,
        description: tool.definition.description,
        inputSchema: tool.definition.input_schema,
        effect: tool.effect,
        parallelSafe: tool.parallelSafe,
        ...(tool.presentation ? { presentation: tool.presentation } : {}),
      }));
    },
    "/approval-tools/prepare": async (body) => {
      const { sessionId, turnId } = ids(body);
      const toolName = nameOf(body);
      const input = inputOf(body);
      const approval = await tools.prepare({
        principal: options.principal,
        sessionId,
        turnId,
        toolName,
        input,
        effect: "external",
      } as Parameters<WorkspaceApprovalHostTools["prepare"]>[0]);
      if (approval.decision !== "deny") {
        grants.expect(
          sessionId,
          toolName,
          approval.preparedInput ?? input,
          approval.decision === "allow",
          {
            toolName,
            summary: approval.summary,
            ...(approval.displayContent === undefined
              ? {}
              : { displayContent: approval.displayContent }),
          },
        );
      }
      return approval;
    },
    "/approval-tools/validate": async (body) => {
      const { sessionId } = ids(body);
      const toolName = nameOf(body);
      return tools.validatePending
        ? await tools.validatePending({
            sessionId,
            toolName,
            input: inputOf(body),
          })
        : { ok: true };
    },
    "/approval-tools/call": async (body, { signal }) => {
      const { sessionId, turnId } = ids(body);
      const toolName = nameOf(body);
      const input = inputOf(body);
      if (!grants.take(sessionId, toolName, input)) {
        throw new HttpError(403, "approval_required");
      }
      const tool = (await resolve(sessionId, turnId)).find(
        (item) => item.definition.name === toolName,
      );
      if (!tool) throw new HttpError(404, "tool_not_found");
      // The grant proves this is exactly the input prepared here, which
      // (like the engine) is not checked against the model's schema again.
      return await tool.executeValidated(input, {
        principal: options.principal,
        sessionId,
        turnId,
        model: body.model as AgentResolvedModelSelection,
        signal,
      });
    },
  };
}

/**
 * The runner's approval tools, from the control plane; undefined when it
 * offers none.
 */
export async function remoteApprovalHostTools(
  client: RunnerHttpClient,
): Promise<WorkspaceApprovalHostTools | undefined> {
  const toolNames = await client.call<string[]>("/approval-tools/names", {});
  if (toolNames.length === 0) return undefined;
  return {
    toolNames,
    resolveTools: async (request) => {
      const listed = await client.call<WireHostTool[]>("/approval-tools/list", {
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
          authorization: "required",
          ...(tool.presentation
            ? { presentation: tool.presentation as never }
            : {}),
          handler: async (input, context) =>
            await client.call<HostToolResult>(
              "/approval-tools/call",
              {
                toolName: tool.name,
                input,
                sessionId: context.sessionId,
                turnId: context.turnId,
                model: context.model,
              },
              context.signal,
            ),
        }),
      );
    },
    prepare: async (request) =>
      await client.call<WorkspaceHostToolApproval>("/approval-tools/prepare", {
        sessionId: request.sessionId,
        turnId: request.turnId,
        toolName: request.toolName,
        input: request.input,
      }),
    validatePending: async (request) =>
      await client.call<{ ok: true } | { ok: false; reason: string }>(
        "/approval-tools/validate",
        {
          sessionId: request.sessionId,
          turnId: "",
          toolName: request.toolName,
          input: request.input,
        },
      ),
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
