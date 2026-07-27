import { describe, expect, it, vi } from "vitest";

import {
  requestEmbeddings,
  type EmbeddingClientOptions,
} from "./embeddingClient.js";

function response(options: {
  ok?: boolean;
  status?: number;
  data?: Array<{ index?: number; embedding: unknown }>;
  text?: string;
  headers?: HeadersInit;
}): Response {
  return {
    ok: options.ok ?? false,
    status: options.status ?? 500,
    headers: new Headers(options.headers),
    json: vi.fn(async () => ({ data: options.data ?? [] })),
    text: vi.fn(async () => options.text ?? "error"),
  } as unknown as Response;
}

function options(
  overrides: Partial<EmbeddingClientOptions> = {},
): EmbeddingClientOptions {
  return {
    maxRetries: 3,
    ...overrides,
  };
}

function workerOptions(
  overrides: Partial<EmbeddingClientOptions> = {},
): EmbeddingClientOptions {
  return options({
    retryFetchErrors: true,
    shouldRetryStatus: (status) =>
      status === 408 || status === 429 || (status >= 500 && status < 600),
    retryDelayMs: (attempt, random, retryAfterMs) =>
      Math.min(retryAfterMs ?? 1000 * 2 ** attempt + random * 500, 30_000),
    bisectOnBadRequest: true,
    sortByIndex: true,
    ...overrides,
  });
}

