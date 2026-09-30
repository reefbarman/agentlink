import {
  OpenAiCompatibleQuotaService,
  parseRetryAfterMs,
} from "./OpenAiCompatibleQuotaService.js";
import { describe, expect, it, vi, type Mock } from "vitest";

import { getOpenAiCompatibleSecretKey } from "../../openAiCompatibleSecrets.js";
import { normalizeOpenAiCompatibleConnections } from "@agentlink/core/openai-compatible";
import { queryProviderUsage } from "../ProviderUsageService.js";

const QUOTA_URL = "https://meridian.example.invalid/v1/usage/quota/all";

type QuotaFetchMock = Mock<
  (input: string, init: RequestInit) => Promise<Response>
>;

function sentHeaders(fetch: QuotaFetchMock): Record<string, string> {
  return fetch.mock.calls[0]![1].headers as Record<string, string>;
}

function mockFetch(impl: () => Promise<Response>): QuotaFetchMock {
  return vi.fn(impl) as unknown as QuotaFetchMock;
}

function connections(quota: Record<string, unknown> | undefined) {
  const result = normalizeOpenAiCompatibleConnections([
    {
      id: "meridian",
      displayName: "Meridian",
      baseUrl: "https://meridian.example.invalid/v1",
      profile: "generic",
      authKey: "meridian-key",
      ...(quota ? { quota } : {}),
      models: [
        {
          id: "claude-opus",
          model: "claude-opus",
          displayName: "Claude Opus",
          contextWindow: 200_000,
          maxOutputTokens: 8_192,
          supportsToolUse: true,
        },
      ],
    },
  ]);
  expect(result.issues).toEqual([]);
  return result.connections;
}

