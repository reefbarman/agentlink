import {
  initialState,
  reducer,
  shouldAcceptSessionChunk,
  type AppAction,
  type AppState,
} from "../shared/chatProjection.js";

type LoadSessionAction = Extract<AppAction, { type: "LOAD_SESSION" }>;
type ProjectedForegroundStoreListener = () => void;

export class ProjectedForegroundStore {
  private readonly emptyState: AppState = { ...initialState };
  private currentState: AppState = this.emptyState;
  private currentSessionId: string | null = null;
  private loadingSessionId: string | null = null;
  private streaming = false;
  private controllerEpoch: string | null = null;
  private readonly acceptedTranscriptRevisions = new Map<string, number>();
  private readonly listeners = new Set<ProjectedForegroundStoreListener>();

  get state(): AppState {
    return this.currentState;
  }

  get sessionId(): string | null {
    return this.currentSessionId;
  }

  get isStreaming(): boolean {
    return this.streaming;
  }

  onDidChange(listener: ProjectedForegroundStoreListener): { dispose(): void } {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  replaceState(state: AppState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    this.emitChange();
  }

  setSessionId(sessionId: string | null): void {
    if (this.currentSessionId === sessionId) return;
    this.currentSessionId = sessionId;
    this.emitChange();
  }

  setControllerEpoch(controllerEpoch: string | null): void {
    if (this.controllerEpoch === controllerEpoch) return;
    this.controllerEpoch = controllerEpoch;
    this.acceptedTranscriptRevisions.clear();
  }

  recordTranscriptRevision(sessionId: string, revision: number): void {
    const accepted = this.acceptedTranscriptRevisions.get(sessionId);
    this.acceptedTranscriptRevisions.set(
      sessionId,
      accepted === undefined ? revision : Math.max(accepted, revision),
    );
  }

  acceptSessionLoad(sessionId: string, revision: number | undefined): boolean {
    if (sessionId !== this.currentSessionId) return false;
    if (revision === undefined) return true;
    const accepted = this.acceptedTranscriptRevisions.get(sessionId);
    if (accepted !== undefined && revision <= accepted) return false;
    this.recordTranscriptRevision(sessionId, revision);
    return true;
  }

  apply(action: AppAction): void {
    const nextState = reducer(this.currentState, action);
    if (nextState === this.currentState) return;
    this.currentState = nextState;
    this.streaming = nextState.streaming;
    this.emitChange();
  }

  setStreaming(streaming: boolean): void {
    if (this.streaming === streaming) return;
    this.streaming = streaming;
    this.emitChange();
  }

  reset(): void {
    const changed =
      this.currentState !== this.emptyState ||
      this.currentSessionId !== null ||
      this.loadingSessionId !== null ||
      this.streaming;
    if (!changed) return;

    this.currentState = this.emptyState;
    this.currentSessionId = null;
    this.loadingSessionId = null;
    this.streaming = false;
    this.acceptedTranscriptRevisions.clear();
    this.emitChange();
  }

  hydrate(loadAction: LoadSessionAction, estimatedTotalUsed: number): void {
    const before = this.currentState;
    const beforeSessionId = this.currentSessionId;
    const beforeLoadingSessionId = this.loadingSessionId;
    const beforeStreaming = this.streaming;

    this.currentState = this.emptyState;
    this.currentSessionId = loadAction.sessionId;
    this.loadingSessionId = null;
    this.streaming = false;
    this.currentState = reducer(this.currentState, loadAction);
    this.streaming = this.currentState.streaming;
    this.currentState = reducer(this.currentState, {
      type: "TOKEN_ESTIMATE",
      estimatedTotalUsed,
    });

    if (
      this.currentState !== before ||
      this.currentSessionId !== beforeSessionId ||
      this.loadingSessionId !== beforeLoadingSessionId ||
      this.streaming !== beforeStreaming
    ) {
      this.emitChange();
    }
  }

  beginSessionLoad(
    sessionId: string,
    hasMoreBefore: boolean | undefined,
  ): void {
    const nextLoadingSessionId = hasMoreBefore === true ? sessionId : null;
    if (
      this.loadingSessionId === nextLoadingSessionId &&
      this.currentSessionId === sessionId
    ) {
      return;
    }
    this.loadingSessionId = nextLoadingSessionId;
    this.currentSessionId = sessionId;
    this.emitChange();
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

  private emitChange(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
