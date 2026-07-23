import { describe, expect, it, vi } from "vitest";

import type { BrowserGatewayCoreOwnerLeaseRegistration } from "../protocol.js";
import {
  BROWSER_GATEWAY_COMMAND_IDEMPOTENCY,
  BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
  type BrowserGatewayOwnerCommand,
  type BrowserGatewayOwnerCommandAck,
  type BrowserGatewayOwnerControl,
} from "./protocol.js";
import {
  BrowserGatewayOwnerRuntime,
  type BrowserGatewayOwnerCommandExecutor,
  type BrowserGatewayOwnerRuntimeTransport,
} from "./BrowserGatewayOwnerRuntime.js";
import type { BrowserGatewayOwnerProjectionPublication } from "./ownerProjectionAdapter.js";
import type {
  BrowserGatewayOwnerProjectionReadSet,
  BrowserGatewayOwnerProjectionSources,
} from "./ownerProjectionSources.js";

const helperGenerationId = "helper-generation-1";
const requestedOwnerId = "workspace-owner";
const effectiveOwnerId = "workspace-owner~instance-2";
const ownerGenerationId = "owner-generation-1";

const owner: BrowserGatewayCoreOwnerLeaseRegistration = {
  ownerId: requestedOwnerId,
  ownerKind: "vscode",
  displayName: "Workspace",
  scope: {
    kind: "workspace",
    workspaceId: "workspace-1",
    displayName: "Workspace",
  },
  ownerGenerationId,
};

function readSet(): BrowserGatewayOwnerProjectionReadSet {
  return {
    catalog: {
      projects: [],
      sessions: [],
      defaultProjectId: null,
      foregroundSessionId: null,
    },
    foreground: null,
    interaction: null,
    background: [],
    fleet: [],
    diffs: [],
    repository: null,
    theme: { cssVariables: {}, colorScheme: "dark" },
    modelCatalogRevision: "models-1",
    mcp: [],
    policies: {
      agentWriteApproval: "prompt",
      commandApprovalPolicy: "safe",
      configuredCommandApprovalPolicy: "safe",
    },
  };
}

class ProjectionSources implements BrowserGatewayOwnerProjectionSources {
  captureCount = 0;

  capture(): BrowserGatewayOwnerProjectionReadSet {
    this.captureCount += 1;
    return readSet();
  }

  onDidChange(): { dispose(): void } {
    return { dispose() {} };
  }
}

class FakeTransport implements BrowserGatewayOwnerRuntimeTransport {
  readonly publications: BrowserGatewayOwnerProjectionPublication[] = [];
  readonly acknowledgements: BrowserGatewayOwnerCommandAck[] = [];
  acknowledgementError: Error | undefined;
  readonly eventsDuringRegister: Array<
    | { kind: "command"; value: BrowserGatewayOwnerCommand }
    | { kind: "control"; value: BrowserGatewayOwnerControl }
  > = [];
  registerCount = 0;
  heartbeatCount = 0;
  closeCount = 0;
  private commandHandler:
    | ((command: BrowserGatewayOwnerCommand) => void | Promise<void>)
    | undefined;
  private controlHandler:
    | ((control: BrowserGatewayOwnerControl) => void | Promise<void>)
    | undefined;

  async register() {
    this.registerCount += 1;
    for (const event of this.eventsDuringRegister) {
      if (event.kind === "command") await this.commandHandler?.(event.value);
      else await this.controlHandler?.(event.value);
    }
    return {
      requestedOwnerId,
      effectiveOwnerId,
      ownerGenerationId,
      helperGenerationId,
      resolution: "collision_assigned" as const,
    };
  }

  async heartbeat(): Promise<void> {
    this.heartbeatCount += 1;
  }

  async publish() {
    return {
      helperGenerationId,
      ownerId: effectiveOwnerId,
      ownerGenerationId,
      batchId: "batch-1",
      cursor: 0,
      duplicate: false,
    };
  }

  async uploadDetail(): Promise<void> {}

  async acknowledge(acknowledgement: BrowserGatewayOwnerCommandAck) {
    this.acknowledgements.push(acknowledgement);
    if (this.acknowledgementError) throw this.acknowledgementError;
  }

  onCommand(
    handler: (command: BrowserGatewayOwnerCommand) => void | Promise<void>,
  ): { dispose(): void } {
    this.commandHandler = handler;
    return {
      dispose: () => {
        if (this.commandHandler === handler) this.commandHandler = undefined;
      },
    };
  }

  onControl(
    handler: (control: BrowserGatewayOwnerControl) => void | Promise<void>,
  ): { dispose(): void } {
    this.controlHandler = handler;
    return {
      dispose: () => {
        if (this.controlHandler === handler) this.controlHandler = undefined;
      },
    };
  }

  enqueue(publication: BrowserGatewayOwnerProjectionPublication): void {
    this.publications.push(publication);
  }

  getPublicationBacklog() {
    return { pendingBatches: 0, queuedBytes: 0 };
  }

