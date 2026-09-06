import { describe, expect, it, vi } from "vitest";

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createNodeHostMcpResourcePromptProvider } from "./mcpResourcePrompts.js";

const principal = { tenantId: "tenant-a", subjectId: "subject-a" };
const discovery = {
  principal,
  sessionId: "session-a",
  turnId: "turn-a",
};

function fixtureClient(overrides: Partial<Client> = {}): Client {
  return {
    listResources: vi.fn(async ({ cursor } = {}) =>
      cursor
        ? {
            resources: [
              { uri: "fixture://two", name: "Two", mimeType: "text/plain" },
            ],
          }
        : {
            resources: [
              {
                uri: "fixture://one",
                name: "One",
                description: "First fixture",
              },
            ],
            nextCursor: "page-2",
          },
    ),
    listPrompts: vi.fn(async () => ({
      prompts: [
        {
          name: "summarize",
          description: "Summarize a topic.",
          arguments: [{ name: "topic", required: true }],
        },
      ],
    })),
    readResource: vi.fn(async () => ({
      contents: [
        { uri: "fixture://one", text: "resource body", mimeType: "text/plain" },
        { uri: "fixture://image", blob: "aW1hZ2U=", mimeType: "image/png" },
      ],
    })),
    getPrompt: vi.fn(async () => ({
      messages: [
        { role: "user", content: { type: "text", text: "Summarize MCP" } },
        { role: "assistant", content: { type: "image", data: "fixture" } },
      ],
    })),
    close: vi.fn(async () => {}),
    ...overrides,
  } as unknown as Client;
}

describe("node host MCP resources and prompts", () => {
  it("captures bounded catalogs and uses fresh operation connections", async () => {
    const clients = [fixtureClient(), fixtureClient(), fixtureClient()];
    const connect = vi.fn(async () => clients.shift()!);
    const provider = await createNodeHostMcpResourcePromptProvider({
      discovery,
      connections: [{ serverName: "fixture", connect }],
    });

    expect(provider.listResources()).toEqual([
      {
        serverName: "fixture",
        uri: "fixture://one",
        name: "One",
        description: "First fixture",
      },
      {
        serverName: "fixture",
        uri: "fixture://two",
        name: "Two",
        mimeType: "text/plain",
      },
    ]);
    expect(provider.listPrompts()).toEqual([
      {
        serverName: "fixture",
        name: "summarize",
        description: "Summarize a topic.",
        arguments: [{ name: "topic", required: true }],
      },
    ]);

    await expect(
      provider.readResource({
        ...discovery,
        serverName: "fixture",
        uri: "fixture://one",
      }),
    ).resolves.toEqual({
      content: [
        { type: "text", text: "resource body" },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
      ],
    });
    await expect(
      provider.getPrompt({
        ...discovery,
        serverName: "fixture",
        name: "summarize",
        arguments: { topic: "MCP" },
      }),
    ).resolves.toEqual({
      content: [
        { type: "text", text: "user: Summarize MCP\n\nassistant: [image]" },
      ],
    });
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it("isolates unavailable servers and bounds catalog/result content", async () => {
    const provider = await createNodeHostMcpResourcePromptProvider({
      discovery,
      maxCatalogPages: 1,
      maxCatalogItems: 1,
      maxResultChars: 5,
      connections: [
        {
          serverName: "offline",
          connect: async () => {
            throw new Error("offline secret detail");
          },
        },
        {
          serverName: "fixture",
          connect: async () =>
            fixtureClient({
              readResource: vi.fn(async () => ({
                contents: [{ uri: "fixture://one", text: "0123456789" }],
              })) as Client["readResource"],
            }),
        },
      ],
    });

    expect(provider.listResources()).toHaveLength(1);
    await expect(
      provider.readResource({
        ...discovery,
        serverName: "fixture",
        uri: "fixture://one",
      }),
    ).resolves.toMatchObject({ content: [{ type: "text", text: "0123…" }] });
    await expect(
      provider.readResource({
        ...discovery,
        serverName: "unknown",
        uri: "fixture://one",
      }),
    ).resolves.toMatchObject({
      isError: true,
      error: { kind: "mcp_resource_not_available" },
    });
  });
});
