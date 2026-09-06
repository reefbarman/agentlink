import { beforeEach, describe, expect, it, vi } from "vitest";

import { createNodeHostMcpClient } from "./mcpElicitation.js";

const mocks = vi.hoisted(() => ({
  capabilities: [] as unknown[],
  handler: undefined as
    | ((request: { params: Record<string, unknown> }) => Promise<unknown>)
    | undefined,
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    constructor(_implementation: unknown, options: unknown) {
      mocks.capabilities.push(options);
    }

    setRequestHandler(
      _schema: unknown,
      handler: (request: {
        params: Record<string, unknown>;
      }) => Promise<unknown>,
    ): void {
      mocks.handler = handler;
    }
  },
}));

const context = {
  principal: { tenantId: "tenant-a", subjectId: "subject-a" },
  sessionId: "session-a",
  turnId: "turn-a",
};

function createClient(
  onElicitation: Parameters<typeof createNodeHostMcpClient>[0]["onElicitation"],
  signal?: AbortSignal,
): void {
  createNodeHostMcpClient({
    clientName: "fixture",
    clientVersion: "1.0.0",
    serverName: "records",
    context: { ...context, signal },
    onElicitation,
  });
}

describe("node host MCP elicitation", () => {
  beforeEach(() => {
    mocks.capabilities.length = 0;
    mocks.handler = undefined;
  });

  it("advertises form support, normalizes the schema, and returns validated values", async () => {
    const onElicitation = vi.fn(async () => ({
      action: "accept" as const,
      content: { count: "2", role: "dev" },
    }));
    createClient(onElicitation);

    expect(mocks.capabilities).toEqual([
      { capabilities: { elicitation: { form: { applyDefaults: true } } } },
    ]);
    const result = await mocks.handler?.({
      params: {
        mode: "form",
        message: "Configure access",
        requestedSchema: {
          type: "object",
          properties: {
            count: { type: "integer", minimum: 1 },
            role: { type: "string", enum: ["dev", "ops"] },
          },
          required: ["count", "role"],
        },
      },
    });

    expect(onElicitation).toHaveBeenCalledWith({
      ...context,
      signal: undefined,
      serverName: "records",
      message: "Configure access",
      fields: [
        expect.objectContaining({
          name: "count",
          kind: "integer",
          required: true,
        }),
        expect.objectContaining({
          name: "role",
          kind: "single-select",
          required: true,
        }),
      ],
    });
    expect(result).toEqual({
      action: "accept",
      content: { count: 2, role: "dev" },
    });
  });

  it("declines URL mode and malformed or invalid form responses", async () => {
    const onElicitation = vi.fn(async () => ({
      action: "accept" as const,
      content: { count: "not-a-number" },
    }));
    createClient(onElicitation);

    await expect(
      mocks.handler?.({
        params: {
          mode: "url",
          message: "Authenticate",
          url: "https://example.test/auth",
          elicitationId: "url-1",
        },
      }),
    ).resolves.toEqual({ action: "decline" });
    expect(onElicitation).not.toHaveBeenCalled();

    await expect(
      mocks.handler?.({
        params: {
          mode: "form",
          message: "Malformed",
          requestedSchema: { type: "array" },
        },
      }),
    ).resolves.toEqual({ action: "decline" });

    await expect(
      mocks.handler?.({
        params: {
          mode: "form",
          message: "Invalid response",
          requestedSchema: {
            type: "object",
            properties: { count: { type: "integer" } },
            required: ["count"],
          },
        },
      }),
    ).resolves.toEqual({ action: "decline" });
  });

  it("cancels promptly while the host form response is pending", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    createClient(async () => {
      started();
      return await new Promise(() => {});
    }, controller.signal);
    const result = mocks.handler?.({
      params: {
        mode: "form",
        message: "Pending",
        requestedSchema: { type: "object", properties: {} },
      },
    });
    await didStart;

    controller.abort();

    await expect(result).resolves.toEqual({ action: "cancel" });
  });

  it("cancels without invoking the host when the turn is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const onElicitation = vi.fn();
    createClient(onElicitation, controller.signal);

    await expect(
      mocks.handler?.({
        params: {
          mode: "form",
          message: "Cancelled",
          requestedSchema: { type: "object", properties: {} },
        },
      }),
    ).resolves.toEqual({ action: "cancel" });
    expect(onElicitation).not.toHaveBeenCalled();
  });

  it("does not advertise elicitation or install a handler without a host callback", () => {
    createClient(undefined);

    expect(mocks.capabilities).toEqual([{ capabilities: {} }]);
    expect(mocks.handler).toBeUndefined();
  });
});
