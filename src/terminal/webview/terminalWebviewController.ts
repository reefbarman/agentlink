import type {
  HostTerminalTab,
  TerminalDimensions,
} from "../../core/terminalProtocol.js";
import { randomId } from "../../shared/randomId.js";
import {
  MAX_TERMINAL_DIMENSION,
  TERMINAL_SURFACE_PROTOCOL_VERSION,
  type HostTerminalBlockBoundary,
  type HostTerminalFallbackState,
  type HostTerminalRenderBatch,
  type HostTerminalReplaySnapshot,
  type HostTerminalSurfaceAction,
  type HostTerminalSurfaceBlockPresentation,
  type HostTerminalSurfacePresentation,
  type TerminalSurfaceConfiguration,
  type TerminalSurfaceEvent,
  type TerminalSurfaceRequest,
} from "../terminalSurfaceProtocol.js";

export interface VsCodeApi {
  postMessage(message: unknown): void;
}

export interface TerminalRendererCallbacks {
  ariaLabel: string;
  onBlockAnchorDisposed(blockId: string): void;
  onData(data: string): void;
  onLink(url: string): void;
  onPaste(): void;
}

export interface TerminalRenderer {
  open(container: HTMLElement): void;
  write(data: string): Promise<void>;
  reset(): void;
  focus(): void;
  fit(): TerminalDimensions | undefined;
  findNext(term: string): boolean;
  findPrevious(term: string): boolean;
  clearSearch(): void;
  registerBlockBoundary(
    blockId: string,
    boundary: HostTerminalBlockBoundary,
  ): boolean;
  retainBlockAnchors(blockIds: ReadonlySet<string>): void;
  updateConfiguration(configuration: TerminalSurfaceConfiguration): void;
  dispose(): void;
}

export interface TerminalRendererFactory {
  create(
    configuration: TerminalSurfaceConfiguration,
    callbacks: TerminalRendererCallbacks,
  ): TerminalRenderer;
}

export interface ResizeObserverHandle {
  observe(target: Element): void;
  disconnect(): void;
}

export type CreateResizeObserver = (
  callback: () => void,
) => ResizeObserverHandle;

export interface TerminalTabView extends HostTerminalTab {
  terminalInstanceId: string;
}

export interface TerminalBlockView extends HostTerminalSurfaceBlockPresentation {
  kind: "raw" | "prompt" | "command" | "unknown";
  anchored: boolean;
}

export interface TerminalBlockStateView {
  mode: "raw" | "integrated";
  alternateScreen: boolean;
  terminalRunning: boolean;
  blocks: readonly TerminalBlockView[];
}

export interface TerminalConfirmationView {
  confirmationId: string;
  terminalId: string;
  terminalInstanceId: string;
  operation: "close" | "paste";
  title: string;
  message: string;
  confirmLabel: string;
}

export interface TerminalWebviewState {
  phase: "loading" | "ready";
  tabs: readonly TerminalTabView[];
  activeTabId?: string;
  fallback?: HostTerminalFallbackState;
  error?: string;
  creating: boolean;
  confirmation?: TerminalConfirmationView;
  blockStates: Readonly<Record<string, TerminalBlockStateView>>;
  rendererErrors: Readonly<Record<string, string>>;
  replayWarnings: Readonly<Record<string, string>>;
}

interface RendererEntry {
  terminalId: string;
  terminalInstanceId: string;
  renderer: TerminalRenderer;
  lastDimensions?: TerminalDimensions;
  lastSequence: number;
  container?: HTMLElement;
  opened: boolean;
  observer?: ResizeObserverHandle;
  blockMode: "raw" | "integrated";
  blockKinds: Map<string, TerminalBlockView["kind"]>;
  anchoredBlockIds: Set<string>;
  presentation: HostTerminalSurfacePresentation;
}

interface MessageHost {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
}

export interface TerminalWebviewControllerOptions {
  vscodeApi: VsCodeApi;
  rendererFactory: TerminalRendererFactory;
  createRequestId?: () => string;
  createResizeObserver?: CreateResizeObserver;
}

type TargetedTerminalRequest = Extract<
  TerminalSurfaceRequest,
  { terminalId: string }
