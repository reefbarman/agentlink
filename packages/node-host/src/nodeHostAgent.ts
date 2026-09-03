import type { CoreReasoningEffort } from "@agentlink/protocol/model-catalog";

import {
  createAgentEngine,
  type AgentEngine,
  type AgentModelReference,
  type AgentPrincipal,
  type AgentSessionRepository,
  type AgentTranscriptPolicy,
  type AgentTurnLeaseProvider,
  type AuthorizeToolCall,
  type CoreModelAuthContext,
  type CoreModelRuntime,
  type DurableToolInteractionRepository,
  type HeadlessTurnAuthRequest,
  type HostTool,
  type HostToolResolver,
  type ResolveAgentInstructions,
  type TurnExecutionLimits,
  type TurnInteractionTokenService,
} from "@agentlink/core";

/** Explicit host-owned persistence dependencies for one embedded Node engine. */
export interface NodeHostPersistence<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly sessions: AgentSessionRepository<TPrincipal>;
  readonly turnLeases: AgentTurnLeaseProvider<TPrincipal>;
}

/** Optional durable approval wiring. Both fields must be supplied together. */
export interface NodeHostInteractions<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly interactions: DurableToolInteractionRepository<TPrincipal>;
  readonly interactionTokens: TurnInteractionTokenService;
  readonly authorizeToolCall?: AuthorizeToolCall<TPrincipal>;
}

/**
 * Resolve Node-host tools once for each principal/session/turn. C1 supplies
 * filesystem/search tools; C0 intentionally accepts only host-provided tools.
 */
export interface CreateNodeHostToolsOptions<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly tools?: readonly HostTool<TPrincipal>[];
  readonly resolveTools?: HostToolResolver<TPrincipal>;
}

/**
 * Create a dynamic host-tool resolver without granting any default capability.
 * Passing both static and dynamic tools is rejected so tool disclosure is
 * deterministic for each turn.
 */
export function createNodeHostTools<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
>(
  options: CreateNodeHostToolsOptions<TPrincipal>,
): HostToolResolver<TPrincipal> | undefined {
  if (options.tools && options.resolveTools) {
    throw new Error(
      "Node host tools must be static or dynamically resolved, not both",
    );
  }
  if (options.resolveTools) return options.resolveTools;
  if (!options.tools) return undefined;
  const tools = [...options.tools];
  return () => tools;
}

/** Host-owned composition boundary for the portable engine. */
export interface CreateNodeHostAgentOptions<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly ownerId: string;
  readonly models: CoreModelRuntime;
  readonly persistence: NodeHostPersistence<TPrincipal>;
  readonly instructions: ResolveAgentInstructions<TPrincipal>;
  readonly tools?: CreateNodeHostToolsOptions<TPrincipal>;
  readonly interactions?: NodeHostInteractions<TPrincipal>;
  readonly defaultModel?: AgentModelReference;
  readonly defaultReasoningEffort?: CoreReasoningEffort;
  readonly transcriptPolicy?: AgentTranscriptPolicy<TPrincipal>;
  readonly resolveAuthContext?: (
    request: HeadlessTurnAuthRequest<TPrincipal>,
  ) =>
    | CoreModelAuthContext
    | undefined
    | Promise<CoreModelAuthContext | undefined>;
  readonly limits?: TurnExecutionLimits;
  readonly maxOutputTokens?: number;
  readonly leaseTtlMs?: number;
  readonly leaseRenewIntervalMs?: number;
  readonly createSessionId?: () => string;
  readonly createTurnId?: () => string;
  readonly createInteractionId?: () => string;
  readonly now?: () => number;
}

/**
 * Compose only explicitly supplied host dependencies into the portable engine.
 * Node-host has no implicit filesystem, shell, network, or MCP capability.
 */
export function createNodeHostAgent<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
>(options: CreateNodeHostAgentOptions<TPrincipal>): AgentEngine<TPrincipal> {
  const interactions = options.interactions;
  return createAgentEngine({
    ownerId: options.ownerId,
    models: options.models,
    sessions: options.persistence.sessions,
    turnLeases: options.persistence.turnLeases,
    ...(interactions
      ? {
          interactions: interactions.interactions,
          interactionTokens: interactions.interactionTokens,
          ...(interactions.authorizeToolCall
            ? { authorizeToolCall: interactions.authorizeToolCall }
            : {}),
        }
      : {}),
    ...(options.defaultModel ? { defaultModel: options.defaultModel } : {}),
    ...(options.defaultReasoningEffort !== undefined
      ? { defaultReasoningEffort: options.defaultReasoningEffort }
      : {}),
    ...(options.transcriptPolicy
      ? { transcriptPolicy: options.transcriptPolicy }
      : {}),
    resolveInstructions: options.instructions,
    ...(options.tools
      ? { resolveTools: createNodeHostTools(options.tools) }
      : {}),
    ...(options.resolveAuthContext
      ? { resolveAuthContext: options.resolveAuthContext }
      : {}),
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.maxOutputTokens
      ? { maxOutputTokens: options.maxOutputTokens }
      : {}),
    ...(options.leaseTtlMs ? { leaseTtlMs: options.leaseTtlMs } : {}),
    ...(options.leaseRenewIntervalMs
      ? { leaseRenewIntervalMs: options.leaseRenewIntervalMs }
      : {}),
    ...(options.createSessionId
      ? { createSessionId: options.createSessionId }
      : {}),
    ...(options.createTurnId ? { createTurnId: options.createTurnId } : {}),
    ...(options.createInteractionId
      ? { createInteractionId: options.createInteractionId }
      : {}),
    ...(options.now ? { now: options.now } : {}),
  });
}
