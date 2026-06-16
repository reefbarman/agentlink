import {
  Agent as RealUndiciAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
} from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";

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

  it("uses undici APIs available from the installed major version", () => {
    expect(typeof RealUndiciAgent).toBe("function");
  });
});
