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
import {
  clearBrowserGatewayHelperDiscovery,
  getBrowserGatewayHelperDiscoveryPath,
} from "../browserGatewayHelperDiscovery.js";

async function waitForListening(
  server: http.Server,
  port = 0,
): Promise<number> {
  return await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const resolved =
        typeof address === "object" && address ? address.port : 0;
      resolve(resolved);
    });
  });
}

async function makeExtensionRoot(): Promise<string> {
  const extensionRootPath = await fs.mkdtemp(
    path.join(process.cwd(), ".tmp-helper-extension-root-"),
  );
  await fs.mkdir(path.join(extensionRootPath, "dist"), { recursive: true });
  await fs.mkdir(path.join(extensionRootPath, "media"), { recursive: true });
  await fs.writeFile(
    path.join(extensionRootPath, "dist", "browser-gateway.js"),
    "console.log('gateway');",
    "utf-8",
  );
  await fs.writeFile(
    path.join(extensionRootPath, "dist", "browser-gateway.css"),
    "body{}",
    "utf-8",
  );
  await fs.writeFile(
    path.join(extensionRootPath, "dist", "codicon.css"),
    "@font-face{}",
    "utf-8",
  );
  await fs.writeFile(
    path.join(extensionRootPath, "dist", "codicon.ttf"),
    "font",
    "utf-8",
  );
  await fs.writeFile(
    path.join(extensionRootPath, "media", "icon.png"),
    "icon",
    "utf-8",
  );
  await fs.writeFile(
    path.join(extensionRootPath, "media", "agentlink-terminal.svg"),
    "<svg></svg>",
    "utf-8",
  );
  return extensionRootPath;
}

