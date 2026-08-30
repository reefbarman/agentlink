export interface AutoContinueTabState {
  enabled: boolean;
  status: string;
  sessionId: string | null;
  mode?: string | null;
  reasoningEffort?: string | null;
  continuedMessageIds: Set<string>;
  count: number;
  pendingUserMessageId: string | null;
}

export function createAutoContinueTabState(
  sessionId: string | null = null,
): AutoContinueTabState {
  return {
    enabled: false,
    status: "",
    sessionId,
    continuedMessageIds: new Set(),
    count: 0,
    pendingUserMessageId: null,
  };
}

export class AutoContinueTabStateCache {
  private readonly states = new Map<string, AutoContinueTabState>();

  save(key: string | null, state: AutoContinueTabState): void {
    if (!key) return;
    this.states.set(key, {
      ...state,
      continuedMessageIds: new Set(state.continuedMessageIds),
    });
  }

  get(key: string | null): AutoContinueTabState | undefined {
    if (!key) return undefined;
    const state = this.states.get(key);
    return state
      ? { ...state, continuedMessageIds: new Set(state.continuedMessageIds) }
      : undefined;
  }

  restore(key: string | null, sessionId: string | null): AutoContinueTabState {
    const state = key ? this.states.get(key) : undefined;
    if (!state) return createAutoContinueTabState(sessionId);
    if (state.sessionId !== sessionId) {
      return {
        ...state,
        status: state.enabled ? "" : state.status,
        sessionId,
        mode: null,
        reasoningEffort: null,
        continuedMessageIds: new Set(),
        count: 0,
        pendingUserMessageId: null,
      };
    }
    return {
      ...state,
      continuedMessageIds: new Set(state.continuedMessageIds),
    };
  }

  clear(): void {
    this.states.clear();
  }
}
