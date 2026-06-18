/** @vitest-environment node */

import * as fs from "fs/promises";
import * as http from "http";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BrowserGatewayHelper,
  type HelperRuntimeOptions,
} from "./browserGatewayHelper.js";
import { DeviceStore } from "./deviceStore.js";
import { PairingBroker } from "./pairingBroker.js";

async function makeExtensionRoot(): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), ".tmp-helper-pairing-"),
  );
  await fs.mkdir(path.join(root, "dist"), { recursive: true });
  await fs.mkdir(path.join(root, "media"), { recursive: true });
  for (const name of [
    "browser-gateway.js",
    "browser-gateway.css",
    "codicon.css",
    "codicon.ttf",
  ]) {
    await fs.writeFile(path.join(root, "dist", name), "", "utf-8");
  }
  await fs.writeFile(path.join(root, "media", "icon.png"), "", "utf-8");
  return root;
}

function readSetCookie(header: string | null): string {
  if (!header) return "";
  return header.split(";")[0] ?? "";
}

describe("BrowserGatewayHelper pairing flow", () => {
  const roots: string[] = [];
  const deviceStores: string[] = [];
  let helper: BrowserGatewayHelper | null = null;
  const servers: http.Server[] = [];

  afterEach(async () => {
    if (helper) {
      await helper.stop("test-cleanup");
      helper = null;
    }
    while (servers.length > 0) {
      const s = servers.pop()!;
      await new Promise<void>((r) => s.close(() => r()));
    }
    while (roots.length > 0) {
      const p = roots.pop()!;
      try {
        await fs.rm(p, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    while (deviceStores.length > 0) {
      const p = deviceStores.pop()!;
      try {
        await fs.rm(path.dirname(p), { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    // Intentionally NOT touching the shared ~/.agentlink/browser-gateways.json
    // or browser-gateway-helper.json files — they're shared with the other
    // integration test file and wiping them mid-run causes flakiness when
    // tests run in parallel.
  });

  it("creates a pairing code, consumes it via POST /pair, and lists the paired device", async () => {
    const extensionRootPath = await makeExtensionRoot();
    roots.push(extensionRootPath);

    const deviceStoreDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "agentlink-pairing-devstore-"),
    );
    const deviceStorePath = path.join(deviceStoreDir, "devices.json");
    deviceStores.push(deviceStorePath);

    const helperServer = http.createServer();
    servers.push(helperServer);

    const options: HelperRuntimeOptions = {
      port: 47210,
      helperVersion: "test-version",
      idleShutdownMs: 120_000,
      extensionRootPath,
      lanAccess: false,
    };
    helper = new BrowserGatewayHelper(options, helperServer, {
      deviceStore: new DeviceStore({ filePath: deviceStorePath }),
      pairingBroker: new PairingBroker({ ttlMs: 60_000 }),
    });
    helperServer.on("request", helper.handleRequest);
    await helper.start();

    const helperBase = `http://127.0.0.1:${options.port}`;

    const discovery = { clientSharedSecret: helper!.getClientSharedSecret() };

    // 1. Create a pairing code via /internal
    const createResp = await fetch(`${helperBase}/internal/pairing/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${discovery.clientSharedSecret}`,
      },
      body: JSON.stringify({}),
    });
    expect(createResp.ok).toBe(true);
    const created = (await createResp.json()) as {
      pairingId: string;
      code: string;
      expiresAt: string;
      pairingUrls: string[];
    };
    expect(created.code).toMatch(/^\d{6}$/);
    expect(created.pairingUrls.length).toBeGreaterThan(0);

    // 2. Pairing endpoint requires auth before pairing — /api/instances rejects
    const unauthorized = await fetch(`${helperBase}/api/instances`);
    expect(unauthorized.status).toBe(401);

    // 3. Wrong code is rejected
    const wrongCode = await fetch(`${helperBase}/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: "000000" }).toString(),
      redirect: "manual",
    });
    expect(wrongCode.status).toBe(401);

    // 4. Correct code issues a device cookie on 303
    const rightCode = await fetch(`${helperBase}/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: created.code }).toString(),
      redirect: "manual",
    });
    expect(rightCode.status).toBe(303);
    const cookieHeader = rightCode.headers.get("set-cookie");
    expect(cookieHeader).toContain("agentlink_bg_session=");
    const cookie = readSetCookie(cookieHeader);

    // 5. Pairing status reports consumed
    const statusResp = await fetch(
      `${helperBase}/internal/pairing/status?id=${encodeURIComponent(
        created.pairingId,
      )}`,
      {
        headers: {
          Authorization: `Bearer ${discovery.clientSharedSecret}`,
        },
      },
    );
    expect(statusResp.ok).toBe(true);
    const status = (await statusResp.json()) as { status: string };
    expect(status.status).toBe("consumed");

    // 6. Cookie authorizes subsequent /api/* requests
    const instancesResp = await fetch(`${helperBase}/api/instances`, {
      headers: { Cookie: cookie },
    });
    expect(instancesResp.ok).toBe(true);

    // 7. /internal/devices lists the newly paired device
    const devicesResp = await fetch(`${helperBase}/internal/devices`, {
      headers: { Authorization: `Bearer ${discovery.clientSharedSecret}` },
    });
    expect(devicesResp.ok).toBe(true);
    const devices = (await devicesResp.json()) as {
      devices: Array<{ id: string; label: string }>;
    };
    expect(devices.devices).toHaveLength(1);

    // 8. Revoking the device invalidates the cookie
    const revokeResp = await fetch(`${helperBase}/internal/devices/revoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${discovery.clientSharedSecret}`,
      },
      body: JSON.stringify({ deviceId: devices.devices[0]!.id }),
    });
    expect(revokeResp.ok).toBe(true);

    const stale = await fetch(`${helperBase}/api/instances`, {
      headers: { Cookie: cookie },
    });
    expect(stale.status).toBe(401);
  });

  it("reuses the existing loopback bootstrap cookie without pairing", async () => {
    const extensionRootPath = await makeExtensionRoot();
    roots.push(extensionRootPath);

    const helperServer = http.createServer();
    servers.push(helperServer);

    const options: HelperRuntimeOptions = {
      port: 47211,
      helperVersion: "test-version",
      idleShutdownMs: 120_000,
      extensionRootPath,
      lanAccess: false,
    };
    helper = new BrowserGatewayHelper(options, helperServer);
    helperServer.on("request", helper.handleRequest);
    await helper.start();

    const helperBase = `http://127.0.0.1:${options.port}`;
    const rootResp = await fetch(`${helperBase}/`);
    expect(rootResp.ok).toBe(true);
    const cookie = readSetCookie(rootResp.headers.get("set-cookie"));
    expect(cookie).toContain("agentlink_bg_session=");

    const authed = await fetch(`${helperBase}/api/instances`, {
      headers: { Cookie: cookie },
    });
    expect(authed.ok).toBe(true);
  });
});
