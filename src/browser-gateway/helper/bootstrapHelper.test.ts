import * as fs from "fs/promises";
import * as http from "http";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bootstrapBrowserGatewayHelper,
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

  it("accepts a healthy helper from a different extension version when protocol matches", async () => {
    const server = http.createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ok",
            protocolVersion: BROWSER_GATEWAY_HELPER_PROTOCOL_VERSION,
            helperVersion: "older-extension-version",
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
      helperVersion: "older-extension-version",
      browserBootstrapToken: "token",
      clientSharedSecret: "secret",
      lanAccess: false,
    };
    await writeBrowserGatewayHelperDiscovery(discovery);

    const resolved = await resolveHealthyDiscoveredHelper(port, {
      lanAccess: false,
    });

    expect(resolved).toEqual(discovery);
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
