import { Buffer } from "node:buffer";
import { mkdir } from "node:fs/promises";
import { basename } from "node:path";

import {
  EMPTY_HOST_TERMINAL_STATE,
  reduceHostTerminalState,
  type HostTerminalEvent,
  type HostTerminalState,
  type TerminalDimensions,
} from "../core/terminalProtocol.js";
import type { CustomTerminalHost } from "./customTerminalSupport.js";
import {
  loadNodePtyForHostShellPlan,
  type NodePtyModuleLoader,
} from "./deferredNodePtyLoader.js";
import {
  materializeHostShellBootstrap,
  type MaterializedHostShellBootstrap,
} from "./hostShellBootstrap.js";
import { HostTerminalRuntime } from "./HostTerminalRuntime.js";
import type {
  HostTerminalSurfaceConnection,
  HostTerminalSurfaceController,
} from "./HostTerminalSurfaceController.js";
import { createNodePtyFactory } from "./nodePtyFactory.js";
import { prepareHostShellBootstrap } from "./prepareHostShellBootstrap.js";
import {
  createRawShellIntegrationParser,
  createShellIntegrationParser,
} from "./shellIntegration.js";
import {
  TerminalDataCoalescer,
  type TerminalDataCoalescerOptions,
} from "./TerminalDataCoalescer.js";
import {
  TerminalSessionService,
  type HostPtyDisposable,
} from "./TerminalSessionService.js";
import {
  TERMINAL_SURFACE_PROTOCOL_VERSION,
  type HostTerminalFallbackState,
  MAX_TERMINAL_PASTE_BYTES,
  type HostTerminalRenderBatch,
  type TerminalSurfaceConfiguration,
  type TerminalSurfaceEvent,
  type TerminalSurfaceRequest,
} from "./terminalSurfaceProtocol.js";
import { SandboxTerminalChannelHub } from "./sandbox/SandboxTerminalChannelHub.js";
import { SandboxTerminalIdleEditor } from "./sandbox/SandboxTerminalIdleEditor.js";
import type { SandboxTerminalChannelEvent } from "./sandbox/SandboxTerminalCoordinator.js";
import type { SandboxTerminalSessionSnapshot } from "./sandbox/SandboxTerminalSession.js";
import type { VscodeTerminalConfigurationSnapshot } from "./vscodeTerminalProfileAdapter.js";

interface PendingTerminalConfirmation {
  confirmationId: string;
  terminalId: string;
  terminalInstanceId: string;
  rendererEpoch: string;
  operation: "close" | "paste";
  targetKind: "host" | "native-agent";
  interactionStateKey: string;
  pasteData?: string;
  bracketedPasteMode?: boolean;
}

interface ManagedSurfaceTerminal {
  terminalId: string;
  terminalInstanceId: string;
  service: TerminalSessionService;
  serviceSubscription: HostPtyDisposable;
  runtime: HostTerminalRuntime;
  bootstrap: MaterializedHostShellBootstrap;
  deliveryQueue: Promise<void>;
  cleaned: boolean;
  renderPaused: boolean;
  resyncRequested: boolean;
  pending: PendingRenderQueue;
}

/**
 * Ceilings for output held back while the renderer catches up. A renderer that
 * keeps acknowledging drains this queue and never resyncs; one that stops
 * acknowledging entirely (throttled or occluded webview) overflows it and falls
 * back to a replay-based resync.
 */
const MAX_QUEUED_RENDER_BYTES = 4 * 1024 * 1024;
const MAX_QUEUED_RENDER_BATCHES = 1024;
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

interface PendingRenderQueue {
  batches: HostTerminalRenderBatch[];
  byteLength: number;
}

interface ManagedSandboxSurfaceTerminal {
  terminalId: string;
  terminalInstanceId: string;
  runtime: HostTerminalRuntime;
  editor: SandboxTerminalIdleEditor;
  deliveryQueue: Promise<void>;
  snapshot: SandboxTerminalSessionSnapshot;
  submitting: boolean;
  renderDeliveryGeneration: number;
  renderPaused: boolean;
  resyncRequested: boolean;
  pending: PendingRenderQueue;
}

function createPendingRenderQueue(): PendingRenderQueue {
  return { batches: [], byteLength: 0 };
}

function renderBatchWriteBytes(batch: HostTerminalRenderBatch): number {
  let bytes = 0;
  for (const operation of batch.operations) {
    if (operation.type === "write") {
      bytes += Buffer.byteLength(operation.data, "utf8");
    }
  }
  return bytes;
}

export interface LiveHostTerminalSurfaceControllerOptions {
  host: CustomTerminalHost;
  runtimeRoot: string;
  nodePtyLoader: NodePtyModuleLoader;
  getConfigurationSnapshot(request: {
    cwd?: string;
    profileName?: string;
  }): VscodeTerminalConfigurationSnapshot;
  getSurfaceConfiguration(): TerminalSurfaceConfiguration;
  isAcceptingRequests(): boolean;
  createId(): string;
  openExternal?(url: string): PromiseLike<unknown> | unknown;
  openNativeTerminal?(fallback: HostTerminalFallbackState): void;
  readClipboard?(): PromiseLike<string> | string;
  writeClipboard?(text: string): PromiseLike<unknown> | unknown;
  runtimeWatermarks?: {
    high: number;
    low: number;
  };
  /** Ceilings for output held back while the renderer catches up. */
  renderQueueLimits?: {
    maxBytes: number;
    maxBatches: number;
  };
  /** Tuning for PTY output coalescing; tests pass `flushDelayMs: 0` for
   * synchronous delivery or an explicit scheduler to control flush timing. */
  dataCoalescing?: Omit<TerminalDataCoalescerOptions, "onFlush">;
  ensureRuntimeRoot?(): Promise<void>;
  materializeBootstrap?: typeof materializeHostShellBootstrap;
  sandboxChannelHub?: SandboxTerminalChannelHub;
  requestTerminalViewReveal?(): void;
  log?(message: string): void;
}

const INITIAL_DIMENSIONS: TerminalDimensions = { columns: 80, rows: 24 };
const FALLBACK_REASONS = new Set<HostTerminalFallbackState["reason"]>([
  "host-unsupported",
  "native-shell-required",
  "shell-unsupported",
  "terminal-configuration-unsafe",
  "workspace-untrusted",
  "unsupported-bash-arguments",
  "unsupported-zsh-arguments",
]);

function fallbackReason(reason: string): HostTerminalFallbackState["reason"] {
  return FALLBACK_REASONS.has(reason as HostTerminalFallbackState["reason"])
    ? (reason as HostTerminalFallbackState["reason"])
    : "shell-unsupported";
}

type TerminalPasteDecision =
  | { action: "paste"; data: string }
  | { action: "confirm"; data: string };

export function decideTerminalPaste(
  data: string,
  warning: "auto" | "always" | "never",
  bracketedPasteMode: boolean,
): TerminalPasteDecision {
  const lines = data.split(/\r?\n/);
  if (lines.length === 1 || warning === "never") {
    return { action: "paste", data };
  }
  if (warning === "auto") {
    if (bracketedPasteMode) return { action: "paste", data };
    if (lines.length === 2 && lines[1].trim().length === 0) {
      return { action: "paste", data: lines[0] };
    }
  }
  return { action: "confirm", data };
}

function prepareTerminalPaste(
  data: string,
  bracketedPasteMode: boolean,
): string {
  const normalized = data.replace(/\r?\n/g, "\r");
  return bracketedPasteMode
    ? `${BRACKETED_PASTE_START}${normalized}${BRACKETED_PASTE_END}`
    : normalized;
}