function quotaBody(nowMs: number, utilization = 0.25) {
  return {
    profiles: [
      {
        id: "work",
        isActive: true,
        windows: [
          { type: "five_hour", utilization, resetsAt: nowMs + 3_600_000 },
        ],
        fetchedAt: nowMs,
        stale: false,
      },
    ],
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function setup(
  options: {
    quota?: Record<string, unknown>;
    fetch?: QuotaFetchMock;
    secret?: string | undefined;
  } = {},
) {
  let now = 1_800_000_000_000;
  const fetch =
    options.fetch ?? mockFetch(async () => jsonResponse(quotaBody(now)));
  const secrets = new Map<string, string>();
  if (options.secret !== undefined) {
    secrets.set(getOpenAiCompatibleSecretKey("meridian-key"), options.secret);
  }
  const configured = connections(
    options.quota ?? { format: "meridian", url: QUOTA_URL },
  );
  const service = new OpenAiCompatibleQuotaService({
    getConnections: () => configured,
    isProviderEnabled: () => true,
    secrets: { get: async (key) => secrets.get(key) },
    fetch,
    now: () => now,
  });
  return {
    service,
    fetch,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
    query: () => queryProviderUsage(service.createAdapters()),
  };
}

describe("OpenAiCompatibleQuotaService", () => {
  it("only queries connections that configure quota", () => {
    const service = new OpenAiCompatibleQuotaService({
      getConnections: () => connections(undefined),
      isProviderEnabled: () => true,
      secrets: { get: async () => undefined },
    });
    expect(service.createAdapters()).toEqual([]);
  });

  it("sends the same-origin connection credential and returns separate accounts", async () => {
    const { fetch, query } = setup({ secret: "s3cret" });
    const usage = await query();

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(QUOTA_URL);
    expect(init).toMatchObject({ method: "GET", redirect: "manual" });
    expect(sentHeaders(fetch).authorization).toBe("Bearer s3cret");
    expect(usage.providers[0]).toMatchObject({
      providerId: "openai-compatible:meridian",
      providerName: "Meridian",
      available: true,
      accounts: [
        {
          id: "work",
          isActive: true,
          windows: [{ id: "five_hour", usedPercent: 25 }],
        },
      ],
    });
  });

  it("does not send a credential for explicit no-auth quota", async () => {
    const { fetch, query } = setup({
      secret: "s3cret",
      quota: { format: "meridian", url: QUOTA_URL, auth: { type: "none" } },
    });
    await query();
    expect(sentHeaders(fetch).authorization).toBeUndefined();
  });

  it("reports a missing named credential without calling the endpoint", async () => {
    const { fetch, query } = setup();
    const usage = await query();
    expect(fetch).not.toHaveBeenCalled();
    expect(usage.providers[0]).toMatchObject({ available: false });
    expect(usage.providers[0]!.reason).toMatch(/meridian-key/);
  });

  it("reports invalid quota configuration without a network request", async () => {
    const { fetch, query } = setup({
      secret: "s",
      quota: { format: "other", url: QUOTA_URL },
    });
    const usage = await query();
    expect(fetch).not.toHaveBeenCalled();
    expect(usage.providers[0]!.reason).toMatch(/misconfigured/);
  });

  it("caches successes briefly and coalesces concurrent requests", async () => {
    const { fetch, query, advance } = setup({ secret: "s" });
    await Promise.all([query(), query()]);
    expect(fetch).toHaveBeenCalledTimes(1);
    advance(10_000);
    await query();
    expect(fetch).toHaveBeenCalledTimes(1);
    advance(25_000);
    await query();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("refuses redirects and hides upstream error bodies", async () => {
    const fetch = mockFetch(
      async () =>
        new Response("secret body http://leak.invalid", {
          status: 302,
          headers: { location: "https://elsewhere.invalid" },
        }),
    );
    const { query } = setup({ secret: "s", fetch });
    const usage = await query();
    expect(usage.providers[0]!.reason).toMatch(/redirected/);
    expect(usage.providers[0]!.reason).not.toMatch(/leak|secret body/);
  });

  it("shows the last reading as stale after a failure, within the age bound", async () => {
    let fail = false;
    let now = 0;
    const fetch = mockFetch(async () =>
      fail ? new Response("", { status: 503 }) : jsonResponse(quotaBody(now)),
    );
    const harness = setup({ secret: "s", fetch });
    now = harness.now();
    await harness.query();

    fail = true;
    harness.advance(60_000);
    const stale = await harness.query();
    expect(stale.providers[0]).toMatchObject({ available: true });
    expect(stale.providers[0]!.notice).toMatch(/last successful reading/);
    expect(stale.providers[0]!.accounts?.[0]?.stale).toBe(true);

    harness.advance(5 * 60_000);
    const expired = await harness.query();
    expect(expired.providers[0]).toMatchObject({ available: false });
    expect(expired.providers[0]!.reason).toMatch(/HTTP 503/);
  });

  it("caps Retry-After and suppresses immediate retries", async () => {
    const fetch = mockFetch(
      async () =>
        new Response("", { status: 429, headers: { "retry-after": "86400" } }),
    );
    const { query, advance } = setup({ secret: "s", fetch });
    const first = await query();
    expect(first.providers[0]!.reason).toMatch(/rate limited/);
    expect(first.providers[0]!.reason).toMatch(/Retry available in about 300s/);
    advance(60_000);
    await query();
    expect(fetch).toHaveBeenCalledTimes(1);
    advance(5 * 60_000);
    await query();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(parseRetryAfterMs("abc")).toBe(30_000);
    expect(parseRetryAfterMs("2")).toBe(2_000);
  });

  it("does not let a request from before invalidation populate the cache", async () => {
    let release: (() => void) | undefined;
    let calls = 0;
    const fetch = mockFetch(async () => {
      calls += 1;
      if (calls === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return jsonResponse(quotaBody(1_800_000_000_000, 0.99));
      }
      return jsonResponse(quotaBody(1_800_000_000_000, 0.1));
    });
    const harness = setup({ secret: "s", fetch });
    const pending = harness.query();
    await vi.waitFor(() => expect(release).toBeDefined());
    harness.service.invalidate();
    release!();
    await pending;

    await harness.query();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
