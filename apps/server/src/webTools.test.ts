import type { HostTool, HostToolExecutionContext } from "@agentlink/core";
import { describe, expect, it, vi } from "vitest";

import type { NetworkPolicy } from "./egressPolicy.js";
import {
  WebFetchError,
  type FetchedPage,
  type WebConnector,
} from "./webFetch.js";
import {
  createWebTools,
  formatPage,
  type WebToolsOptions,
} from "./webTools.js";

const connector: WebConnector = {
  connect: () => Promise.reject(new Error("unused")),
};

function context(providerId = "openrouter"): HostToolExecutionContext {
  return {
    principal: {
      id: "owner",
    } as unknown as HostToolExecutionContext["principal"],
    sessionId: "session-1",
    turnId: "turn-1",
    model: { model: { providerId, modelId: "model-1" }, source: "session" },
    signal: undefined,
  } as HostToolExecutionContext;
}

async function tools(
  policy: NetworkPolicy,
  options: Partial<WebToolsOptions> = {},
): Promise<Map<string, HostTool>> {
  const resolve = createWebTools({
    policy: () => policy,
    connector,
    ...options,
  });
  const list = await resolve({} as never);
  return new Map(list.map((tool) => [tool.definition.name, tool]));
}

const open: NetworkPolicy = { preset: "open", allow: [] };

describe("createWebTools", () => {
  it("follows the project's preset", async () => {
    const searx = { searxngUrl: "http://searxng:8080" };
    expect([...(await tools(open, searx)).keys()]).toEqual([
      "web_fetch",
      "web_search",
    ]);
    expect([
      ...(await tools({ preset: "dependencies", allow: [] }, searx)).keys(),
    ]).toEqual(["web_fetch"]);
    expect((await tools({ preset: "off", allow: [] }, searx)).size).toBe(0);
  });

  it("offers no search without Codex or SearXNG", async () => {
    expect([...(await tools(open)).keys()]).toEqual(["web_fetch"]);
  });

  it("all tools are read-only and need no approval", async () => {
    for (const tool of (
      await tools(open, { searxngUrl: "http://s" })
    ).values()) {
      expect(tool.effect).toBe("read");
      expect(tool.authorization).toBe("none");
      // The chat's tool card shows what was asked for.
      expect(tool.displayInput?.({ url: "https://a.example" })).toEqual({
        url: "https://a.example",
      });
    }
  });
});

describe("web_fetch", () => {
  const page: FetchedPage = {
    url: "https://example.com/",
    status: 200,
    contentType: "text/html",
    title: "Example",
    text: "abcdefghij",
    bodyTruncated: false,
  };

  it("fetches with the current policy and formats the page", async () => {
    const fetchPage = vi.fn(async () => page);
    const tool = (await tools(open, { fetchPage })).get("web_fetch")!;
    const result = await tool.execute(
      { url: "https://example.com/" },
      context(),
    );
    expect(fetchPage).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://example.com/", policy: open }),
    );
    expect(result.isError).toBeUndefined();
    expect(result.modelContent).toContain("Title: Example");
    expect(result.modelContent).toContain("abcdefghij");
  });

  it("returns fetch errors to the model", async () => {
    const fetchPage = vi.fn(async () => {
      throw new WebFetchError("Blocked example.com: not allowed");
    });
    const tool = (await tools(open, { fetchPage })).get("web_fetch")!;
    const result = await tool.execute(
      { url: "https://example.com/" },
      context(),
    );
    expect(result).toMatchObject({
      isError: true,
      modelContent: "Blocked example.com: not allowed",
    });
  });

  it("pages long text", () => {
    const first = formatPage(page, 0, 4);
    expect(first.modelContent).toContain("Showing characters 0-4 of 10");
    expect(first.modelContent).toContain("abcd");
    expect(first.modelContent).toContain("start_index 4");
    const last = formatPage(page, 8, 4);
    expect(last.modelContent).toContain("ij");
    expect(last.modelContent).not.toContain("start_index");
  });
});

describe("web_search", () => {
  it("uses SearXNG for non-Codex models", async () => {
    const fetch = vi.fn(
      async (_url: URL | RequestInfo) =>
        new Response(
          JSON.stringify({
            results: [
              { title: "One", url: "https://one.example/", content: "first" },
              { title: "Dup", url: "https://one.example/", content: "again" },
              { title: "Bad", url: "javascript:alert(1)" },
              { title: "Two", url: "https://two.example/", content: "" },
            ],
          }),
        ),
    );
    const tool = (
      await tools(open, { searxngUrl: "http://searxng:8080", fetch })
    ).get("web_search")!;
    const result = await tool.execute(
      { query: "agentlink", time_range: "week" },
      context(),
    );
    const url = new URL(String(fetch.mock.calls[0]![0]));
    expect(url.origin + url.pathname).toBe("http://searxng:8080/search");
    expect(url.searchParams.get("q")).toBe("agentlink");
    expect(url.searchParams.get("format")).toBe("json");
    expect(url.searchParams.get("time_range")).toBe("week");
    expect(result.modelContent).toContain("1. One\n   https://one.example/");
    expect(result.modelContent).toContain("2. Two");
    expect(result.modelContent).not.toMatch(/Dup|javascript/u);
  });

  it("explains a SearXNG without the json format", async () => {
    const fetch = vi.fn(async () => new Response("", { status: 403 }));
    const tool = (await tools(open, { searxngUrl: "http://s", fetch })).get(
      "web_search",
    )!;
    const result = await tool.execute({ query: "x" }, context());
    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("json format");
  });

  it("uses Codex hosted search for Codex models", async () => {
    const search = vi.fn(async () => ({
      backend: "provider" as const,
      provider: "codex",
      operation: "search" as const,
      input: {},
      activities: [],
      content: "codex results",
      citations: [],
    }));
    const tool = (
      await tools(open, {
        searxngUrl: "http://s",
        codex: {
          providerIds: new Set(["codex"]),
          resolveAuth: async () => ({
            method: "oauth",
            bearerToken: "t",
            canRefresh: false,
          }),
          search,
        },
      })
    ).get("web_search")!;
    const result = await tool.execute({ query: "x" }, context("codex"));
    expect(result.modelContent).toBe("codex results");
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "model-1",
        operation: "search",
        sessionId: "session-1",
      }),
    );
  });

  it("asks for a ChatGPT sign-in when Codex has none", async () => {
    const tool = (
      await tools(open, {
        codex: {
          providerIds: new Set(["codex"]),
          resolveAuth: async () => null,
        },
      })
    ).get("web_search")!;
    const result = await tool.execute({ query: "x" }, context("codex"));
    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("codex-login");
  });

  it("refuses non-Codex models without SearXNG", async () => {
    const tool = (
      await tools(open, {
        codex: {
          providerIds: new Set(["codex"]),
          resolveAuth: async () => null,
        },
      })
    ).get("web_search")!;
    const result = await tool.execute({ query: "x" }, context("meridian"));
    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("searxngUrl");
  });
});
