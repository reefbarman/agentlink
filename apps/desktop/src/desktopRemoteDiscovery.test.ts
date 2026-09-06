import { describe, expect, it, vi } from "vitest";

import { BROWSER_GATEWAY_HELPER_PROTOCOL_VERSION } from "@agentlink/protocol/browser-gateway-helper-lifecycle";
import { discoverDesktopRemote } from "./desktopRemoteDiscovery.js";

const record = {
  url: "http://127.0.0.1:47137/",
  port: 47137,
  pid: 1234,
  protocolVersion: BROWSER_GATEWAY_HELPER_PROTOCOL_VERSION,
  helperVersion: "1.2.3",
  helperGenerationId: "generation-a",
  clientSharedSecret: "must-not-leave-discovery",
  browserBootstrapToken: "must-not-leave-discovery",
};
const health = {
  status: "ok",
  protocolVersion: record.protocolVersion,
  helperVersion: record.helperVersion,
  helperGenerationId: record.helperGenerationId,
};
function fixture(overrides = {}) {
  return {
    readRecord: vi.fn(async () => ({ ...record, ...overrides })),
    isProcessAlive: vi.fn(() => true),
    fetch: vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify(health)),
    ),
  };
}

describe("desktop VS Code discovery", () => {
  it("returns only a workspace URL and generation, with redirect-free bounded health", async () => {
    const deps = fixture();
    expect(await discoverDesktopRemote(deps)).toEqual({
      url: "http://127.0.0.1:47137/?desktopWorkspace=1",
      generation: "generation-a",
    });
    expect(deps.isProcessAlive).toHaveBeenCalledWith(1234);
    expect(deps.fetch).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:47137/health"),
      {
        redirect: "error",
        credentials: "omit",
        signal: expect.any(AbortSignal),
      },
    );
  });

  it.each([
    "http://localhost:47137/",
    "http://2130706433:47137/",
    "http://127.1:47137/",
    "http://127.0.0.1:47137@evil.test/",
    "http://evil.test:47137/",
    "https://127.0.0.1:47137/",
    "http://127.0.0.1:47137/health",
    "http://127.0.0.1:47137/?token=secret",
    "http://127.0.0.1:47137/#secret",
    "file:///tmp/helper",
    "http://127.0.0.1:47138/",
  ])("rejects unsafe discovery URL %s before fetching", async (url) => {
    const deps = fixture({ url });
    expect(await discoverDesktopRemote(deps)).toBeNull();
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("accepts literal IPv6 loopback", async () => {
    expect(
      await discoverDesktopRemote(fixture({ url: "http://[::1]:47137/" })),
    ).toEqual({
      url: "http://[::1]:47137/?desktopWorkspace=1",
      generation: "generation-a",
    });
  });

  it.each([
    { pid: -1 },
    { pid: 1.5 },
    { port: 0 },
    { port: 65536 },
    { protocolVersion: -1 },
    { helperGenerationId: "" },
    { helperVersion: null },
  ])("rejects malformed identity %j", async (overrides) => {
    const deps = fixture(overrides);
    expect(await discoverDesktopRemote(deps)).toBeNull();
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("rejects dead processes", async () => {
    const deps = fixture();
    deps.isProcessAlive.mockReturnValue(false);
    expect(await discoverDesktopRemote(deps)).toBeNull();
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it.each([
    { status: "error" },
    { protocolVersion: -1 },
    { helperVersion: "other" },
    { helperGenerationId: "other" },
  ])("rejects mismatched health %j", async (overrides) => {
    const deps = fixture();
    deps.fetch.mockResolvedValue(
      new Response(JSON.stringify({ ...health, ...overrides })),
    );
    expect(await discoverDesktopRemote(deps)).toBeNull();
  });

  it("rejects oversized health and fetch failures", async () => {
    const deps = fixture();
    deps.fetch.mockResolvedValue(new Response(" ".repeat(65_537)));
    expect(await discoverDesktopRemote(deps)).toBeNull();
    deps.fetch.mockRejectedValue(new Error("redirect or timeout"));
    expect(await discoverDesktopRemote(deps)).toBeNull();
  });
});
