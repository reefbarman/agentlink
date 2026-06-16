import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PROXY_ENV_KEYS = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
] as const;
let originalProxyEnv: Partial<Record<(typeof PROXY_ENV_KEYS)[number], string>>;

const mocks = vi.hoisted(() => {
  class MockDispatcher {
    readonly options: unknown;
    readonly kind: string;

    constructor(kind: string, options: unknown) {
      this.kind = kind;
      this.options = options;
    }

    compose = vi.fn(() => ({ kind: `${this.kind}:composed` }));
  }

  return {
    Agent: vi.fn(function (this: unknown, options: unknown) {
      return new MockDispatcher("agent", options);
    }),
    EnvHttpProxyAgent: vi.fn(function (this: unknown, options: unknown) {
      return new MockDispatcher("proxy", options);
    }),
    dns: vi.fn(() => "dns-interceptor"),
    fetch: vi.fn(() => Promise.resolve("response")),
    setGlobalDispatcher: vi.fn(),
  };
});

vi.mock("undici", () => ({
  Agent: mocks.Agent,
  EnvHttpProxyAgent: mocks.EnvHttpProxyAgent,
  fetch: mocks.fetch,
  interceptors: { dns: mocks.dns },
  setGlobalDispatcher: mocks.setGlobalDispatcher,
}));

describe("installAgentLinkHttpDispatcher", () => {
  beforeEach(() => {
    originalProxyEnv = Object.fromEntries(
      PROXY_ENV_KEYS.map((key) => [key, process.env[key]]),
    );
    for (const key of PROXY_ENV_KEYS) {
      delete process.env[key];
    }
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const key of PROXY_ENV_KEYS) {
      const original = originalProxyEnv[key];
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
  });

  it("installs a tuned direct dispatcher with DNS interception", async () => {
    const { installAgentLinkHttpDispatcher } =
      await import("./httpDispatcher.js");

    installAgentLinkHttpDispatcher({});

    expect(mocks.Agent).toHaveBeenCalledWith({
      keepAliveTimeout: 60_000,
      headersTimeout: 30_000,
    });
    expect(mocks.EnvHttpProxyAgent).not.toHaveBeenCalled();
    expect(mocks.dns).toHaveBeenCalledTimes(1);
    expect(mocks.setGlobalDispatcher).toHaveBeenCalledWith({
      kind: "agent:composed",
    });
  });

  it("uses EnvHttpProxyAgent when proxy variables are configured", async () => {
    const { installAgentLinkHttpDispatcher } =
      await import("./httpDispatcher.js");

    installAgentLinkHttpDispatcher({ HTTPS_PROXY: "http://proxy.local:8080" });

    expect(mocks.Agent).not.toHaveBeenCalled();
    expect(mocks.EnvHttpProxyAgent).toHaveBeenCalledWith({
      keepAliveTimeout: 60_000,
      headersTimeout: 30_000,
    });
    expect(mocks.dns).not.toHaveBeenCalled();
    expect(mocks.setGlobalDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "proxy" }),
    );
  });

  it("reuses dispatcher instances per proxy mode", async () => {
    const { getAgentLinkHttpDispatcher } = await import("./httpDispatcher.js");

    const directA = getAgentLinkHttpDispatcher({});
    const directB = getAgentLinkHttpDispatcher({});
    const proxy = getAgentLinkHttpDispatcher({ HTTP_PROXY: "http://proxy" });

    expect(directA).toBe(directB);
    expect(proxy).not.toBe(directA);
    expect(mocks.Agent).toHaveBeenCalledTimes(1);
    expect(mocks.EnvHttpProxyAgent).toHaveBeenCalledTimes(1);
  });

  it("uses the tuned dispatcher for explicit SDK fetch calls", async () => {
    const { agentLinkFetch } = await import("./httpDispatcher.js");

    await agentLinkFetch("https://example.com", { method: "POST" });

    expect(mocks.fetch).toHaveBeenCalledWith(
      "https://example.com",
      expect.objectContaining({
        method: "POST",
        dispatcher: { kind: "agent:composed" },
      }),
    );
  });

  it("uses the tuned proxy dispatcher for explicit SDK fetch calls behind proxies", async () => {
    process.env.HTTPS_PROXY = "http://proxy.local:8080";
    const { agentLinkFetch } = await import("./httpDispatcher.js");

    await agentLinkFetch("https://example.com", {
      body: "{}",
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(mocks.fetch).toHaveBeenCalledWith(
      "https://example.com",
      expect.objectContaining({
        body: "{}",
        headers: { "content-type": "application/json" },
        method: "POST",
        dispatcher: expect.objectContaining({ kind: "proxy" }),
      }),
    );
    expect(mocks.Agent).not.toHaveBeenCalled();
    expect(mocks.EnvHttpProxyAgent).toHaveBeenCalledWith({
      keepAliveTimeout: 60_000,
      headersTimeout: 30_000,
    });
  });

  it("installs only once", async () => {
    const { installAgentLinkHttpDispatcher } =
      await import("./httpDispatcher.js");

    installAgentLinkHttpDispatcher({});
    installAgentLinkHttpDispatcher({ HTTPS_PROXY: "http://proxy.local:8080" });

    expect(mocks.Agent).toHaveBeenCalledTimes(1);
    expect(mocks.EnvHttpProxyAgent).not.toHaveBeenCalled();
    expect(mocks.setGlobalDispatcher).toHaveBeenCalledTimes(1);
  });
});
