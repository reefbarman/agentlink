import type {
  SandboxTerminalChannelEvent,
  SandboxTerminalCoordinator,
} from "./SandboxTerminalCoordinator.js";

import type { SandboxTerminalSessionSnapshot } from "./SandboxTerminalSession.js";
import type { TerminalDimensions } from "../../core/terminalProtocol.js";
import type { TerminalExecuteOptions } from "../../core/capabilities/terminal.js";

export interface SandboxTerminalChannelHubDisposable {
  dispose(): void;
}

export type SandboxTerminalChannelHubListener = (
  update: SandboxTerminalChannelEvent,
) => void;

export interface AgentTerminalRawDataEvent {
  channelId: string;
  data: string;
}

export type AgentTerminalChannelAuthority = "sandbox" | "native";

interface RawDataTerminalChannelCoordinator {
  onRawData(
    listener: (update: AgentTerminalRawDataEvent) => void,
  ): SandboxTerminalChannelHubDisposable;
}

interface TerminalChannelCoordinator {
  listTerminals(request: { owner: undefined }): Array<{ id: string }>;
  getChannelSnapshot(
    channelId: string,
  ): SandboxTerminalSessionSnapshot | undefined;
  onChannelEvent(
    listener: (update: SandboxTerminalChannelEvent) => void,
  ): SandboxTerminalChannelHubDisposable;
  onDispose(listener: () => void): SandboxTerminalChannelHubDisposable;
  write(channelId: string, data: string): boolean;
  resize(channelId: string, dimensions: TerminalDimensions): boolean;
  interruptTerminal(request: { owner: undefined; terminalId: string }): boolean;
  closeTerminals(request: { owner: undefined; names?: string[] }): {
    closed: number;
  };
  executeCommand(options: TerminalExecuteOptions): Promise<unknown>;
}

interface CoordinatorRegistration {
  eventSubscription: SandboxTerminalChannelHubDisposable;
  rawDataSubscription?: SandboxTerminalChannelHubDisposable;
  disposeSubscription: SandboxTerminalChannelHubDisposable;
}

export interface SandboxTerminalChannelHubOptions {
  onAgentCommandStarted?(channelId: string): void;
  onCallbackError?(error: unknown): void;
}

export class SandboxTerminalChannelHub {
  private currentCoordinator: TerminalChannelCoordinator | undefined;
  private readonly coordinators = new Map<
    TerminalChannelCoordinator,
    CoordinatorRegistration
  >();
  private readonly channelOwners = new Map<
    string,
    TerminalChannelCoordinator
  >();
  private readonly channelAuthorities = new Map<
    string,
    AgentTerminalChannelAuthority
  >();
  private readonly listeners = new Set<SandboxTerminalChannelHubListener>();
  private readonly rawDataListeners = new Set<
    (update: AgentTerminalRawDataEvent) => void
  >();
  private readonly snapshots = new Map<
    string,
    SandboxTerminalSessionSnapshot
  >();

  constructor(
    private readonly options: SandboxTerminalChannelHubOptions = {},
  ) {}

  attach(
    coordinator: SandboxTerminalCoordinator | TerminalChannelCoordinator,
    authority: AgentTerminalChannelAuthority = "sandbox",
  ): void {
    this.currentCoordinator = coordinator;
    if (this.coordinators.has(coordinator)) return;

    for (const terminal of coordinator.listTerminals({ owner: undefined })) {
      const snapshot = coordinator.getChannelSnapshot(terminal.id);
      if (snapshot) this.setSnapshotOwner(coordinator, snapshot, authority);
    }
    const eventSubscription = coordinator.onChannelEvent((update) => {
      if (update.snapshot.status === "closed") {
        if (this.channelOwners.get(update.snapshot.channelId) === coordinator) {
          this.channelOwners.delete(update.snapshot.channelId);
          this.channelAuthorities.delete(update.snapshot.channelId);
          this.snapshots.delete(update.snapshot.channelId);
        }
      } else {
        this.setSnapshotOwner(coordinator, update.snapshot, authority);
      }
      if (
        update.event.type === "command-started" &&
        update.event.command.origin === "agent"
      ) {
        try {
          this.options.onAgentCommandStarted?.(update.snapshot.channelId);
        } catch (error) {
          this.options.onCallbackError?.(error);
        }
      }
      for (const listener of this.listeners) listener(update);
    });
    const rawDataSubscription = this.isRawDataCoordinator(coordinator)
      ? coordinator.onRawData((update) => {
          const snapshot = coordinator.getChannelSnapshot(update.channelId);
          if (snapshot) this.setSnapshotOwner(coordinator, snapshot, authority);
          for (const listener of this.rawDataListeners) listener(update);
        })
      : undefined;
    const disposeSubscription = coordinator.onDispose(() =>
      this.detach(coordinator),
    );
    this.coordinators.set(coordinator, {
      eventSubscription,
      ...(rawDataSubscription ? { rawDataSubscription } : {}),
      disposeSubscription,
    });
  }

