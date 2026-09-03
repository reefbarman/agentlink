export type { CoreReasoningEffort } from "@agentlink/protocol/model-catalog";
export type { AgentModelReference, AgentPrincipal } from "./modelIdentity.js";

import type { AgentModelReference, AgentPrincipal } from "./modelIdentity.js";
import type {
  CoreModelDocumentBlock,
  CoreModelImageBlock,
  CoreModelMessage,
  CoreModelStopReason,
  CoreModelUsage,
} from "./modelRuntime.js";
import type {
  EmbeddedAgentErrorCategory,
  EmbeddedAgentToolPresentation,
} from "@agentlink/protocol/embedded-agent-presentation";
import type {
  TurnExecutionEvent,
  TurnExecutionLimits,
  TurnExecutionSnapshot,
} from "./turnExecution.js";

import type { CoreReasoningEffort } from "@agentlink/protocol/model-catalog";

export type AgentModelSelectionSource = "turn" | "session" | "runtime";
export type AgentReasoningEffortSelectionSource =
  | "turn"
  | "session"
  | "runtime";

export interface AgentResolvedModelSelection {
  readonly model: AgentModelReference;
  readonly source: AgentModelSelectionSource;
}

export interface ResolveAgentModelSelectionRequest {
  readonly turnModel: AgentModelReference | undefined;
  readonly sessionModel: AgentModelReference | undefined;
  readonly runtimeDefaultModel: AgentModelReference | undefined;
}

export interface AgentResolvedReasoningEffort {
  readonly effort: CoreReasoningEffort;
  readonly source: AgentReasoningEffortSelectionSource;
}

export interface ResolveAgentReasoningEffortRequest {
  readonly turnReasoningEffort: CoreReasoningEffort | undefined;
  readonly sessionReasoningEffort: CoreReasoningEffort | undefined;
  readonly runtimeDefaultReasoningEffort: CoreReasoningEffort | undefined;
}

/** Resolve the documented turn > session > runtime model precedence. */
export function resolveAgentModelSelection(
  request: ResolveAgentModelSelectionRequest,
): AgentResolvedModelSelection | null {
  if (request.turnModel) {
    return { model: request.turnModel, source: "turn" };
  }
  if (request.sessionModel) {
    return { model: request.sessionModel, source: "session" };
  }
  if (request.runtimeDefaultModel) {
    return { model: request.runtimeDefaultModel, source: "runtime" };
  }
  return null;
}

/** Resolve the documented turn > session > runtime reasoning precedence. */
export function resolveAgentReasoningEffort(
  request: ResolveAgentReasoningEffortRequest,
): AgentResolvedReasoningEffort | null {
  if (request.turnReasoningEffort !== undefined) {
    return { effort: request.turnReasoningEffort, source: "turn" };
  }
  if (request.sessionReasoningEffort !== undefined) {
    return { effort: request.sessionReasoningEffort, source: "session" };
  }
  if (request.runtimeDefaultReasoningEffort !== undefined) {
    return { effort: request.runtimeDefaultReasoningEffort, source: "runtime" };
  }
  return null;
}

export function agentModelReferenceKey(model: AgentModelReference): string {
  return JSON.stringify([model.providerId, model.modelId]);
}

export type AgentTurnAttachment = CoreModelImageBlock | CoreModelDocumentBlock;

/** Host-authenticated input for one conversational turn. */
export interface AgentTurnInput {
  readonly text: string;
  readonly attachments: readonly AgentTurnAttachment[] | undefined;
}

/** Serializable public host intent. Session history and policy remain engine-owned. */
export interface AgentTurnRequest<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly principal: TPrincipal;
  readonly sessionId: string;
  readonly input: AgentTurnInput;
  /** Optional one-turn override; does not mutate the persisted session model. */
  readonly model: AgentModelReference | undefined;
  /** Optional one-turn reasoning override; `"none"` explicitly disables it. */
  readonly reasoningEffort?: CoreReasoningEffort;
}

/** Ephemeral execution controls passed beside, never persisted within, an intent. */
export interface AgentTurnDurableState {
  /** Exact private transcript after this execution boundary. Never emitted publicly. */
  readonly messages: readonly CoreModelMessage[];
  /** Usage accumulated through this execution boundary. */
  readonly usage: CoreModelUsage | undefined;
}

export interface AgentTurnRunOptions {
  readonly signal: AbortSignal | undefined;
  /** Internal host persistence hook; raw tool results remain outside public events. */
  readonly onDurableState?: (state: AgentTurnDurableState) => void;
}

/**
 * Model-ready request after a future engine resolves session state, host
 * instructions, defaults, context selection, and limits. Composition keeps it
 * distinct from the host intent accepted by public operations.
 */
export interface PreparedAgentTurnRequest<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly request: AgentTurnRequest<TPrincipal>;
  /** Engine-assigned stable ID for execution and event correlation. */
  readonly turnId: string;
  readonly history: readonly CoreModelMessage[];
  readonly sessionModel: AgentModelReference | undefined;
  readonly runtimeDefaultModel: AgentModelReference | undefined;
  readonly systemPrompt: string;
  readonly maxOutputTokens: number;
  readonly reasoningEffort: CoreReasoningEffort | undefined;
  readonly limits: TurnExecutionLimits | undefined;
  /** Durable revision the engine must compare when mutating this session. */
  readonly sessionRevision: string;
  /** Optional active distributed turn fence used by repository mutations. */
  readonly turnFencingToken?: string;
}

