/** @vitest-environment node */

import type { ChatMessage } from "../../agent/webview/types.js";
import type { BrowserGatewayThemeSnapshot } from "../../shared/types.js";
import { BROWSER_GATEWAY_ASK_AGENT_OWNER_ID } from "../browserGatewayAskAgentSessionStore.js";
import { BrowserGatewayCoreOwnerRegistry } from "../coreOwnerRegistry.js";
import {
  BROWSER_GATEWAY_COMMAND_IDEMPOTENCY,
  BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
  type BrowserGatewayDetailHandle,
  type BrowserGatewayOwnerCommand,
  type BrowserGatewayOwnerCommandBody,
  type BrowserGatewayOwnerPublicationBatch,
} from "../dataPlane/protocol.js";
import { AskAgentController } from "./AskAgentController.js";
import {
  ASK_AGENT_OWNER_COMMAND_CAPABILITIES,
  AskAgentOwnerAdapter,
  askAgentOwnerCommandCapabilities,
  askAgentOwnerGenerationId,
  type AskAgentOwnerCommandExecutor,
  type AskAgentOwnerResolvedDetail,
} from "./AskAgentOwnerAdapter.js";
import { describe, expect, it, vi } from "vitest";

const theme: BrowserGatewayThemeSnapshot = {
  cssVariables: { "--vscode-foreground": "#ffffff" },
  colorScheme: "dark",
  themeLabel: "Dark",
  source: "vscode-theme-api",
};

const missingCredential = {
  state: "missing" as const,
  reason: "No model credential available.",
};

function command(
  ownerGenerationId: string,
  operationId: string,
  body: BrowserGatewayOwnerCommandBody,
): BrowserGatewayOwnerCommand {
  return {
    protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
    helperGenerationId: "helper-generation-1",
    ownerId: BROWSER_GATEWAY_ASK_AGENT_OWNER_ID,
    ownerGenerationId,
    operationId,
    emittedAt: 1_000,
    deadlineAt: 10_000,
    deadlineClass: "default",
    idempotency: BROWSER_GATEWAY_COMMAND_IDEMPOTENCY[body.kind],
    command: body,
  };
}

function detailHandle(
  ownerGenerationId: string,
  handleId: string,
  kind: BrowserGatewayDetailHandle["kind"],
  content: Uint8Array,
  mediaType?: string,
): BrowserGatewayDetailHandle {
  return {
    helperGenerationId: "helper-generation-1",
    ownerId: BROWSER_GATEWAY_ASK_AGENT_OWNER_ID,
    ownerGenerationId,
    handleId,
    kind,
    byteLength: content.byteLength,
    expiresAt: 10_000,
    ...(mediaType ? { mediaType } : {}),
  } as BrowserGatewayDetailHandle;
}

function createHarness(
  overrides: {
    ingestPublication?: (batch: BrowserGatewayOwnerPublicationBatch) => void;
    onPublicationError?: (error: unknown) => void;
  } = {},
) {
  let now = 1_000;
  const ownerGenerationId = askAgentOwnerGenerationId("helper-generation-1");
  const registry = new BrowserGatewayCoreOwnerRegistry({
    heartbeatTtlMs: 30_000,
  });
  const legacyPublications: unknown[] = [];
  let adapter: AskAgentOwnerAdapter;
  const controller = new AskAgentController({
    ownerRegistry: registry,
    ownerGenerationId,
    additionalOwnerCapabilities: askAgentOwnerCommandCapabilities(),
    coalesceMs: 0,
    serialize: JSON.stringify,
    byteLength: (serialized) => Buffer.byteLength(serialized),
    publish: (publication) => {
      legacyPublications.push(publication);
      adapter.publishControllerPublication(publication);
    },
  });
  const batches: BrowserGatewayOwnerPublicationBatch[] = [];
  const acknowledgements: Array<{
    operation: { operationId: string; state: string; message?: string };
  }> = [];
  const details = new Map<string, AskAgentOwnerResolvedDetail>();
  const executor = {
    selectSession: vi.fn(),
    send: vi.fn(),
    stopSession: vi.fn(),
    respondToApproval: vi.fn(),
    respondToQuestion: vi.fn(),
    loadHistory: vi.fn(() => ({
      messages: [message("history-message", "Earlier")],
      earlierCursor: null,
      hasEarlier: false,
    })),
  } satisfies AskAgentOwnerCommandExecutor;
  adapter = new AskAgentOwnerAdapter({
    helperGenerationId: "helper-generation-1",
    ownerRegistry: registry,
    executor,
    now: () => now,
    heartbeatIntervalMs: 0,
    ingestPublication:
      overrides.ingestPublication ??
      ((batch) => {
        batches.push(batch);
      }),
    onPublicationError: overrides.onPublicationError,
    putDetail: (handle, content) => {
      details.set(handle.handleId, { handle, content });
    },
    getDetail: ({ handleId }) => details.get(handleId) ?? null,
    acknowledge: (acknowledgement) => {
      acknowledgements.push(acknowledgement);
    },
  });
  const state = controller.projectState({
    now,
    theme,
    modelCredentialStatus: missingCredential,
  });
  adapter.initialize(state.snapshot);
  return {
    adapter,
    acknowledgements,
    batches,
    controller,
    details,
    executor,
    legacyPublications,
    ownerGenerationId,
    registry,
    setNow(value: number) {
      now = value;
    },
    state,
  };
}

