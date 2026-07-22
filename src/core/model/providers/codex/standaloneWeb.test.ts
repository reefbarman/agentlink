import { describe, expect, it, vi } from "vitest";

import { normalizeCoreWebAccessSettings } from "../../../webAccess.js";
import {
  executeCodexStandaloneWeb,
  prepareCodexStandaloneWebRequest,
} from "./standaloneWeb.js";

const auth = {
  method: "oauth" as const,
  bearerToken: "test-token",
  accountId: "account-1",
  canRefresh: true,
};

describe("prepareCodexStandaloneWebRequest", () => {
  it("maps search preferences, recency, restrictions, and indexed mode", () => {
    const prepared = prepareCodexStandaloneWebRequest({
      sessionId: "session-1",
      model: "gpt-test",
      operation: "search",
      input: {
        query: "latest platform docs",
        max_results: 3,
        language: "en",
        time_range: "week",
        safe_search: "strict",
      },
      settings: normalizeCoreWebAccessSettings({
        nativeSearchMode: "indexed",
        allowedDomains: ["example.com"],
      }),
    });

    expect(prepared.maxResults).toBe(3);
    expect(prepared.body).toMatchObject({
      model: "gpt-test",
      commands: {
        search_query: [
          {
            q: "latest platform docs",
            recency: 7,
            domains: ["example.com"],
          },
        ],
        response_length: "short",
      },
      settings: {
        allowed_callers: ["direct"],
        external_web_access: "indexed",
        filters: { allowed_domains: ["example.com"] },
      },
    });
    const inputText = JSON.stringify(prepared.body.input);
    expect(inputText).toContain('\\"language\\":\\"en\\"');
    expect(inputText).toContain('\\"safe_search\\":\\"strict\\"');
  });

  it("maps fetch find and enforces domain policy before transport", () => {
    const settings = normalizeCoreWebAccessSettings({
      nativeSearchMode: "live",
      blockedDomains: ["blocked.example.com"],
    });
    const prepared = prepareCodexStandaloneWebRequest({
      sessionId: "session-1",
      model: "gpt-test",
      operation: "fetch",
      input: {
        url: "https://docs.example.com/page",
        find: "Authentication",
      },
      settings,
    });

    expect(prepared.body).toMatchObject({
      commands: {
        find: [
          {
            ref_id: "https://docs.example.com/page",
            pattern: "Authentication",
          },
        ],
        response_length: "long",
      },
      settings: {
        external_web_access: true,
        filters: { blocked_domains: ["blocked.example.com"] },
      },
    });

    expect(() =>
      prepareCodexStandaloneWebRequest({
        sessionId: "session-1",
        model: "gpt-test",
        operation: "fetch",
        input: { url: "https://blocked.example.com/secret" },
        settings,
      }),
    ).toThrow("blocked by web access policy");
  });
});

describe("executeCodexStandaloneWeb", () => {
  it("returns a bounded structured search result and omits encrypted output", async () => {
    let capturedInit: RequestInit | undefined;
    const webFetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedInit = init;
        return new Response(
          JSON.stringify({
            encrypted_output: "must-not-leak",
            output: "opaque generated output",
            results: [
              {
                type: "text_result",
                ref_id: "turn0search0",
                url: "https://one.example.com",
                title: "One",
                snippet: "First result",
              },
              {
                type: "text_result",
                ref_id: "turn0search1",
                url: "https://two.example.com",
                title: "Two",
                snippet: "Second result",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );

    const result = await executeCodexStandaloneWeb({
      auth,
      sessionId: "session-1",
      model: "gpt-test",
      operation: "search",
      input: { query: "example", max_results: 1 },
      settings: normalizeCoreWebAccessSettings(),
      fetch: webFetch as typeof globalThis.fetch,
    });

    expect(result.content).toContain("1. One");
    expect(result.content).not.toContain("Two");
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
    expect(result.citations).toEqual([
      {
        url: "https://one.example.com",
        title: "One",
        citedText: "First result",
      },
    ]);
    expect(webFetch).toHaveBeenCalledOnce();
    expect(capturedInit?.headers).toMatchObject({
      Authorization: "Bearer test-token",
      "ChatGPT-Account-Id": "account-1",
    });
  });

  it("truncates fetched content to the requested visible length", async () => {
    const result = await executeCodexStandaloneWeb({
      auth,
      sessionId: "session-1",
      model: "gpt-test",
      operation: "fetch",
      input: { url: "https://example.com", max_length: 5 },
      settings: normalizeCoreWebAccessSettings(),
      fetch: (async () =>
        new Response(JSON.stringify({ output: "abcdefghij", results: [] }), {
          status: 200,
        })) as typeof globalThis.fetch,
    });

    expect(result.content).toBe("abcde\n\n[Content truncated by AgentLink]");
  });
});