export interface AgentInteractionRequest {
  readonly interactionId: string;
  readonly kind: "tool_authorization";
  readonly summary: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly effect: "read" | "write" | "external" | "unknown";
  readonly presentation?: EmbeddedAgentToolPresentation;
  readonly displayInput?: unknown;
  readonly displayContent?: unknown;
}

export interface AgentTurnProvenance {
  readonly requestedModel: AgentModelReference | undefined;
  /** Null when execution ended before model selection completed. */
  readonly resolvedModel: AgentResolvedModelSelection | null;
}

export interface AgentTurnPublicResultBase {
  readonly sessionId: string;
  readonly turnId: string;
  /** Durable revision after this terminal state was committed. */
  readonly sessionRevision: string;
  readonly execution: TurnExecutionSnapshot;
  readonly provenance: AgentTurnProvenance;
}

export interface AgentTurnError {
  readonly code: string;
  readonly category: EmbeddedAgentErrorCategory;
  readonly message: string;
  readonly retryable: boolean;
}

export type AgentTurnResult =
  | (AgentTurnPublicResultBase & {
      readonly status: "completed";
      readonly text: string;
      readonly stopReason: CoreModelStopReason | undefined;
      readonly usage: CoreModelUsage | undefined;
    })
  | (AgentTurnPublicResultBase & {
      readonly status: "cancelled";
      readonly reason: string | undefined;
      readonly usage: CoreModelUsage | undefined;
    })
  | (AgentTurnPublicResultBase & {
      readonly status: "failed";
      readonly error: AgentTurnError;
      readonly usage: CoreModelUsage | undefined;
    })
  | (AgentTurnPublicResultBase & {
      readonly status: "suspended";
      readonly interaction: AgentInteractionRequest;
    });

export interface AgentTurnEventBase {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly turnId: string;
  readonly sequence: number;
  readonly emittedAt: number;
}

export type AgentTurnEvent =
  | (AgentTurnEventBase & { readonly type: "turn.started" })
  | (AgentTurnEventBase & {
      readonly type: "model.resolved";
      readonly provenance: AgentTurnProvenance & {
        readonly resolvedModel: AgentResolvedModelSelection;
      };
    })
  | (AgentTurnEventBase & {
      readonly type: "text.delta";
      readonly text: string;
    })
  | (AgentTurnEventBase & {
      readonly type: "tool.requested";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly effect: "read" | "write" | "external" | "unknown";
      readonly presentation?: EmbeddedAgentToolPresentation;
      readonly displayInput?: unknown;
    })
  | (AgentTurnEventBase & {
      readonly type: "tool.started";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly effect: "read" | "write" | "external" | "unknown";
      readonly presentation?: EmbeddedAgentToolPresentation;
    })
  | (AgentTurnEventBase & {
      readonly type: "tool.completed";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly effect: "read" | "write" | "external" | "unknown";
      readonly presentation?: EmbeddedAgentToolPresentation;
      readonly displayContent?: unknown;
    })
  | (AgentTurnEventBase & {
      readonly type: "tool.failed";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly effect: "read" | "write" | "external" | "unknown";
      readonly presentation?: EmbeddedAgentToolPresentation;
      readonly error: AgentTurnError;
    })
  | (AgentTurnEventBase & {
      readonly type: "interaction.required";
      readonly interaction: AgentInteractionRequest;
      readonly interactionRevision: string;
      readonly sessionRevision: string;
    })
  | (AgentTurnEventBase & {
      readonly type: "interaction.resumed";
      readonly interactionId: string;
      readonly decision: "allow" | "deny";
      readonly sessionRevision: string;
    })
  | (AgentTurnEventBase & {
      readonly type: "usage.updated";
      readonly model: AgentModelReference;
      readonly usage: CoreModelUsage;
    })
  | (AgentTurnEventBase & {
      readonly type: "execution.updated";
      readonly event: TurnExecutionEvent;
    })
  | (AgentTurnEventBase & {
      readonly type: "turn.completed";
      readonly result: Extract<AgentTurnResult, { status: "completed" }>;
    })
  | (AgentTurnEventBase & {
      readonly type: "turn.cancelled";
      readonly result: Extract<AgentTurnResult, { status: "cancelled" }>;
    })
  | (AgentTurnEventBase & {
      readonly type: "turn.failed";
      readonly result: Extract<AgentTurnResult, { status: "failed" }>;
    })
  | (AgentTurnEventBase & {
      readonly type: "turn.suspended";
      readonly result: Extract<AgentTurnResult, { status: "suspended" }>;
    });

/** The future public engine streams events and returns its public terminal result. */
export type AgentTurnStream = AsyncGenerator<AgentTurnEvent, AgentTurnResult>;
