import { initialState, type AppState } from "../../shared/chatProjection.js";

const MAX_CACHED_PROJECTIONS = 32;

type SharedProjectionFields = Pick<
  AppState,
  "modes" | "availableModels" | "slashCommands"
>;

export type SessionProjectionState = Omit<
  AppState,
  | keyof SharedProjectionFields
  | "debugInfo"
  | "systemPrompt"
  | "loadedInstructions"
>;

export class ChatProjectionStateCache {
  private readonly bySession = new Map<string, SessionProjectionState>();

  save(state: AppState): void {
    const sessionId = state.chatState.sessionId;
    if (!sessionId) return;
    this.bySession.delete(sessionId);
    this.bySession.set(sessionId, toSessionProjection(state));
    while (this.bySession.size > MAX_CACHED_PROJECTIONS) {
      const oldest = this.bySession.keys().next().value;
      if (typeof oldest !== "string") break;
      this.bySession.delete(oldest);
    }
  }

  restore(sessionId: string | null, shared: SharedProjectionFields): AppState {
    const cached = sessionId ? this.bySession.get(sessionId) : undefined;
    if (!cached) {
      return {
        ...structuredClone(initialState),
        ...structuredClone(shared),
        chatState: {
          ...structuredClone(initialState.chatState),
          sessionId,
        },
      };
    }
    this.bySession.delete(sessionId!);
    this.bySession.set(sessionId!, cached);
    return {
      ...structuredClone(cached),
      ...structuredClone(shared),
      debugInfo: null,
      systemPrompt: null,
      loadedInstructions: null,
    };
  }

  retainSessions(sessionIds: ReadonlySet<string>): void {
    for (const sessionId of this.bySession.keys()) {
      if (!sessionIds.has(sessionId)) this.bySession.delete(sessionId);
    }
  }

  has(sessionId: string): boolean {
    return this.bySession.has(sessionId);
  }
}

function toSessionProjection(state: AppState): SessionProjectionState {
  const {
    modes: _modes,
    availableModels: _availableModels,
    slashCommands: _slashCommands,
    debugInfo: _debugInfo,
    systemPrompt: _systemPrompt,
    loadedInstructions: _loadedInstructions,
    ...sessionState
  } = state;
  return structuredClone(sessionState);
}
