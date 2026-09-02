import {
  Agent as RealUndiciAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
} from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_CONCURRENT_MODEL_REQUESTS_PER_PROVIDER } from "@agentlink/core/model-request-scheduler";
import { createServer } from "http";

describe("installAgentLinkHttpDispatcher integration", () => {
  const originalDispatcher = getGlobalDispatcher();

  afterEach(() => {
    setGlobalDispatcher(originalDispatcher);
    vi.restoreAllMocks();
  });

  it("installs a tuned dispatcher as the undici global dispatcher", async () => {
    vi.resetModules();
    const { installAgentLinkHttpDispatcher } =
      await import("./httpDispatcher.js");

    installAgentLinkHttpDispatcher({});

    expect(getGlobalDispatcher()).not.toBe(originalDispatcher);
  });

  it("uses explicit AgentLink fetch for real HTTP requests", async () => {
    vi.resetModules();
    const { agentLinkFetch } = await import("./httpDispatcher.js");
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("agentlink-dispatcher-smoke");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected loopback server address");
      }

      const response = await agentLinkFetch(
        `http://127.0.0.1:${address.port}/smoke`,
      );

      expect(await response.text()).toBe("agentlink-dispatcher-smoke");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("bounds concurrent sockets per origin at the scheduler ceiling", async () => {
    vi.resetModules();
    const { agentLinkFetch } = await import("./httpDispatcher.js");
    let active = 0;
    let peakActive = 0;
    const server = createServer((_req, res) => {
      active++;
      peakActive = Math.max(peakActive, active);
      setTimeout(() => {
        active--;
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
      }, 50);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected loopback server address");
      }
      const url = `http://127.0.0.1:${address.port}/bounded`;
      const responses = await Promise.all(
        Array.from(
          { length: MAX_CONCURRENT_MODEL_REQUESTS_PER_PROVIDER + 8 },
          () => agentLinkFetch(url),
        ),
      );
      await Promise.all(responses.map((response) => response.text()));

      // The transport cap must sit at (not below) the scheduler's admission
      // ceiling: a lower socket cap silently queues admitted streaming turns
      // inside undici, serializing concurrent sessions on the same provider.
      expect(peakActive).toBeGreaterThan(6);
      expect(peakActive).toBeLessThanOrEqual(
        MAX_CONCURRENT_MODEL_REQUESTS_PER_PROVIDER,
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("uses undici APIs available from the installed major version", () => {
    expect(typeof RealUndiciAgent).toBe("function");
  });
});
