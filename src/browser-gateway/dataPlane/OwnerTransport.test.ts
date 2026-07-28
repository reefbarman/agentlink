import { afterEach, describe, expect, it, vi } from "vitest";

import { BROWSER_GATEWAY_DATA_PLANE_LIMITS } from "./limits.js";
import {
  BROWSER_GATEWAY_COMMAND_IDEMPOTENCY,
  BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
  type BrowserGatewayDetailHandle,
  type BrowserGatewayOwnerCheckpoint,
  type BrowserGatewayOwnerCommand,
  type BrowserGatewayOwnerPublicationBatch,
  type BrowserGatewayOwnerEvent,
} from "./protocol.js";
import { HttpBrowserGatewayOwnerTransport } from "./OwnerTransport.js";

const helperGenerationId = "helper-generation-1";
const requestedOwnerId = "owner-1";
const effectiveOwnerId = "owner-1~generation-1";
const ownerGenerationId = "generation-1";

function checkpoint(sequence = 0): BrowserGatewayOwnerCheckpoint {
  return {
    protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
    helperGenerationId,
    ownerId: effectiveOwnerId,
    ownerGenerationId,
    checkpointId: `checkpoint-${sequence}`,
    checkpointSequence: sequence,
    emittedAt: 1_000,
    foreground: null,
    catalog: {
      projects: [],
      sessions: [],
      defaultProjectId: null,
      foregroundSessionId: null,
    },
    transcript: { messages: [], earlierCursor: null, hasEarlier: false },
    ui: { interaction: null, queue: [], todos: [], operations: [] },
    background: [],
    fleet: [],
    diffs: [],
    repository: null,
    theme: { revision: "theme-1", colorScheme: "dark", variables: [] },
    modelCatalogRevision: "models-1",
    capabilities: [],
  };
}

function event(sequence: number): BrowserGatewayOwnerEvent {
  return {
    protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
    helperGenerationId,
    ownerId: effectiveOwnerId,
    ownerGenerationId,
    ownerSequence: sequence,
    eventId: `event-${sequence}`,
    kind: "foreground.control.updated",
    emittedAt: 1_000 + sequence,
    payload: { foreground: null },
  };
}

function transcriptEvent(
  sequence: number,
  terminal: "error" | "completion" | null,
): BrowserGatewayOwnerEvent {
  return {
    ...event(sequence),
    kind: "transcript.message.upserted",
    payload: {
      message: {
        messageId: "message-1",
        role: "assistant",
        revision: sequence,
        createdAt: 1_000,
        content: { kind: "inline", text: "" },
        blocks: [],
        ...(terminal === "error"
          ? { error: { message: "failed", retryable: true } }
          : {}),
        ...(terminal === "completion"
          ? {
              finalMarker: {
                status: "completed" as const,
                source: "engine" as const,
              },
            }
          : {}),
      },
    },
  };
}

function command(operationId = "operation-1"): BrowserGatewayOwnerCommand {
  return {
    protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
    helperGenerationId,
    ownerId: effectiveOwnerId,
    ownerGenerationId,
    operationId,
    emittedAt: 1_000,
    deadlineAt: 1_000 + BROWSER_GATEWAY_DATA_PLANE_LIMITS.commandDeadlineMs,
    deadlineClass: "default",
    idempotency: BROWSER_GATEWAY_COMMAND_IDEMPOTENCY["session.select"],
    command: { kind: "session.select", sessionId: "session-1" },
  };
}

function registrationResponse(): Response {
  return Response.json({
    ok: true,
    helperGenerationId,
    requestedOwnerId,
    effectiveOwnerId,
    resolution: "collision_assigned",
    ownerRegistration: {
      owner: { ownerId: effectiveOwnerId },
      ownerGenerationId,
      status: "connected",
      capabilities: [],
    },
  });
}

function publicationAck(body: string, duplicate = false): Response {
  const batch = JSON.parse(body) as {
    batchId: string;
    lastSequence: number;
  };
  return Response.json({
    ok: true,
    helperGenerationId,
    ownerId: effectiveOwnerId,
    ownerGenerationId,
    batchId: batch.batchId,
    cursor: batch.lastSequence,
    duplicate,
  });
}

