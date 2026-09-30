import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canRedispatchResponses,
  ResponsesTransportInterruptedError,
  ResponsesWebSocketConnectError,
  ResponsesWebSocketRejectionError,
  type ResponsesDispatchEvidence,
  type ResponsesWebSocketConnectRequest,
} from "@agentlink/core/codex";
import { createResponsesWebSocketConnector } from "./responsesWebSocket.js";

class FakeSocket extends EventEmitter {
  static instances: FakeSocket[] = [];
  static autoOpen = true;
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;
  readonly OPEN = FakeSocket.OPEN;
  readonly CLOSED = FakeSocket.CLOSED;
  readyState = FakeSocket.CONNECTING;
  sent: string[] = [];
  options: Record<string, unknown>;
  upgradeReq = { headers: { "x-codex-turn-state": "route-token" } };

  constructor(
    readonly url: string,
    options: Record<string, unknown>,
  ) {
    super();
    this.options = options;
    FakeSocket.instances.push(this);
    if (FakeSocket.autoOpen) {
      queueMicrotask(() => {
        this.readyState = FakeSocket.OPEN;
        this.emit("upgrade", this.upgradeReq);
        this.emit("open");
      });
    }
  }

  send(value: string, callback?: (error?: Error) => void): void {
    this.sent.push(value);
    callback?.();
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED;
    queueMicrotask(() => this.emit("close"));
  }

  terminate(): void {
    this.readyState = FakeSocket.CLOSED;
    this.emit("close");
  }

  frame(value: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(value)));
  }
}

const baseRequest = (): ResponsesWebSocketConnectRequest => ({
  url: "wss://api.openai.com/v1/responses",
  headers: { authorization: "Bearer test" },
  handshakeTimeoutMs: 15_000,
});

function evidence(): ResponsesDispatchEvidence {
  return { transport: "websocket", phase: "not_sent" };
}

function openConnector() {
  FakeSocket.instances = [];
  const connector = createResponsesWebSocketConnector({
    WebSocket: FakeSocket as never,
    getProxyForUrl: () => "",
  });
  return connector.connect(baseRequest());
}

beforeEach(() => {
  FakeSocket.instances = [];
  FakeSocket.autoOpen = true;
});

afterEach(() => vi.unstubAllEnvs());

