import { randomUUID } from "crypto";

import type { BrowserGatewayCoreOwnerLeaseRegistration } from "../protocol.js";
import {
  BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
  parseBrowserGatewayOwnerCommandAck,
  type BrowserGatewayDetailHandle,
  type BrowserGatewayOwnerCommand,
  type BrowserGatewayOwnerCommandBody,
  type BrowserGatewayOwnerCommandKind,
  type BrowserGatewayOwnerControl,
  type BrowserGatewayOperationState,
} from "./protocol.js";
import {
  HttpBrowserGatewayOwnerTransport,
  type BrowserGatewayOwnerTransport,
  type BrowserGatewayOwnerTransportRegistration,
} from "./OwnerTransport.js";
import {
  BrowserGatewayOwnerProjectionAdapter,
  type BrowserGatewayOwnerProjectionPublication,
} from "./ownerProjectionAdapter.js";
import type { BrowserGatewayOwnerProjectionSources } from "./ownerProjectionSources.js";
import {
  BROWSER_GATEWAY_DATA_PLANE_LIMITS,
  browserGatewayDetailResponseByteLimit,
} from "./limits.js";

export interface BrowserGatewayOwnerCommandExecutionResult {
  readonly detail?: {
    readonly content: Uint8Array;
    readonly mediaType: string;
    readonly kind: BrowserGatewayDetailHandle["kind"];
  };
  readonly history?: {
    readonly messages: Parameters<
      BrowserGatewayOwnerProjectionAdapter["publishTranscriptHistory"]
    >[0];
    readonly earlierCursor: string | null;
    readonly hasEarlier: boolean;
  };
}

export interface BrowserGatewayOwnerCommandExecutor {
  execute(
    command: BrowserGatewayOwnerCommandBody,
    signal: AbortSignal,
  ): Promise<BrowserGatewayOwnerCommandExecutionResult | void>;
}

export interface BrowserGatewayOwnerRuntimeTransport extends BrowserGatewayOwnerTransport {
  enqueue(publication: BrowserGatewayOwnerProjectionPublication): void;
}

export interface BrowserGatewayOwnerRuntimeOptions {
  readonly helperUrl: string;
  readonly clientSharedSecret: string;
  readonly helperGenerationId: string;
  readonly owner: BrowserGatewayCoreOwnerLeaseRegistration;
  readonly sources: BrowserGatewayOwnerProjectionSources;
  readonly executor: BrowserGatewayOwnerCommandExecutor;
  readonly commandCapabilities: readonly BrowserGatewayOwnerCommandKind[];
  readonly heartbeatIntervalMs?: number;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
  readonly createTransport?: (
    options: ConstructorParameters<typeof HttpBrowserGatewayOwnerTransport>[0],
  ) => BrowserGatewayOwnerRuntimeTransport;
}

export class BrowserGatewayOwnerRuntime {
  private readonly now: () => number;
  private readonly transport: BrowserGatewayOwnerRuntimeTransport;
  private readonly commandControllers = new Map<string, AbortController>();
  private readonly pendingInbound: Array<
    | { kind: "command"; value: BrowserGatewayOwnerCommand }
    | { kind: "control"; value: BrowserGatewayOwnerControl }
  > = [];
  private projection: BrowserGatewayOwnerProjectionAdapter | undefined;
  private projectionSubscription: { dispose(): void } | undefined;
  private commandSubscription: { dispose(): void } | undefined;
  private controlSubscription: { dispose(): void } | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private registration: BrowserGatewayOwnerTransportRegistration | undefined;
  private startPromise:
    | Promise<BrowserGatewayOwnerTransportRegistration>
    | undefined;
  private started = false;
  private disposed = false;

