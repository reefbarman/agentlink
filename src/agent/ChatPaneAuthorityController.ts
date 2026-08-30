import type {
  ChatPaneLease,
  ChatPaneSurface,
} from "@agentlink/protocol/chat-pane-transport";

export type {
  ChatPaneLease,
  ChatPaneSurface,
} from "@agentlink/protocol/chat-pane-transport";

export interface ChatPaneAuthoritySnapshot {
  active: ChatPaneLease | null;
  pending: ChatPaneLease | null;
}

export type ChatPaneTransitionResult =
  | { ok: true; lease: ChatPaneLease }
  | { ok: false; reason: "unknown_tab" | "handoff_in_progress" };

export interface ChatPaneAuthorityControllerOptions {
  isKnownTab(tabId: string): boolean;
}

interface TabAuthorityState {
  nextEpoch: number;
  active?: ChatPaneLease;
  pending?: ChatPaneLease;
}

export class ChatPaneAuthorityController {
  private readonly states = new Map<string, TabAuthorityState>();
  private readonly nextEpochByTab = new Map<string, number>();

  constructor(private readonly options: ChatPaneAuthorityControllerOptions) {}

  adoptSidebar(tabId: string): ChatPaneTransitionResult {
    if (!this.options.isKnownTab(tabId)) {
      return { ok: false, reason: "unknown_tab" };
    }
    const state = this.getOrCreateState(tabId);
    if (state.active?.surface === "sidebar" && !state.pending) {
      return { ok: true, lease: cloneLease(state.active) };
    }
    if (state.active || state.pending) {
      return { ok: false, reason: "handoff_in_progress" };
    }
    const lease = this.createLease(tabId, "sidebar", state);
    state.active = lease;
    return { ok: true, lease: cloneLease(lease) };
  }

  prepare(tabId: string, surface: ChatPaneSurface): ChatPaneTransitionResult {
    if (!this.options.isKnownTab(tabId)) {
      return { ok: false, reason: "unknown_tab" };
    }
    const state = this.getOrCreateState(tabId);
    if (state.pending?.surface === surface) {
      return { ok: true, lease: cloneLease(state.pending) };
    }
    if (state.pending) {
      return { ok: false, reason: "handoff_in_progress" };
    }
    const lease = this.createLease(tabId, surface, state);
    state.pending = lease;
    return { ok: true, lease: cloneLease(lease) };
  }

  activate(lease: ChatPaneLease): {
    ok: boolean;
    previous: ChatPaneLease | null;
  } {
    const state = this.states.get(lease.tabId);
    if (!state) return { ok: false, previous: null };
    if (sameLease(state.active, lease)) {
      return { ok: true, previous: cloneLease(state.active!) };
    }
    if (!sameLease(state.pending, lease)) {
      return { ok: false, previous: null };
    }
    const previous = state.active ? cloneLease(state.active) : null;
    state.active = state.pending;
    state.pending = undefined;
    return { ok: true, previous };
  }

  cancel(lease: ChatPaneLease): boolean {
    const state = this.states.get(lease.tabId);
    if (!state || !sameLease(state.pending, lease)) return false;
    state.pending = undefined;
    return true;
  }

  rollbackActivation(
    lease: ChatPaneLease,
    previous: ChatPaneLease | null,
  ): boolean {
    const state = this.states.get(lease.tabId);
    if (!state || state.pending || !sameLease(state.active, lease))
      return false;
    state.active = previous ? cloneLease(previous) : undefined;
    return true;
  }

  revoke(lease: ChatPaneLease): boolean {
    const state = this.states.get(lease.tabId);
    if (!state) return false;
    if (sameLease(state.pending, lease)) {
      state.pending = undefined;
      return true;
    }
    if (sameLease(state.active, lease)) {
      state.active = undefined;
      return true;
    }
    return false;
  }

  isAuthoritative(lease: ChatPaneLease): boolean {
    return sameLease(this.states.get(lease.tabId)?.active, lease);
  }

  getAuthority(tabId: string): ChatPaneAuthoritySnapshot {
    const state = this.states.get(tabId);
    return {
      active: state?.active ? cloneLease(state.active) : null,
      pending: state?.pending ? cloneLease(state.pending) : null,
    };
  }

  releaseTab(tabId: string): void {
    this.states.delete(tabId);
  }

  dispose(): void {
    this.states.clear();
  }

  private getOrCreateState(tabId: string): TabAuthorityState {
    const existing = this.states.get(tabId);
    if (existing) return existing;
    const state: TabAuthorityState = {
      nextEpoch: this.nextEpochByTab.get(tabId) ?? 1,
    };
    this.states.set(tabId, state);
    return state;
  }

  private createLease(
    tabId: string,
    surface: ChatPaneSurface,
    state: TabAuthorityState,
  ): ChatPaneLease {
    const lease = { tabId, surface, epoch: state.nextEpoch };
    state.nextEpoch += 1;
    this.nextEpochByTab.set(tabId, state.nextEpoch);
    return lease;
  }
}

function sameLease(
  left: ChatPaneLease | undefined,
  right: ChatPaneLease | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.tabId === right.tabId &&
    left.surface === right.surface &&
    left.epoch === right.epoch
  );
}

function cloneLease(lease: ChatPaneLease): ChatPaneLease {
  return { ...lease };
}
