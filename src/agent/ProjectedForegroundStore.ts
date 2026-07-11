import {
  initialState,
  reducer,
  shouldAcceptSessionChunk,
  type AppAction,
  type AppState,
} from "../shared/chatProjection.js";

type LoadSessionAction = Extract<AppAction, { type: "LOAD_SESSION" }>;

export class ProjectedForegroundStore {
  private currentState: AppState = { ...initialState };
  private currentSessionId: string | null = null;
  private loadingSessionId: string | null = null;
  private streaming = false;

  get state(): AppState {
    return this.currentState;
  }

  get sessionId(): string | null {
    return this.currentSessionId;
  }

  get isStreaming(): boolean {
    return this.streaming;
  }

  replaceState(state: AppState): void {
    this.currentState = state;
  }

  setSessionId(sessionId: string | null): void {
    this.currentSessionId = sessionId;
  }

  apply(action: AppAction): void {
    this.currentState = reducer(this.currentState, action);
    this.streaming = this.currentState.streaming;
  }

  setStreaming(streaming: boolean): void {
    this.streaming = streaming;
  }

  reset(): void {
    this.currentState = { ...initialState };
    this.currentSessionId = null;
    this.loadingSessionId = null;
    this.streaming = false;
  }

  hydrate(loadAction: LoadSessionAction, estimatedTotalUsed: number): void {
    this.reset();
    this.currentSessionId = loadAction.sessionId;
    this.apply(loadAction);
    this.apply({ type: "TOKEN_ESTIMATE", estimatedTotalUsed });
  }

  beginSessionLoad(
    sessionId: string,
    hasMoreBefore: boolean | undefined,
  ): void {
    this.loadingSessionId = hasMoreBefore === true ? sessionId : null;
    this.currentSessionId = sessionId;
  }

  acceptSessionChunk(
    sessionId: string,
    hasMoreBefore: boolean | undefined,
  ): boolean {
    if (
      !shouldAcceptSessionChunk(
        sessionId,
        this.currentSessionId,
        this.loadingSessionId,
      )
    ) {
      return false;
    }
    if (hasMoreBefore !== true) {
      this.loadingSessionId = null;
    }
    return true;
  }
}