  constructor(private readonly options: BrowserGatewayOwnerRuntimeOptions) {
    this.now = options.now ?? Date.now;
    const transportOptions: ConstructorParameters<
      typeof HttpBrowserGatewayOwnerTransport
    >[0] = {
      helperUrl: options.helperUrl,
      clientSharedSecret: options.clientSharedSecret,
      helperGenerationId: options.helperGenerationId,
      owner: {
        ...options.owner,
        capabilities: options.commandCapabilities.map((capabilityId) => ({
          capabilityId,
          state: "enabled" as const,
        })),
      },
      getCheckpoint: () => this.requireProjection().getCheckpoint(),
      getRecoveryCheckpointPublication: () =>
        this.requireProjection().getRecoveryCheckpointPublication(),
      log: options.log,
    };
    this.transport = options.createTransport
      ? options.createTransport(transportOptions)
      : new HttpBrowserGatewayOwnerTransport(transportOptions);
  }

  async start(): Promise<BrowserGatewayOwnerTransportRegistration> {
    if (this.disposed)
      throw new Error("browser_gateway_owner_runtime_disposed");
    if (this.started) return this.requireRegistration();
    if (!this.startPromise) this.startPromise = this.startInternal();
    return await this.startPromise;
  }

  getRegistration(): BrowserGatewayOwnerTransportRegistration | undefined {
    return this.registration;
  }

