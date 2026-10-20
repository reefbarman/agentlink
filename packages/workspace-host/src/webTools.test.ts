import type { HostTool, HostToolExecutionContext } from "@agentlink/core";
import { describe, expect, it, vi } from "vitest";

import {
  createWorkspaceWebTools,
  type CreateWorkspaceWebToolsOptions,
  type WorkspaceWebAccess,
  type WorkspaceWebPage,
} from "./webTools.js";

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

const page: WorkspaceWebPage = {
  url: "https://example.com/",
  status: 200,
  contentType: "text/html",
  title: "Example",
  text: "hello page",
  bodyTruncated: false,
};

async function tools(
  options: Partial<CreateWorkspaceWebToolsOptions> & {
    access?: () => WorkspaceWebAccess;
  } = {},
): Promise<Map<string, HostTool>> {
  const resolve = createWorkspaceWebTools({
    access: () => "fetch_and_search",
    fetchPage: async () => page,
    ...options,
  });
  const list = await resolve({} as never);
  return new Map(list.map((tool) => [tool.definition.name, tool]));
}

describe("createWorkspaceWebTools", () => {
  it("offers tools by access level and search backend", async () => {
    const searx = { searxngUrl: "https://search.example" };
    expect([...(await tools(searx)).keys()]).toEqual([
      "web_fetch",
      "web_search",
    ]);
    expect([
      ...(await tools({ ...searx, access: () => "fetch" })).keys(),
    ]).toEqual(["web_fetch"]);
    expect((await tools({ ...searx, access: () => "off" })).size).toBe(0);
    expect([...(await tools()).keys()]).toEqual(["web_fetch"]);
  });

  it("offers read-only tools that need no approval", async () => {
    for (const tool of (
      await tools({ searxngUrl: "https://s.example" })
    ).values()) {
      expect(tool.effect).toBe("read");
      expect(tool.authorization).toBe("none");
    }
  });

  it("rechecks access on every call", async () => {
    let access: WorkspaceWebAccess = "fetch_and_search";
    const fetchPage = vi.fn(async () => page);
    const fetch = vi.fn();
    const offered = await tools({
      access: () => access,
      fetchPage,
      searxngUrl: "https://s.example",
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    access = "off";
    const fetched = await offered
      .get("web_fetch")!
      .execute({ url: "https://example.com/" }, context());
    expect(fetched.isError).toBe(true);
    expect(fetchPage).not.toHaveBeenCalled();
    access = "fetch";
    const searched = await offered
      .get("web_search")!
      .execute({ query: "x" }, context());
    expect(searched.isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("web_fetch", () => {
  it("passes the URL and cancellation to the host and formats the page", async () => {
    const fetchPage = vi.fn(async () => page);
    const controller = new AbortController();
    const result = await (
      await tools({ fetchPage })
    )
      .get("web_fetch")!
      .execute({ url: "https://example.com/" }, {
        ...context(),
        signal: controller.signal,
      } as HostToolExecutionContext);
    expect(fetchPage).toHaveBeenCalledWith({
      url: "https://example.com/",
      signal: controller.signal,
    });
    expect(result.modelContent).toContain("Title: Example");
    expect(result.modelContent).toContain("hello page");
  });

  it("only shows error messages the host marks as safe", async () => {
    class SafeError extends Error {}
    const describeFetchError = (error: unknown) =>
      error instanceof SafeError ? error.message : undefined;
    const safe = await (
      await tools({
        fetchPage: async () => {
          throw new SafeError("Blocked: private address");
        },
        describeFetchError,
      })
    )
      .get("web_fetch")!
      .execute({ url: "https://a.example/" }, context());
    expect(safe).toMatchObject({
      isError: true,
      modelContent: "Blocked: private address",
    });
    const hidden = await (
      await tools({
        fetchPage: async () => {
          throw new Error("internal detail token=abc");
        },
        describeFetchError,
      })
    )
      .get("web_fetch")!
      .execute({ url: "https://a.example/" }, context());
    expect(hidden.modelContent).toBe("Fetching https://a.example/ failed");
  });
});

describe("web_search", () => {
  it("queries SearXNG without following redirects", async () => {
    const fetch = vi.fn(
      async (_url: URL | RequestInfo, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            results: [{ title: "One", url: "https://one.example/" }],
          }),
        ),
    );
    const result = await (
      await tools({
        searxngUrl: "https://search.example/",
        fetch: fetch as unknown as typeof globalThis.fetch,
      })
    )
      .get("web_search")!
      .execute({ query: "agentlink" }, context());
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://search.example/search?q=agentlink&format=json",
    );
    expect(init?.redirect).toBe("error");
    expect(result.modelContent).toContain("1. One");
  });

  it("refuses an oversized SearXNG response", async () => {
    const big = "x".repeat(2 * 1024 * 1024 + 1);
    const fetch = vi.fn(async () => new Response(big));
    const result = await (
      await tools({
        searxngUrl: "https://search.example",
        fetch: fetch as unknown as typeof globalThis.fetch,
      })
    )
      .get("web_search")!
      .execute({ query: "x" }, context());
    expect(result).toMatchObject({
      isError: true,
      modelContent: "SearXNG returned too much data",
    });
  });

  it("routes Codex models to Codex search with the session's model", async () => {
    const search = vi.fn(async () => ({
      backend: "provider" as const,
      provider: "codex",
      operation: "search" as const,
      input: {},
      activities: [],
      content: "codex results",
      citations: [],
    }));
    const offered = await tools({
      codex: {
        providerIds: new Set(["codex"]),
        resolveAuth: async () => ({
          method: "oauth",
          bearerToken: "t",
          canRefresh: false,
        }),
        search,
      },
    });
    const result = await offered
      .get("web_search")!
      .execute({ query: "x", time_range: "week" }, context("codex"));
    expect(result.modelContent).toBe("codex results");
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "model-1",
        sessionId: "session-1",
        operation: "search",
        input: expect.objectContaining({ query: "x", time_range: "week" }),
      }),
    );
    const other = await offered
      .get("web_search")!
      .execute({ query: "x" }, context("openrouter"));
    expect(other.isError).toBe(true);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("asks for a sign-in instead of using API-key Codex auth", async () => {
    const search = vi.fn();
    const result = await (
      await tools({
        codex: {
          providerIds: new Set(["codex"]),
          resolveAuth: async () => ({
            method: "apiKey",
            bearerToken: "k",
            canRefresh: false,
          }),
          search,
          signInMessage: "sign in please",
        },
      })
    )
      .get("web_search")!
      .execute({ query: "x" }, context("codex"));
    expect(result).toMatchObject({
      isError: true,
      modelContent: "sign in please",
    });
    expect(search).not.toHaveBeenCalled();
  });
});
