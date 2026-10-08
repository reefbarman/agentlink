import { describe, expect, it, vi } from "vitest";
import {
  executeCodexStandaloneWeb,
  prepareCodexStandaloneWebRequest,
} from "./standaloneWeb.js";

import { normalizeCoreWebAccessSettings } from "@agentlink/core/web-access";

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

  it.each([0, 400])(
    "honours explicit start_line=%s when find is also supplied",
    (startLine) => {
      const prepared = prepareCodexStandaloneWebRequest({
        sessionId: "session-focus",
        model: "gpt-test",
        operation: "fetch",
        input: {
          url: "https://example.com/docs",
          find: "Identity headers",
          start_line: startLine,
        },
        settings: normalizeCoreWebAccessSettings(),
      });
      expect(prepared.body.commands).toEqual({
        open: [{ ref_id: "https://example.com/docs", lineno: startLine }],
        response_length: "long",
      });
      expect(JSON.stringify(prepared.body.input)).toContain("Identity headers");
    },
  );

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

  it.each([
    "Internal Error ()",
    "\n L0: Internal Error ()\n",
    "Total lines: 1\nL0: Internal Error ()",
    '【turn0view0】 Source: open({"ref_id":"https://example.com"}); Total lines: 1\nL0: Internal Error ()',
    'Internal Error ()\n【turn0view0】 Source: open({"ref_id":"https://example.com"}); Total lines: 1',
  ])(
    "rejects provider page-access errors instead of completing with error text: %s",
    async (output) => {
      const retainOutput = vi.fn(() => "/tmp/not-content.txt");
      await expect(
        executeCodexStandaloneWeb({
          auth,
          sessionId: "session-1",
          model: "gpt-test",
          operation: "fetch",
          input: { url: "https://example.com", find: "previous_response_id" },
          settings: normalizeCoreWebAccessSettings(),
          fetch: (async () =>
            new Response(JSON.stringify({ output }), {
              status: 200,
            })) as typeof globalThis.fetch,
          retainOutput,
        }),
      ).rejects.toThrow("provider_page_internal_error");
      expect(retainOutput).not.toHaveBeenCalled();
    },
  );

  it("retains partial content when a continuation page fails internally", async () => {
    const outputs = ["Total lines: 4\nL0: zero\nL1: one", "Internal Error ()"];
    const retainOutput = vi.fn(() => "/tmp/not-complete.txt");
    const result = await executeCodexStandaloneWeb({
      auth,
      sessionId: "session-1",
      model: "gpt-test",
      operation: "fetch",
      input: { url: "https://example.com" },
      settings: normalizeCoreWebAccessSettings(),
      fetch: (async () =>
        new Response(JSON.stringify({ output: outputs.shift() }), {
          status: 200,
        })) as typeof globalThis.fetch,
      retainOutput,
    });
    expect(result.content_truncated).toBe(true);
    expect(result.output_warning).toContain("did not advance");
    expect(result.next_start_line).toBeUndefined();
    expect(result.content).toContain("L0: zero");
    expect(result.content).not.toContain("Internal Error");
    expect(retainOutput).toHaveBeenCalledWith(
      "Total lines: 4\nL0: zero\nL1: one",
    );
  });

  it("does not mistake an article discussing internal errors for a failed read", async () => {
    const output =
      "Troubleshooting\nThe provider may return Internal Error () when it is unavailable.";
    const result = await executeCodexStandaloneWeb({
      auth,
      sessionId: "session-1",
      model: "gpt-test",
      operation: "fetch",
      input: { url: "https://example.com" },
      settings: normalizeCoreWebAccessSettings(),
      fetch: (async () =>
        new Response(JSON.stringify({ output }), {
          status: 200,
        })) as typeof globalThis.fetch,
    });
    expect(result.content).toBe(output);
    expect(result.activities[0]?.status).toBe("completed");
  });

  it("retains fetched content beyond the visible preview", async () => {
    const retainOutput = vi.fn(() => "/tmp/agentlink-output-test/output.txt");
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
      retainOutput,
    });

    expect(result).toMatchObject({
      content: "abcde\n\n[Content truncated by AgentLink]",
      content_truncated: true,
      output_file: "/tmp/agentlink-output-test/output.txt",
      output_warning: expect.stringContaining("read_file"),
    });
    expect(retainOutput).toHaveBeenCalledWith("abcdefghij");
  });

  it("continues a navigation-only find response with open and previews the source match", async () => {
    const outputs = [
      'Source: find({"pattern":"Identity headers"}); Total lines: 10\nL0: navigation\nL1: more navigation',
      "Total lines: 10\nL2: ## IDENTITY HEADERS\nL3: Tailscale-User-Login",
    ];
    const requestBodies: Array<{ commands: unknown }> = [];
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestBodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ output: outputs.shift() }), {
          status: 200,
        });
      },
    );
    const retainOutput = vi.fn(() => "/tmp/focused-output.txt");
    const result = await executeCodexStandaloneWeb({
      auth,
      sessionId: "session-focus",
      model: "gpt-test",
      operation: "fetch",
      input: { url: "https://example.com/docs", find: "Identity headers" },
      settings: normalizeCoreWebAccessSettings(),
      fetch,
      retainOutput,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(requestBodies[0]?.commands).toMatchObject({
      find: [{ pattern: "Identity headers" }],
    });
    expect(requestBodies[1]?.commands).toEqual({
      open: [{ ref_id: "https://example.com/docs", lineno: 2 }],
      response_length: "long",
    });
    expect(result.content).toMatch(/^L2: ## IDENTITY HEADERS/);
    expect(result.content).toContain("Tailscale-User-Login");
    expect(result.content).not.toContain("navigation");
    expect(result.next_start_line).toBe(4);
    expect(retainOutput).toHaveBeenCalledWith(
      expect.stringContaining("L0: navigation"),
    );
    expect(retainOutput).toHaveBeenCalledWith(
      expect.stringContaining("L2: ## IDENTITY HEADERS"),
    );
  });

  it("keeps a match near the end of a long collapsed source line inside the preview", async () => {
    const output = `Total lines: 1\nL0: ${"navigation ".repeat(1000)}Identity headers: useful content`;
    const result = await executeCodexStandaloneWeb({
      auth,
      sessionId: "session-focus",
      model: "gpt-test",
      operation: "fetch",
      input: {
        url: "https://example.com/docs",
        find: "Identity headers",
        max_length: 200,
      },
      settings: normalizeCoreWebAccessSettings(),
      fetch: (async () =>
        new Response(JSON.stringify({ output }), {
          status: 200,
        })) as typeof globalThis.fetch,
      retainOutput: () => "/tmp/retained.txt",
    });
    expect(result.content).toContain("Identity headers: useful content");
    expect(result.content.length).toBeLessThan(250);
  });

  it("previews a find match instead of the page prefix without output retention", async () => {
    const result = await executeCodexStandaloneWeb({
      auth,
      sessionId: "session-focus",
      model: "gpt-test",
      operation: "fetch",
      input: {
        url: "https://example.com/docs",
        find: "Authentication",
        start_line: 400,
      },
      settings: normalizeCoreWebAccessSettings(),
      fetch: (async () =>
        new Response(
          JSON.stringify({
            output:
              "Total lines: 402\nL399: navigation\nL400: Authentication\nL401: use a token",
          }),
          { status: 200 },
        )) as typeof globalThis.fetch,
    });
    expect(result.content).toMatch(/^L400: Authentication/);
    expect(result.content).not.toContain("navigation");
    expect(result.next_start_line).toBeUndefined();
  });

  it.each(["saved", "unavailable", "disabled"] as const)(
    "focuses explicit line previews before truncation with %s retention",
    async (retention) => {
      const initial = `Total lines: 233\nL0: ${"navigation ".repeat(100)}\nL229: earlier content L999: embedded marker\nL230: requested content\nwrapped target\nL231: next line`;
      const fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              output:
                fetch.mock.calls.length === 1
                  ? initial
                  : "Total lines: 233\nL232: final line",
            }),
            { status: 200 },
          ),
      );
      const retainOutput =
        retention === "disabled"
          ? undefined
          : vi.fn(() =>
              retention === "saved" ? "/tmp/focused-output.txt" : null,
            );
      const result = await executeCodexStandaloneWeb({
        auth,
        sessionId: "session-focus",
        model: "gpt-test",
        operation: "fetch",
        input: {
          url: "https://example.com/docs",
          start_line: 230,
          max_length: 48,
        },
        settings: normalizeCoreWebAccessSettings(),
        fetch,
        retainOutput,
      });

      expect(result.content).toMatch(
        /^L230: requested content\nwrapped target/,
      );
      expect(result.content).not.toContain("navigation");
      expect(result.content).not.toContain("embedded marker");
      expect(result.content_truncated).toBe(true);
      expect(result.output_warning).not.toContain("did not advance");
      if (retention === "disabled") {
        expect(fetch).toHaveBeenCalledTimes(1);
      } else {
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(retainOutput).toHaveBeenCalledWith(
          `${initial}\n\nTotal lines: 233\nL232: final line`,
        );
      }
      if (retention === "saved") {
        expect(result.output_file).toBe("/tmp/focused-output.txt");
        expect(result.next_start_line).toBeUndefined();
      } else {
        expect(result.output_file).toBeUndefined();
        expect(result.next_start_line).toBe(232);
      }
    },
  );

  it.each([0, 230])(
    "does not label an omitted prefix as truncation for start_line %s",
    async (startLine) => {
      const focused = `L${startLine}: requested content\nwrapped target\nL${startLine + 1}: final line`;
      const output = `Provider header ${"metadata ".repeat(100)}\nTotal lines: ${startLine + 2}\n${startLine > 0 ? `L0: ${"navigation ".repeat(100)}\n` : ""}${focused}`;
      const retainOutput = vi.fn(() => "/tmp/not-needed.txt");
      const result = await executeCodexStandaloneWeb({
        auth,
        sessionId: "session-focus",
        model: "gpt-test",
        operation: "fetch",
        input: {
          url: "https://example.com/docs",
          start_line: startLine,
          max_length: 128,
        },
        settings: normalizeCoreWebAccessSettings(),
        fetch: (async () =>
          new Response(JSON.stringify({ output }), {
            status: 200,
          })) as typeof globalThis.fetch,
        retainOutput,
      });

      expect(result.content).toBe(focused);
      expect(result.content_truncated).toBeUndefined();
      expect(result.output_warning).toBeUndefined();
      expect(result.output_file).toBeUndefined();
      expect(result.next_start_line).toBeUndefined();
      expect(retainOutput).not.toHaveBeenCalled();
    },
  );

  it("keeps a focused preview and unique overlapping blocks when a later page stalls", async () => {
    const initial =
      "Total lines: 234\nL0: navigation\nL230: requested content\nL231: next line";
    const overlap =
      "Total lines: 234\nL229: earlier content\nL230: requested content\nL231: next line\nL232: new content\nwrapped addition";
    const outputs = [initial, overlap, overlap];
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ output: outputs.shift() }), {
          status: 200,
        }),
    );
    const retainOutput = vi.fn(() => "/tmp/focused-output.txt");
    const result = await executeCodexStandaloneWeb({
      auth,
      sessionId: "session-focus",
      model: "gpt-test",
      operation: "fetch",
      input: {
        url: "https://example.com/docs",
        start_line: 230,
        max_length: 200,
      },
      settings: normalizeCoreWebAccessSettings(),
      fetch,
      retainOutput,
    });

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(result.content).toMatch(/^L230: requested content/);
    expect(result.content).not.toContain("navigation");
    expect(result.content_truncated).toBe(true);
    expect(result.output_warning).toContain("did not advance");
    expect(result.next_start_line).toBeUndefined();
    expect(retainOutput).toHaveBeenCalledWith(
      `${initial}\n\nL232: new content\nwrapped addition`,
    );
  });

  it("continues line-addressed pages before retaining provider output", async () => {
    const requestBodies: Record<string, unknown>[] = [];
    const retainOutput = vi.fn(() => "/tmp/agentlink-output-test/output.txt");
    const outputs = [
      "Total lines: 4\nL0: zero\nL1: one",
      "Total lines: 4\nL2: two\nL3: three",
    ];
    const result = await executeCodexStandaloneWeb({
      auth,
      sessionId: "session-1",
      model: "gpt-test",
      operation: "fetch",
      input: { url: "https://example.com", max_length: 5 },
      settings: normalizeCoreWebAccessSettings(),
      fetch: (async (_input, init) => {
        requestBodies.push(
          JSON.parse(String(init?.body)) as Record<string, unknown>,
        );
        return new Response(
          JSON.stringify({
            output: outputs[requestBodies.length - 1],
            results: [],
          }),
          { status: 200 },
        );
      }) as typeof globalThis.fetch,
      retainOutput,
    });

    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[1]).toMatchObject({
      commands: { open: [{ ref_id: "https://example.com/", lineno: 2 }] },
    });
    expect(retainOutput).toHaveBeenCalledWith(`${outputs[0]}\n\n${outputs[1]}`);
    expect(result.next_start_line).toBeUndefined();
  });

  it.each([true, false])(
    "stops repeated pages without appending them or inventing progress (retention: %s)",
    async (retain) => {
      const output = "Total lines: 100\nL0: zero\nL1: one";
      const fetch = vi.fn(
        async () => new Response(JSON.stringify({ output }), { status: 200 }),
      );
      const retainOutput = vi.fn(() => (retain ? "/tmp/retained.txt" : null));
      const result = await executeCodexStandaloneWeb({
        auth,
        sessionId: "session-1",
        model: "gpt-test",
        operation: "fetch",
        input: { url: "https://example.com/", max_length: 1000 },
        settings: normalizeCoreWebAccessSettings(),
        fetch: fetch as typeof globalThis.fetch,
        retainOutput,
      });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(retainOutput).toHaveBeenCalledWith(output);
      expect(result.next_start_line).toBeUndefined();
      expect(result.output_warning).toContain("did not advance");
      expect(result.content_truncated).toBe(true);
    },
  );

  it.each([undefined, "GetOwnedGames"])(
    "fails for hosted fallback when an explicit start line is ignored (find: %s)",
    async (find) => {
      const fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              output:
                "Total lines: 900\nL0: navigation\nL3: more navigation L800: collapsed marker",
            }),
            { status: 200 },
          ),
      );
      await expect(
        executeCodexStandaloneWeb({
          auth,
          sessionId: "session-1",
          model: "gpt-test",
          operation: "fetch",
          input: { url: "https://example.com/", start_line: 360, find },
          settings: normalizeCoreWebAccessSettings(),
          fetch: fetch as typeof globalThis.fetch,
          retainOutput: () => "/tmp/retained.txt",
        }),
      ).rejects.toThrow("provider_page_focus_unavailable");
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("fails for hosted fallback when find cannot get past repeated navigation", async () => {
    const output =
      'Source: find({"pattern":"Identity headers"}); Total lines: 495\nL0: navigation\nL363: introduction';
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ output }), { status: 200 }),
    );
    await expect(
      executeCodexStandaloneWeb({
        auth,
        sessionId: "session-focus",
        model: "gpt-test",
        operation: "fetch",
        input: { url: "https://example.com/docs", find: "Identity headers" },
        settings: normalizeCoreWebAccessSettings(),
        fetch,
        retainOutput: () => "/tmp/retained.txt",
      }),
    ).rejects.toThrow("provider_page_focus_unavailable");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retains only new line blocks from an overlapping final page", async () => {
    const outputs = [
      "Total lines: 4\nL0: zero\nL1: one",
      "Total lines: 4\nL0: zero\nL1: one\nL2: two\nwrapped text\nL3: three",
    ];
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ output: outputs.shift() }), {
          status: 200,
        }),
    );
    const retainOutput = vi.fn(() => "/tmp/retained.txt");
    const result = await executeCodexStandaloneWeb({
      auth,
      sessionId: "session-1",
      model: "gpt-test",
      operation: "fetch",
      input: { url: "https://example.com/", max_length: 1000 },
      settings: normalizeCoreWebAccessSettings(),
      fetch: fetch as typeof globalThis.fetch,
      retainOutput,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(retainOutput).toHaveBeenCalledWith(
      "Total lines: 4\nL0: zero\nL1: one\n\nL2: two\nwrapped text\nL3: three",
    );
    expect(result.next_start_line).toBeUndefined();
    expect(result.output_warning).not.toContain("did not advance");
  });

  it("stops an unnumbered continuation without claiming the page is complete", async () => {
    const outputs = [
      "Total lines: 10\nL0: zero",
      "provider returned an unrelated answer",
    ];
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ output: outputs.shift() }), {
          status: 200,
        }),
    );
    const retainOutput = vi.fn(() => "/tmp/retained.txt");
    const result = await executeCodexStandaloneWeb({
      auth,
      sessionId: "session-1",
      model: "gpt-test",
      operation: "fetch",
      input: { url: "https://example.com/" },
      settings: normalizeCoreWebAccessSettings(),
      fetch: fetch as typeof globalThis.fetch,
      retainOutput,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(retainOutput).toHaveBeenCalledWith("Total lines: 10\nL0: zero");
    expect(result.output_warning).toContain("did not advance");
    expect(result.next_start_line).toBeUndefined();
  });

  it("returns a recoverable start line when retained output cannot be saved", async () => {
    const outputs = [
      "Total lines: 4\nL0: zero\nL1: one",
      "Total lines: 4\nL2: two\nL3: three",
    ];
    let requestCount = 0;
    const result = await executeCodexStandaloneWeb({
      auth,
      sessionId: "session-1",
      model: "gpt-test",
      operation: "fetch",
      input: { url: "https://example.com", max_length: 5 },
      settings: normalizeCoreWebAccessSettings(),
      fetch: (async () =>
        new Response(
          JSON.stringify({ output: outputs[requestCount++], results: [] }),
          { status: 200 },
        )) as typeof globalThis.fetch,
      retainOutput: () => null,
    });

    expect(result).toMatchObject({
      content_truncated: true,
      next_start_line: 2,
      output_warning: expect.stringContaining("could not be retained"),
    });
  });

  it("maps explicit start_line to the provider open command", () => {
    const prepared = prepareCodexStandaloneWebRequest({
      sessionId: "session-1",
      model: "gpt-test",
      operation: "fetch",
      input: { url: "https://example.com", start_line: 42 },
      settings: normalizeCoreWebAccessSettings(),
    });

    expect(prepared.body).toMatchObject({
      commands: { open: [{ ref_id: "https://example.com/", lineno: 42 }] },
    });
  });
});
