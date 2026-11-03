import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { McpAuthCoordinator } from "./mcpAuthCoordinator.js";
import {
  McpClientHub,
  type McpHubHost,
  type McpServerInfo,
} from "./McpClientHub.js";
import type { McpServerConfig } from "./mcpConfig.js";
import {
  createInMemoryMcpProtocolVerdictStore,
  mcpProtocolVerdictKey,
  type McpProtocolVerdictStore,
} from "./mcpProtocolNegotiation.js";

// Real stdio servers: the probe spawns a sibling process, so allow for load.
const TEST_TIMEOUT_MS = 30_000;
const fixture = fileURLToPath(
  new URL("../test-fixtures/modernMcpServer.mjs", import.meta.url),
);

const hubs: McpClientHub[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(hubs.splice(0).map((hub) => hub.disconnectAll()));
  for (const dir of tempDirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

function createHub(store: McpProtocolVerdictStore) {
  const stateDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "agentlink-mcp-protocol-"),
  );
  tempDirs.push(stateDirectory);
  const host: McpHubHost = {
    authorizeNativeConnection: () => true,
    notify: async () => undefined,
    baseEnvironment: () => ({ PATH: process.env.PATH ?? "" }),
    buildPluginEnvironment: (base) => base,
    fetch: globalThis.fetch,
    createNativeFetch: (_config, baseFetch) => baseFetch,
    createPluginFetch: (_url, _headers, baseFetch) => baseFetch,
    createPluginSseTransport: () => {
      throw new Error("not used");
    },
    createSchemaValidator: async () => {
      const { AjvJsonSchemaValidator } =
        await import("@modelcontextprotocol/client/validators/ajv");
      return new AjvJsonSchemaValidator();
    },
    protocolVerdicts: store,
  };
  const hub = new McpClientHub(host, "test", {
    authCoordinator: new McpAuthCoordinator({ stateDirectory }),
  });
  const logs: string[] = [];
  hub.onLog = (message) => logs.push(message);
  hubs.push(hub);
  return { hub, logs };
}

function server(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    name: "fixture",
    command: process.execPath,
    args: [fixture],
    ...overrides,
  };
}

function connectLog(logs: string[]): string {
  return logs.find((line) => line.includes("connect succeeded")) ?? "";
}

function waitForStatus(
  hub: McpClientHub,
  predicate: (infos: McpServerInfo[]) => boolean,
): Promise<void> {
  return new Promise((resolve) => {
    hub.onStatusChange = (infos) => {
      if (predicate(infos)) resolve();
    };
  });
}

describe("McpClientHub protocol negotiation", () => {
  it(
    "negotiates 2026-07-28, remembers it and serves modern features",
    async () => {
      const store = createInMemoryMcpProtocolVerdictStore();
      const { hub, logs } = createHub(store);
      const elicitations: string[] = [];
      hub.onElicitation = (request, resolve) => {
        elicitations.push(request.message);
        resolve({ confirm: true });
      };

      await hub.connect([server()]);

      expect(connectLog(logs)).toContain("protocol=2026-07-28 era=modern");
      expect(store.get(mcpProtocolVerdictKey(server()))).toMatchObject({
        kind: "modern",
        discover: { supportedVersions: ["2026-07-28"] },
      });

      // Elicitation arrives as an `input_required` round, not a push request.
      const confirmed = await hub.callTool("fixture__confirm", {});
      expect(JSON.stringify(confirmed)).toContain("confirmed");
      expect(elicitations).toEqual(["Proceed?"]);

      // Change notifications arrive over the subscriptions/listen stream.
      const refreshed = waitForStatus(hub, (infos) =>
        infos.some((info) =>
          info.tools?.some((tool) => tool.name === "fixture__late_tool"),
        ),
      );
      await hub.callTool("fixture__add_tool", {});
      await refreshed;
      expect(hub.getToolNames()).toContain("fixture__late_tool");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "skips the probe when a verdict is remembered",
    async () => {
      const store = createInMemoryMcpProtocolVerdictStore();
      await createHub(store).hub.connect([server()]);

      const { hub, logs } = createHub(store);
      await hub.connect([server()]);

      expect(connectLog(logs)).toContain("era=modern");
      expect(connectLog(logs)).toContain("remembered=modern");
      const echoed = await hub.callTool("fixture__echo", { text: "hi" });
      expect(JSON.stringify(echoed)).toContain("hi");

      // Without a probe the SDK opens no listen stream; the hub opens one.
      const refreshed = waitForStatus(hub, (infos) =>
        infos.some((info) =>
          info.tools?.some((tool) => tool.name === "fixture__late_tool"),
        ),
      );
      await hub.callTool("fixture__add_tool", {});
      await refreshed;
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "falls back to the 2025-era handshake for a legacy server",
    async () => {
      const store = createInMemoryMcpProtocolVerdictStore();
      const { hub, logs } = createHub(store);
      hub.onElicitation = (_request, resolve) => resolve({ confirm: false });
      const legacy = server({ env: { FIXTURE_ERA: "legacy" } });

      await hub.connect([legacy]);

      expect(connectLog(logs)).toContain("era=legacy");
      expect(store.get(mcpProtocolVerdictKey(legacy))).toMatchObject({
        kind: "legacy",
      });
      const refused = await hub.callTool("fixture__confirm", {});
      expect(JSON.stringify(refused)).toContain("refused");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "honours a per-server legacy override without remembering it",
    async () => {
      const store = createInMemoryMcpProtocolVerdictStore();
      const { hub, logs } = createHub(store);
      const pinned = server({ protocol: "legacy" });

      await hub.connect([pinned]);

      expect(connectLog(logs)).toContain("era=legacy negotiation=legacy");
      expect(store.get(mcpProtocolVerdictKey(pinned))).toBe(undefined);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "reopens a change notification stream that drops unexpectedly",
    async () => {
      const { hub, logs } = createHub(createInMemoryMcpProtocolVerdictStore());
      await hub.connect([server()]);

      // Simulate the server dropping the stream on a live connection.
      const internals = hub as unknown as {
        servers: Map<string, { client: { listen: unknown } }>;
        watchChangeSubscription: (
          entry: unknown,
          client: unknown,
          subscription: unknown,
          attempt: number,
        ) => void;
      };
      const entry = internals.servers.get("fixture")!;
      const reopened = Promise.withResolvers<void>();
      const listen = vi.fn(async (filter: unknown) => {
        reopened.resolve();
        return {
          honoredFilter: filter,
          close: async () => undefined,
          closed: new Promise(() => undefined),
        };
      });
      entry.client.listen = listen;
      internals.watchChangeSubscription(
        entry,
        entry.client,
        {
          honoredFilter: { toolsListChanged: true },
          closed: Promise.resolve("remote"),
        },
        0,
      );

      await reopened.promise;
      expect(listen).toHaveBeenCalledWith({ toolsListChanged: true });
      await vi.waitFor(() =>
        expect(logs).toContain(
          "[mcp:fixture] change notification stream reopened",
        ),
      );
    },
    TEST_TIMEOUT_MS,
  );
});