>;
type TargetedTerminalRequestPayload =
  TargetedTerminalRequest extends infer Request
    ? Request extends TargetedTerminalRequest
      ? Omit<Request, "terminalId" | "terminalInstanceId" | "rendererEpoch">
      : never
    : never;

const DEFAULT_CONFIGURATION: TerminalSurfaceConfiguration = {
  scrollback: 1000,
};

const EMPTY_PRESENTATION: HostTerminalSurfacePresentation = {
  alternateScreen: false,
  terminalRunning: true,
  blocks: [],
};

function defaultResizeObserver(callback: () => void): ResizeObserverHandle {
  return new ResizeObserver(callback);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameDimensions(
  left: TerminalDimensions | undefined,
  right: TerminalDimensions,
): boolean {
  return left?.columns === right.columns && left.rows === right.rows;
}

function validDimensions(
  dimensions: TerminalDimensions | undefined,
): dimensions is TerminalDimensions {
  return (
    dimensions !== undefined &&
    Number.isInteger(dimensions.columns) &&
    dimensions.columns > 0 &&
    dimensions.columns <= MAX_TERMINAL_DIMENSION &&
    Number.isInteger(dimensions.rows) &&
    dimensions.rows > 0 &&
    dimensions.rows <= MAX_TERMINAL_DIMENSION
  );
}

function replayWarning(
  snapshot: HostTerminalReplaySnapshot,
): string | undefined {
  if (snapshot.replayPendingControl) {
    return "The retained terminal replay ended during a control sequence.";
  }
  if (snapshot.replayTruncated) {
    return `${snapshot.droppedBytes.toLocaleString()} bytes were omitted from the retained terminal output.`;
  }
  return undefined;
}

export class TerminalWebviewController {
  private state: TerminalWebviewState = {
    phase: "loading",
    tabs: [],
    creating: false,
    blockStates: {},
    rendererErrors: {},
    replayWarnings: {},
  };
  private configuration = DEFAULT_CONFIGURATION;
  private rendererEpoch: string | undefined;
  private readonly entries = new Map<string, RendererEntry>();
  private readonly listeners = new Set<(state: TerminalWebviewState) => void>();
  private readonly vscodeApi: VsCodeApi;
  private readonly rendererFactory: TerminalRendererFactory;
  private readonly createRequestId: () => string;
  private readonly createResizeObserver: CreateResizeObserver;
  private requestCounter = 0;
  private pendingCreateRequestId: string | undefined;
  private initialTerminalRequested = false;
  private resyncPending = false;
  private eventQueue: Promise<void> = Promise.resolve();
  private messageHost: MessageHost | undefined;
  private readonly messageListener = (event: MessageEvent<unknown>) => {
    void this.receive(event.data);
  };

  constructor(options: TerminalWebviewControllerOptions) {
    this.vscodeApi = options.vscodeApi;
    this.rendererFactory = options.rendererFactory;
    this.createRequestId = options.createRequestId ?? randomId;
    this.createResizeObserver =
      options.createResizeObserver ?? defaultResizeObserver;
  }

  getSnapshot(): TerminalWebviewState {
    return this.state;
  }

  subscribe(listener: (state: TerminalWebviewState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  mount(messageHost: MessageHost): () => void {
    if (this.messageHost) this.unmount();
    this.messageHost = messageHost;
    messageHost.addEventListener("message", this.messageListener);
    this.post({
      type: "terminal-view/ready",
      protocolVersion: TERMINAL_SURFACE_PROTOCOL_VERSION,
    });
    return () => this.unmount();
  }

  dispose(): void {
    this.unmount();
    for (const entry of this.entries.values()) this.disposeEntry(entry);
    this.entries.clear();
    this.listeners.clear();
  }

  receive(event: unknown): Promise<void> {
    this.eventQueue = this.eventQueue
      .then(() => this.applyEvent(event))
      .catch((error: unknown) => {
        this.patchState({ error: errorMessage(error), creating: false });
      });
    return this.eventQueue;
  }

  createTerminal(): string {
    this.requestCounter += 1;
    const requestId = `terminal-create-${this.requestCounter}-${this.createRequestId()}`;
    this.pendingCreateRequestId = requestId;
    this.patchState({ creating: true, error: undefined });
    this.post({ type: "host-terminal/create", requestId });
    return requestId;
  }

  selectTerminal(terminalId: string): void {
    const entry = this.entries.get(terminalId);
    if (!entry || terminalId === this.state.activeTabId) {
      if (entry) {
        this.fitEntry(entry);
        entry.renderer.focus();
      }
      return;
    }
    this.patchState({ activeTabId: terminalId });
    this.postTarget(entry, { type: "host-terminal/activate" });
    this.fitEntry(entry);
    entry.renderer.focus();
  }

  closeTerminal(terminalId: string): void {
    const entry = this.entries.get(terminalId);
    if (!entry) return;
    this.postTarget(entry, { type: "host-terminal/close-intent" });
  }

  pasteTerminal(terminalId: string): void {
    const entry = this.entries.get(terminalId);
    if (!entry) return;
    this.postTarget(entry, { type: "host-terminal/paste-intent" });
  }

  runBlockAction(
    terminalId: string,
    blockId: string,
    action: HostTerminalSurfaceAction,
  ): void {
    const entry = this.entries.get(terminalId);
    if (!entry || entry.presentation.alternateScreen) return;
    const block = entry.presentation.blocks.find(
      (candidate) => candidate.blockId === blockId,
    );
    if (
      !block ||
      block.decoration === "hidden" ||
      !block.actions.includes(action)
    ) {
      return;
    }
    this.postTarget(entry, { type: "terminal-view/action", blockId, action });
  }

  respondToConfirmation(accept: boolean): void {
    const confirmation = this.state.confirmation;
    if (!confirmation) return;
    const entry = this.matchingEntry(
      confirmation.terminalId,
      confirmation.terminalInstanceId,
    );
    this.patchState({ confirmation: undefined });
    if (!entry) return;
    this.postTarget(entry, {
      type: "terminal-view/confirm",
      confirmationId: confirmation.confirmationId,
      accept,
    });
  }

  attachContainer(terminalId: string, container: HTMLElement | null): void {
    const entry = this.entries.get(terminalId);
    if (!entry) return;
    if (!container) {
      entry.observer?.disconnect();
      entry.observer = undefined;
      entry.container = undefined;
      return;
    }
    if (entry.container === container) return;
    if (entry.opened) {
      this.setRendererError(
        terminalId,
        "The retained terminal container was replaced unexpectedly.",
      );
      return;
    }

    try {
      entry.renderer.open(container);
      entry.opened = true;
      entry.container = container;
      entry.observer = this.createResizeObserver(() => this.fitEntry(entry));
      entry.observer.observe(container);
      this.fitEntry(entry);
    } catch (error) {
      this.setRendererError(terminalId, errorMessage(error));
    }
  }

  focusActive(): void {
    const entry = this.activeEntry();
    if (!entry) return;
    this.fitEntry(entry);
    entry.renderer.focus();
  }

  findNext(term: string): boolean {
    const entry = this.activeEntry();
    return entry && term ? entry.renderer.findNext(term) : false;
  }

  findPrevious(term: string): boolean {
    const entry = this.activeEntry();
    return entry && term ? entry.renderer.findPrevious(term) : false;
  }

  clearSearch(): void {
    this.activeEntry()?.renderer.clearSearch();
  }

  openNativeFallback(): void {
    if (!this.rendererEpoch) return;
    this.post({
      type: "terminal-view/open-native-fallback",
      rendererEpoch: this.rendererEpoch,
    });
  }

  private unmount(): void {
    this.messageHost?.removeEventListener("message", this.messageListener);
    this.messageHost = undefined;
  }

  private async applyEvent(event: unknown): Promise<void> {
    if (!event || typeof event !== "object" || !("type" in event)) return;
    const message = event as TerminalSurfaceEvent;

    switch (message.type) {
      case "terminal-view/bootstrap":
        await this.applyBootstrap(message);
        return;
      case "terminal-view/config":
        this.applyConfiguration(message.configuration);
        return;
      case "terminal-view/resync-required":
        if (
          message.rendererEpoch === this.rendererEpoch &&
          !this.resyncPending
        ) {
          this.resyncPending = true;
          this.post({
            type: "terminal-view/resync",
            rendererEpoch: message.rendererEpoch,
          });
        }
        return;
      case "terminal-view/confirmation":
        if (
          this.matchingEntry(message.terminalId, message.terminalInstanceId)
        ) {
          this.patchState({ confirmation: message });
        }
        return;
      case "terminal-view/confirmation-cancelled":
        if (
          this.state.confirmation?.confirmationId === message.confirmationId
        ) {
          this.patchState({ confirmation: undefined });
        }
        return;
      case "terminal-view/fallback":
        this.patchState({ fallback: message.fallback });
        return;
      case "terminal-view/render-batch":
        await this.applyRenderBatch(message);
        return;
      case "host-terminal/opened":
        this.applyOpened(message.terminal, message.terminalInstanceId);
        return;
      case "host-terminal/data":
        // Renderable output arrives through ordered render batches. This lifecycle
        // delta is deliberately not written again.
        return;
      case "host-terminal/cwd":
        this.updateTab(
          message.terminalId,
          message.terminalInstanceId,
          (tab) => ({
            ...tab,
            cwd: message.cwd,
          }),
        );
        return;
      case "host-terminal/resized": {
        const entry = this.matchingEntry(
          message.terminalId,
          message.terminalInstanceId,
        );
        if (entry && validDimensions(message.dimensions)) {
          entry.lastDimensions = message.dimensions;
        }
        this.updateTab(
          message.terminalId,
          message.terminalInstanceId,
          (tab) => ({
            ...tab,
            dimensions: message.dimensions,
          }),
        );
        return;
      }
      case "host-terminal/activated":
        if (
          this.matchingEntry(message.terminalId, message.terminalInstanceId)
        ) {
          this.patchState({ activeTabId: message.terminalId });
        }
        return;
      case "host-terminal/exited": {
        const entry = this.matchingEntry(
          message.terminalId,
          message.terminalInstanceId,
        );
        if (entry) {
          entry.presentation = {
            ...entry.presentation,
            terminalRunning: false,
          };
        }
        this.updateTab(
          message.terminalId,
          message.terminalInstanceId,
          (tab) => ({
            ...tab,
            status: "exited",
            ...(message.exitCode === undefined
              ? {}
              : { exitCode: message.exitCode }),
            ...(message.signal === undefined ? {} : { signal: message.signal }),
          }),
        );
        if (entry) this.patchState({ blockStates: this.projectBlockStates() });
        return;
      }
      case "host-terminal/closed":
        this.applyClosed(message.terminalId, message.terminalInstanceId);
        return;
      case "host-terminal/error":
        if (
          message.requestId !== undefined &&
          message.requestId !== this.pendingCreateRequestId
        ) {
          return;
        }
        this.pendingCreateRequestId = undefined;
        this.patchState({ error: message.message, creating: false });
        return;
    }
  }

  private async applyBootstrap(
    message: Extract<TerminalSurfaceEvent, { type: "terminal-view/bootstrap" }>,
  ): Promise<void> {
    if (message.protocolVersion !== TERMINAL_SURFACE_PROTOCOL_VERSION) {
      throw new Error(
        `Unsupported terminal protocol version ${message.protocolVersion}.`,
      );
    }

    this.rendererEpoch = message.rendererEpoch;
    this.configuration = message.configuration;
    this.pendingCreateRequestId = undefined;
    const resetForResync = this.resyncPending;
    this.resyncPending = false;
    const replayByTerminalId = new Map(
      message.replay.map((snapshot) => [snapshot.terminalId, snapshot]),
    );
    const desiredIds = new Set(message.state.tabs.map((tab) => tab.id));
    for (const [terminalId, entry] of this.entries) {
      const replay = replayByTerminalId.get(terminalId);
      if (
        !desiredIds.has(terminalId) ||
        replay?.terminalInstanceId !== entry.terminalInstanceId
      ) {
        this.disposeEntry(entry);
        this.entries.delete(terminalId);
      }
    }

    const tabs: TerminalTabView[] = [];
    const replayTerminalIds = new Set<string>();
    const rendererErrors: Record<string, string> = {};
    const replayWarnings: Record<string, string> = {};
    for (const tab of message.state.tabs) {
      const replay = replayByTerminalId.get(tab.id);
      if (!replay) {
        rendererErrors[tab.id] = "No terminal replay identity was provided.";
        tabs.push({ ...tab, terminalInstanceId: "" });
        continue;
      }
      tabs.push({ ...tab, terminalInstanceId: replay.terminalInstanceId });
      const warning = replayWarning(replay);
      if (warning) replayWarnings[tab.id] = warning;
      let entry = this.entries.get(tab.id);
      if (!entry) {
        try {
          entry = this.createEntry(tab, replay.terminalInstanceId);
          this.entries.set(tab.id, entry);
          replayTerminalIds.add(tab.id);
        } catch (error) {
          rendererErrors[tab.id] = errorMessage(error);
        }
      } else {
        if (resetForResync) replayTerminalIds.add(tab.id);
        try {
          entry.renderer.updateConfiguration(message.configuration);
        } catch (error) {
          rendererErrors[tab.id] = errorMessage(error);
        }
      }
      if (entry) {
        entry.blockMode = replay.blocks.mode;
        entry.blockKinds = new Map(
          replay.blocks.blocks.map((block) => [block.id, block.kind]),
        );
        const retainedBlockIds = new Set(
          replay.presentation.blocks.map((block) => block.blockId),
        );
        entry.renderer.retainBlockAnchors(retainedBlockIds);
        for (const blockId of entry.anchoredBlockIds) {
          if (!retainedBlockIds.has(blockId)) {
            entry.anchoredBlockIds.delete(blockId);
          }
        }
        entry.presentation = replay.presentation;
        if (replayTerminalIds.has(tab.id)) entry.anchoredBlockIds.clear();
      }
    }

    this.state = {
      phase: "ready",
      tabs,
      activeTabId: message.state.activeTabId,
      fallback: message.fallback,
      creating: false,
      blockStates: this.projectBlockStates(),
      rendererErrors,
      replayWarnings,
    };
    this.emit();
    if (
      !this.initialTerminalRequested &&
      !resetForResync &&
      tabs.length === 0 &&
      !message.fallback
    ) {
      this.initialTerminalRequested = true;
      this.createTerminal();
    }

    for (const snapshot of message.replay) {
      const entry = this.matchingEntry(
        snapshot.terminalId,
        snapshot.terminalInstanceId,
      );
      if (!entry || !replayTerminalIds.has(snapshot.terminalId)) continue;
      entry.renderer.reset();
      if (snapshot.data) await entry.renderer.write(snapshot.data);
      entry.lastSequence = snapshot.sequence;
    }
  }

  private applyConfiguration(
    configuration: TerminalSurfaceConfiguration,
  ): void {
    this.configuration = configuration;
    for (const entry of this.entries.values()) {
      try {
        entry.renderer.updateConfiguration(configuration);
        this.fitEntry(entry);
      } catch (error) {
        this.setRendererError(entry.terminalId, errorMessage(error));
      }
    }
  }

  private async applyRenderBatch(
    batch: HostTerminalRenderBatch,
  ): Promise<void> {
    const entry = this.matchingEntry(
      batch.terminalId,
      batch.terminalInstanceId,
    );
    if (!entry || !this.rendererEpoch || this.resyncPending) return;

    if (batch.sequence > entry.lastSequence + 1) {
      if (!this.resyncPending) {
        this.resyncPending = true;
        this.post({
          type: "terminal-view/resync",
          rendererEpoch: this.rendererEpoch,
        });
      }
      return;
    }

    if (batch.sequence === entry.lastSequence + 1) {
      for (const operation of batch.operations) {
        if (operation.type === "write") {
          await entry.renderer.write(operation.data);
        } else if (operation.type === "block-boundary") {
          this.applyBlockBoundary(entry, operation.blockId, operation.boundary);
        } else if (operation.type === "alternate-screen") {
          entry.presentation = {
            ...entry.presentation,
            alternateScreen: operation.transition.type === "enter",
            blocks: entry.presentation.blocks.map((block) => ({
              ...block,
              ...(operation.transition.type === "enter"
                ? { decoration: "hidden" as const, actions: [] }
                : {}),
            })),
          };
        } else {
          this.applyPresentation(
            entry,
            operation.alternateScreen,
            operation.blocks,
          );
        }
      }
      entry.lastSequence = batch.sequence;
      this.patchState({ blockStates: this.projectBlockStates() });
      if (batch.replayTruncated || batch.replayPendingControl) {
        const warning = batch.replayPendingControl
          ? "Terminal output is waiting for a complete control sequence."
          : `${batch.droppedRenderBytes.toLocaleString()} bytes are outside the retained terminal replay.`;
        this.patchState({
          replayWarnings: {
            ...this.state.replayWarnings,
            [batch.terminalId]: warning,
          },
        });
      }
    }

    // Ack duplicates as well as newly rendered batches so a lost host-side ack
    // can recover without writing the same output twice.
    this.postTarget(entry, {
      type: "terminal-view/output-ack",
      sequence: batch.sequence,
    });
  }

  private applyOpened(tab: HostTerminalTab, terminalInstanceId: string): void {
    this.pendingCreateRequestId = undefined;
    const existing = this.entries.get(tab.id);
    if (existing?.terminalInstanceId !== terminalInstanceId) {
      if (existing) this.disposeEntry(existing);
      try {
        this.entries.set(tab.id, this.createEntry(tab, terminalInstanceId));
      } catch (error) {
        this.setRendererError(tab.id, errorMessage(error));
      }
    }

    const terminal: TerminalTabView = { ...tab, terminalInstanceId };
    const tabs = this.state.tabs.some((candidate) => candidate.id === tab.id)
      ? this.state.tabs.map((candidate) =>
          candidate.id === tab.id ? terminal : candidate,
        )
      : [...this.state.tabs, terminal];
    this.patchState({
      phase: "ready",
      tabs,
      activeTabId: tab.id,
      fallback: undefined,
      creating: false,
      error: undefined,
    });
  }

  private applyClosed(terminalId: string, terminalInstanceId: string): void {
    const entry = this.matchingEntry(terminalId, terminalInstanceId);
    if (!entry) return;
    this.disposeEntry(entry);
    this.entries.delete(terminalId);

    const index = this.state.tabs.findIndex((tab) => tab.id === terminalId);
    if (index < 0) return;
    const tabs = this.state.tabs.filter((tab) => tab.id !== terminalId);
    const activeTabId =
      this.state.activeTabId === terminalId
        ? tabs[Math.min(index, tabs.length - 1)]?.id
        : this.state.activeTabId;
    const rendererErrors = { ...this.state.rendererErrors };
    const replayWarnings = { ...this.state.replayWarnings };
    delete rendererErrors[terminalId];
    delete replayWarnings[terminalId];
    this.patchState({
      tabs,
      activeTabId,
      confirmation:
        this.state.confirmation?.terminalId === terminalId
          ? undefined
          : this.state.confirmation,
      rendererErrors,
      replayWarnings,
      blockStates: this.projectBlockStates(),
    });
  }

  private createEntry(
    tab: HostTerminalTab,
    terminalInstanceId: string,
  ): RendererEntry {
    let entry: RendererEntry;
    const renderer = this.rendererFactory.create(this.configuration, {
      ariaLabel: `${tab.title} terminal`,
      onData: (data) => {
        if (!data) return;
        this.postTarget(entry, { type: "host-terminal/write", data });
      },
      onLink: (url) => {
        if (!url || !this.rendererEpoch) return;
        this.post({
          type: "terminal-view/open-link",
          rendererEpoch: this.rendererEpoch,
          url,
        });
      },
      onPaste: () =>
        this.postTarget(entry, { type: "host-terminal/paste-intent" }),
      onBlockAnchorDisposed: (blockId) => {
        if (!entry.anchoredBlockIds.delete(blockId)) return;
        if (this.entries.get(entry.terminalId) === entry) {
          this.patchState({ blockStates: this.projectBlockStates() });
        }
      },
    });
    entry = {
      terminalId: tab.id,
      terminalInstanceId,
      renderer,
      lastDimensions: validDimensions(tab.dimensions)
        ? tab.dimensions
        : undefined,
      lastSequence: -1,
      opened: false,
      blockMode: "raw",
      blockKinds: new Map(),
      anchoredBlockIds: new Set(),
      presentation: EMPTY_PRESENTATION,
    };
    return entry;
  }

  private applyPresentation(
    entry: RendererEntry,
    alternateScreen: boolean,
    blocks: readonly HostTerminalSurfaceBlockPresentation[],
  ): void {
    const retainedIds = new Set(blocks.map((block) => block.blockId));
    entry.renderer.retainBlockAnchors(retainedIds);
    for (const blockId of entry.blockKinds.keys()) {
      if (!retainedIds.has(blockId)) entry.blockKinds.delete(blockId);
    }
    for (const blockId of entry.anchoredBlockIds) {
      if (!retainedIds.has(blockId)) entry.anchoredBlockIds.delete(blockId);
    }
    entry.presentation = {
      ...entry.presentation,
      alternateScreen,
      blocks,
    };
  }

  private applyBlockBoundary(
    entry: RendererEntry,
    blockId: string,
    boundary: HostTerminalBlockBoundary,
  ): void {
    entry.blockMode = "integrated";
    entry.blockKinds.set(
      blockId,
      boundary.startsWith("prompt") ? "prompt" : "command",
    );
    if (
      (boundary === "prompt-start" || boundary === "command-start") &&
      entry.renderer.registerBlockBoundary(blockId, boundary)
    ) {
      entry.anchoredBlockIds.add(blockId);
    }
  }

  private projectBlockStates(): Record<string, TerminalBlockStateView> {
    const blockStates: Record<string, TerminalBlockStateView> = {};
    for (const entry of this.entries.values()) {
      blockStates[entry.terminalId] = {
        mode: entry.blockMode,
        alternateScreen: entry.presentation.alternateScreen,
        terminalRunning: entry.presentation.terminalRunning,
        blocks: entry.presentation.blocks.map((block) => ({
          ...block,
          kind:
            entry.blockKinds.get(block.blockId) ??
            (entry.blockMode === "raw" ? "raw" : "unknown"),
          anchored: entry.anchoredBlockIds.has(block.blockId),
        })),
      };
    }
    return blockStates;
  }

  private disposeEntry(entry: RendererEntry): void {
    entry.observer?.disconnect();
    entry.renderer.dispose();
  }

  private matchingEntry(
    terminalId: string,
    terminalInstanceId: string,
  ): RendererEntry | undefined {
    const entry = this.entries.get(terminalId);
    return entry?.terminalInstanceId === terminalInstanceId ? entry : undefined;
  }

  private activeEntry(): RendererEntry | undefined {
    return this.state.activeTabId
      ? this.entries.get(this.state.activeTabId)
      : undefined;
  }

  private fitEntry(entry: RendererEntry): void {
    if (!entry.opened || !entry.container || !this.rendererEpoch) return;
    try {
      const dimensions = entry.renderer.fit();
      if (
        !validDimensions(dimensions) ||
        sameDimensions(entry.lastDimensions, dimensions)
      ) {
        return;
      }
      entry.lastDimensions = dimensions;
      this.postTarget(entry, {
        type: "host-terminal/resize",
        dimensions,
      });
    } catch (error) {
      this.setRendererError(entry.terminalId, errorMessage(error));
    }
  }

  private updateTab(
    terminalId: string,
    terminalInstanceId: string,
    update: (tab: TerminalTabView) => TerminalTabView,
  ): void {
    if (!this.matchingEntry(terminalId, terminalInstanceId)) return;
    let changed = false;
    const tabs = this.state.tabs.map((tab) => {
      if (
        tab.id !== terminalId ||
        tab.terminalInstanceId !== terminalInstanceId
      ) {
        return tab;
      }
      changed = true;
      return update(tab);
    });
    if (changed) this.patchState({ tabs });
  }

  private postTarget(
    entry: RendererEntry,
    request: TargetedTerminalRequestPayload,
  ): void {
    if (!this.rendererEpoch) return;
    this.post({
      ...request,
      terminalId: entry.terminalId,
      terminalInstanceId: entry.terminalInstanceId,
      rendererEpoch: this.rendererEpoch,
    } as TerminalSurfaceRequest);
  }

  private post(message: TerminalSurfaceRequest): void {
    this.vscodeApi.postMessage(message);
  }

  private setRendererError(terminalId: string, message: string): void {
    this.patchState({
      rendererErrors: {
        ...this.state.rendererErrors,
        [terminalId]: message,
      },
    });
  }

  private patchState(patch: Partial<TerminalWebviewState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.state);
  }
}