  detach(coordinator: TerminalChannelCoordinator): void {
    const registration = this.coordinators.get(coordinator);
    if (!registration) return;
    registration.eventSubscription.dispose();
    registration.rawDataSubscription?.dispose();
    registration.disposeSubscription.dispose();
    this.coordinators.delete(coordinator);
    if (this.currentCoordinator === coordinator) {
      this.currentCoordinator = undefined;
    }
    for (const [channelId, owner] of this.channelOwners) {
      if (owner !== coordinator) continue;
      this.channelOwners.delete(channelId);
      this.channelAuthorities.delete(channelId);
      this.snapshots.delete(channelId);
    }
  }

  subscribe(
    listener: SandboxTerminalChannelHubListener,
  ): SandboxTerminalChannelHubDisposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  subscribeRawData(
    listener: (update: AgentTerminalRawDataEvent) => void,
  ): SandboxTerminalChannelHubDisposable {
    this.rawDataListeners.add(listener);
    return { dispose: () => this.rawDataListeners.delete(listener) };
  }

  listSnapshots(): SandboxTerminalSessionSnapshot[] {
    return [...this.snapshots.values()].map((snapshot) =>
      structuredClone(snapshot),
    );
  }

  getSnapshot(channelId: string): SandboxTerminalSessionSnapshot | undefined {
    const snapshot = this.snapshots.get(channelId);
    return snapshot ? structuredClone(snapshot) : undefined;
  }

  getAuthority(channelId: string): AgentTerminalChannelAuthority | undefined {
    return this.channelAuthorities.get(channelId);
  }

  write(channelId: string, data: string): boolean {
    return this.channelOwners.get(channelId)?.write(channelId, data) ?? false;
  }

  resize(channelId: string, dimensions: TerminalDimensions): boolean {
    return (
      this.channelOwners.get(channelId)?.resize(channelId, dimensions) ?? false
    );
  }

  interrupt(channelId: string): boolean {
    return (
      this.channelOwners.get(channelId)?.interruptTerminal({
        owner: undefined,
        terminalId: channelId,
      }) ?? false
    );
  }

  close(channelId: string): boolean {
    return (
      (this.channelOwners.get(channelId)?.closeTerminals({
        owner: undefined,
        names: [channelId],
      }).closed ?? 0) > 0
    );
  }

  async executeUserCommand(input: {
    channelId: string;
    command: string;
    cwd: string;
  }): Promise<void> {
    const coordinator = this.channelOwners.get(input.channelId);
    if (!coordinator) {
      throw new Error("The AgentLink sandbox terminal is unavailable");
    }
    await coordinator.executeCommand({
      owner: undefined,
      command: input.command,
      cwd: input.cwd,
      terminal_id: input.channelId,
      sandboxSessionId: `terminal-user:${input.channelId}`,
      background: true,
    });
  }

  private isRawDataCoordinator(
    coordinator: TerminalChannelCoordinator,
  ): coordinator is TerminalChannelCoordinator &
    RawDataTerminalChannelCoordinator {
    return (
      "onRawData" in coordinator && typeof coordinator.onRawData === "function"
    );
  }

  private setSnapshotOwner(
    coordinator: TerminalChannelCoordinator,
    snapshot: SandboxTerminalSessionSnapshot,
    authority: AgentTerminalChannelAuthority,
  ): void {
    const existing = this.channelOwners.get(snapshot.channelId);
    if (existing && existing !== coordinator) {
      throw new Error(`Duplicate sandbox terminal ID: ${snapshot.channelId}`);
    }
    this.channelOwners.set(snapshot.channelId, coordinator);
    this.channelAuthorities.set(snapshot.channelId, authority);
    this.snapshots.set(snapshot.channelId, snapshot);
  }
}
