import type { HostTool, HostToolExecutionContext } from "@agentlink/core";
import { WebImageError, type PublicWebPageFetcher } from "@agentlink/node-host";
import { describe, expect, it, vi } from "vitest";

import type { CliWebConfig } from "./types.js";
import {
  createCliWebTools,
  type CreateCliWebToolsOptions,
} from "./webTools.js";

function context(providerId: string): HostToolExecutionContext {
  return {
    principal: {
      id: "owner",
    } as unknown as HostToolExecutionContext["principal"],
    sessionId: "session-1",
    turnId: "turn-1",
    model: { model: { providerId, modelId: "gpt-x" }, source: "session" },
    signal: undefined,
  } as HostToolExecutionContext;
}

function pageFetcher(): PublicWebPageFetcher & {
  fetchPage: ReturnType<typeof vi.fn>;
} {
  return {
    fetchPage: vi.fn(async ({ url }: { url: string }) => ({
      url,
      status: 200,
      contentType: "text/plain",
      text: "page text",
      bodyTruncated: false,
    })),
    dispose: async () => undefined,
  };
}

async function resolve(
  web: CliWebConfig,
  options: Partial<CreateCliWebToolsOptions> = {},
): Promise<Map<string, HostTool>> {
  const resolver = createCliWebTools({
    web,
    codexProviderIds: new Set(["codex"]),
    ...options,
  });
  return new Map(
    (await resolver({} as never)).map((tool) => [tool.definition.name, tool]),
  );
}

describe("createCliWebTools", () => {
  it("always offers web_fetch, and web_search when a backend exists", async () => {
    expect([...(await resolve({})).keys()]).toEqual(["web_fetch"]);
    expect([
      ...(
        await resolve(
          {},
          { codexCredentials: { resolveAuth: async () => null } },
        )
      ).keys(),
    ]).toEqual(["web_fetch", "web_search"]);
  });

  it("reads pages through the public page fetcher", async () => {
    const fetcher = pageFetcher();
    const tools = await resolve({}, { pageFetcher: fetcher });
    const result = await tools
      .get("web_fetch")!
      .execute({ url: "https://example.com/" }, context("codex"));
    expect(fetcher.fetchPage).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://example.com/" }),
    );
    expect(result.modelContent).toContain("page text");
  });

  it("shows transport refusals to the model", async () => {
    const fetcher = pageFetcher();
    fetcher.fetchPage.mockRejectedValueOnce(
      new WebImageError("blocked_destination", "private hosts are blocked"),
    );
    const result = await (
      await resolve({}, { pageFetcher: fetcher })
    )
      .get("web_fetch")!
      .execute({ url: "https://intranet.example/" }, context("codex"));
    expect(result).toMatchObject({
      isError: true,
      modelContent: "private hosts are blocked",
    });
  });

  it("searches with the CLI's Codex sign-in for Codex models", async () => {
    const resolveAuth = vi.fn(async () => ({
      method: "oauth" as const,
      bearerToken: "token",
      canRefresh: false,
    }));
    const codexSearch = vi.fn(async () => ({
      backend: "provider" as const,
      provider: "codex",
      operation: "search" as const,
      input: {},
      activities: [],
      content: "results",
      citations: [],
    }));
    const tools = await resolve(
      {},
      { codexCredentials: { resolveAuth }, codexSearch },
    );
    const result = await tools
      .get("web_search")!
      .execute({ query: "agentlink" }, context("codex"));
    expect(result.modelContent).toBe("results");
    expect(resolveAuth).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "nativeWeb" }),
    );
    expect(codexSearch).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-x", sessionId: "session-1" }),
    );
  });

  it("uses the configured SearXNG for other models", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            results: [{ title: "One", url: "https://one.example/" }],
          }),
        ),
    );
    const tools = await resolve(
      { searxngUrl: "http://192.168.1.10:8080" },
      { fetch: fetch as unknown as typeof globalThis.fetch },
    );
    const result = await tools
      .get("web_search")!
      .execute({ query: "x" }, context("local"));
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toContain(
      "http://192.168.1.10:8080/search?q=x",
    );
    expect(result.modelContent).toContain("1. One");
  });

  it("explains missing search for a non-Codex model without SearXNG", async () => {
    const tools = await resolve(
      {},
      { codexCredentials: { resolveAuth: async () => null } },
    );
    const result = await tools
      .get("web_search")!
      .execute({ query: "x" }, context("local"));
    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("web.searxngUrl");
  });
});