function message(id: string, text: string): ChatMessage {
  return {
    id,
    role: "user",
    content: text,
    timestamp: 500,
    blocks: [{ type: "text", text }],
  };
}

describe("AskAgentOwnerAdapter", () => {
  it("binds checkpoints and owner registration to the helper generation", async () => {
    const harness = createHarness();
    harness.adapter.setDemanded(true);
    await harness.adapter.drain();

    expect(harness.ownerGenerationId).toBe(
      "browser-gateway:ask-agent:helper-generation-1",
    );
    expect(harness.state.ownerRegistration).toMatchObject({
      ownerGenerationId: harness.ownerGenerationId,
      capabilities: expect.arrayContaining(
        ASK_AGENT_OWNER_COMMAND_CAPABILITIES.map((capabilityId) => ({
          capabilityId,
          state: "enabled",
        })),
      ),
    });
    expect(harness.batches[0]?.checkpoint).toMatchObject({
      helperGenerationId: "helper-generation-1",
      ownerId: BROWSER_GATEWAY_ASK_AGENT_OWNER_ID,
      ownerGenerationId: harness.ownerGenerationId,
      foreground: { sessionId: "browser-gateway:ask-agent:default" },
      capabilities: expect.arrayContaining(
        ASK_AGENT_OWNER_COMMAND_CAPABILITIES.map((capabilityId) => ({
          capabilityId,
          state: "enabled",
        })),
      ),
    });
    expect(
      harness.batches[0]?.checkpoint?.capabilities.some(
        (capability) => capability.capabilityId === "diff.detail",
      ),
    ).toBe(false);

    await harness.adapter.dispose();
    await harness.controller.dispose();
  });

  it("tees committed controller publications into incremental relay events without changing legacy publication", async () => {
    const harness = createHarness();
    harness.adapter.setDemanded(true);
    await harness.adapter.drain();
    harness.batches.length = 0;

    harness.controller.sessionStore.appendUserMessage({
      id: "user-1",
      text: "Hello relay",
      now: 1_100,
    });
    const next = harness.controller.projectState({
      now: 1_100,
      theme,
      modelCredentialStatus: missingCredential,
    });
    await harness.controller.publishSnapshot(next.snapshot);
    await harness.adapter.drain();

    expect(harness.legacyPublications).toHaveLength(1);
    expect(harness.legacyPublications[0]).toMatchObject({
      snapshot: next.snapshot,
    });
    expect(
      harness.batches
        .flatMap((batch) => batch.events)
        .map((event) => event.kind),
    ).toContain("transcript.message.appended");

    await harness.adapter.dispose();
    await harness.controller.dispose();
  });

  it("stores projected transcript details locally before publication", async () => {
    const harness = createHarness();
    harness.controller.sessionStore.appendUserMessage({
      id: "long-message",
      text: "x".repeat(80_000),
      now: 1_100,
    });
    const next = harness.controller.projectState({
      now: 1_100,
      theme,
      modelCredentialStatus: missingCredential,
    });
    harness.adapter.initialize(next.snapshot);
    harness.adapter.setDemanded(true);
    await harness.adapter.drain();

    const projected =
      harness.batches[0]?.checkpoint?.transcript.messages.at(-1);
    expect(projected?.content.kind).toBe("detail");
    if (projected?.content.kind !== "detail")
      throw new Error("expected detail");
    expect(
      Buffer.from(
        harness.details.get(projected.content.detailHandle.handleId)?.content ??
          [],
      ),
    ).toEqual(Buffer.from("x".repeat(80_000)));

    await harness.adapter.dispose();
    await harness.controller.dispose();
  });

  it("maps supported commands and emits accepted and completed acknowledgements", async () => {
    const harness = createHarness();
    const media = Buffer.from("image");
    const mediaHandle = detailHandle(
      harness.ownerGenerationId,
      "media-1",
      "media",
      media,
      "image/png",
    );
    harness.details.set(mediaHandle.handleId, {
      handle: mediaHandle,
      content: media,
    });
    const response = Buffer.from(
      JSON.stringify({ answers: { choice: "Yes" }, notes: {} }),
    );
    const responseHandle = detailHandle(
      harness.ownerGenerationId,
      "question-1",
      "interaction",
      response,
      "application/json",
    );
    harness.details.set(responseHandle.handleId, {
      handle: responseHandle,
      content: response,
    });
    const commands: BrowserGatewayOwnerCommand[] = [
      command(harness.ownerGenerationId, "select", {
        kind: "session.select",
        sessionId: "session-1",
      }),
      command(harness.ownerGenerationId, "send", {
        kind: "session.send",
        sessionId: "session-1",
        text: "Hello",
        detailHandles: [mediaHandle],
      }),
      command(harness.ownerGenerationId, "stop", {
        kind: "session.stop",
        sessionId: "session-1",
      }),
      command(harness.ownerGenerationId, "approval", {
        kind: "approval.respond",
        requestId: "approval-1",
        decision: "approve",
      }),
      command(harness.ownerGenerationId, "question", {
        kind: "question.respond",
        requestId: "question-request-1",
        responseHandle,
      }),
      command(harness.ownerGenerationId, "history", {
        kind: "history.load",
        cursor: "session-1:20",
        count: 10,
      }),
    ];

    for (const ownerCommand of commands) {
      expect(harness.adapter.publishCommand(ownerCommand)).toBe(true);
    }
    await vi.waitFor(() => {
      expect(
        harness.acknowledgements.filter(
          (acknowledgement) => acknowledgement.operation.state === "completed",
        ),
      ).toHaveLength(commands.length);
    });
    await harness.adapter.drain();

    expect(harness.executor.selectSession).toHaveBeenCalledWith("session-1");
    expect(harness.executor.send).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "send",
        sessionId: "session-1",
        text: "Hello",
        details: [{ handle: mediaHandle, content: media }],
      }),
    );
    expect(harness.executor.stopSession).toHaveBeenCalledWith("session-1");
    expect(harness.executor.respondToApproval).toHaveBeenCalledWith({
      requestId: "approval-1",
      decision: "approve",
    });
    expect(harness.executor.respondToQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "question-request-1",
        response: { answers: { choice: "Yes" }, notes: {} },
      }),
    );
    expect(harness.executor.loadHistory).toHaveBeenCalledWith({
      kind: "history.load",
      cursor: "session-1:20",
      count: 10,
    });
    expect(
      harness.batches
        .flatMap((batch) => batch.events)
        .map((event) => event.kind),
    ).toContain("transcript.history.prepended");

    await harness.adapter.dispose();
    await harness.controller.dispose();
  });

  it("reports relay publication failures without breaking queue cleanup", async () => {
    const publicationError = new Error("relay ingest failed");
    const onPublicationError = vi.fn();
    const harness = createHarness({
      ingestPublication: () => {
        throw publicationError;
      },
      onPublicationError,
    });

    harness.adapter.setDemanded(true);
    await expect(harness.adapter.drain()).rejects.toBe(publicationError);
    expect(onPublicationError).toHaveBeenCalledWith(publicationError);

    await harness.adapter.dispose();
    await harness.controller.dispose();
  });

  it("rejects stale identities, supports cancellation, and prevents work after disposal", async () => {
    const harness = createHarness();
    harness.setNow(2_000);
    expect(
      harness.adapter.publishCommand({
        ...command(harness.ownerGenerationId, "stale", {
          kind: "session.select",
          sessionId: "session-1",
        }),
        ownerGenerationId: "stale-generation",
      }),
    ).toBe(false);

    let observedAbort = false;
    harness.executor.send.mockImplementation(
      ({ signal }) =>
        new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              resolve();
            },
            { once: true },
          );
        }),
    );
    const pending = command(harness.ownerGenerationId, "pending", {
      kind: "session.send",
      sessionId: "session-1",
      text: "Wait",
      detailHandles: [],
    });
    expect(harness.adapter.publishCommand(pending)).toBe(true);
    expect(harness.adapter.cancelCommand(pending)).toBe(true);
    await vi.waitFor(() => expect(observedAbort).toBe(true));

    await harness.adapter.dispose();
    expect(
      harness.registry.get(BROWSER_GATEWAY_ASK_AGENT_OWNER_ID)?.status,
    ).toBe("disconnected");
    expect(harness.adapter.publishCommand(pending)).toBe(false);
    expect(() => harness.adapter.getCheckpoint()).toThrow(
      "ask_agent_owner_adapter_disposed",
    );
    await harness.controller.dispose();
  });
});