  async drain(): Promise<void> {}

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

function control(
  kind: "hello" | "checkpoint.requested" | "command.cancelled",
  payload:
    | { publicationCursor: number; subscriberCount: number }
    | { reason: "checkpoint_required"; latestSequence: number }
    | { operationId: string },
): BrowserGatewayOwnerControl {
  return {
    protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
    helperGenerationId,
    ownerId: effectiveOwnerId,
    ownerGenerationId,
    emittedAt: 1_000,
    kind,
    payload,
  } as BrowserGatewayOwnerControl;
}

function command(
  operationId: string,
  body: BrowserGatewayOwnerCommand["command"] = {
    kind: "session.stop",
    sessionId: "session-1",
  },
): BrowserGatewayOwnerCommand {
  return {
    protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
    helperGenerationId,
    ownerId: effectiveOwnerId,
    ownerGenerationId,
    operationId,
    emittedAt: 1_000,
    deadlineAt: 31_000,
    deadlineClass: "default",
    idempotency: BROWSER_GATEWAY_COMMAND_IDEMPOTENCY[body.kind],
    command: body,
  };
}

function makeRuntime(
  transport: FakeTransport,
  sources: ProjectionSources,
  execute: BrowserGatewayOwnerCommandExecutor["execute"] = vi.fn(
    async () => undefined,
  ),
) {
  return {
    execute,
    runtime: new BrowserGatewayOwnerRuntime({
      helperUrl: "http://127.0.0.1:47137",
      clientSharedSecret: "secret-1",
      helperGenerationId,
      owner,
      sources,
      executor: { execute },
      commandCapabilities: ["session.stop"],
      heartbeatIntervalMs: 0,
      now: () => 2_000,
      createTransport: () => transport,
    }),
  };
}

describe("BrowserGatewayOwnerRuntime", () => {
  it("buffers registration-time controls and binds publications to the effective owner identity", async () => {
    const transport = new FakeTransport();
    const sources = new ProjectionSources();
    transport.eventsDuringRegister.push(
      {
        kind: "control",
        value: control("hello", {
          publicationCursor: 0,
          subscriberCount: 1,
        }),
      },
      {
        kind: "control",
        value: control("checkpoint.requested", {
          reason: "checkpoint_required",
          latestSequence: 0,
        }),
      },
    );
    const { runtime } = makeRuntime(transport, sources);

    const registration = await runtime.start();

    expect(registration.effectiveOwnerId).toBe(effectiveOwnerId);
    expect(sources.captureCount).toBe(2);
    expect(transport.publications).toHaveLength(2);
    expect(
      transport.publications.map((publication) =>
        publication.kind === "checkpoint"
          ? publication.checkpoint.ownerId
          : publication.event.ownerId,
      ),
    ).toEqual([effectiveOwnerId, effectiveOwnerId]);
    await runtime.close();
  });

  it("buffers a fast command and completes its acknowledgement lifecycle", async () => {
    const transport = new FakeTransport();
    transport.eventsDuringRegister.push({
      kind: "command",
      value: command("operation-1"),
    });
    const { runtime, execute } = makeRuntime(
      transport,
      new ProjectionSources(),
    );

    await runtime.start();
    await vi.waitFor(() => {
      expect(transport.acknowledgements).toHaveLength(2);
    });

    expect(execute).toHaveBeenCalledWith(
      { kind: "session.stop", sessionId: "session-1" },
      expect.any(AbortSignal),
    );
    expect(
      transport.acknowledgements.map((ack) => ack.operation.state),
    ).toEqual(["accepted", "completed"]);
    await runtime.close();
  });

  it("replays registration-time cancellation after its command and suppresses completion", async () => {
    const transport = new FakeTransport();
    const operationId = "operation-cancelled";
    transport.eventsDuringRegister.push(
      { kind: "command", value: command(operationId) },
      {
        kind: "control",
        value: control("command.cancelled", { operationId }),
      },
    );
    const { runtime, execute } = makeRuntime(
      transport,
      new ProjectionSources(),
    );

    await runtime.start();
    await vi.waitFor(() => {
      expect(transport.acknowledgements).toHaveLength(1);
    });
    await Promise.resolve();

    expect(execute).toHaveBeenCalledOnce();
    expect(vi.mocked(execute).mock.calls[0]?.[1].aborted).toBe(true);
    expect(transport.acknowledgements[0]?.operation.state).toBe("accepted");
    await runtime.close();
  });

  it("cleans up a command when its accepted acknowledgement fails", async () => {
    const transport = new FakeTransport();
    transport.acknowledgementError = new Error("ack failed");
    transport.eventsDuringRegister.push({
      kind: "command",
      value: command("operation-ack-failed"),
    });
    const { runtime, execute } = makeRuntime(
      transport,
      new ProjectionSources(),
    );

    await runtime.start();
    await vi.waitFor(() => {
      expect(transport.acknowledgements).toHaveLength(2);
    });

    expect(
      transport.acknowledgements.map((ack) => ack.operation.state),
    ).toEqual(["accepted", "failed"]);
    expect(execute).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("shares concurrent startup and closes once", async () => {
    const transport = new FakeTransport();
    const { runtime } = makeRuntime(transport, new ProjectionSources());

    const [first, second] = await Promise.all([
      runtime.start(),
      runtime.start(),
    ]);

    expect(first).toEqual(second);
    expect(transport.registerCount).toBe(1);
    await runtime.close();
    await runtime.close();
    expect(transport.closeCount).toBe(1);
  });
});