export class LiveHostTerminalSurfaceController implements HostTerminalSurfaceController {
  private readonly connections = new Set<HostTerminalSurfaceConnection>();
  private readonly readyConnections = new Set<HostTerminalSurfaceConnection>();
  private readonly terminals = new Map<string, ManagedSurfaceTerminal>();
  private readonly sandboxTerminals = new Map<
    string,
    ManagedSandboxSurfaceTerminal
  >();
  private readonly sandboxSubscription: { dispose(): void } | undefined;
  private readonly agentRawDataSubscription: { dispose(): void } | undefined;
  private readonly dataCoalescer: TerminalDataCoalescer;
  private readonly pendingConfirmations = new Map<
    string,
    PendingTerminalConfirmation
  >();
  private readonly interactionGenerations = new Map<string, number>();
  private nextConnectionGeneration = 1;
  private state: HostTerminalState = EMPTY_HOST_TERMINAL_STATE;
  private terminalViewFocused = false;
  private fallback: HostTerminalFallbackState | undefined;
  private disposed = false;

  constructor(
    private readonly options: LiveHostTerminalSurfaceControllerOptions,
  ) {
    this.dataCoalescer = new TerminalDataCoalescer({
      ...options.dataCoalescing,
      onFlush: (terminalId, data) => {
        // Timer-driven flushes run outside the session service's listener
        // guard, so failures must not escape to the event loop.
        try {
          this.processCoalescedData(terminalId, data);
        } catch (error) {
          this.options.log?.(
            `Host terminal output processing failed: ${String(error)}`,
          );
        }
      },
    });
    this.sandboxSubscription = options.sandboxChannelHub?.subscribe((update) =>
      this.handleSandboxEvent(update),
    );
    this.agentRawDataSubscription = options.sandboxChannelHub?.subscribeRawData(
      (update) => this.handleAgentRawData(update),
    );
  }

  attach(
    postMessage: HostTerminalSurfaceConnection["postMessage"],
  ): HostTerminalSurfaceConnection {
    const connection: HostTerminalSurfaceConnection = {
      generation: this.nextConnectionGeneration++,
      rendererEpoch: this.options.createId(),
      postMessage,
    };
    this.connections.add(connection);
    return connection;
  }

  detach(connection: HostTerminalSurfaceConnection): void {
    if (!this.connections.delete(connection)) return;
    this.readyConnections.delete(connection);
    if (this.readyConnections.size === 0) this.terminalViewFocused = false;
    this.deleteConfirmationsForRenderer(connection.rendererEpoch);
    this.interactionGenerations.delete(connection.rendererEpoch);
    for (const terminal of this.terminals.values()) {
      terminal.renderPaused = false;
      this.clearPendingRenderQueue(terminal);
      const detached = terminal.runtime.detachRenderer(
        terminal.terminalInstanceId,
        connection.rendererEpoch,
      );
      if (detached.shouldResume) {
        terminal.service.resumeOutput(terminal.terminalId);
      }
    }
    for (const terminal of this.sandboxTerminals.values()) {
      terminal.renderDeliveryGeneration += 1;
      terminal.renderPaused = false;
      this.clearPendingRenderQueue(terminal);
      terminal.runtime.detachRenderer(
        terminal.terminalInstanceId,
        connection.rendererEpoch,
      );
    }
  }

