/**
 * Shapes of the assistant server's API as the web app reads them. Kept
 * local and minimal: the app only relies on these fields.
 */

export interface AuthSession {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly deviceLabel: string;
  readonly expiresAt: number;
  readonly recentlyAuthenticated: boolean;
  readonly csrfToken: string;
}

export interface ModelReference {
  readonly providerId: string;
  readonly modelId: string;
}

export interface ModelChoice extends ModelReference {
  readonly displayName?: string;
  readonly providerDisplayName?: string;
}

export interface ModelsResponse {
  readonly models: readonly ModelChoice[];
  readonly defaultModel: ModelReference;
  readonly roles: Readonly<Record<string, ModelReference>>;
}

export interface Project {
  readonly projectId: string;
  readonly label?: string;
}

export interface SessionSummary {
  readonly sessionId: string;
  readonly updatedAt: number;
  readonly state: string;
  readonly model: ModelReference;
  readonly background: boolean;
}

export interface TranscriptEntry {
  readonly kind: "user" | "assistant" | "tool";
  readonly text?: string;
  readonly truncated?: true;
  readonly toolName?: string;
}

export interface PendingInteraction {
  readonly request: {
    readonly interactionId: string;
    readonly summary: string;
    readonly toolName: string;
    readonly effect: string;
    readonly displayInput?: unknown;
    readonly displayContent?: unknown;
  };
  readonly interactionRevision: string;
}

export interface SessionSnapshot {
  readonly session: {
    readonly phase: string;
    readonly pendingInteraction?: PendingInteraction;
  };
  readonly transcript: {
    readonly entries: readonly TranscriptEntry[];
    readonly omitted: number;
  };
  readonly model: ModelReference;
  readonly task: {
    readonly taskId: string;
    readonly operation: string;
    readonly startedSequence?: number;
    /** The running turn's prompt (bounded), until the turn commits. */
    readonly text?: string;
  } | null;
  readonly events: { readonly epoch: string; readonly sequence: number };
}

export interface TurnEvent {
  readonly type: string;
  readonly text?: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly result?: {
    readonly status: string;
    readonly reason?: string;
    readonly error?: { readonly code?: string; readonly message?: string };
  };
}

export type SessionEvent =
  | { readonly kind: "turn"; readonly event: TurnEvent }
  | {
      readonly kind: "task";
      readonly state: "started";
      readonly taskId: string;
      readonly operation: string;
    }
  | {
      readonly kind: "task";
      readonly state: "finished";
      readonly taskId: string;
      readonly status: string;
    }
  | {
      readonly kind: "task";
      readonly state: "failed";
      readonly taskId: string;
      readonly error: string;
    }
  | {
      readonly kind: "agent";
      readonly state: string;
      readonly childSessionId: string;
    };

export interface SequencedEvent {
  readonly sequence: number;
  readonly event: SessionEvent;
}

export interface BackgroundAgent {
  readonly childSessionId: string;
  readonly task: string;
  readonly lifecycle: string;
  readonly phase: string;
  readonly createdAt?: number;
  readonly model?: ModelReference;
  readonly currentTool?: string;
  readonly resultText?: string;
  readonly partialOutput?: string;
  readonly terminalReason?: string;
  readonly approval?: {
    readonly interactionId: string;
    readonly toolName: string;
    readonly summary: string;
    readonly displayContent?: unknown;
  };
}

export interface Device {
  readonly deviceId: string;
  readonly label: string;
  readonly createdAt: number;
  readonly revokedAt?: number;
  readonly current: boolean;
}
