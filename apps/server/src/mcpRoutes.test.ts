import { afterEach, describe, expect, it } from "vitest";
import { createMcpRoutes, renderMcpReturnPage } from "./mcpRoutes.js";

import type { AddressInfo } from "node:net";
import type { AssistantServerAuth } from "./assistantServer.js";
import { HttpError } from "./httpJson.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { promises as fs } from "node:fs";
import http from "node:http";
import { openMcpRegistry } from "./mcpRegistry.js";
import os from "node:os";
import path from "node:path";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const auth = (subjectId: string): AssistantServerAuth => {
  const signedIn: AssistantServerAuth = {
    principal: { tenantId: "agentlink-server", subjectId },
    session: {
      ownerId: subjectId,
      sessionId: "s",
      deviceId: "d",
      deviceLabel: "Laptop",
      createdAt: 0,
      expiresAt: Number.MAX_SAFE_INTEGER,
    },
    signal: new AbortController().signal,
    revalidate: async () => ({ valid: true }),
    detach: () => signedIn,
  };
  return signedIn;
};

async function setup() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-routes-"));
  cleanup.push(() => fs.rm(dataRoot, { recursive: true, force: true }));
  const registry = await openMcpRegistry({
    dataRoot,
    redirectUrl: "https://assistant.example/mcp/callback",
    createTransport: () => {
      const [client, serverSide] = InMemoryTransport.createLinkedPair();
      const server = new Server(
        { name: "fake", version: "1.0.0" },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          {
            name: "search",
            description: "Search",
            inputSchema: { type: "object" as const, properties: {} },
          },
        ],
      }));
      void server.connect(serverSide);
      return client;
    },
  });
  let changes = 0;
  const routes = createMcpRoutes({
    registry,
    refresh: (id) => registry.refresh(id),
    onChanged: () => {
      changes += 1;
    },
    isOwner: (request) => request.principal.subjectId === "owner",
  });
  let caller = auth("owner");
  const server = http.createServer((request, response) => {
    routes
      .handleRequest(request, response, caller)
      .then((handled) => {
        if (!handled) {
          response.writeHead(404);
          response.end("{}");
        }
      })
      .catch((error: unknown) => {
        response.writeHead(error instanceof HttpError ? error.status : 500, {
          "content-type": "application/json",
        });
        response.end(
          JSON.stringify({
            error: error instanceof HttpError ? error.code : String(error),
          }),
        );
      });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  cleanup.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const port = (server.address() as AddressInfo).port;
  const call = async (method: string, pathname: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method,
      redirect: "manual",
      ...(body !== undefined
        ? {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }
        : {}),
    });
    const text = await response.text();
    return {
      status: response.status,
      text,
      location: response.headers.get("location"),
      body: text ? (JSON.parse(text) as Record<string, any>) : {},
    };
  };
  return {
    call,
    registry,
    changes: () => changes,
    setCaller: (subjectId: string) => {
      caller = auth(subjectId);
    },
  };
}