  async handleRequest(
    connection: HostTerminalSurfaceConnection,
    request: TerminalSurfaceRequest,
  ): Promise<void> {
    if (!this.isCurrent(connection)) return;

    if (request.type === "terminal-view/ready") {
      await this.handleReady(connection);
      return;
    }
    if (!this.readyConnections.has(connection)) return;

    if (request.type === "terminal-view/focus-changed") {
      this.terminalViewFocused = request.focused;
      return;
    }
    if (request.type === "terminal-view/resync") {
      if (request.rendererEpoch !== connection.rendererEpoch) return;
      this.deleteConfirmationsForRenderer(connection.rendererEpoch);
      this.interactionGenerations.delete(connection.rendererEpoch);
      this.readyConnections.delete(connection);
      for (const terminal of this.terminals.values()) {
        terminal.renderPaused = false;
        this.clearPendingRenderQueue(terminal);
        const detached = terminal.runtime.detachRenderer(
          terminal.terminalInstanceId,
          connection.rendererEpoch,
        );
        if (detached.shouldResume) {
          terminal.service.resumeOutput(terminal.terminalId);
        }
      }
      for (const terminal of this.sandboxTerminals.values()) {
        terminal.renderDeliveryGeneration += 1;
        terminal.renderPaused = false;
        this.clearPendingRenderQueue(terminal);
        terminal.runtime.detachRenderer(
          terminal.terminalInstanceId,
          connection.rendererEpoch,
        );
      }
      await this.handleReady(connection);
      return;
    }
    if (request.type === "host-terminal/create") {
      await this.createTerminal(connection, request);
      return;
    }
    if (request.type === "terminal-view/open-native-fallback") {
      if (
        request.rendererEpoch === connection.rendererEpoch &&
        this.fallback &&
        this.isCurrent(connection)
      ) {
        this.options.openNativeTerminal?.(this.fallback);
      }
      return;
    }
    if (request.type === "terminal-view/open-link") {
      if (request.rendererEpoch !== connection.rendererEpoch) return;
      let url: URL;
      try {
        url = new URL(request.url);
      } catch {
        return;
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") return;
      await this.options.openExternal?.(url.href);
      return;
    }
    if (request.type === "host-terminal/activate") {
      if (!this.matchesAnyTarget(connection, request)) return;
      this.state = reduceHostTerminalState(this.state, {
        type: "host-terminal/activated",
        terminalId: request.terminalId,
      });
      await this.post(connection, {
        type: "host-terminal/activated",
        terminalId: request.terminalId,
        terminalInstanceId: request.terminalInstanceId,
      });
      return;
    }
    if (request.type === "host-terminal/write") {
      const sandboxTerminal = this.sandboxTarget(connection, request);
      if (sandboxTerminal) {
        if (this.isNativeAgentTerminal(sandboxTerminal)) {
          this.beginInteraction(connection.rendererEpoch);
          this.deleteConfirmationsForTerminal(sandboxTerminal.terminalId);
          if (
            !sandboxTerminal.runtime.noteUserInput(
              sandboxTerminal.terminalInstanceId,
            )
          ) {
            return;
          }
          this.options.sandboxChannelHub?.write(
            sandboxTerminal.terminalId,
            request.data,
          );
        } else {
          this.handleSandboxInput(sandboxTerminal, request.data);
        }
        return;
      }
      const terminal = this.target(connection, request);
      if (!terminal) return;
      this.beginInteraction(connection.rendererEpoch);
      this.deleteConfirmationsForTerminal(terminal.terminalId);
      if (!terminal.runtime.noteUserInput(request.terminalInstanceId)) return;
      terminal.service.write(request.terminalId, request.data);
      return;
    }
    if (request.type === "host-terminal/resize") {
      const sandboxTerminal = this.sandboxTarget(connection, request);
      if (sandboxTerminal) {
        this.options.sandboxChannelHub?.resize(
          request.terminalId,
          request.dimensions,
        );
        this.state = reduceHostTerminalState(this.state, {
          type: "host-terminal/resized",
          terminalId: request.terminalId,
          dimensions: request.dimensions,
        });
        sandboxTerminal.snapshot = {
          ...sandboxTerminal.snapshot,
          dimensions: { ...request.dimensions },
        };
        return;
      }
      const terminal = this.target(connection, request);
      if (!terminal) return;
      terminal.service.resize(request.terminalId, request.dimensions);
      return;
    }
    if (request.type === "host-terminal/close-intent") {
      const sandboxTerminal = this.sandboxTarget(connection, request);
      if (sandboxTerminal) {
        this.options.sandboxChannelHub?.close(sandboxTerminal.terminalId);
        return;
      }
      const terminal = this.target(connection, request);
      if (!terminal) return;
      this.beginInteraction(connection.rendererEpoch);
      this.deleteConfirmationsForTerminal(terminal.terminalId);
      if (!terminal.runtime.closeRequiresConfirmation) {
        await this.closeTerminal(terminal);
        return;
      }
      await this.requestConfirmation(connection, terminal, {
        operation: "close",
        title: "Kill active terminal?",
        message:
          "This terminal may have a running command or interactive process. Closing it will terminate the process.",
        confirmLabel: "Kill Terminal",
      });
      return;
    }
    if (request.type === "host-terminal/paste-intent") {
      const sandboxTerminal = this.sandboxTarget(connection, request);
      if (sandboxTerminal) {
        if (this.isNativeAgentTerminal(sandboxTerminal)) {
          await this.pasteNativeAgentTerminal(
            connection,
            sandboxTerminal,
            request.bracketedPasteMode === true,
          );
        } else {
          await this.pasteSandboxTerminal(connection, sandboxTerminal);
        }
        return;
      }
      const terminal = this.target(connection, request);
      if (
        !terminal ||
        !terminal.runtime.terminalRunning ||
        !this.options.readClipboard
      ) {
        return;
      }
      this.deleteConfirmationsForTerminal(terminal.terminalId);
      const intentGeneration = this.beginInteraction(connection.rendererEpoch);
      const interactionStateKey = terminal.runtime.interactionStateKey;
      let data: string;
      try {
        data = await this.options.readClipboard();
      } catch (error) {
        if (
          this.matchesTarget(connection, request) &&
          this.isLatestInteraction(connection.rendererEpoch, intentGeneration)
        ) {
          await this.post(connection, {
            type: "host-terminal/error",
            terminalId: terminal.terminalId,
            terminalInstanceId: terminal.terminalInstanceId,
            message: `Unable to read the clipboard: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
        return;
      }
      if (
        !this.matchesTarget(connection, request) ||
        !this.isLatestInteraction(connection.rendererEpoch, intentGeneration) ||
        interactionStateKey !== terminal.runtime.interactionStateKey
      ) {
        return;
      }
      if (!this.isValidPaste(data)) {
        if (data) {
          await this.post(connection, {
            type: "host-terminal/error",
            terminalId: terminal.terminalId,
            terminalInstanceId: terminal.terminalInstanceId,
            message: `Clipboard text exceeds the ${MAX_TERMINAL_PASTE_BYTES.toLocaleString()} byte paste limit.`,
          });
        }
        return;
      }
      const paste = decideTerminalPaste(
        data,
        this.options.getSurfaceConfiguration().multiLinePasteWarning ?? "auto",
        request.bracketedPasteMode === true,
      );
      if (paste.action === "paste") {
        this.writeUserInput(
          terminal,
          prepareTerminalPaste(paste.data, request.bracketedPasteMode === true),
        );
        return;
      }
      await this.requestConfirmation(connection, terminal, {
        operation: "paste",
        title: "Paste multiple lines?",
        message:
          "The clipboard contains multiple lines. Pasting may run commands immediately in this terminal.",
        confirmLabel: "Paste",
        pasteData: paste.data,
        bracketedPasteMode: request.bracketedPasteMode === true,
      });
      return;
    }
    if (request.type === "terminal-view/confirm") {
      const pending = this.pendingConfirmations.get(request.confirmationId);
      this.pendingConfirmations.delete(request.confirmationId);
      if (!pending || pending.rendererEpoch !== connection.rendererEpoch)
        return;
      const terminal =
        pending.targetKind === "host"
          ? this.target(connection, request)
          : this.sandboxTarget(connection, request);
      if (
        !terminal ||
        pending.terminalId !== terminal.terminalId ||
        pending.terminalInstanceId !== terminal.terminalInstanceId ||
        pending.interactionStateKey !== terminal.runtime.interactionStateKey ||
        !request.accept
      ) {
        return;
      }
      if (pending.operation === "close") {
        if (pending.targetKind !== "host" || !("service" in terminal)) return;
        if (!terminal.runtime.closeRequiresConfirmation) return;
        await this.closeTerminal(terminal);
      } else if (pending.pasteData) {
        if (pending.targetKind === "host" && "service" in terminal) {
          this.writeUserInput(
            terminal,
            prepareTerminalPaste(
              pending.pasteData,
              request.bracketedPasteMode ?? pending.bracketedPasteMode === true,
            ),
          );
        } else if (
          pending.targetKind === "native-agent" &&
          !("service" in terminal) &&
          this.isNativeAgentTerminal(terminal)
        ) {
          terminal.runtime.noteUserInput(terminal.terminalInstanceId);
          this.options.sandboxChannelHub?.write(
            terminal.terminalId,
            prepareTerminalPaste(
              pending.pasteData,
              request.bracketedPasteMode ?? pending.bracketedPasteMode === true,
            ),
          );
        }
      }
      return;
    }
    if (request.type === "terminal-view/action") {
      const terminal = this.target(connection, request);
      if (!terminal) return;
      this.beginInteraction(connection.rendererEpoch);
      this.deleteConfirmationsForTerminal(terminal.terminalId);
      const authorization = terminal.runtime.authorizeAction(
        request.terminalInstanceId,
        request.blockId,
        request.action,
      );
      if (!authorization.authorized) {
        if (authorization.reason) {
          await this.post(connection, {
            type: "host-terminal/error",
            terminalId: terminal.terminalId,
            terminalInstanceId: terminal.terminalInstanceId,
            message:
              authorization.reason === "copy-output-truncated"
                ? "The retained command output is incomplete and cannot be copied safely."
                : "The requested terminal text exceeds the copy limit.",
          });
        }
        return;
      }
      if ("clipboardText" in authorization) {
        if (!this.options.writeClipboard) return;
        try {
          await this.options.writeClipboard(authorization.clipboardText);
        } catch (error) {
          const message = `Unable to write to the clipboard: ${error instanceof Error ? error.message : String(error)}`;
          this.options.log?.(
            `Host terminal clipboard write failed: ${message}`,
          );
          if (this.matchesTarget(connection, request)) {
            await this.post(connection, {
              type: "host-terminal/error",
              terminalId: terminal.terminalId,
              terminalInstanceId: terminal.terminalInstanceId,
              message,
            });
          }
        }
        return;
      }
      if (authorization.action === "rerun-command") {
        this.writeUserInput(terminal, `${authorization.command}\r`);
      } else {
        this.writeUserInput(terminal, authorization.data);
      }
      return;
    }
    if (request.type === "terminal-view/output-ack") {
      const sandboxTerminal = this.sandboxTarget(connection, request);
      if (sandboxTerminal) {
        const acknowledgment = sandboxTerminal.runtime.acknowledge(
          request.terminalInstanceId,
          connection.rendererEpoch,
          request.sequence,
        );
        if (sandboxTerminal.renderPaused && acknowledgment.shouldResume) {
          // The renderer caught up: resume delivering the queued tail in order
          // rather than resetting it and replaying from retention.
          sandboxTerminal.renderPaused = false;
          this.scheduleSandboxDelivery(sandboxTerminal);
        }
        return;
      }
      const terminal = this.target(connection, request);
      if (!terminal) return;
      const acknowledged = terminal.runtime.acknowledge(
        request.terminalInstanceId,
        connection.rendererEpoch,
        request.sequence,
      );
      if (acknowledged.shouldResume) {
        terminal.service.resumeOutput(request.terminalId);
        if (terminal.renderPaused) {
          terminal.renderPaused = false;
          this.scheduleHostDelivery(terminal);
        }
      }
    }
  }

  refreshSandboxChannels(): void {
    for (const snapshot of this.options.sandboxChannelHub?.listSnapshots() ??
      []) {
      this.ensureSandboxTerminal(snapshot, true);
    }
  }

  updateConfiguration(configuration: TerminalSurfaceConfiguration): void {
    for (const connection of this.readyConnections) {
      void this.post(connection, {
        type: "terminal-view/config",
        configuration,
      });
    }
  }

  revealTerminal(terminalId: string): boolean {
    const terminal = this.sandboxTerminals.get(terminalId);
    if (!terminal) return false;
    this.activateAgentTerminal(terminal);
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.dataCoalescer.dispose();
    this.readyConnections.clear();
    this.connections.clear();
    this.pendingConfirmations.clear();
    this.interactionGenerations.clear();
    this.sandboxSubscription?.dispose();
    this.agentRawDataSubscription?.dispose();
    for (const terminal of this.terminals.values()) {
      this.disposeTerminal(terminal);
    }
    this.terminals.clear();
    this.sandboxTerminals.clear();
    this.state = EMPTY_HOST_TERMINAL_STATE;
  }

  private async handleReady(
    connection: HostTerminalSurfaceConnection,
  ): Promise<void> {
    if (!this.isCurrent(connection)) return;
    // Buffered output must be folded into replay retention before snapshots
    // are taken, or the bootstrap replay would miss the freshest tail.
    this.dataCoalescer.flushAll();
    this.readyConnections.add(connection);
    this.refreshSandboxChannels();
    const replay = [];
    for (const terminal of this.terminals.values()) {
      terminal.renderPaused = false;
      terminal.resyncRequested = false;
      // The bootstrap replay carries the authoritative tail, so anything still
      // queued for the previous renderer would duplicate it.
      this.clearPendingRenderQueue(terminal);
      terminal.service.resumeOutput(terminal.terminalId);
      replay.push(terminal.runtime.attachRenderer(connection.rendererEpoch));
    }
    for (const terminal of this.sandboxTerminals.values()) {
      terminal.renderPaused = false;
      terminal.resyncRequested = false;
      this.clearPendingRenderQueue(terminal);
      replay.push(terminal.runtime.attachRenderer(connection.rendererEpoch));
    }
    await this.post(connection, {
      type: "terminal-view/bootstrap",
      protocolVersion: TERMINAL_SURFACE_PROTOCOL_VERSION,
      rendererEpoch: connection.rendererEpoch,
      state: this.state,
      configuration: this.options.getSurfaceConfiguration(),
      replay,
      ...(this.fallback ? { fallback: this.fallback } : {}),
    });
  }

  private handleAgentRawData(update: {
    channelId: string;
    data: string;
  }): void {
    if (this.disposed) return;
    const snapshot = this.options.sandboxChannelHub?.getSnapshot(
      update.channelId,
    );
    const terminal = snapshot
      ? this.ensureSandboxTerminal(snapshot)
      : this.sandboxTerminals.get(update.channelId);
    if (!terminal || !this.isNativeAgentTerminal(terminal)) return;
    if (snapshot && terminal.snapshot.cwd !== snapshot.cwd) {
      terminal.snapshot = snapshot;
      this.state = reduceHostTerminalState(this.state, {
        type: "host-terminal/cwd",
        terminalId: terminal.terminalId,
        cwd: snapshot.cwd,
      });
      void this.postSandboxLifecycle(terminal, {
        type: "host-terminal/cwd",
        terminalId: terminal.terminalId,
        cwd: snapshot.cwd,
      });
    }
    this.processSandboxRenderData(terminal, update.data);
  }

  private handleSandboxEvent(update: SandboxTerminalChannelEvent): void {
    if (this.disposed) return;
    const terminal = this.ensureSandboxTerminal(update.snapshot);
    if (!terminal) return;
    terminal.snapshot = update.snapshot;

    if (update.event.type === "command-started") {
      terminal.submitting = false;
      terminal.editor.reset();
      if (update.event.command.origin === "agent") {
        this.handleAgentCommandStarted(terminal);
      }
      if (
        !this.isNativeAgentTerminal(terminal) &&
        update.event.command.origin !== "user"
      ) {
        this.processSandboxRenderData(
          terminal,
          `\r\x1b[2K$ ${update.event.command.command}\r\n`,
        );
      }
      return;
    }
    if (update.event.type === "data") {
      if (!this.isNativeAgentTerminal(terminal)) {
        this.processSandboxRenderData(terminal, update.event.data);
      }
      return;
    }
    if (update.event.type === "cwd") {
      this.state = reduceHostTerminalState(this.state, {
        type: "host-terminal/cwd",
        terminalId: terminal.terminalId,
        cwd: update.event.cwd,
      });
      void this.postSandboxLifecycle(terminal, {
        type: "host-terminal/cwd",
        terminalId: terminal.terminalId,
        cwd: update.event.cwd,
      });
      return;
    }
    if (update.event.type === "violation") {
      this.processSandboxRenderData(
        terminal,
        `\r\n\x1b[33mSandbox blocked: ${update.event.violation.operation}\x1b[0m\r\n`,
      );
      return;
    }
    if (update.event.type === "command-exited") {
      this.handleAgentCommandFinished(terminal, update.event.commandId);
      if (!this.isNativeAgentTerminal(terminal)) {
        this.resetSandboxProcessBoundary(terminal);
        this.processSandboxRenderData(terminal, "\r\n$ ");
      }
      return;
    }
    if (update.event.type === "command-failed") {
      terminal.submitting = false;
      this.handleAgentCommandFinished(terminal, update.event.commandId);
      if (!this.isNativeAgentTerminal(terminal)) {
        this.resetSandboxProcessBoundary(terminal);
        this.processSandboxRenderData(
          terminal,
          `\r\n\x1b[31m${update.event.error}\x1b[0m\r\n$ `,
        );
      }
      return;
    }
    if (update.event.type === "resized") {
      this.state = reduceHostTerminalState(this.state, {
        type: "host-terminal/resized",
        terminalId: terminal.terminalId,
        dimensions: update.event.dimensions,
      });
      void this.postSandboxLifecycle(terminal, {
        type: "host-terminal/resized",
        terminalId: terminal.terminalId,
        dimensions: update.event.dimensions,
      });
      return;
    }
    if (update.event.type === "closed") {
      this.dataCoalescer.discard(terminal.terminalId);
      this.sandboxTerminals.delete(terminal.terminalId);
      this.state = reduceHostTerminalState(this.state, {
        type: "host-terminal/closed",
        terminalId: terminal.terminalId,
      });
      void this.postSandboxLifecycle(terminal, {
        type: "host-terminal/closed",
        terminalId: terminal.terminalId,
      });
    }
  }

  private ensureSandboxTerminal(
    snapshot: SandboxTerminalSessionSnapshot,
    reconstruct = false,
  ): ManagedSandboxSurfaceTerminal | undefined {
    const existing = this.sandboxTerminals.get(snapshot.channelId);
    if (existing) return existing;
    if (snapshot.status === "closed") return undefined;

    const terminalInstanceId = this.options.createId();
    const terminal: ManagedSandboxSurfaceTerminal = {
      terminalId: snapshot.channelId,
      terminalInstanceId,
      runtime: new HostTerminalRuntime({
        terminalId: snapshot.channelId,
        terminalInstanceId,
        parser: createRawShellIntegrationParser(),
        initialCwd: snapshot.cwd,
        ...(this.options.runtimeWatermarks
          ? {
              renderHighWaterBytes: this.options.runtimeWatermarks.high,
              renderLowWaterBytes: this.options.runtimeWatermarks.low,
            }
          : {}),
      }),
      editor: new SandboxTerminalIdleEditor(),
      deliveryQueue: Promise.resolve(),
      snapshot,
      submitting: false,
      renderDeliveryGeneration: 0,
      renderPaused: false,
      resyncRequested: false,
      pending: createPendingRenderQueue(),
    };
    if (reconstruct && !this.isNativeAgentTerminal(terminal)) {
      const initialRender = [
        snapshot.replay,
        snapshot.status === "idle" ? (snapshot.replay ? "\r\n$ " : "$ ") : "",
      ].join("");
      terminal.runtime.processData(initialRender);
    }
    const connection = this.currentReadyConnection();
    if (connection) terminal.runtime.attachRenderer(connection.rendererEpoch);
    this.sandboxTerminals.set(terminal.terminalId, terminal);
    const opened: HostTerminalEvent = {
      type: "host-terminal/opened",
      activate: reconstruct,
      terminal: {
        id: terminal.terminalId,
        title: snapshot.title,
        channelKind:
          this.options.sandboxChannelHub?.getAuthority(snapshot.channelId) ===
          "native"
            ? "agent-native"
            : "agent-sandbox",
        cwd: snapshot.cwd,
        profileName:
          this.options.sandboxChannelHub?.getAuthority(snapshot.channelId) ===
          "native"
            ? "AgentLink Native"
            : "AgentLink Sandbox",
        dimensions: snapshot.dimensions,
        status: "running",
      },
    };
    this.state = reduceHostTerminalState(this.state, opened);
    if (!reconstruct) void this.postSandboxLifecycle(terminal, opened);
    return terminal;
  }

  private handleAgentCommandStarted(
    terminal: ManagedSandboxSurfaceTerminal,
  ): void {
    const activityEvent: HostTerminalEvent = {
      type: "host-terminal/agent-activity",
      terminalId: terminal.terminalId,
      activity: "running",
    };
    this.state = reduceHostTerminalState(this.state, activityEvent);
    void this.postSandboxLifecycle(terminal, activityEvent);
    if (this.terminalViewFocused && this.activeUserTerminalThatMayBeBusy())
      return;
    this.activateAgentTerminal(terminal);
  }

  private activateAgentTerminal(terminal: ManagedSandboxSurfaceTerminal): void {
    const activated: HostTerminalEvent = {
      type: "host-terminal/activated",
      terminalId: terminal.terminalId,
    };
    this.state = reduceHostTerminalState(this.state, activated);
    void this.postSandboxLifecycle(terminal, activated);
    try {
      this.options.requestTerminalViewReveal?.();
    } catch (error) {
      this.options.log?.(
        `Unable to reveal AgentLink Terminal: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private handleAgentCommandFinished(
    terminal: ManagedSandboxSurfaceTerminal,
    commandId: string,
  ): void {
    const command = terminal.snapshot.commands.find(
      (candidate) => candidate.commandId === commandId,
    );
    if (command?.origin !== "agent") return;
    const activityEvent: HostTerminalEvent = {
      type: "host-terminal/agent-activity",
      terminalId: terminal.terminalId,
      activity:
        this.state.activeTabId === terminal.terminalId ? "none" : "unread",
    };
    this.state = reduceHostTerminalState(this.state, activityEvent);
    void this.postSandboxLifecycle(terminal, activityEvent);
  }

  private activeUserTerminalThatMayBeBusy():
    | ManagedSurfaceTerminal
    | undefined {
    const activeTabId = this.state.activeTabId;
    if (!activeTabId) return undefined;
    const terminal = this.terminals.get(activeTabId);
    return terminal?.runtime.userMayBeBusy ? terminal : undefined;
  }

  private handleSandboxInput(
    terminal: ManagedSandboxSurfaceTerminal,
    data: string,
  ): void {
    if (
      terminal.submitting ||
      terminal.snapshot.status === "launching" ||
      terminal.snapshot.status === "running"
    ) {
      if (data.includes("\x03")) {
        this.options.sandboxChannelHub?.interrupt(terminal.terminalId);
        return;
      }
      this.options.sandboxChannelHub?.write(terminal.terminalId, data);
      return;
    }

    for (const action of terminal.editor.handle(data)) {
      if (action.type === "write") {
        this.processSandboxRenderData(terminal, action.data);
      } else if (action.type === "interrupt") {
        this.options.sandboxChannelHub?.interrupt(terminal.terminalId);
      } else {
        terminal.submitting = true;
        void this.options.sandboxChannelHub
          ?.executeUserCommand({
            channelId: terminal.terminalId,
            command: action.command,
            cwd: terminal.snapshot.cwd,
          })
          .then(
            () => {
              terminal.submitting = false;
            },
            (error) => {
              terminal.submitting = false;
              this.processSandboxRenderData(
                terminal,
                `\x1b[31m${error instanceof Error ? error.message : String(error)}\x1b[0m\r\n$ `,
              );
            },
          );
      }
    }
  }

  private isNativeAgentTerminal(
    terminal: ManagedSandboxSurfaceTerminal,
  ): boolean {
    return (
      this.options.sandboxChannelHub?.getAuthority(terminal.terminalId) ===
      "native"
    );
  }

  private async pasteNativeAgentTerminal(
    connection: HostTerminalSurfaceConnection,
    terminal: ManagedSandboxSurfaceTerminal,
    bracketedPasteMode: boolean,
  ): Promise<void> {
    if (!this.options.readClipboard) return;
    let data: string;
    try {
      data = await this.options.readClipboard();
    } catch (error) {
      await this.post(connection, {
        type: "host-terminal/error",
        terminalId: terminal.terminalId,
        terminalInstanceId: terminal.terminalInstanceId,
        message: `Unable to read the clipboard: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    if (!this.isValidPaste(data)) return;
    const paste = decideTerminalPaste(
      data,
      this.options.getSurfaceConfiguration().multiLinePasteWarning ?? "auto",
      bracketedPasteMode,
    );
    if (paste.action === "confirm") {
      await this.requestConfirmation(connection, terminal, {
        operation: "paste",
        title: "Paste multiple lines?",
        message:
          "The clipboard contains multiple lines. Pasting may run commands immediately in this terminal.",
        confirmLabel: "Paste",
        pasteData: paste.data,
        targetKind: "native-agent",
        bracketedPasteMode,
      });
      return;
    }
    terminal.runtime.noteUserInput(terminal.terminalInstanceId);
    this.options.sandboxChannelHub?.write(
      terminal.terminalId,
      prepareTerminalPaste(paste.data, bracketedPasteMode),
    );
  }

  private async pasteSandboxTerminal(
    connection: HostTerminalSurfaceConnection,
    terminal: ManagedSandboxSurfaceTerminal,
  ): Promise<void> {
    if (!this.options.readClipboard) return;
    let data: string;
    try {
      data = await this.options.readClipboard();
    } catch (error) {
      await this.post(connection, {
        type: "host-terminal/error",
        terminalId: terminal.terminalId,
        terminalInstanceId: terminal.terminalInstanceId,
        message: `Unable to read the clipboard: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    if (!this.isValidPaste(data)) return;
    if (/[\r\n]/.test(data)) {
      await this.post(connection, {
        type: "host-terminal/error",
        terminalId: terminal.terminalId,
        terminalInstanceId: terminal.terminalInstanceId,
        message:
          "Multiline paste is not available in sandbox terminals yet. Paste and run one command at a time so each command receives a fresh sandbox authorization.",
      });
      return;
    }
    this.handleSandboxInput(terminal, data);
  }

  private resetSandboxProcessBoundary(
    terminal: ManagedSandboxSurfaceTerminal,
  ): void {
    // The boundary must observe everything the command produced.
    this.dataCoalescer.flush(terminal.terminalId);
    const update = terminal.runtime.resetProcessBoundary();
    if (update.batch) this.enqueueSandboxBatch(terminal, update.batch);
  }

  private processSandboxRenderData(
    terminal: ManagedSandboxSurfaceTerminal,
    data: string,
  ): void {
    // Synthetic prompts and markers share the coalescer with raw channel
    // output so per-terminal ordering is preserved.
    this.dataCoalescer.push(terminal.terminalId, data);
  }

  private requestSandboxResync(
    terminal: ManagedSandboxSurfaceTerminal,
    connection: HostTerminalSurfaceConnection,
  ): void {
    if (terminal.resyncRequested) return;
    terminal.renderPaused = false;
    terminal.resyncRequested = true;
    terminal.renderDeliveryGeneration += 1;
    this.clearPendingRenderQueue(terminal);
    terminal.runtime.detachRenderer(
      terminal.terminalInstanceId,
      connection.rendererEpoch,
    );
    void this.post(connection, {
      type: "terminal-view/resync-required",
      rendererEpoch: connection.rendererEpoch,
    });
  }

  private enqueueSandboxBatch(
    terminal: ManagedSandboxSurfaceTerminal,
    batch: HostTerminalRenderBatch,
  ): void {
    const connection = this.currentReadyConnection();
    if (!connection || terminal.resyncRequested) return;
    terminal.pending.batches.push(batch);
    terminal.pending.byteLength += renderBatchWriteBytes(batch);
    if (this.isPendingRenderQueueOverflowing(terminal.pending)) {
      this.clearPendingRenderQueue(terminal);
      this.requestSandboxResync(terminal, connection);
      return;
    }
    this.scheduleSandboxDelivery(terminal);
  }

  private scheduleSandboxDelivery(
    terminal: ManagedSandboxSurfaceTerminal,
  ): void {
    const deliveryGeneration = terminal.renderDeliveryGeneration;
    terminal.deliveryQueue = terminal.deliveryQueue.then(async () => {
      while (
        terminal.pending.batches.length > 0 &&
        !terminal.renderPaused &&
        !terminal.resyncRequested &&
        deliveryGeneration === terminal.renderDeliveryGeneration
      ) {
        const connection = this.currentReadyConnection();
        if (!connection) return;
        const batch = terminal.pending.batches[0];
        const delivery = terminal.runtime.markBatchDelivered(
          terminal.terminalInstanceId,
          connection.rendererEpoch,
          batch.sequence,
        );
        if (delivery.shouldPause) terminal.renderPaused = true;
        const delivered = await this.post(connection, batch);
        if (!delivered) {
          this.handleFailedDelivery(connection);
          return;
        }
        terminal.pending.batches.shift();
        terminal.pending.byteLength -= renderBatchWriteBytes(batch);
      }
    });
  }

  private async postSandboxLifecycle(
    terminal: ManagedSandboxSurfaceTerminal,
    event: HostTerminalEvent,
  ): Promise<void> {
    const connection = this.currentReadyConnection();
    if (!connection) return;
    const surfaceEvent: TerminalSurfaceEvent =
      event.type === "host-terminal/opened"
        ? {
            type: event.type,
            terminalInstanceId: terminal.terminalInstanceId,
            terminal: event.terminal,
            ...(event.activate === undefined
              ? {}
              : { activate: event.activate }),
          }
        : ({
            ...event,
            terminalInstanceId: terminal.terminalInstanceId,
          } as TerminalSurfaceEvent);
    await this.post(connection, surfaceEvent);
  }

  private async createTerminal(
    connection: HostTerminalSurfaceConnection,
    request: Extract<TerminalSurfaceRequest, { type: "host-terminal/create" }>,
  ): Promise<void> {
    const terminalId = `host-terminal-${this.options.createId()}`;
    const terminalInstanceId = this.options.createId();
    const artifactId = `tab-${this.options.createId()}`.replaceAll("-", "_");
    const nonce = this.options.createId().replaceAll("-", "_");
    let materialized: MaterializedHostShellBootstrap | undefined;
    let managed: ManagedSurfaceTerminal | undefined;

    try {
      const snapshot = this.options.getConfigurationSnapshot({
        cwd: request.cwd,
        profileName: request.profileName,
      });
      if (!snapshot.isWorkspaceTrusted) {
        const fallback: HostTerminalFallbackState = {
          reason: "workspace-untrusted",
          message:
            "AgentLink host terminals are unavailable until this workspace is trusted. You can open VS Code's terminal explicitly instead.",
        };
        this.fallback = fallback;
        await this.post(connection, {
          type: "terminal-view/fallback",
          fallback,
        });
        return;
      }
      const prepared = prepareHostShellBootstrap({
        configuration: snapshot,
        host: this.options.host,
        runtimeRoot: this.options.runtimeRoot,
        artifactId,
        nonce,
        originalZdotdir: snapshot.baseEnvironment.ZDOTDIR,
      });
      if (!this.isCurrent(connection)) return;
      if (prepared.plan.mode === "native-fallback") {
        const fallback: HostTerminalFallbackState = {
          reason: fallbackReason(prepared.plan.reason),
          message: prepared.plan.message,
          profileName: prepared.plan.profile.profileName,
          executable: prepared.plan.profile.shellPath,
        };
        this.fallback = fallback;
        await this.post(connection, {
          type: "terminal-view/fallback",
          fallback,
        });
        return;
      }

      if (prepared.plan.mode === "integrated") {
        await this.ensureRuntimeRoot();
        if (!this.isCurrent(connection)) return;
      }
      materialized = await (
        this.options.materializeBootstrap ?? materializeHostShellBootstrap
      )(prepared.plan);
      if (!this.isCurrent(connection)) {
        await this.cleanupBootstrap(materialized);
        return;
      }

      const loaded = loadNodePtyForHostShellPlan(
        materialized,
        this.options.nodePtyLoader,
      );
      if (loaded.mode !== "custom") return;
      if (!this.isCurrent(connection)) {
        await this.cleanupBootstrap(materialized);
        return;
      }

      const parser =
        materialized.mode === "integrated"
          ? createShellIntegrationParser(materialized.nonce)
          : createRawShellIntegrationParser();
      const runtime = new HostTerminalRuntime({
        terminalId,
        terminalInstanceId,
        parser,
        initialCwd: materialized.profile.cwd,
        ...(this.options.runtimeWatermarks
          ? {
              renderHighWaterBytes: this.options.runtimeWatermarks.high,
              renderLowWaterBytes: this.options.runtimeWatermarks.low,
            }
          : {}),
      });
      runtime.attachRenderer(connection.rendererEpoch);
      const service = new TerminalSessionService({
        ptyFactory: createNodePtyFactory(loaded.nodePty),
        createTerminalId: () => terminalId,
        onListenerError: (error) =>
          this.options.log?.(`Host terminal listener failed: ${String(error)}`),
      });
      managed = {
        terminalId,
        terminalInstanceId,
        service,
        serviceSubscription: { dispose() {} },
        runtime,
        bootstrap: materialized,
        deliveryQueue: Promise.resolve(),
        cleaned: false,
        renderPaused: false,
        resyncRequested: false,
        pending: createPendingRenderQueue(),
      };
      managed.serviceSubscription = service.onEvent((event) =>
        this.handleServiceEvent(managed!, event),
      );
      this.terminals.set(terminalId, managed);
      service.create({
        requestId: request.requestId,
        title:
          basename(materialized.profile.shellPath) ||
          materialized.profile.profileName,
        profile: materialized.profile,
        dimensions: INITIAL_DIMENSIONS,
      });
      this.fallback = undefined;
    } catch (error) {
      if (managed) {
        this.terminals.delete(managed.terminalId);
        this.disposeTerminal(managed);
      } else if (materialized) {
        await this.cleanupBootstrap(materialized);
      }
      if (!managed && this.isCurrent(connection)) {
        await this.post(connection, {
          type: "host-terminal/error",
          requestId: request.requestId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private handleServiceEvent(
    terminal: ManagedSurfaceTerminal,
    event: HostTerminalEvent,
  ): boolean | void {
    if (this.disposed || !this.terminals.has(terminal.terminalId)) return;

    if (event.type === "host-terminal/data") {
      // Coalesce bursts of PTY chunks into large writes before parsing and
      // delivery; per-chunk batches multiply postMessage/ack round trips and
      // made sustained output render slowly. Renderer pressure pauses
      // delivery, not the PTY: keep draining the child process while replay
      // retention records the authoritative tail.
      this.dataCoalescer.push(terminal.terminalId, event.data);
      return true;
    }

    this.state = reduceHostTerminalState(this.state, event);
    if (event.type === "host-terminal/exited") {
      // Buffered output must land before the exit summary to keep order.
      this.dataCoalescer.flush(terminal.terminalId);
      this.deleteConfirmationsForTerminal(terminal.terminalId);
      const update = terminal.runtime.finish();
      if (update.batch) this.enqueueBatch(terminal, update.batch);
      terminal.deliveryQueue = terminal.deliveryQueue.then(async () => {
        await this.postLifecycle(terminal, event);
        await this.cleanupTerminalBootstrap(terminal);
      });
      return;
    }
    if (event.type === "host-terminal/closed") {
      this.dataCoalescer.discard(terminal.terminalId);
      this.deleteConfirmationsForTerminal(terminal.terminalId);
      this.terminals.delete(terminal.terminalId);
      terminal.deliveryQueue = terminal.deliveryQueue.then(async () => {
        await this.postLifecycle(terminal, event);
        this.disposeTerminal(terminal);
      });
      return;
    }
    void this.postLifecycle(terminal, event);
  }

  /** Applies a coalesced run of PTY or sandbox output to the owning
   * terminal's runtime and delivery queue. */
  private processCoalescedData(terminalId: string, data: string): void {
    if (this.disposed) return;
    const terminal = this.terminals.get(terminalId);
    if (terminal) {
      this.deleteConfirmationsForTerminal(terminal.terminalId);
      const previousCwd = terminal.runtime.currentCwd;
      const update = terminal.runtime.processData(data);
      if (update.batch) this.enqueueBatch(terminal, update.batch);
      if (terminal.runtime.currentCwd !== previousCwd) {
        const cwdEvent: HostTerminalEvent = {
          type: "host-terminal/cwd",
          terminalId: terminal.terminalId,
          cwd: terminal.runtime.currentCwd,
        };
        this.state = reduceHostTerminalState(this.state, cwdEvent);
        void this.postLifecycle(terminal, cwdEvent);
      }
      return;
    }
    const sandboxTerminal = this.sandboxTerminals.get(terminalId);
    if (!sandboxTerminal) return;
    const update = sandboxTerminal.runtime.processData(data);
    if (update.batch) this.enqueueSandboxBatch(sandboxTerminal, update.batch);
  }

  private enqueueBatch(
    terminal: ManagedSurfaceTerminal,
    batch: HostTerminalRenderBatch,
  ): void {
    const connection = this.currentReadyConnection();
    if (!connection || terminal.resyncRequested) return;
    terminal.pending.batches.push(batch);
    terminal.pending.byteLength += renderBatchWriteBytes(batch);
    if (this.isPendingRenderQueueOverflowing(terminal.pending)) {
      // The renderer has stopped acknowledging altogether. Drop the queue and
      // fall back to replay-based resync rather than buffering without bound.
      this.clearPendingRenderQueue(terminal);
      this.requestHostTerminalResync(terminal, connection);
      return;
    }
    this.scheduleHostDelivery(terminal);
  }

  /**
   * Delivers queued batches in sequence order, stopping while the renderer is
   * behind. Output waits in the queue instead of being dropped, so a renderer
   * that keeps acknowledging never has to reset and replay.
   */
  private scheduleHostDelivery(terminal: ManagedSurfaceTerminal): void {
    terminal.deliveryQueue = terminal.deliveryQueue.then(async () => {
      while (
        terminal.pending.batches.length > 0 &&
        !terminal.renderPaused &&
        !terminal.resyncRequested
      ) {
        const connection = this.currentReadyConnection();
        if (!connection) return;
        const batch = terminal.pending.batches[0];
        // Record the delivery before awaiting the post: the renderer can
        // acknowledge as soon as it receives the batch, and an acknowledgment
        // that arrived first would be rejected as out of order and stall the
        // queue.
        const delivery = terminal.runtime.markBatchDelivered(
          terminal.terminalInstanceId,
          connection.rendererEpoch,
          batch.sequence,
        );
        if (delivery.shouldPause) {
          // Never pause the PTY on renderer backpressure: a throttled or hidden
          // renderer (screen lock marks the window occluded and clamps webview
          // timers) would otherwise freeze the child process mid-write. Hold
          // further batches in the queue and resume delivering them once
          // acknowledgements prove xterm has caught up. This is set before the
          // post so it stays in step with the runtime's own backpressure state
          // for any acknowledgment that arrives while the post is in flight.
          terminal.renderPaused = true;
        }
        const delivered = await this.post(connection, batch);
        if (!delivered) {
          this.handleFailedDelivery(connection);
          return;
        }
        terminal.pending.batches.shift();
        terminal.pending.byteLength -= renderBatchWriteBytes(batch);
      }
    });
  }

  /** Revokes the renderer after a post failure so nothing is delivered into a
   * connection the webview can no longer receive on. */
  private handleFailedDelivery(
    connection: HostTerminalSurfaceConnection,
  ): void {
    this.readyConnections.delete(connection);
    for (const candidate of this.terminals.values()) {
      candidate.renderPaused = false;
      this.clearPendingRenderQueue(candidate);
      const detached = candidate.runtime.detachRenderer(
        candidate.terminalInstanceId,
        connection.rendererEpoch,
      );
      if (detached.shouldResume) {
        candidate.service.resumeOutput(candidate.terminalId);
      }
    }
    for (const candidate of this.sandboxTerminals.values()) {
      candidate.renderDeliveryGeneration += 1;
      candidate.renderPaused = false;
      this.clearPendingRenderQueue(candidate);
      candidate.runtime.detachRenderer(
        candidate.terminalInstanceId,
        connection.rendererEpoch,
      );
    }
  }

  private isPendingRenderQueueOverflowing(
    pending: PendingRenderQueue,
  ): boolean {
    const limits = this.options.renderQueueLimits;
    return (
      pending.byteLength > (limits?.maxBytes ?? MAX_QUEUED_RENDER_BYTES) ||
      pending.batches.length > (limits?.maxBatches ?? MAX_QUEUED_RENDER_BATCHES)
    );
  }

  private clearPendingRenderQueue(terminal: {
    pending: PendingRenderQueue;
  }): void {
    terminal.pending.batches = [];
    terminal.pending.byteLength = 0;
  }

  private requestHostTerminalResync(
    terminal: ManagedSurfaceTerminal,
    connection: HostTerminalSurfaceConnection,
  ): void {
    if (terminal.resyncRequested) return;
    terminal.renderPaused = false;
    terminal.resyncRequested = true;
    this.clearPendingRenderQueue(terminal);
    const detached = terminal.runtime.detachRenderer(
      terminal.terminalInstanceId,
      connection.rendererEpoch,
    );
    if (detached.shouldResume) {
      terminal.service.resumeOutput(terminal.terminalId);
    }
    void this.post(connection, {
      type: "terminal-view/resync-required",
      rendererEpoch: connection.rendererEpoch,
    });
  }

  private async postLifecycle(
    terminal: ManagedSurfaceTerminal,
    event: HostTerminalEvent,
  ): Promise<void> {
    const connection = this.currentReadyConnection();
    if (!connection) return;
    let surfaceEvent: TerminalSurfaceEvent;
    if (event.type === "host-terminal/opened") {
      surfaceEvent = {
        type: event.type,
        terminalInstanceId: terminal.terminalInstanceId,
        terminal: event.terminal,
      };
    } else if (event.type === "host-terminal/error") {
      surfaceEvent = {
        ...event,
        terminalInstanceId: terminal.terminalInstanceId,
      };
    } else {
      surfaceEvent = {
        ...event,
        terminalInstanceId: terminal.terminalInstanceId,
      } as TerminalSurfaceEvent;
    }
    await this.post(connection, surfaceEvent);
  }

  private async requestConfirmation(
    connection: HostTerminalSurfaceConnection,
    terminal: ManagedSurfaceTerminal | ManagedSandboxSurfaceTerminal,
    confirmation: {
      operation: "close" | "paste";
      title: string;
      message: string;
      confirmLabel: string;
      pasteData?: string;
      targetKind?: "host" | "native-agent";
      bracketedPasteMode?: boolean;
    },
  ): Promise<void> {
    this.deleteConfirmationsForRenderer(connection.rendererEpoch);
    const confirmationId = this.options.createId();
    const pending: PendingTerminalConfirmation = {
      confirmationId,
      terminalId: terminal.terminalId,
      terminalInstanceId: terminal.terminalInstanceId,
      rendererEpoch: connection.rendererEpoch,
      operation: confirmation.operation,
      targetKind: confirmation.targetKind ?? "host",
      interactionStateKey: terminal.runtime.interactionStateKey,
      ...(confirmation.pasteData === undefined
        ? {}
        : { pasteData: confirmation.pasteData }),
      ...(confirmation.bracketedPasteMode === undefined
        ? {}
        : { bracketedPasteMode: confirmation.bracketedPasteMode }),
    };
    this.pendingConfirmations.set(confirmationId, pending);
    const delivered = await this.post(connection, {
      type: "terminal-view/confirmation",
      confirmationId,
      terminalId: terminal.terminalId,
      terminalInstanceId: terminal.terminalInstanceId,
      operation: confirmation.operation,
      title: confirmation.title,
      message: confirmation.message,
      confirmLabel: confirmation.confirmLabel,
    });
    if (!delivered) this.pendingConfirmations.delete(confirmationId);
  }

  private async closeTerminal(terminal: ManagedSurfaceTerminal): Promise<void> {
    this.deleteConfirmationsForTerminal(terminal.terminalId);
    terminal.service.close(terminal.terminalId);
    await terminal.deliveryQueue;
  }

  private writeUserInput(
    terminal: ManagedSurfaceTerminal,
    data: string,
  ): boolean {
    return (
      terminal.runtime.noteUserInput(terminal.terminalInstanceId) &&
      terminal.service.write(terminal.terminalId, data)
    );
  }

  private isValidPaste(data: string): boolean {
    return (
      data.length > 0 &&
      !data.includes("\0") &&
      Buffer.byteLength(data, "utf8") <= MAX_TERMINAL_PASTE_BYTES
    );
  }

  private beginInteraction(rendererEpoch: string): number {
    const generation =
      (this.interactionGenerations.get(rendererEpoch) ?? 0) + 1;
    this.interactionGenerations.set(rendererEpoch, generation);
    return generation;
  }

  private isLatestInteraction(
    rendererEpoch: string,
    generation: number,
  ): boolean {
    return this.interactionGenerations.get(rendererEpoch) === generation;
  }

  private deleteConfirmationsForTerminal(terminalId: string): void {
    for (const [confirmationId, pending] of this.pendingConfirmations) {
      if (pending.terminalId !== terminalId) continue;
      this.pendingConfirmations.delete(confirmationId);
      let connection: HostTerminalSurfaceConnection | undefined;
      for (const candidate of this.readyConnections) {
        if (candidate.rendererEpoch === pending.rendererEpoch) {
          connection = candidate;
          break;
        }
      }
      if (connection) {
        void this.post(connection, {
          type: "terminal-view/confirmation-cancelled",
          confirmationId,
        });
      }
    }
  }

  private deleteConfirmationsForRenderer(rendererEpoch: string): void {
    for (const [confirmationId, pending] of this.pendingConfirmations) {
      if (pending.rendererEpoch === rendererEpoch) {
        this.pendingConfirmations.delete(confirmationId);
      }
    }
  }

  private currentReadyConnection(): HostTerminalSurfaceConnection | undefined {
    let current: HostTerminalSurfaceConnection | undefined;
    for (const connection of this.readyConnections) current = connection;
    return current;
  }

  private sandboxTarget(
    connection: HostTerminalSurfaceConnection,
    request: {
      terminalId: string;
      terminalInstanceId: string;
      rendererEpoch: string;
    },
  ): ManagedSandboxSurfaceTerminal | undefined {
    if (!this.matchesAnyTarget(connection, request)) return undefined;
    return this.sandboxTerminals.get(request.terminalId);
  }

  private target(
    connection: HostTerminalSurfaceConnection,
    request: {
      terminalId: string;
      terminalInstanceId: string;
      rendererEpoch: string;
    },
  ): ManagedSurfaceTerminal | undefined {
    if (!this.matchesTarget(connection, request)) return undefined;
    return this.terminals.get(request.terminalId);
  }

  private matchesAnyTarget(
    connection: HostTerminalSurfaceConnection,
    request: {
      terminalId: string;
      terminalInstanceId: string;
      rendererEpoch: string;
    },
  ): boolean {
    const terminal =
      this.terminals.get(request.terminalId) ??
      this.sandboxTerminals.get(request.terminalId);
    return (
      this.isCurrent(connection) &&
      this.readyConnections.has(connection) &&
      request.rendererEpoch === connection.rendererEpoch &&
      terminal?.terminalInstanceId === request.terminalInstanceId
    );
  }

  private matchesTarget(
    connection: HostTerminalSurfaceConnection,
    request: {
      terminalId: string;
      terminalInstanceId: string;
      rendererEpoch: string;
    },
  ): boolean {
    const terminal = this.terminals.get(request.terminalId);
    return (
      this.isCurrent(connection) &&
      this.readyConnections.has(connection) &&
      request.rendererEpoch === connection.rendererEpoch &&
      terminal?.terminalInstanceId === request.terminalInstanceId
    );
  }

  private isCurrent(connection: HostTerminalSurfaceConnection): boolean {
    return (
      !this.disposed &&
      this.options.isAcceptingRequests() &&
      this.connections.has(connection)
    );
  }

  private async post(
    connection: HostTerminalSurfaceConnection,
    event: TerminalSurfaceEvent,
  ): Promise<boolean> {
    if (!this.connections.has(connection) || this.disposed) return false;
    try {
      return await connection.postMessage(event);
    } catch (error) {
      this.options.log?.(`Host terminal webview post failed: ${String(error)}`);
      return false;
    }
  }

  private disposeTerminal(terminal: ManagedSurfaceTerminal): void {
    this.deleteConfirmationsForTerminal(terminal.terminalId);
    terminal.serviceSubscription.dispose();
    terminal.service.dispose();
    void this.cleanupTerminalBootstrap(terminal);
  }

  private async cleanupTerminalBootstrap(
    terminal: ManagedSurfaceTerminal,
  ): Promise<void> {
    if (terminal.cleaned) return;
    terminal.cleaned = true;
    await this.cleanupBootstrap(terminal.bootstrap);
  }

  private async ensureRuntimeRoot(): Promise<void> {
    if (this.options.ensureRuntimeRoot) {
      await this.options.ensureRuntimeRoot();
      return;
    }
    await mkdir(this.options.runtimeRoot, { recursive: true, mode: 0o700 });
  }

  private async cleanupBootstrap(
    bootstrap: MaterializedHostShellBootstrap,
  ): Promise<void> {
    if (bootstrap.mode !== "integrated") return;
    try {
      await bootstrap.cleanup();
    } catch (error) {
      this.options.log?.(
        `Host terminal bootstrap cleanup failed: ${String(error)}`,
      );
    }
  }
}