describe("Node Responses WebSocket connector", () => {
  it("honours HTTP_PROXY-only environments and NO_PROXY on HTTPS port 443", async () => {
    vi.stubEnv("https_proxy", "");
    vi.stubEnv("HTTPS_PROXY", "");
    vi.stubEnv("http_proxy", "");
    vi.stubEnv("HTTP_PROXY", "http://proxy.example:8080");
    vi.stubEnv("all_proxy", "");
    vi.stubEnv("ALL_PROXY", "");
    vi.stubEnv("no_proxy", "");
    vi.stubEnv("NO_PROXY", "");
    const connector = createResponsesWebSocketConnector({
      WebSocket: FakeSocket as never,
    });
    const connection = await connector.connect(baseRequest());
    expect(FakeSocket.instances[0].options.agent).toBeDefined();
    connection.close();
    vi.stubEnv("NO_PROXY", "api.openai.com:443");
    const direct = await connector.connect(baseRequest());
    expect(FakeSocket.instances[1].options.agent).toBeUndefined();
    direct.close();
  });

  it.each(["context_length_exceeded", "context_window_exceeded"])(
    "recognises definitive pre-start %s rejection",
    async (code) => {
      const connection = await openConnector();
      const proof = evidence();
      const iterator = connection
        .dispatch({ body: { model: "gpt-test" }, evidence: proof })
        [Symbol.asyncIterator]();
      const pending = iterator.next();
      FakeSocket.instances[0].frame({
        type: "error",
        error: {
          type: "invalid_request_error",
          code,
          message: "Context too long",
        },
      });
      await expect(pending).rejects.toMatchObject({
        code,
        verifiedRejection: true,
      });
      expect(canRedispatchResponses(proof)).toBe(true);
      connection.close();
    },
  );

  it("records an authoritative terminal failure without permitting completed-response replay", async () => {
    const connection = await openConnector();
    const proof = evidence();
    const iterator = connection
      .dispatch({ body: { model: "gpt-test" }, evidence: proof })
      [Symbol.asyncIterator]();
    const pending = iterator.next();
    FakeSocket.instances[0].frame({
      type: "response.failed",
      response: { error: { code: "context_length_exceeded" } },
    });
    expect((await pending).value).toMatchObject({ type: "response.failed" });
    expect(canRedispatchResponses(proof)).toBe(true);
    expect(
      canRedispatchResponses({
        transport: "websocket",
        phase: "terminal",
        terminalFailure: false,
      }),
    ).toBe(false);
    connection.close();
  });
  it("limits destination, payload and redirects, then resolves only on terminal events", async () => {
    const pending = openConnector();
    const connection = await pending;
    const socket = FakeSocket.instances[0];
    expect(socket.options).toMatchObject({
      handshakeTimeout: 15_000,
      maxPayload: 16 * 1024 * 1024,
      followRedirects: false,
      rejectUnauthorized: true,
    });
    expect(connection.headers.get("x-codex-turn-state")).toBe("route-token");

    const proof = evidence();
    const received: unknown[] = [];
    const iterator = connection
      .dispatch({
        body: { model: "gpt-test", input: [] },
        evidence: proof,
      })
      [Symbol.asyncIterator]();
    const first = iterator.next();
    socket.frame({ type: "response.created" });
    expect((await first).value).toEqual({ type: "response.created" });
    expect(proof.phase).toBe("response_started");
    const terminal = iterator.next();
    socket.frame({ type: "response.completed", response: { id: "resp_1" } });
    received.push((await terminal).value);
    expect(received[0]).toMatchObject({ type: "response.completed" });
    expect(proof.phase).toBe("terminal");
    expect(JSON.parse(socket.sent[0])).toEqual({
      type: "response.create",
      model: "gpt-test",
      input: [],
    });
    connection.close();
  });

  it("classifies known rejection narrowly and unknown post-send close as an interruption", async () => {
    const connection = await openConnector();
    const socket = FakeSocket.instances[0];
    const proof = evidence();
    const iterator = connection
      .dispatch({
        body: { model: "gpt-test" },
        evidence: proof,
      })
      [Symbol.asyncIterator]();
    const pending = iterator.next();
    socket.frame({
      type: "error",
      error: {
        status: 400,
        code: "invalid_request_error",
        message: "bad input",
      },
    });
    await expect(pending).rejects.toBeInstanceOf(
      ResponsesWebSocketRejectionError,
    );
    expect(proof.verifiedRejection).toBe(true);
    connection.close();

    const next = await openConnector();
    const secondSocket = FakeSocket.instances[0];
    const secondProof = evidence();
    const secondIterator = next
      .dispatch({
        body: { model: "gpt-test" },
        evidence: secondProof,
      })
      [Symbol.asyncIterator]();
    const waiting = secondIterator.next();
    secondSocket.terminate();
    await expect(waiting).rejects.toBeInstanceOf(
      ResponsesTransportInterruptedError,
    );
    expect(secondProof.phase).toBe("sent_unacknowledged");
  });

  it("surfaces handshake status and permits only 426/network fallback", async () => {
    FakeSocket.autoOpen = false;
    const connector = createResponsesWebSocketConnector({
      WebSocket: FakeSocket as never,
      getProxyForUrl: () => "",
    });
    const pending = connector.connect(baseRequest());
    await Promise.resolve();
    const socket = FakeSocket.instances[0];
    const response = new EventEmitter() as EventEmitter & {
      statusCode: number;
      headers: object;
    };
    response.statusCode = 401;
    response.headers = { "x-request-id": "req" };
    socket.emit("unexpected-response", socket, response);
    response.emit("data", Buffer.from('{"error":"unauthorized"}'));
    response.emit("end");
    await expect(pending).rejects.toMatchObject({
      fallbackAllowed: false,
      status: 401,
      headers: expect.any(Headers),
      body: { error: "unauthorized" },
    } satisfies Partial<ResponsesWebSocketConnectError>);
  });

  it("rejects non-first-party endpoints without opening a socket", async () => {
    const connector = createResponsesWebSocketConnector({
      WebSocket: FakeSocket as never,
      getProxyForUrl: vi.fn(() => ""),
    });
    await expect(
      connector.connect({
        ...baseRequest(),
        url: "wss://evil.example/responses",
      }),
    ).rejects.toMatchObject({ fallbackAllowed: false });
    expect(FakeSocket.instances).toHaveLength(0);
  });
});