describe("MCP routes", () => {
  it("are the owner's only", async () => {
    const { call, setCaller } = await setup();
    setCaller("someone-else");
    await expect(call("GET", "/api/mcp")).resolves.toMatchObject({
      status: 403,
      body: { error: "mcp_forbidden" },
    });
  });

  it("add, test, set a policy and remove, never returning a secret", async () => {
    const { call, changes } = await setup();
    const added = await call("POST", "/api/mcp", {
      label: "Tracker",
      url: "https://mcp.tracker.example/mcp",
      auth: "header",
      headerName: "Authorization",
      headerValue: "Bearer sk-hidden-123",
    });
    expect(added.status).toBe(201);
    expect(added.body.server).toMatchObject({
      id: "tracker",
      status: "ok",
      hasCredentials: true,
      headerName: "Authorization",
      tools: [{ name: "search", policy: "ask" }],
    });
    expect(added.text).not.toContain("sk-hidden");

    const listed = await call("GET", "/api/mcp");
    expect(listed.text).not.toContain("sk-hidden");
    expect(listed.body.servers).toHaveLength(1);

    const policy = await call("PUT", "/api/mcp/tracker/tools/search", {
      policy: "run",
    });
    expect(policy.body.server.tools[0].policy).toBe("run");
    await expect(
      call("PUT", "/api/mcp/tracker/tools/search", { policy: "always" }),
    ).resolves.toMatchObject({ status: 400 });

    const tested = await call("POST", "/api/mcp/tracker/test");
    expect(tested.body).toMatchObject({ changed: [], removed: [] });

    const off = await call("PATCH", "/api/mcp/tracker", { enabled: false });
    expect(off.body.server.enabled).toBe(false);

    await expect(call("DELETE", "/api/mcp/tracker")).resolves.toMatchObject({
      status: 200,
    });
    await expect(call("GET", "/api/mcp/tracker/test")).resolves.toMatchObject({
      status: 404,
    });
    expect(changes()).toBeGreaterThan(0);
  });

  it("keep the always-ask list, refuse Run for tools on it, and check Run rules", async () => {
    const { call } = await setup();
    await call("POST", "/api/mcp", {
      label: "Tracker",
      url: "https://mcp.tracker.example/mcp",
      auth: "none",
    });
    const listed = await call("GET", "/api/mcp");
    expect(listed.body.alwaysAsk.builtIn.length).toBeGreaterThan(0);
    expect(listed.body.alwaysAsk.extra).toEqual([]);
    expect(listed.body.servers[0].tools[0]).toMatchObject({
      name: "search",
      arguments: [],
    });

    // No such argument for a rule.
    await expect(
      call("PUT", "/api/mcp/tracker/tools/search", {
        policy: "run",
        runWhen: { q: ["x"] },
      }),
    ).resolves.toMatchObject({
      status: 400,
      body: { error: "mcp_rule_invalid" },
    });

    await call("PUT", "/api/mcp/tracker/tools/search", { policy: "run" });
    const extended = await call("PUT", "/api/mcp", { alwaysAsk: ["search"] });
    expect(extended.body.alwaysAsk.extra).toEqual(["search"]);
    expect(extended.body.servers[0].tools[0]).toMatchObject({
      policy: "ask",
      alwaysAsks: expect.stringContaining("search"),
    });
    await expect(
      call("PUT", "/api/mcp/tracker/tools/search", { policy: "run" }),
    ).resolves.toMatchObject({
      status: 409,
      body: { error: "mcp_run_refused" },
    });
    await expect(
      call("PUT", "/api/mcp", { alwaysAsk: ["*"] }),
    ).resolves.toMatchObject({ status: 400 });
  });

  it("add a server on the owner's network only with the flag", async () => {
    const { call } = await setup();
    const refused = await call("POST", "/api/mcp", {
      label: "Home",
      url: "http://192.168.1.20:8123/api/mcp",
      auth: "header",
      headerName: "Authorization",
      headerValue: "Bearer ha-hidden",
    });
    expect(refused).toMatchObject({
      status: 400,
      body: { error: "mcp_url_invalid" },
    });
    expect(refused.body.detail).toContain("On my network");
    await expect(
      call("POST", "/api/mcp", {
        label: "Home",
        url: "http://192.168.1.20:8123/api/mcp",
        auth: "none",
        network: "yes",
      }),
    ).resolves.toMatchObject({
      status: 400,
      body: { error: "network_invalid" },
    });
    const added = await call("POST", "/api/mcp", {
      label: "Home",
      url: "http://192.168.1.20:8123/api/mcp",
      auth: "header",
      headerName: "Authorization",
      headerValue: "Bearer ha-hidden",
      network: true,
    });
    expect(added.status).toBe(201);
    expect(added.body.server).toMatchObject({ network: true, status: "ok" });
    expect(added.text).not.toContain("ha-hidden");
  });

  it("explains a refused address in plain words", async () => {
    const { call } = await setup();
    await expect(
      call("POST", "/api/mcp", {
        label: "Local",
        url: "https://localhost/mcp",
        auth: "none",
      }),
    ).resolves.toMatchObject({
      status: 400,
      body: { error: "mcp_url_invalid", detail: expect.any(String) },
    });
  });

  it("returns to the app after a sign-in that is unknown or refused", async () => {
    const { call } = await setup();
    await expect(
      call("GET", "/api/mcp/oauth/callback?state=nope&code=abc"),
    ).resolves.toMatchObject({
      status: 303,
      location: "/?mcp=sign-in-failed",
    });
    await expect(
      call("GET", "/api/mcp/oauth/callback?error=access_denied"),
    ).resolves.toMatchObject({
      status: 303,
      location: "/?mcp=sign-in-failed",
    });
  });
});

describe("renderMcpReturnPage", () => {
  it("forwards only state, code and error, escaped", () => {
    const html = renderMcpReturnPage(
      new URLSearchParams({
        state: 'a"><script>',
        code: "c&d",
        other: "dropped",
      }),
    );
    expect(html).toContain("/api/mcp/oauth/callback?state=");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("dropped");
  });
});