  async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    for (const controller of this.commandControllers.values())
      controller.abort();
    this.commandControllers.clear();
    this.commandSubscription?.dispose();
    this.commandSubscription = undefined;
    this.controlSubscription?.dispose();
    this.controlSubscription = undefined;
    this.projectionSubscription?.dispose();
    this.projectionSubscription = undefined;
    this.projection?.dispose();
    this.projection = undefined;
    this.pendingInbound.length = 0;
    await this.transport.close();
  }

  private async startInternal(): Promise<BrowserGatewayOwnerTransportRegistration> {
    this.controlSubscription = this.transport.onControl((control) =>
      this.receiveInbound({ kind: "control", value: control }),
    );
    this.commandSubscription = this.transport.onCommand((command) =>
      this.receiveInbound({ kind: "command", value: command }),
    );
    try {
      const registration = await this.transport.register();
      if (this.disposed)
        throw new Error("browser_gateway_owner_runtime_disposed");
      this.registration = registration;
      this.projection = new BrowserGatewayOwnerProjectionAdapter(
        this.options.sources,
        {
          helperGenerationId: registration.helperGenerationId,
          ownerId: registration.effectiveOwnerId,
          ownerGenerationId: registration.ownerGenerationId,
        },
        {
          commandCapabilities: this.options.commandCapabilities,
          dataPlaneFeatures: registration.dataPlaneFeatures,
        },
      );
      this.projectionSubscription = this.projection.onDidPublish(
        (publication) => {
          this.transport.enqueue(publication);
        },
      );
      this.started = true;
      this.replayPendingInbound();
      const heartbeatIntervalMs = this.options.heartbeatIntervalMs ?? 10_000;
      if (heartbeatIntervalMs > 0) {
        this.heartbeatTimer = setInterval(() => {
          void this.transport.heartbeat().catch((error) => {
            this.options.log?.(
              `[browser-gateway-data-plane] owner heartbeat failed: ${String(error)}`,
            );
          });
        }, heartbeatIntervalMs);
        this.heartbeatTimer.unref?.();
      }
      return registration;
    } catch (error) {
      // A failed registration may have partially opened helper-side state or an SSE
      // loop. Treat this runtime instance as terminal; the owning lifecycle creates
      // a fresh runtime for its next readiness attempt.
      this.disposed = true;
      this.commandSubscription?.dispose();
      this.commandSubscription = undefined;
      this.controlSubscription?.dispose();
      this.controlSubscription = undefined;
      this.pendingInbound.length = 0;
      await this.transport.close().catch((closeError) => {
        this.options.log?.(
          `[browser-gateway-data-plane] owner startup cleanup failed: ${String(closeError)}`,
        );
      });
      throw error;
    } finally {
      this.startPromise = undefined;
    }
  }

  private receiveInbound(
    inbound: BrowserGatewayOwnerRuntime["pendingInbound"][number],
  ): void | Promise<void> {
    if (!this.projection) {
      this.pendingInbound.push(inbound);
      return;
    }
    return this.dispatchInbound(inbound);
  }

  private replayPendingInbound(): void {
    for (const inbound of this.pendingInbound.splice(0)) {
      void Promise.resolve(this.dispatchInbound(inbound)).catch((error) => {
        this.options.log?.(
          `[browser-gateway-data-plane] buffered owner event failed: ${String(error)}`,
        );
      });
    }
  }

  private dispatchInbound(
    inbound: BrowserGatewayOwnerRuntime["pendingInbound"][number],
  ): void | Promise<void> {
    if (inbound.kind === "command") return this.handleCommand(inbound.value);
    const control = inbound.value;
    if (control.kind === "hello" || control.kind === "demand.changed") {
      this.requireProjection().setDemanded(control.payload.subscriberCount > 0);
    } else if (control.kind === "checkpoint.requested") {
      this.transport.enqueue(
        this.requireProjection().getRecoveryCheckpointPublication(),
      );
    } else if (control.kind === "command.cancelled") {
      this.cancelCommand(control.payload.operationId);
    }
  }

  private async handleCommand(
    command: BrowserGatewayOwnerCommand,
  ): Promise<void> {
    const controller = new AbortController();
    this.commandControllers.set(command.operationId, controller);
    try {
      await this.acknowledge(command, { state: "accepted" });
      const result = await this.options.executor.execute(
        command.command,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      let detailHandle: BrowserGatewayDetailHandle | undefined;
      if (result?.detail) {
        if (
          result.detail.content.byteLength >
          browserGatewayDetailResponseByteLimit(result.detail.kind)
        ) {
          throw new Error("browser_gateway_session_detail_too_large");
        }
        detailHandle = this.createCommandDetailHandle(result.detail);
        await this.transport.uploadDetail(detailHandle, result.detail.content);
      }
      if (result?.history) {
        this.requireProjection().publishTranscriptHistory(
          result.history.messages,
          result.history.earlierCursor,
          result.history.hasEarlier,
        );
      }
      await this.acknowledge(command, {
        state: "completed",
        detailHandle,
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      await this.acknowledge(command, {
        state: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.commandControllers.delete(command.operationId);
    }
  }

  private cancelCommand(operationId: string): void {
    const controller = this.commandControllers.get(operationId);
    if (!controller) return;
    controller.abort();
    this.commandControllers.delete(operationId);
  }

  private createCommandDetailHandle(
    detail: NonNullable<BrowserGatewayOwnerCommandExecutionResult["detail"]>,
  ): BrowserGatewayDetailHandle {
    const registration = this.requireRegistration();
    return {
      helperGenerationId: registration.helperGenerationId,
      ownerId: registration.effectiveOwnerId,
      ownerGenerationId: registration.ownerGenerationId,
      handleId: randomUUID(),
      kind: detail.kind,
      byteLength: detail.content.byteLength,
      expiresAt:
        this.now() +
        BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerTranscriptDetailTtlMs,
      mediaType: detail.mediaType,
    };
  }

  private acknowledge(
    command: BrowserGatewayOwnerCommand,
    operation: Pick<
      BrowserGatewayOperationState,
      "state" | "message" | "detailHandle"
    >,
  ): Promise<void> {
    return this.transport.acknowledge(
      parseBrowserGatewayOwnerCommandAck({
        protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
        helperGenerationId: command.helperGenerationId,
        ownerId: command.ownerId,
        ownerGenerationId: command.ownerGenerationId,
        acknowledgedAt: this.now(),
        operation: {
          operationId: command.operationId,
          kind: command.command.kind,
          state: operation.state,
          ...(operation.message ? { message: operation.message } : {}),
          ...(operation.detailHandle
            ? { detailHandle: operation.detailHandle }
            : {}),
        },
      }),
    );
  }

  private requireProjection(): BrowserGatewayOwnerProjectionAdapter {
    if (!this.projection)
      throw new Error("browser_gateway_owner_runtime_not_started");
    return this.projection;
  }

  private requireRegistration(): BrowserGatewayOwnerTransportRegistration {
    if (!this.registration) {
      throw new Error("browser_gateway_owner_runtime_not_started");
    }
    return this.registration;
  }
}