describe("BrowserGatewayHelper proxy routing", () => {
  const servers: http.Server[] = [];
  let helper: BrowserGatewayHelper | null = null;

  afterEach(async () => {
    if (helper) {
      await helper.stop("test-cleanup");
      helper = null;
    }
    while (servers.length > 0) {
      const server = servers.pop()!;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    try {
      await fs.unlink(
        path.join(os.homedir(), ".agentlink", "browser-gateways.json"),
      );
    } catch {
      // ignore
    }
    await clearBrowserGatewayHelperDiscovery();
  });

  it("requires shared-secret auth for internal lease endpoints", async () => {
    const extensionRootPath = await fs.mkdtemp(
      path.join(process.cwd(), ".tmp-helper-extension-root-"),
    );
    await fs.mkdir(path.join(extensionRootPath, "dist"), { recursive: true });
    await fs.mkdir(path.join(extensionRootPath, "media"), { recursive: true });
    await fs.writeFile(
      path.join(extensionRootPath, "dist", "browser-gateway.js"),
      "",
      "utf-8",
    );
    await fs.writeFile(
      path.join(extensionRootPath, "dist", "browser-gateway.css"),
      "",
      "utf-8",
    );
    await fs.writeFile(
      path.join(extensionRootPath, "dist", "codicon.css"),
      "",
      "utf-8",
    );
    await fs.writeFile(
      path.join(extensionRootPath, "dist", "codicon.ttf"),
      "",
      "utf-8",
    );
    await fs.writeFile(
      path.join(extensionRootPath, "media", "icon.png"),
      "",
      "utf-8",
    );

    const helperPort = 47200;
    const helperServer = http.createServer();
    servers.push(helperServer);

    const options: HelperRuntimeOptions = {
      port: helperPort,
      helperVersion: "test-version",
      idleShutdownMs: 120_000,
      extensionRootPath,
    };
    helper = new BrowserGatewayHelper(options, helperServer);
    helperServer.on("request", helper.handleRequest);
    await helper.start();

    const helperBase = `http://127.0.0.1:${helperPort}`;

    const unauthorized = await fetch(`${helperBase}/internal/client/lease`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: "client-a" }),
    });
    expect(unauthorized.status).toBe(401);

    const discovery = JSON.parse(
      await fs.readFile(getBrowserGatewayHelperDiscoveryPath(), "utf-8"),
    ) as { clientSharedSecret: string };

    const authorized = await fetch(`${helperBase}/internal/client/lease`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${discovery.clientSharedSecret}`,
      },
      body: JSON.stringify({ clientId: "client-a" }),
    });
    expect(authorized.ok).toBe(true);

    await fs.rm(extensionRootPath, { recursive: true, force: true });
  });

  it("serves versioned browser assets with cache revalidation headers", async () => {
    const extensionRootPath = await makeExtensionRoot();

    const helperPort = 47203;
    const helperServer = http.createServer();
    servers.push(helperServer);

    const options: HelperRuntimeOptions = {
      port: helperPort,
      helperVersion: "test version/with spaces",
      idleShutdownMs: 120_000,
      extensionRootPath,
    };
    helper = new BrowserGatewayHelper(options, helperServer);
    helperServer.on("request", helper.handleRequest);
    await helper.start();

    const helperBase = `http://127.0.0.1:${helperPort}`;
    const rootResponse = await fetch(`${helperBase}/`);
    expect(rootResponse.headers.get("cache-control")).toBe("no-store");
    const html = await rootResponse.text();
    const encodedVersion = "test%20version%2Fwith%20spaces";
    expect(html).toContain(`/agentlink-icon.svg?v=${encodedVersion}`);
    expect(html).toContain(`/agentlink-icon.png?v=${encodedVersion}`);
    expect(html).toContain(`/apple-touch-icon.png?v=${encodedVersion}`);
    expect(html).toContain(`/site.webmanifest?v=${encodedVersion}`);
    expect(html).toContain(`apple-mobile-web-app-title" content="AgentLink"`);
    expect(html).toContain(`/codicon.css?v=${encodedVersion}`);
    expect(html).toContain(`/browser-gateway.css?v=${encodedVersion}`);
    expect(html).toContain(`/browser-gateway.js?v=${encodedVersion}`);

    const iconResponse = await fetch(
      `${helperBase}/agentlink-icon.png?v=${encodedVersion}`,
    );
    expect(iconResponse.ok).toBe(true);
    expect(iconResponse.headers.get("content-type")).toBe("image/png");
    expect(iconResponse.headers.get("cache-control")).toBe("no-cache");
    expect(iconResponse.headers.get("x-agentlink-helper-version")).toBe(
      "test version/with spaces",
    );

    const svgIconResponse = await fetch(
      `${helperBase}/agentlink-icon.svg?v=${encodedVersion}`,
    );
    expect(svgIconResponse.ok).toBe(true);
    expect(svgIconResponse.headers.get("content-type")).toBe(
      "image/svg+xml; charset=utf-8",
    );
    expect(svgIconResponse.headers.get("cache-control")).toBe("no-cache");

    const manifestResponse = await fetch(
      `${helperBase}/site.webmanifest?v=${encodedVersion}`,
    );
    expect(manifestResponse.ok).toBe(true);
    expect(manifestResponse.headers.get("content-type")).toBe(
      "application/manifest+json; charset=utf-8",
    );
    const manifest = (await manifestResponse.json()) as {
      name?: string;
      short_name?: string;
      theme_color?: string;
      icons?: Array<{ src?: string; sizes?: string; purpose?: string }>;
    };
    expect(manifest.name).toBe("AgentLink Remote");
    expect(manifest.short_name).toBe("AgentLink");
    expect(manifest.theme_color).toBe("#4EC9B0");
    expect(manifest.icons?.[0]).toMatchObject({
      src: "/agentlink-icon.svg",
      sizes: "any",
      purpose: "any",
    });
    expect(manifest.icons?.[1]).toMatchObject({
      src: "/agentlink-icon.png",
      sizes: "256x256",
      purpose: "any",
    });

    const scriptResponse = await fetch(
      `${helperBase}/browser-gateway.js?v=${encodedVersion}`,
    );
    expect(scriptResponse.ok).toBe(true);
    expect(scriptResponse.headers.get("cache-control")).toBe("no-cache");
    expect(scriptResponse.headers.get("x-agentlink-helper-version")).toBe(
      "test version/with spaces",
    );
    expect(scriptResponse.headers.get("etag")).toBe(
      '"test version/with spaces:dist/browser-gateway.js"',
    );

    await fs.rm(extensionRootPath, { recursive: true, force: true });
  });

  it("requires browser session cookie for browser-facing helper APIs", async () => {
    const extensionRootPath = await fs.mkdtemp(
      path.join(process.cwd(), ".tmp-helper-extension-root-"),
    );
    await fs.mkdir(path.join(extensionRootPath, "dist"), { recursive: true });
    await fs.mkdir(path.join(extensionRootPath, "media"), { recursive: true });
    await fs.writeFile(
      path.join(extensionRootPath, "dist", "browser-gateway.js"),
      "",
      "utf-8",
    );
    await fs.writeFile(
      path.join(extensionRootPath, "dist", "browser-gateway.css"),
      "",
      "utf-8",
    );
    await fs.writeFile(
      path.join(extensionRootPath, "dist", "codicon.css"),
      "",
      "utf-8",
    );
    await fs.writeFile(
      path.join(extensionRootPath, "dist", "codicon.ttf"),
      "",
      "utf-8",
    );
    await fs.writeFile(
      path.join(extensionRootPath, "media", "icon.png"),
      "",
      "utf-8",
    );

    const helperPort = 47202;
    const helperServer = http.createServer();
    servers.push(helperServer);

    const options: HelperRuntimeOptions = {
      port: helperPort,
      helperVersion: "test-version",
      idleShutdownMs: 120_000,
      extensionRootPath,
    };
    helper = new BrowserGatewayHelper(options, helperServer);
    helperServer.on("request", helper.handleRequest);
    await helper.start();

    const helperBase = `http://127.0.0.1:${helperPort}`;

    const unauthorized = await fetch(`${helperBase}/api/instances`);
    expect(unauthorized.status).toBe(401);

    const rootResponse = await fetch(`${helperBase}/`);
    expect(rootResponse.ok).toBe(true);
    const setCookie = rootResponse.headers.get("set-cookie");
    expect(setCookie).toContain("agentlink_bg_session=");

    const authorized = await fetch(`${helperBase}/api/instances`, {
      headers: {
        Cookie: String(setCookie?.split(";")[0] ?? ""),
      },
    });
    expect(authorized.ok).toBe(true);

    await fs.rm(extensionRootPath, { recursive: true, force: true });
  });

  it("accepts authenticated internal shutdown requests", async () => {
    const extensionRootPath = await makeExtensionRoot();

    const helperPort = 47204;
    const helperServer = http.createServer();
    servers.push(helperServer);

    const options: HelperRuntimeOptions = {
      port: helperPort,
      helperVersion: "test-version",
      idleShutdownMs: 120_000,
      extensionRootPath,
    };
    helper = new BrowserGatewayHelper(options, helperServer);
    helperServer.on("request", helper.handleRequest);
    await helper.start();

    const helperBase = `http://127.0.0.1:${helperPort}`;
    const unauthorized = await fetch(`${helperBase}/internal/shutdown`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(unauthorized.status).toBe(401);

    const discovery = JSON.parse(
      await fs.readFile(getBrowserGatewayHelperDiscoveryPath(), "utf-8"),
    ) as { clientSharedSecret: string };

    const authorized = await fetch(`${helperBase}/internal/shutdown`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${discovery.clientSharedSecret}`,
      },
      body: "{}",
    });
    expect(authorized.status).toBe(202);
    await expect(authorized.json()).resolves.toEqual({ ok: true });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const healthController = new AbortController();
    const healthTimer = setTimeout(() => healthController.abort(), 250);
    await expect(
      fetch(`${helperBase}/health`, { signal: healthController.signal }),
    ).rejects.toThrow();
    clearTimeout(healthTimer);

    await fs.rm(extensionRootPath, { recursive: true, force: true });
  });

  it("proxies /api/ui-state and /events to selected instance", async () => {
    const upstream = http.createServer((req, res) => {
      const url = req.url ?? "/";
      if (url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (url === "/api/instance-status") {
        expect(req.headers.authorization).toBe("Bearer token-a");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            kind: "awaiting_approval",
            label: "Approval",
            detail: "Awaiting response",
            sessionTitle: "Remote session",
          }),
        );
        return;
      }
      if (url === "/api/ui-state") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ui: {
              approval: null,
              question: null,
              questionProgress: null,
              recentEvents: [],
            },
            session: { sessions: [], foreground: null },
            background: [],
            diffs: [],
            theme: null,
          }),
        );
        return;
      }
      if (url === "/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.end('event: snapshot\\ndata: {"ok":true}\\n\\n');
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found", url }));
    });
    servers.push(upstream);
    const upstreamPort = await waitForListening(upstream, 0);

    const registryDir = path.join(os.homedir(), ".agentlink");
    const registryPath = path.join(registryDir, "browser-gateways.json");
    await fs.mkdir(registryDir, { recursive: true });
    await fs.writeFile(
      registryPath,
      JSON.stringify([
        {
          instanceId: "instance-a",
          workspaceName: "Workspace A",
          workspacePath: "/workspace/a",
          pid: process.pid,
          port: upstreamPort,
          url: `http://127.0.0.1:${upstreamPort}`,
          protocolVersion: 1,
          startedAt: new Date().toISOString(),
          authToken: "token-a",
        },
      ]),
      "utf-8",
    );

    const extensionRootPath = await fs.mkdtemp(
      path.join(process.cwd(), ".tmp-helper-extension-root-"),
    );
    await fs.mkdir(path.join(extensionRootPath, "dist"), { recursive: true });
    await fs.mkdir(path.join(extensionRootPath, "media"), { recursive: true });
    await fs.writeFile(
      path.join(extensionRootPath, "dist", "browser-gateway.js"),
      "",
      "utf-8",
    );
    await fs.writeFile(
      path.join(extensionRootPath, "dist", "browser-gateway.css"),
      "",
      "utf-8",
    );
    await fs.writeFile(
      path.join(extensionRootPath, "dist", "codicon.css"),
      "",
      "utf-8",
    );
    await fs.writeFile(
      path.join(extensionRootPath, "dist", "codicon.ttf"),
      "",
      "utf-8",
    );
    await fs.writeFile(
      path.join(extensionRootPath, "media", "icon.png"),
      "",
      "utf-8",
    );

    const helperPort = 47201;
    const helperServer = http.createServer();
    servers.push(helperServer);

    const options: HelperRuntimeOptions = {
      port: helperPort,
      helperVersion: "test-version",
      idleShutdownMs: 120_000,
      extensionRootPath,
    };
    helper = new BrowserGatewayHelper(options, helperServer);
    helperServer.on("request", helper.handleRequest);
    await helper.start();

    const helperBase = `http://127.0.0.1:${helperPort}`;

    const root = await fetch(`${helperBase}/`);
    expect(root.ok).toBe(true);
    const cookie = String(root.headers.get("set-cookie")?.split(";")[0] ?? "");

    const instances = await fetch(`${helperBase}/api/instances`, {
      headers: { Cookie: cookie },
    });
    expect(instances.ok).toBe(true);
    const instancesJson = (await instances.json()) as {
      currentInstanceId: string;
      instances: Array<{
        instanceId: string;
        status?: { kind: string; label: string; detail?: string };
      }>;
    };
    expect(instancesJson).toHaveProperty("currentInstanceId");
    expect(typeof instancesJson.currentInstanceId).toBe("string");
    expect(Array.isArray(instancesJson.instances)).toBe(true);
    expect(
      instancesJson.instances.find(
        (instance) => instance.instanceId === "instance-a",
      )?.status,
    ).toEqual({
      kind: "awaiting_approval",
      label: "Approval",
      detail: "Awaiting response",
      sessionTitle: "Remote session",
    });

    const snapshot = await fetch(
      `${helperBase}/api/ui-state?instanceId=instance-a`,
      {
        headers: { Cookie: cookie },
      },
    );
    expect(snapshot.ok).toBe(true);
    const snapshotJson = (await snapshot.json()) as { ui?: unknown };
    expect(snapshotJson.ui).toBeTruthy();

    const sse = await fetch(`${helperBase}/events?instanceId=instance-a`, {
      headers: { Accept: "text/event-stream", Cookie: cookie },
    });
    expect(sse.ok).toBe(true);
    const reader = sse.body?.getReader();
    expect(reader).toBeTruthy();
    if (reader) {
      const first = await reader.read();
      const chunk = Buffer.from(first.value ?? new Uint8Array()).toString(
        "utf-8",
      );
      expect(chunk).toContain("event: snapshot");
      await reader.cancel();
    }

    await fs.rm(extensionRootPath, { recursive: true, force: true });
  });
});
