import * as fs from "fs/promises";
import * as http from "http";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bootstrapBrowserGatewayHelper,
  compareHelperReleaseVersions,
  discoveryMatchesDesiredConfig,
  fetchHelperHealth,
  resolveHealthyDiscoveredHelper,
} from "./bootstrapHelper.js";
import {
  clearBrowserGatewayHelperDiscovery,
  getBrowserGatewayHelperDiscoveryPath,
  writeBrowserGatewayHelperDiscovery,
} from "../browserGatewayHelperDiscovery.js";

import { BROWSER_GATEWAY_HELPER_PROTOCOL_VERSION } from "../protocol.js";

afterEach(async () => {
  await clearBrowserGatewayHelperDiscovery();
});

describe("browser gateway helper bootstrap", () => {
  it.each([
    ["1.17.99", "1.17.103", -1],
    ["1.17.103", "1.17.99", 1],
    ["1.17.103", "1.17.103", 0],
    ["1.18.0-beta.2", "1.18.0-beta.10", -1],
    ["1.18.0", "1.18.0-beta.10", 1],
    ["development", "1.18.0", null],
  ])("orders helper release %s against %s", (left, right, expected) => {
    expect(compareHelperReleaseVersions(left, right)).toBe(expected);
  });

  it("accepts LAN helpers that fell back to direct IP URLs when mDNS is unavailable", () => {
    expect(
      discoveryMatchesDesiredConfig(
        {
          pid: process.pid,
          port: 47137,
          url: "http://127.0.0.1:47137",
          protocolVersion: BROWSER_GATEWAY_HELPER_PROTOCOL_VERSION,
          startedAt: new Date().toISOString(),
          lastHeartbeatAt: new Date().toISOString(),
          helperVersion: "test-version",
          browserBootstrapToken: "token",
          clientSharedSecret: "secret",
          lanAccess: true,
          lanUrls: ["http://192.168.50.178:47137"],
        },
        { lanAccess: true, mdnsName: "agentlink" },
      ),
    ).toBe(true);
  });

  it.each([undefined, []])(
    "rejects LAN helpers without mDNS or direct IP URLs (%s)",
    (lanUrls) => {
      expect(
        discoveryMatchesDesiredConfig(
          {
            pid: process.pid,
            port: 47137,
            url: "http://127.0.0.1:47137",
            protocolVersion: BROWSER_GATEWAY_HELPER_PROTOCOL_VERSION,
            startedAt: new Date().toISOString(),
            lastHeartbeatAt: new Date().toISOString(),
            helperVersion: "test-version",
            browserBootstrapToken: "token",
            clientSharedSecret: "secret",
            lanAccess: true,
            lanUrls,
          },
          { lanAccess: true, mdnsName: "agentlink" },
        ),
      ).toBe(false);
    },
  );

  it("requires a restart when secure LAN HTTPS configuration changes", () => {
    const discovery = {
      pid: process.pid,
      port: 47137,
      url: "http://127.0.0.1:47137",
      protocolVersion: BROWSER_GATEWAY_HELPER_PROTOCOL_VERSION,
      startedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      helperVersion: "test-version",
      browserBootstrapToken: "token",
      clientSharedSecret: "secret",
      lanAccess: true,
      mdnsHostName: "agentlink",
      mdnsUrl: "https://agentlink.local:47138",
      secureLanAccess: true,
    };
    expect(
      discoveryMatchesDesiredConfig(discovery, {
        lanAccess: true,
        mdnsName: "agentlink",
        secureLanAccess: true,
      }),
    ).toBe(true);
    expect(
      discoveryMatchesDesiredConfig(discovery, {
        lanAccess: true,
        mdnsName: "agentlink",
        secureLanAccess: false,
      }),
    ).toBe(false);
  });

  it("returns null when no discovery exists", async () => {
    const resolved = await resolveHealthyDiscoveredHelper(47137, {
      lanAccess: false,
    });
    expect(resolved).toBeNull();
  });

  it("rejects discovery when pid is not alive", async () => {
    await writeBrowserGatewayHelperDiscovery({
      pid: 999_999_999,
      port: 47137,
      url: "http://127.0.0.1:47137",
      protocolVersion: BROWSER_GATEWAY_HELPER_PROTOCOL_VERSION,
      startedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      helperVersion: "test-version",
      browserBootstrapToken: "token",
      clientSharedSecret: "secret",
    });

    const resolved = await resolveHealthyDiscoveredHelper(47137, {
      lanAccess: false,
    });
    expect(resolved).toBeNull();
  });

  it("returns health payload for running helper", async () => {
    const server = http.createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ok",
            protocolVersion: BROWSER_GATEWAY_HELPER_PROTOCOL_VERSION,
            helperVersion: "test-version",
            startedAt: new Date().toISOString(),
            now: new Date().toISOString(),
            uptimeMs: 123,
            activeClientLeases: 0,
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const health = await fetchHelperHealth({
      url: `http://127.0.0.1:${port}`,
    });

    expect(health?.status).toBe("ok");
    expect(health?.protocolVersion).toBe(
      BROWSER_GATEWAY_HELPER_PROTOCOL_VERSION,
    );

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it.each([
    ["1.17.103", "1.17.103", true],
    ["1.17.103", "1.17.99", true],
    ["1.17.99", "1.17.103", false],
    ["development", "1.17.103", true],
  ])(
    "reuses running helper %s for requester %s: %s",
    async (runningVersion, requestedVersion, expectedReuse) => {
      const server = http.createServer((req, res) => {
        if (req.url === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              status: "ok",
              protocolVersion: BROWSER_GATEWAY_HELPER_PROTOCOL_VERSION,
              helperVersion: runningVersion,
              startedAt: new Date().toISOString(),
              now: new Date().toISOString(),
              uptimeMs: 123,
              activeClientLeases: 1,
            }),
          );
          return;
        }
        res.writeHead(404);
        res.end();
      });

      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const discovery = {
        pid: process.pid,
        port,
        url: `http://127.0.0.1:${port}`,
        protocolVersion: BROWSER_GATEWAY_HELPER_PROTOCOL_VERSION,
        startedAt: new Date().toISOString(),
        lastHeartbeatAt: new Date().toISOString(),
        helperVersion: runningVersion,
        browserBootstrapToken: "token",
        clientSharedSecret: "secret",
        lanAccess: false,
      };
      await writeBrowserGatewayHelperDiscovery(discovery);

      const resolved = await resolveHealthyDiscoveredHelper(port, {
        lanAccess: false,
        helperVersion: requestedVersion,
      });

      expect(resolved).toEqual(expectedReuse ? discovery : null);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  );

  it("rejects discovery when health reports a different helper version", async () => {
    const server = http.createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ok",
            protocolVersion: BROWSER_GATEWAY_HELPER_PROTOCOL_VERSION,
            helperVersion: "1.17.104",
            startedAt: new Date().toISOString(),
            now: new Date().toISOString(),
            uptimeMs: 123,
            activeClientLeases: 1,
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await writeBrowserGatewayHelperDiscovery({
      pid: process.pid,
      port,
      url: `http://127.0.0.1:${port}`,
      protocolVersion: BROWSER_GATEWAY_HELPER_PROTOCOL_VERSION,
      startedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      helperVersion: "1.17.103",
      browserBootstrapToken: "token",
      clientSharedSecret: "secret",
      lanAccess: false,
    });

    await expect(
      resolveHealthyDiscoveredHelper(port, {
        lanAccess: false,
        helperVersion: "1.17.103",
      }),
    ).resolves.toBeNull();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("preserves a newer helper when an older requester wants different config", async () => {
    const server = http.createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ok",
            protocolVersion: BROWSER_GATEWAY_HELPER_PROTOCOL_VERSION,
            helperVersion: "1.17.104",
            startedAt: new Date().toISOString(),
            now: new Date().toISOString(),
            uptimeMs: 123,
            activeClientLeases: 1,
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const discovery = {
      pid: process.pid,
      port,
      url: `http://127.0.0.1:${port}`,
      protocolVersion: BROWSER_GATEWAY_HELPER_PROTOCOL_VERSION,
      startedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      helperVersion: "1.17.104",
      browserBootstrapToken: "token",
      clientSharedSecret: "secret",
      lanAccess: false,
    };
    await writeBrowserGatewayHelperDiscovery(discovery);
    const log = vi.fn();

    const result = await bootstrapBrowserGatewayHelper({
      extensionRootPath: process.cwd(),
      browserGatewayPort: port,
      helperVersion: "1.17.103",
      lanAccess: true,
      log,
    });

    expect(result).toEqual({ source: "existing", discovery });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("preserving newer helper"),
    );
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("fails fast when helper bundle is missing", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), ".tmp-helper-missing-"),
    );

    await expect(
      bootstrapBrowserGatewayHelper({
        extensionRootPath: tempRoot,
        browserGatewayPort: 47137,
        helperVersion: "test-version",
        startupTimeoutMs: 200,
        log: vi.fn(),
      }),
    ).rejects.toThrow(/helper_bundle_missing/);

    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("writes helper discovery with expected fields", async () => {
    const now = new Date().toISOString();
    await writeBrowserGatewayHelperDiscovery({
      pid: process.pid,
      port: 47137,
      url: "http://127.0.0.1:47137",
      protocolVersion: BROWSER_GATEWAY_HELPER_PROTOCOL_VERSION,
      startedAt: now,
      lastHeartbeatAt: now,
      helperVersion: "test-version",
      browserBootstrapToken: "token-1",
      clientSharedSecret: "secret-1",
    });

    const raw = await fs.readFile(
      getBrowserGatewayHelperDiscoveryPath(),
      "utf-8",
    );
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.pid).toBe(process.pid);
    expect(parsed.port).toBe(47137);
    expect(parsed.browserBootstrapToken).toBe("token-1");
    expect(parsed.clientSharedSecret).toBe("secret-1");
  });
});