describe("requestEmbeddings", () => {
  it("sends the stable request shape and bearer token", async () => {
    const fetchMock = vi.fn(async () =>
      response({ ok: true, data: [{ embedding: [0.1, 0.2] }] }),
    );

    await expect(
      requestEmbeddings("query", "token", options({ fetch: fetchMock })),
    ).resolves.toEqual([[0.1, 0.2]]);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/embeddings",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer token",
        },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: "query",
        }),
      },
    );
  });

  it("sorts indexed batch responses when requested", async () => {
    const fetchMock = vi.fn(async () =>
      response({
        ok: true,
        data: [
          { index: 1, embedding: [2] },
          { index: 0, embedding: [1] },
        ],
      }),
    );

    await expect(
      requestEmbeddings(
        ["first", "second"],
        "token",
        options({ fetch: fetchMock, sortByIndex: true }),
      ),
    ).resolves.toEqual([[1], [2]]);
  });

  it.each([
    ["empty", []],
    ["non-finite", [Number.NaN]],
    ["non-number", [null]],
  ])("rejects %s embedding vectors", async (_, embedding) => {
    const fetchMock = vi.fn(async () =>
      response({ ok: true, data: [{ index: 0, embedding }] }),
    );

    await expect(
      requestEmbeddings(
        ["first"],
        "token",
        workerOptions({ fetch: fetchMock }),
      ),
    ).rejects.toThrow("invalid embedding data");
  });

  it.each([
    {
      name: "missing indexes",
      data: [{ index: 0, embedding: [1] }],
    },
    {
      name: "duplicate indexes",
      data: [
        { index: 0, embedding: [1] },
        { index: 0, embedding: [2] },
      ],
    },
    {
      name: "out-of-range indexes",
      data: [
        { index: 0, embedding: [1] },
        { index: 2, embedding: [2] },
      ],
    },
  ])("rejects $name in indexed batch responses", async ({ data }) => {
    const fetchMock = vi.fn(async () => response({ ok: true, data }));

    await expect(
      requestEmbeddings(
        ["first", "second"],
        "token",
        workerOptions({ fetch: fetchMock }),
      ),
    ).rejects.toThrow(/incomplete|invalid indexed/);
  });

  it("retries configured statuses with injected backoff and jitter", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ status: 500 }))
      .mockResolvedValueOnce(response({ status: 500 }))
      .mockResolvedValueOnce(
        response({ ok: true, data: [{ embedding: [1] }] }),
      );
    const sleepMock = vi.fn(async () => undefined);

    await requestEmbeddings(
      "query",
      "token",
      options({
        fetch: fetchMock,
        sleep: sleepMock,
        random: () => 0.5,
        shouldRetryStatus: (status) => status >= 500,
        retryDelayMs: (attempt, random) =>
          Math.min(500 * 2 ** attempt + random * 250, 5000),
      }),
    );

    expect(sleepMock).toHaveBeenNthCalledWith(1, 625);
    expect(sleepMock).toHaveBeenNthCalledWith(2, 1125);
  });

  it("retries thrown fetch errors only when configured", async () => {
    const retryingFetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockResolvedValueOnce(
        response({ ok: true, data: [{ embedding: [1] }] }),
      );

    await expect(
      requestEmbeddings(
        "query",
        "token",
        options({
          fetch: retryingFetch,
          sleep: async () => undefined,
          retryFetchErrors: true,
        }),
      ),
    ).resolves.toEqual([[1]]);

    const nonRetryingFetch = vi
      .fn()
      .mockRejectedValue(new TypeError("network down"));
    await expect(
      requestEmbeddings(
        ["batch"],
        "token",
        options({ fetch: nonRetryingFetch }),
      ),
    ).rejects.toThrow("network down");
    expect(nonRetryingFetch).toHaveBeenCalledTimes(1);
  });

  it("refreshes the bearer token after 401 when configured", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ status: 401 }))
      .mockResolvedValueOnce(
        response({ ok: true, data: [{ embedding: [1] }] }),
      );
    const refreshBearerToken = vi.fn(async () => "fresh-token");

    await requestEmbeddings(
      ["batch"],
      "stale-token",
      options({ fetch: fetchMock, refreshBearerToken }),
    );

    expect(refreshBearerToken).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer stale-token",
    });
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer fresh-token",
    });
  });

  it("propagates a refreshed token into subsequent bisection requests", async () => {
    const requestTokens: string[] = [];
    let firstRequest = true;
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string> | undefined;
        requestTokens.push(String(headers?.Authorization));
        if (firstRequest) {
          firstRequest = false;
          return response({ status: 401 });
        }
        const body = JSON.parse(String(init?.body)) as { input: string[] };
        if (body.input.length > 1) return response({ status: 400 });
        const value = body.input[0] === "first" ? 1 : 2;
        return response({ ok: true, data: [{ index: 0, embedding: [value] }] });
      },
    );

    await expect(
      requestEmbeddings(
        ["first", "second"],
        "stale-token",
        workerOptions({
          fetch: fetchMock,
          refreshBearerToken: async () => "fresh-token",
        }),
      ),
    ).resolves.toEqual([[1], [2]]);

    expect(requestTokens).toEqual([
      "Bearer stale-token",
      "Bearer fresh-token",
      "Bearer fresh-token",
      "Bearer fresh-token",
    ]);
  });

  it("preserves 429 retry budget before refreshing a 401", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ status: 429 }))
      .mockResolvedValueOnce(response({ status: 401 }))
      .mockResolvedValueOnce(
        response({ ok: true, data: [{ index: 0, embedding: [1] }] }),
      );
    const sleepMock = vi.fn(async () => undefined);
    const refreshBearerToken = vi.fn(async () => "fresh-token");

    await expect(
      requestEmbeddings(
        ["batch"],
        "stale-token",
        workerOptions({
          fetch: fetchMock,
          sleep: sleepMock,
          random: () => 0,
          refreshBearerToken,
        }),
      ),
    ).resolves.toEqual([[1]]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleepMock).toHaveBeenCalledOnce();
    expect(sleepMock).toHaveBeenCalledWith(1000);
    expect(refreshBearerToken).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[2]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer fresh-token",
    });
  });

  it("gives each bisected half a fresh retry budget", async () => {
    const attempts = new Map<string, number>();
    const sleepMock = vi.fn(async () => undefined);
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { input: string[] };
        if (body.input.length > 1) return response({ status: 400 });
        const key = body.input[0];
        const attempt = (attempts.get(key) ?? 0) + 1;
        attempts.set(key, attempt);
        if (attempt === 1) return response({ status: 429 });
        const value = key === "first" ? 1 : 2;
        return response({ ok: true, data: [{ index: 0, embedding: [value] }] });
      },
    );

    await expect(
      requestEmbeddings(
        ["first", "second"],
        "token",
        workerOptions({ fetch: fetchMock, sleep: sleepMock, random: () => 0 }),
      ),
    ).resolves.toEqual([[1], [2]]);

    expect(attempts).toEqual(
      new Map([
        ["first", 2],
        ["second", 2],
      ]),
    );
    expect(sleepMock).toHaveBeenCalledTimes(2);
    expect(sleepMock).toHaveBeenCalledWith(1000);
  });

  it.each([408, 429, 500, 503, 599])(
    "retries HTTP %s under the worker policy",
    async (status) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(response({ status }))
        .mockResolvedValueOnce(
          response({ ok: true, data: [{ index: 0, embedding: [1] }] }),
        );
      const sleepMock = vi.fn(async () => undefined);

      await expect(
        requestEmbeddings(
          ["batch"],
          "token",
          workerOptions({
            fetch: fetchMock,
            sleep: sleepMock,
            random: () => 0,
          }),
        ),
      ).resolves.toEqual([[1]]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(sleepMock).toHaveBeenCalledWith(1000);
    },
  );

  it("retries thrown fetch errors under the worker policy", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockResolvedValueOnce(
        response({ ok: true, data: [{ index: 0, embedding: [1] }] }),
      );
    const sleepMock = vi.fn(async () => undefined);

    await expect(
      requestEmbeddings(
        ["batch"],
        "token",
        workerOptions({ fetch: fetchMock, sleep: sleepMock, random: () => 0 }),
      ),
    ).resolves.toEqual([[1]]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleepMock).toHaveBeenCalledWith(1000);
  });

  it.each([
    ["numeric seconds", "2", undefined, 2_000],
    ["HTTP date", "Thu, 01 Jan 1970 00:00:02 GMT", () => 500, 1_500],
    ["bounded server delay", "120", undefined, 30_000],
    ["malformed fallback", "later", undefined, 1_000],
  ] as const)(
    "honors %s Retry-After under the worker policy",
    async (_label, retryAfter, now, expectedDelay) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          response({ status: 429, headers: { "Retry-After": retryAfter } }),
        )
        .mockResolvedValueOnce(
          response({ ok: true, data: [{ index: 0, embedding: [1] }] }),
        );
      const sleepMock = vi.fn(async () => undefined);

      await requestEmbeddings(
        ["batch"],
        "token",
        workerOptions({
          fetch: fetchMock,
          sleep: sleepMock,
          random: () => 0,
          now,
        }),
      );

      expect(sleepMock).toHaveBeenCalledWith(expectedDelay);
    },
  );

  it("does not refresh or retry a terminal 401", async () => {
    const fetchMock = vi.fn(async () =>
      response({ status: 401, text: "unauthorized" }),
    );

    await expect(
      requestEmbeddings("query", "token", options({ fetch: fetchMock })),
    ).rejects.toThrow("OpenAI API error (401): unauthorized");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("bisects multi-input 400 responses while preserving order", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { input: string[] };
        if (body.input.length > 1) return response({ status: 400 });
        const value = body.input[0] === "first" ? 1 : 2;
        return response({ ok: true, data: [{ index: 0, embedding: [value] }] });
      },
    );

    await expect(
      requestEmbeddings(
        ["first", "second"],
        "token",
        options({ fetch: fetchMock, bisectOnBadRequest: true }),
      ),
    ).resolves.toEqual([[1], [2]]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stops after the configured retry budget", async () => {
    const fetchMock = vi.fn(async () =>
      response({ status: 500, text: "unavailable" }),
    );

    await expect(
      requestEmbeddings(
        "query",
        "token",
        options({
          maxRetries: 2,
          fetch: fetchMock,
          sleep: async () => undefined,
          shouldRetryStatus: (status) => status === 500,
        }),
      ),
    ).rejects.toThrow("OpenAI API error (500): unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("surfaces terminal HTTP errors without retrying", async () => {
    const fetchMock = vi.fn(async () =>
      response({ status: 400, text: "bad input" }),
    );

    await expect(
      requestEmbeddings(
        ["single"],
        "token",
        options({ fetch: fetchMock, bisectOnBadRequest: true }),
      ),
    ).rejects.toThrow("OpenAI API error (400): bad input");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
