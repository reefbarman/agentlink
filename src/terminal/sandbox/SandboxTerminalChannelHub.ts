import type {
  SandboxTerminalChannelEvent,
  SandboxTerminalCoordinator,
} from "./SandboxTerminalCoordinator.js";

import type { SandboxTerminalSessionSnapshot } from "./SandboxTerminalSession.js";
import type { TerminalDimensions } from "../../core/terminalProtocol.js";

export interface SandboxTerminalChannelHubDisposable {
  dispose(): void;
}

export type SandboxTerminalChannelHubListener = (
  update: SandboxTerminalChannelEvent,
) => void;

interface CoordinatorRegistration {
  eventSubscription: SandboxTerminalChannelHubDisposable;
  disposeSubscription: SandboxTerminalChannelHubDisposable;
}

export interface SandboxTerminalChannelHubOptions {
  onAgentCommandStarted?(channelId: string): void;
  onCallbackError?(error: unknown): void;
}

export class SandboxTerminalChannelHub {
  private currentCoordinator: SandboxTerminalCoordinator | undefined;
  private readonly coordinators = new Map<
    SandboxTerminalCoordinator,
    CoordinatorRegistration
  >();
  private readonly channelOwners = new Map<
    string,
    SandboxTerminalCoordinator
  >();
  private readonly listeners = new Set<SandboxTerminalChannelHubListener>();
  private readonly snapshots = new Map<
    string,
    SandboxTerminalSessionSnapshot
  >();

  constructor(
    private readonly options: SandboxTerminalChannelHubOptions = {},
  ) {}

  attach(coordinator: SandboxTerminalCoordinator): void {
    this.currentCoordinator = coordinator;
    if (this.coordinators.has(coordinator)) return;

    for (const terminal of coordinator.listTerminals()) {
      const snapshot = coordinator.getChannelSnapshot(terminal.id);
      if (snapshot) this.setSnapshotOwner(coordinator, snapshot);
    }
    const eventSubscription = coordinator.onChannelEvent((update) => {
      if (update.snapshot.status === "closed") {
        if (this.channelOwners.get(update.snapshot.channelId) === coordinator) {
          this.channelOwners.delete(update.snapshot.channelId);
          this.snapshots.delete(update.snapshot.channelId);
        }
      } else {
        this.setSnapshotOwner(coordinator, update.snapshot);
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
    const disposeSubscription = coordinator.onDispose(() =>
      this.detach(coordinator),
    );
    this.coordinators.set(coordinator, {
      eventSubscription,
      disposeSubscription,
    });
  }

  detach(coordinator: SandboxTerminalCoordinator): void {
    const registration = this.coordinators.get(coordinator);
    if (!registration) return;
    registration.eventSubscription.dispose();
    registration.disposeSubscription.dispose();
    this.coordinators.delete(coordinator);
    if (this.currentCoordinator === coordinator) {
      this.currentCoordinator = undefined;
    }
    for (const [channelId, owner] of this.channelOwners) {
      if (owner !== coordinator) continue;
      this.channelOwners.delete(channelId);
      this.snapshots.delete(channelId);
    }
  }

  subscribe(
    listener: SandboxTerminalChannelHubListener,
  ): SandboxTerminalChannelHubDisposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
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
      this.channelOwners.get(channelId)?.interruptTerminal(channelId) ?? false
    );
  }

  close(channelId: string): boolean {
    return (
      (this.channelOwners.get(channelId)?.closeTerminals([channelId]).closed ??
        0) > 0
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
      command: input.command,
      cwd: input.cwd,
      terminal_id: input.channelId,
      sandboxSessionId: `terminal-user:${input.channelId}`,
      background: true,
    });
  }

  private setSnapshotOwner(
    coordinator: SandboxTerminalCoordinator,
    snapshot: SandboxTerminalSessionSnapshot,
  ): void {
    const existing = this.channelOwners.get(snapshot.channelId);
    if (existing && existing !== coordinator) {
      throw new Error(`Duplicate sandbox terminal ID: ${snapshot.channelId}`);
    }
    this.channelOwners.set(snapshot.channelId, coordinator);
    this.snapshots.set(snapshot.channelId, snapshot);
  }
}