function hangingStreamResponse(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({ start: () => undefined }),
    {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    },
  );
}

function transport(
  fetchImpl: typeof fetch,
  options: { getCheckpoint?: () => BrowserGatewayOwnerCheckpoint } = {},
) {
  return new HttpBrowserGatewayOwnerTransport({
    helperUrl: "http://127.0.0.1:47137",
    clientSharedSecret: "secret-1",
    helperGenerationId,
    owner: {
      ownerId: requestedOwnerId,
      ownerKind: "vscode",
      displayName: "Owner",
      scope: {
        kind: "workspace",
        workspaceId: "workspace-1",
        displayName: "Workspace",
      },
      ownerGenerationId,
      instanceId: "instance-1",
    },
    fetch: fetchImpl,
    now: () => 1_100,
    random: () => 0.5,
    retryBaseMs: 1,
    reconnectBaseMs: 1_000,
    getCheckpoint: options.getCheckpoint ?? (() => checkpoint()),
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("HttpBrowserGatewayOwnerTransport", () => {
  it("registers and binds subsequent traffic to the collision-assigned effective identity", async () => {
    const calls: Array<{ pathname: string; search: string; body?: string }> =
      [];
    const fetchImpl = vi.fn(async (input, init) => {
      const url = new URL(String(input));
      calls.push({
        pathname: url.pathname,
        search: url.search,
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      if (url.pathname.endsWith("/register")) return registrationResponse();
      if (url.pathname.endsWith("/commands")) return hangingStreamResponse();
      if (url.pathname.endsWith("/heartbeat"))
        return Response.json({ ok: true });
      throw new Error(`unexpected ${url.pathname}`);
    }) as typeof fetch;
    const ownerTransport = transport(fetchImpl);

    await expect(ownerTransport.register()).resolves.toEqual({
      requestedOwnerId,
      effectiveOwnerId,
      ownerGenerationId,
      helperGenerationId,
      resolution: "collision_assigned",
      dataPlaneFeatures: [],
    });
    await ownerTransport.heartbeat();

    await vi.waitFor(() =>
      expect(calls.some((call) => call.pathname.endsWith("/commands"))).toBe(
        true,
      ),
    );
    const commandCall = calls.find((call) =>
      call.pathname.endsWith("/commands"),
    );
    expect(new URLSearchParams(commandCall?.search).get("ownerId")).toBe(
      effectiveOwnerId,
    );
    expect(
      calls.find((call) => call.pathname.endsWith("/heartbeat"))?.body,
    ).toContain(`"ownerId":"${effectiveOwnerId}"`);

    await ownerTransport.close();
  });

  it("uploads generation-bound detail bytes under the effective owner identity", async () => {
    let detailRequest:
      | {
          url: URL;
          authorization: string | null;
          contentType: string | null;
          body: Buffer;
        }
      | undefined;
    const fetchImpl = vi.fn(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/register")) return registrationResponse();
      if (url.pathname.endsWith("/commands")) return hangingStreamResponse();
      if (url.pathname.endsWith("/details")) {
        detailRequest = {
          url,
          authorization: new Headers(init?.headers).get("authorization"),
          contentType: new Headers(init?.headers).get("content-type"),
          body: Buffer.from((init?.body as ArrayBuffer) ?? new ArrayBuffer(0)),
        };
        return Response.json(
          {
            ok: true,
            helperGenerationId,
            ownerId: effectiveOwnerId,
            ownerGenerationId,
            handleId: "detail-1",
          },
          { status: 201 },
        );
      }
      throw new Error(`unexpected ${url.pathname}`);
    }) as typeof fetch;
    const ownerTransport = transport(fetchImpl);
    await ownerTransport.register();
    const handle: BrowserGatewayDetailHandle = {
      helperGenerationId,
      ownerId: effectiveOwnerId,
      ownerGenerationId,
      handleId: "detail-1",
      kind: "message",
      byteLength: 5,
      expiresAt: 5_000,
      mediaType: "text/plain",
    };

    await ownerTransport.uploadDetail(handle, Buffer.from("hello"));

    expect(detailRequest?.authorization).toBe("Bearer secret-1");
    expect(detailRequest?.contentType).toBe("application/octet-stream");
    expect(detailRequest?.body).toEqual(Buffer.from("hello"));
    expect(
      JSON.parse(detailRequest?.url.searchParams.get("handle") ?? ""),
    ).toEqual(handle);
    await expect(
      ownerTransport.uploadDetail(handle, Buffer.from("bad")),
    ).rejects.toThrow("browser_gateway_detail_size_mismatch");
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    await ownerTransport.close();
  });

  it("uploads queued transcript details before publishing their checkpoint", async () => {
    vi.useFakeTimers();
    const operations: string[] = [];
    const handle: BrowserGatewayDetailHandle = {
      helperGenerationId,
      ownerId: effectiveOwnerId,
      ownerGenerationId,
      handleId: "transcript-detail-1",
      kind: "message",
      byteLength: 5,
      expiresAt: 5_000,
      mediaType: "text/plain; charset=utf-8",
    };
    const projectedCheckpoint = checkpoint();
    projectedCheckpoint.transcript.messages = [
      {
        messageId: "message-1",
        role: "user",
        revision: 1,
        createdAt: 1_000,
        content: { kind: "detail", preview: "hello", detailHandle: handle },
        blocks: [],
      },
    ];
    const fetchImpl = vi.fn(async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname.endsWith("/register")) return registrationResponse();
      if (pathname.endsWith("/commands")) return hangingStreamResponse();
      if (pathname.endsWith("/details")) {
        operations.push("detail");
        expect(
          Buffer.from(
            (init?.body as ArrayBuffer) ?? new ArrayBuffer(0),
          ).toString("utf-8"),
        ).toBe("hello");
        return Response.json(
          {
            ok: true,
            helperGenerationId,
            ownerId: effectiveOwnerId,
            ownerGenerationId,
            handleId: handle.handleId,
          },
          { status: 201 },
        );
      }
      if (pathname.endsWith("/publications")) {
        operations.push("publication");
        return publicationAck(String(init?.body));
      }
      throw new Error(`unexpected ${pathname}`);
    }) as typeof fetch;
    const ownerTransport = transport(fetchImpl);
    await ownerTransport.register();

    ownerTransport.enqueue({
      kind: "checkpoint",
      checkpoint: projectedCheckpoint,
      details: [{ handle, content: Buffer.from("hello") }],
    });
    await vi.advanceTimersByTimeAsync(
      BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerPublicationBatchWindowMs,
    );
    await vi.waitFor(() =>
      expect(operations).toEqual(["detail", "publication"]),
    );

    await ownerTransport.close();
  });

  it("does not publish an envelope when its queued detail upload fails", async () => {
    vi.useFakeTimers();
    let detailCalls = 0;
    const publicationBodies: string[] = [];
    const handle: BrowserGatewayDetailHandle = {
      helperGenerationId,
      ownerId: effectiveOwnerId,
      ownerGenerationId,
      handleId: "failed-detail",
      kind: "message",
      byteLength: 5,
      expiresAt: 5_000,
    };
    const fetchImpl = vi.fn(async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname.endsWith("/register")) return registrationResponse();
      if (pathname.endsWith("/commands")) return hangingStreamResponse();
      if (pathname.endsWith("/details")) {
        detailCalls += 1;
        return Response.json({ error: "detail_rejected" }, { status: 400 });
      }
      if (pathname.endsWith("/publications")) {
        const body = String(init?.body);
        publicationBodies.push(body);
        return publicationAck(body);
      }
      throw new Error(`unexpected ${pathname}`);
    }) as typeof fetch;
    const ownerTransport = transport(fetchImpl);
    await ownerTransport.register();

    ownerTransport.enqueue({
      kind: "checkpoint",
      checkpoint: checkpoint(),
      details: [{ handle, content: Buffer.from("hello") }],
    });
    await vi.advanceTimersByTimeAsync(
      BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerPublicationBatchWindowMs,
    );
    await vi.waitFor(() => expect(detailCalls).toBe(1));
    expect(publicationBodies).toEqual([]);
    const closing = expect(ownerTransport.close()).rejects.toThrow(
      "owner_detail_upload",
    );
    await vi.runAllTimersAsync();
    await closing;
    expect(publicationBodies).toHaveLength(1);
    expect(publicationBodies[0]).not.toContain(handle.handleId);
  });

  it("retries registration after a lost response with the same requested identity", async () => {
    vi.useFakeTimers();
    const registrationBodies: string[] = [];
    const fetchImpl = vi.fn(async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname.endsWith("/register")) {
        registrationBodies.push(String(init?.body));
        if (registrationBodies.length === 1)
          throw new TypeError("response_lost");
        return registrationResponse();
      }
      if (pathname.endsWith("/commands")) return hangingStreamResponse();
      throw new Error(`unexpected ${pathname}`);
    }) as typeof fetch;
    const ownerTransport = transport(fetchImpl);

    const registering = ownerTransport.register();
    await vi.advanceTimersByTimeAsync(1);
    await expect(registering).resolves.toMatchObject({ effectiveOwnerId });
    expect(registrationBodies).toHaveLength(2);
    expect(registrationBodies[1]).toBe(registrationBodies[0]);

    await ownerTransport.close();
  });

  it("serializes direct publication calls", async () => {
    let resolveFirst!: (response: Response) => void;
    const firstPublication = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const publicationBodies: string[] = [];
    const fetchImpl = vi.fn(async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname.endsWith("/register")) return registrationResponse();
      if (pathname.endsWith("/commands")) return hangingStreamResponse();
      if (pathname.endsWith("/publications")) {
        const body = String(init?.body);
        publicationBodies.push(body);
        if (publicationBodies.length === 1) return firstPublication;
        return publicationAck(body);
      }
      throw new Error(`unexpected ${pathname}`);
    }) as typeof fetch;
    const ownerTransport = transport(fetchImpl);
    await ownerTransport.register();
    const firstBatch: BrowserGatewayOwnerPublicationBatch = {
      protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
      helperGenerationId,
      ownerId: effectiveOwnerId,
      ownerGenerationId,
      batchId: "direct-1",
      firstSequence: 0,
      lastSequence: 0,
      checkpoint: checkpoint(),
      events: [],
    };
    const secondBatch: BrowserGatewayOwnerPublicationBatch = {
      ...firstBatch,
      batchId: "direct-2",
      firstSequence: 1,
      lastSequence: 1,
      checkpoint: null,
      events: [event(1)],
    };

    const first = ownerTransport.publish(firstBatch);
    const second = ownerTransport.publish(secondBatch);
    await Promise.resolve();
    expect(publicationBodies).toHaveLength(1);
    resolveFirst(publicationAck(publicationBodies[0]));
    await first;
    await second;
    expect(publicationBodies).toHaveLength(2);

    await ownerTransport.close();
  });

  it("flushes terminal transcript messages immediately while batching ordinary upserts", async () => {
    vi.useFakeTimers();
    const publicationBodies: string[] = [];
    const fetchImpl = vi.fn(async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname.endsWith("/register")) return registrationResponse();
      if (pathname.endsWith("/commands")) return hangingStreamResponse();
      if (pathname.endsWith("/publications")) {
        const body = String(init?.body);
        publicationBodies.push(body);
        return publicationAck(body);
      }
      throw new Error(`unexpected ${pathname}`);
    }) as typeof fetch;
    const ownerTransport = transport(fetchImpl);
    await ownerTransport.register();

    ownerTransport.enqueue({
      kind: "event",
      event: transcriptEvent(1, null),
    });
    await Promise.resolve();
    expect(publicationBodies).toEqual([]);
    await vi.advanceTimersByTimeAsync(
      BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerPublicationBatchWindowMs,
    );
    await vi.waitFor(() => expect(publicationBodies).toHaveLength(1));

    ownerTransport.enqueue({
      kind: "event",
      event: transcriptEvent(2, "error"),
    });
    await vi.waitFor(() => expect(publicationBodies).toHaveLength(2));
    ownerTransport.enqueue({
      kind: "event",
      event: transcriptEvent(3, "completion"),
    });
    await vi.waitFor(() => expect(publicationBodies).toHaveLength(3));

    expect(
      publicationBodies.map((body) =>
        (JSON.parse(body) as BrowserGatewayOwnerPublicationBatch).events.map(
          ({ ownerSequence }) => ownerSequence,
        ),
      ),
    ).toEqual([[1], [2], [3]]);
    await ownerTransport.close();
  });

  it("batches projection publications for 50ms and sends batches single-flight", async () => {
    vi.useFakeTimers();
    const publicationBodies: string[] = [];
    let resolveFirst!: (response: Response) => void;
    const firstPublication = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const fetchImpl = vi.fn(async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname.endsWith("/register")) return registrationResponse();
      if (pathname.endsWith("/commands")) return hangingStreamResponse();
      if (pathname.endsWith("/publications")) {
        const body = String(init?.body);
        publicationBodies.push(body);
        if (publicationBodies.length === 1) return firstPublication;
        return publicationAck(body);
      }
      throw new Error(`unexpected ${pathname}`);
    }) as typeof fetch;
    const ownerTransport = transport(fetchImpl);
    await ownerTransport.register();

    ownerTransport.enqueue({ kind: "checkpoint", checkpoint: checkpoint() });
    ownerTransport.enqueue({ kind: "event", event: event(1) });
    expect(ownerTransport.getPublicationBacklog()).toMatchObject({
      pendingBatches: 1,
      queuedBytes: expect.any(Number),
    });
    await vi.advanceTimersByTimeAsync(49);
    expect(publicationBodies).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(publicationBodies).toHaveLength(1);
    expect(ownerTransport.getPublicationBacklog().pendingBatches).toBe(1);

    ownerTransport.enqueue({ kind: "event", event: event(2) });
    await vi.advanceTimersByTimeAsync(50);
    expect(publicationBodies).toHaveLength(1);
    expect(ownerTransport.getPublicationBacklog().pendingBatches).toBe(2);

    resolveFirst(publicationAck(publicationBodies[0]));
    await vi.waitFor(() => expect(publicationBodies).toHaveLength(2));
    expect(JSON.parse(publicationBodies[0])).toMatchObject({
      firstSequence: 1,
      lastSequence: 1,
      checkpoint: { checkpointSequence: 0 },
      events: [{ ownerSequence: 1 }],
    });
    expect(JSON.parse(publicationBodies[1])).toMatchObject({
      firstSequence: 2,
      lastSequence: 2,
    });

    await ownerTransport.close();
    expect(ownerTransport.getPublicationBacklog()).toEqual({
      pendingBatches: 0,
      queuedBytes: 0,
    });
  });

  it("does not retry malformed publication acknowledgements", async () => {
    let publicationCalls = 0;
    const fetchImpl = vi.fn(async (input) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname.endsWith("/register")) return registrationResponse();
      if (pathname.endsWith("/commands")) return hangingStreamResponse();
      if (pathname.endsWith("/publications")) {
        publicationCalls += 1;
        return Response.json({ ok: true, cursor: 0 });
      }
      throw new Error(`unexpected ${pathname}`);
    }) as typeof fetch;
    const ownerTransport = transport(fetchImpl);
    await ownerTransport.register();

    await expect(
      ownerTransport.publish({
        protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
        helperGenerationId,
        ownerId: effectiveOwnerId,
        ownerGenerationId,
        batchId: "malformed-ack",
        firstSequence: 0,
        lastSequence: 0,
        checkpoint: checkpoint(),
        events: [],
      }),
    ).rejects.toThrow("browser_gateway_invalid_publication_duplicate");
    expect(publicationCalls).toBe(1);

    await ownerTransport.close();
  });

  it("retries the identical publication batch after a lost response", async () => {
    vi.useFakeTimers();
    const publicationBodies: string[] = [];
    const fetchImpl = vi.fn(async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname.endsWith("/register")) return registrationResponse();
      if (pathname.endsWith("/commands")) return hangingStreamResponse();
      if (pathname.endsWith("/publications")) {
        const body = String(init?.body);
        publicationBodies.push(body);
        if (publicationBodies.length === 1)
          throw new TypeError("response_lost");
        return publicationAck(body, true);
      }
      throw new Error(`unexpected ${pathname}`);
    }) as typeof fetch;
    const ownerTransport = transport(fetchImpl);
    await ownerTransport.register();

    ownerTransport.enqueue({ kind: "checkpoint", checkpoint: checkpoint() });
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(publicationBodies).toHaveLength(2));
    expect(publicationBodies[1]).toBe(publicationBodies[0]);

    await ownerTransport.close();
  });

  it("rejects a recovery checkpoint older than the acknowledged cursor", async () => {
    vi.useFakeTimers();
    const publicationBodies: string[] = [];
    const fetchImpl = vi.fn(async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname.endsWith("/register")) return registrationResponse();
      if (pathname.endsWith("/commands")) return hangingStreamResponse();
      if (pathname.endsWith("/publications")) {
        const body = String(init?.body);
        publicationBodies.push(body);
        return publicationAck(body);
      }
      throw new Error(`unexpected ${pathname}`);
    }) as typeof fetch;
    let recoverySequence = 1;
    const ownerTransport = transport(fetchImpl, {
      getCheckpoint: () => checkpoint(recoverySequence),
    });
    await ownerTransport.register();

    ownerTransport.enqueue({ kind: "event", event: event(2) });
    await vi.advanceTimersByTimeAsync(
      BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerPublicationBatchWindowMs,
    );
    await vi.waitFor(() => expect(publicationBodies).toHaveLength(1));

    const largeDelta = (sequence: number): BrowserGatewayOwnerEvent => ({
      ...event(sequence),
      kind: "transcript.block.delta",
      payload: {
        messageId: "message-1",
        blockId: "block-1",
        field: "text",
        delta: "x".repeat(200_000),
        revision: sequence,
      },
    });
    ownerTransport.enqueue({ kind: "event", event: largeDelta(3) });
    ownerTransport.enqueue({ kind: "event", event: largeDelta(4) });
    expect(() =>
      ownerTransport.enqueue({ kind: "event", event: largeDelta(5) }),
    ).toThrow("browser_gateway_stale_recovery_checkpoint");

    recoverySequence = 5;
    ownerTransport.enqueue({ kind: "event", event: event(6) });
    const closing = ownerTransport.close();
    await vi.runAllTimersAsync();
    await closing;
    expect(JSON.parse(publicationBodies.at(-1) ?? "{}")).toMatchObject({
      checkpoint: { checkpointSequence: 5 },
      events: [],
    });
  });

  it("compacts an overflowing queued delta tail to a fresh checkpoint", async () => {
    vi.useFakeTimers();
    const publicationBodies: string[] = [];
    let resolveFirst!: (response: Response) => void;
    const firstPublication = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const freshCheckpoint = checkpoint(10);
    const fetchImpl = vi.fn(async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname.endsWith("/register")) return registrationResponse();
      if (pathname.endsWith("/commands")) return hangingStreamResponse();
      if (pathname.endsWith("/publications")) {
        const body = String(init?.body);
        publicationBodies.push(body);
        if (publicationBodies.length === 1) return firstPublication;
        return publicationAck(body);
      }
      throw new Error(`unexpected ${pathname}`);
    }) as typeof fetch;
    const ownerTransport = transport(fetchImpl, {
      getCheckpoint: () => freshCheckpoint,
    });
    await ownerTransport.register();

    ownerTransport.enqueue({ kind: "checkpoint", checkpoint: checkpoint() });
    await vi.advanceTimersByTimeAsync(50);
    expect(publicationBodies).toHaveLength(1);

    for (let sequence = 1; sequence <= 3; sequence += 1) {
      ownerTransport.enqueue({
        kind: "event",
        event: {
          ...event(sequence),
          kind: "transcript.block.delta",
          payload: {
            messageId: "message-1",
            blockId: `block-${sequence}`,
            field: "text",
            delta: "x".repeat(200_000),
            revision: sequence,
          },
        },
      });
    }

    resolveFirst(publicationAck(publicationBodies[0]));
    await vi.waitFor(() => expect(publicationBodies).toHaveLength(2));
    expect(JSON.parse(publicationBodies[1])).toMatchObject({
      firstSequence: 10,
      lastSequence: 10,
      checkpoint: { checkpointSequence: 10 },
      events: [],
    });

    await ownerTransport.close();
  });

  it("parses command SSE frames, dispatches current commands, and posts acknowledgements", async () => {
    const encoder = new TextEncoder();
    let commandStreamController!: ReadableStreamDefaultController<Uint8Array>;
    const commandStream = new ReadableStream<Uint8Array>({
      start(controller) {
        commandStreamController = controller;
      },
    });
    const acknowledgementBodies: string[] = [];
    const fetchImpl = vi.fn(async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname.endsWith("/register")) return registrationResponse();
      if (pathname.endsWith("/commands")) {
        return new Response(commandStream, {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      if (pathname.endsWith("/acknowledgements")) {
        acknowledgementBodies.push(String(init?.body));
        return Response.json({ ok: true });
      }
      throw new Error(`unexpected ${pathname}`);
    }) as typeof fetch;
    const ownerTransport = transport(fetchImpl);
    const received: BrowserGatewayOwnerCommand[] = [];
    const controls: string[] = [];
    ownerTransport.onCommand((value) => {
      received.push(value);
    });
    ownerTransport.onControl((value) => {
      controls.push(value.kind);
    });
    await ownerTransport.register();
    await vi.waitFor(() => expect(commandStreamController).toBeTruthy());

    commandStreamController.enqueue(
      encoder.encode(
        `event: control\ndata: ${JSON.stringify({
          protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
          helperGenerationId,
          ownerId: effectiveOwnerId,
          ownerGenerationId,
          kind: "hello",
          emittedAt: 1_000,
          payload: { publicationCursor: 0, subscriberCount: 0 },
        })}\n\nevent: command\ndata: ${JSON.stringify(command())}\n\n`,
      ),
    );
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(controls).toEqual(["hello"]);

    await ownerTransport.acknowledge({
      protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
      helperGenerationId,
      ownerId: effectiveOwnerId,
      ownerGenerationId,
      operation: {
        operationId: "operation-1",
        kind: "session.select",
        state: "completed",
      },
      acknowledgedAt: 1_200,
    });
    expect(acknowledgementBodies[0]).toContain('"operationId":"operation-1"');

    commandStreamController.enqueue(
      encoder.encode(`event: command\ndata: ${JSON.stringify(command())}\n\n`),
    );
    await vi.waitFor(() => expect(acknowledgementBodies).toHaveLength(2));
    expect(received).toHaveLength(1);
    expect(acknowledgementBodies[1]).toBe(acknowledgementBodies[0]);

    commandStreamController.close();
    await ownerTransport.close();
  });

  it("rejects mismatched generation acknowledgements and drains queued publications on close", async () => {
    vi.useFakeTimers();
    const publicationBodies: string[] = [];
    const fetchImpl = vi.fn(async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname.endsWith("/register")) return registrationResponse();
      if (pathname.endsWith("/commands")) return hangingStreamResponse();
      if (pathname.endsWith("/publications")) {
        const body = String(init?.body);
        publicationBodies.push(body);
        return publicationAck(body);
      }
      throw new Error(`unexpected ${pathname}`);
    }) as typeof fetch;
    const ownerTransport = transport(fetchImpl);
    await ownerTransport.register();

    expect(() =>
      ownerTransport.acknowledge({
        protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
        helperGenerationId: "stale-helper",
        ownerId: effectiveOwnerId,
        ownerGenerationId,
        operation: {
          operationId: "operation-1",
          kind: "session.select",
          state: "completed",
        },
        acknowledgedAt: 1_200,
      }),
    ).toThrow("browser_gateway_helper_generation_mismatch");

    ownerTransport.enqueue({ kind: "checkpoint", checkpoint: checkpoint() });
    const closing = ownerTransport.close();
    await vi.runAllTimersAsync();
    await closing;
    expect(publicationBodies).toHaveLength(1);
  });
});
