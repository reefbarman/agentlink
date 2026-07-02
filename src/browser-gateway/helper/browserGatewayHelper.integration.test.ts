/** @vitest-environment node */

import * as fs from "fs/promises";
import * as http from "http";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatMessage } from "../../agent/webview/types.js";
import {
  BrowserGatewayHelper,
  type HelperRuntimeOptions,
} from "./browserGatewayHelper.js";
import type { CoreModelMessage } from "../../core/modelRuntime.js";
import {
  BrowserGatewayAskAgentModelClient,
  type BrowserGatewayAskAgentCompletionParams,
  type BrowserGatewayAskAgentCompletionResult,
} from "./askAgentModelClient.js";
import {
  clearBrowserGatewayHelperDiscovery,
  getBrowserGatewayHelperDiscoveryPath,
} from "../browserGatewayHelperDiscovery.js";
import {
  BROWSER_GATEWAY_ASK_AGENT_OWNER_ID,
  BROWSER_GATEWAY_ASK_AGENT_SESSION_ID,
} from "../browserGatewayAskAgentSessionStore.js";
import { BrowserGatewayAskAgentPreferencesStore } from "../browserGatewayAskAgentPreferences.js";
import { BrowserGatewayAskAgentHistoryStore } from "../browserGatewayAskAgentHistory.js";
import { BrowserGatewayAskAgentMemoryStore } from "../browserGatewayAskAgentMemory.js";
import type {
  BrowserGatewayAskAgentSummarizer,
  BrowserGatewayAskAgentSummaryResult,
} from "./browserGatewayAskAgentSummarizer.js";

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

async function getAvailablePort(): Promise<number> {
  const server = http.createServer();
  const port = await waitForListening(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function readJsonlLog(
  filePath: string,
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const lines = raw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      if (lines.length > 0) {
        return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      }
    } catch {
      // The helper creates the log lazily after the first Ask Agent event.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return [];
}

async function waitForExpectation(
  assertion: () => void | Promise<void>,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (lastError) throw lastError;
}

type AskAgentProjectedMessageForTest = {
  id?: string;
  role: string;
  content: string;
  memoryDisclosure?: {
    status: string;
    summaryCount: number;
    transcriptExcerptCount: number;
    sources: Array<{
      kind: string;
      label: string;
      title?: string;
      score?: number;
    }>;
  };
};

type AskAgentToolLoopTestClient = Pick<
  BrowserGatewayAskAgentModelClient,
  "complete" | "completeWithToolCalls"
>;

async function makeAskAgentToolLoopTestHarness(params: {
  modelClient: AskAgentToolLoopTestClient;
  helperVersion?: string;
}): Promise<{
  helper: BrowserGatewayHelper;
  helperServer: http.Server;
  helperBase: string;
  cookie: string;
  askAgentLogPath: string;
}> {
  const extensionRootPath = await makeExtensionRoot();
  const helperPort = await getAvailablePort();
  const helperServer = http.createServer();
  const askAgentLogPath = path.join(
    os.tmpdir(),
    `.tmp-ask-agent-tool-loop-${Date.now()}-${Math.random()}.jsonl`,
  );
  const storeDir = await fs.mkdtemp(
    path.join(os.tmpdir(), ".tmp-ask-agent-tool-loop-store-"),
  );
  const helper = new BrowserGatewayHelper(
    {
      port: helperPort,
      helperVersion: params.helperVersion ?? "test-version",
      idleShutdownMs: 120_000,
      extensionRootPath,
      askAgentLogPath,
    },
    helperServer,
    {
      askAgentModelClient: params.modelClient,
      askAgentPreferencesStore: new BrowserGatewayAskAgentPreferencesStore({
        filePath: path.join(storeDir, "preferences.json"),
      }),
      askAgentHistoryStore: new BrowserGatewayAskAgentHistoryStore({
        filePath: path.join(storeDir, "history.json"),
      }),
      askAgentMemoryStore: new BrowserGatewayAskAgentMemoryStore({
        filePath: path.join(storeDir, "memory.json"),
      }),
    },
  );
  helperServer.on("request", helper.handleRequest);
  await helper.start();
  const helperBase = `http://127.0.0.1:${helperPort}`;
  const root = await fetch(`${helperBase}/`);
  const cookie = String(root.headers.get("set-cookie")?.split(";")[0] ?? "");
  const discovery = JSON.parse(
    await fs.readFile(getBrowserGatewayHelperDiscoveryPath(), "utf-8"),
  ) as { clientSharedSecret: string; helperGenerationId: string };
  const internalHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${discovery.clientSharedSecret}`,
  };
  const owner = await fetch(`${helperBase}/api/ask-agent/session`, {
    headers: { Cookie: cookie },
  });
  const ownerPayload = (await owner.json()) as {
    ownerRegistration: {
      owner: { ownerId: string };
      ownerGenerationId: string;
    };
  };
  await fetch(`${helperBase}/internal/core-owners/register`, {
    method: "POST",
    headers: internalHeaders,
    body: JSON.stringify({
      ownerId: "vscode-owner",
      ownerKind: "vscode",
      displayName: "VS Code Test Owner",
      scope: { kind: "workspace", workspaceId: "workspace-test" },
      ownerGenerationId: "vscode-generation-1",
      instanceId: "vscode-instance-1",
      processId: process.pid,
    }),
  });
  await fetch(`${helperBase}/internal/model-auth/credentials`, {
    method: "POST",
    headers: internalHeaders,
    body: JSON.stringify({
      providerId: "openai-codex",
      method: "oauth",
      bearerToken: "test-token",
      grantedByOwnerId: "vscode-owner",
      modelScopes: ["chat"],
      helperGenerationId: discovery.helperGenerationId,
      ttlMs: 60_000,
      now: Date.now(),
    }),
  });
  await fetch(`${helperBase}/internal/model-auth/leases`, {
    method: "POST",
    headers: internalHeaders,
    body: JSON.stringify({
      providerId: "openai-codex",
      method: "oauth",
      grantedByOwnerId: "vscode-owner",
      grantedToOwnerId: ownerPayload.ownerRegistration.owner.ownerId,
      grantedToOwnerGenerationId:
        ownerPayload.ownerRegistration.ownerGenerationId,
      modelScopes: ["chat"],
      helperGenerationId: discovery.helperGenerationId,
      ttlMs: 60_000,
      auditId: "ask-agent-tool-loop-test",
    }),
  });
  return { helper, helperServer, helperBase, cookie, askAgentLogPath };
}

function makeAskAgentToolLoopClient(
  completeWithToolCalls: (
    params: BrowserGatewayAskAgentCompletionParams,
  ) => Promise<BrowserGatewayAskAgentCompletionResult>,
): AskAgentToolLoopTestClient {
  return {
    complete: async (params) => (await completeWithToolCalls(params)).text,
    completeWithToolCalls,
  };
}

async function makeExtensionRoot(): Promise<string> {
  const extensionRootPath = await fs.mkdtemp(
    path.join(os.tmpdir(), ".tmp-helper-extension-root-"),
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
  const isolatedStoreDirs: string[] = [];
  let helper: BrowserGatewayHelper | null = null;

  type BrowserGatewayHelperInjectables = NonNullable<
    ConstructorParameters<typeof BrowserGatewayHelper>[2]
  >;

  async function createIsolatedHelper(
    options: HelperRuntimeOptions,
    server: http.Server,
    injectables: BrowserGatewayHelperInjectables = {},
  ): Promise<BrowserGatewayHelper> {
    const storeDir = await fs.mkdtemp(
      path.join(os.tmpdir(), ".tmp-browser-gateway-helper-store-"),
    );
    isolatedStoreDirs.push(storeDir);
    return new BrowserGatewayHelper(options, server, {
      ...injectables,
      askAgentPreferencesStore:
        injectables.askAgentPreferencesStore ??
        new BrowserGatewayAskAgentPreferencesStore({
          filePath: path.join(storeDir, "preferences.json"),
        }),
      askAgentHistoryStore:
        injectables.askAgentHistoryStore ??
        new BrowserGatewayAskAgentHistoryStore({
          filePath: path.join(storeDir, "history.json"),
        }),
      askAgentMemoryStore:
        injectables.askAgentMemoryStore ??
        new BrowserGatewayAskAgentMemoryStore({
          filePath: path.join(storeDir, "memory.json"),
        }),
    });
  }

  afterEach(async () => {
    if (helper) {
      await helper.stop("test-cleanup");
      helper = null;
    }
    while (servers.length > 0) {
      const server = servers.pop()!;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    while (isolatedStoreDirs.length > 0) {
      const dir = isolatedStoreDirs.pop()!;
      await fs.rm(dir, { recursive: true, force: true });
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
      path.join(os.tmpdir(), ".tmp-helper-extension-root-"),
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
    helper = await createIsolatedHelper(options, helperServer);
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

  it("serves authenticated Ask Agent projectless slash commands", async () => {
    const extensionRootPath = await makeExtensionRoot();

    const helperPort = 47206;
    const helperServer = http.createServer();
    servers.push(helperServer);

    const options: HelperRuntimeOptions = {
      port: helperPort,
      helperVersion: "test-version",
      idleShutdownMs: 120_000,
      extensionRootPath,
    };
    helper = await createIsolatedHelper(options, helperServer);
    helperServer.on("request", helper.handleRequest);
    await helper.start();

    const helperBase = `http://127.0.0.1:${helperPort}`;
    const unauthorized = await fetch(
      `${helperBase}/api/ask-agent/slash-commands`,
    );
    expect(unauthorized.status).toBe(401);

    const bootstrap = await fetch(helperBase);
    const cookie = bootstrap.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("agentlink_bg_session=");

    const authorized = await fetch(
      `${helperBase}/api/ask-agent/slash-commands`,
      {
        headers: { Cookie: cookie.split(";")[0] ?? "" },
      },
    );
    expect(authorized.status).toBe(200);
    const body = (await authorized.json()) as {
      commands: Array<{ name: string; source: string; builtin: boolean }>;
    };
    const commandNames = body.commands.map((command) => command.name);
    expect(commandNames).toContain("remember");
    expect(commandNames).toContain("mcp");
    expect(commandNames).toContain("mcp-config");
    expect(commandNames).toContain("mcp-refresh");
    expect(commandNames).toContain("skill:skill-writing");
    expect(commandNames).not.toContain("new");
    expect(commandNames).not.toContain("mode");
    expect(commandNames).not.toContain("checkpoint");
    expect(commandNames).not.toContain("revert");
    expect(commandNames).not.toContain("btw");
    expect(commandNames).not.toContain("pair");
    expect(body.commands.every((command) => command.source !== "project")).toBe(
      true,
    );
    expect(
      body.commands
        .filter((command) => command.builtin)
        .map((command) => command.name)
        .sort(),
    ).toEqual(["mcp", "mcp-config", "mcp-refresh"]);

    await fs.rm(extensionRootPath, { recursive: true, force: true });
  });

  it("creates Ask Agent memory proposals without writing until approval", async () => {
    const extensionRootPath = await makeExtensionRoot();
    const homeDir = await fs.mkdtemp(
      path.join(os.tmpdir(), ".tmp-helper-home-"),
    );
    const originalHome = process.env.HOME;
    process.env.HOME = homeDir;

    try {
      const helperPort = 47207;
      const helperServer = http.createServer();
      servers.push(helperServer);

      const options: HelperRuntimeOptions = {
        port: helperPort,
        helperVersion: "test-version",
        idleShutdownMs: 120_000,
        extensionRootPath,
      };
      helper = await createIsolatedHelper(options, helperServer);
      helperServer.on("request", helper.handleRequest);
      await helper.start();

      const helperBase = `http://127.0.0.1:${helperPort}`;
      const bootstrap = await fetch(helperBase);
      const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0] ?? "";
      expect(cookie).toContain("agentlink_bg_session=");

      const memoryPath = path.join(homeDir, ".agentlink", "memory.md");
      const proposal = await fetch(
        `${helperBase}/api/ask-agent/memory/proposal`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: cookie,
          },
          body: JSON.stringify({
            tier: "memory",
            scope: "global",
            operation: "add",
            title: "Remember preference",
            rationale: "User invoked /remember in Ask Agent.",
            content: "User prefers checklist smoke-test notes.",
          }),
        },
      );
      expect(proposal.status).toBe(200);
      const proposalBody = (await proposal.json()) as {
        approval: { id: string; memoryContent?: string };
        snapshot: { ui: { approval: { id: string; kind: string } | null } };
      };
      expect(proposalBody.snapshot.ui.approval).toMatchObject({
        id: proposalBody.approval.id,
        kind: "memory",
      });
      await expect(fs.readFile(memoryPath, "utf-8")).rejects.toMatchObject({
        code: "ENOENT",
      });

      const accepted = await fetch(
        `${helperBase}/api/ask-agent/memory/approval`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: cookie,
          },
          body: JSON.stringify({
            id: proposalBody.approval.id,
            decision: "accept",
            editedContent: proposalBody.approval.memoryContent,
          }),
        },
      );
      expect(accepted.status).toBe(200);
      const acceptedBody = (await accepted.json()) as {
        snapshot: { ui: { approval: null | unknown } };
      };
      expect(acceptedBody.snapshot.ui.approval).toBeNull();
      await expect(fs.readFile(memoryPath, "utf-8")).resolves.toContain(
        "User prefers checklist smoke-test notes.",
      );
    } finally {
      process.env.HOME = originalHome;
      await fs.rm(homeDir, { recursive: true, force: true });
      await fs.rm(extensionRootPath, { recursive: true, force: true });
    }
  });

  it("surfaces durable memory candidate nudges without writing until approval", async () => {
    const extensionRootPath = await makeExtensionRoot();
    const homeDir = await fs.mkdtemp(
      path.join(os.tmpdir(), ".tmp-helper-home-"),
    );
    const originalHome = process.env.HOME;
    process.env.HOME = homeDir;

    try {
      const helperPort = 47217;
      const helperServer = http.createServer();
      servers.push(helperServer);
      const options: HelperRuntimeOptions = {
        port: helperPort,
        helperVersion: "test-version",
        idleShutdownMs: 120_000,
        extensionRootPath,
      };
      helper = await createIsolatedHelper(options, helperServer);
      helperServer.on("request", helper.handleRequest);
      await helper.start();

      const helperBase = `http://127.0.0.1:${helperPort}`;
      const bootstrap = await fetch(helperBase);
      const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0] ?? "";
      const session = await fetch(`${helperBase}/api/ask-agent/session`, {
        headers: { Cookie: cookie },
      });
      const sessionBody = (await session.json()) as {
        session: { sessionId: string };
      };
      const memoryPath = path.join(homeDir, ".agentlink", "memory.md");

      const send = await fetch(`${helperBase}/api/ask-agent/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({
          sessionId: sessionBody.session.sessionId,
          text: "Going forward, always ask me before switching modes.",
        }),
      });
      expect(send.status).toBe(200);
      const sendBody = (await send.json()) as {
        snapshot: {
          ui: {
            approval: null | unknown;
            memoryCandidateNudge: null | {
              id: string;
              content: string;
              suggestedScope: string;
            };
          };
        };
      };
      expect(sendBody.snapshot.ui.approval).toBeNull();
      expect(sendBody.snapshot.ui.memoryCandidateNudge).toMatchObject({
        content: "Going forward, always ask me before switching modes",
        suggestedScope: "global",
      });
      await expect(fs.readFile(memoryPath, "utf-8")).rejects.toMatchObject({
        code: "ENOENT",
      });

      const proposal = await fetch(
        `${helperBase}/api/ask-agent/memory/proposal`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: cookie },
          body: JSON.stringify({
            nudgeId: sendBody.snapshot.ui.memoryCandidateNudge?.id,
            tier: "memory",
            scope: "global",
            operation: "add",
            title: "Remember from Ask Agent",
            rationale:
              "User approved reviewing a Browser Ask Agent memory nudge.",
            content: sendBody.snapshot.ui.memoryCandidateNudge?.content,
          }),
        },
      );
      expect(proposal.status).toBe(200);
      const proposalBody = (await proposal.json()) as {
        approval: { id: string; memoryContent?: string };
        snapshot: {
          ui: { approval: { id: string } | null; memoryCandidateNudge: null };
        };
      };
      expect(proposalBody.snapshot.ui.memoryCandidateNudge).toBeNull();
      expect(proposalBody.snapshot.ui.approval?.id).toBe(
        proposalBody.approval.id,
      );
      await expect(fs.readFile(memoryPath, "utf-8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      process.env.HOME = originalHome;
      await fs.rm(homeDir, { recursive: true, force: true });
      await fs.rm(extensionRootPath, { recursive: true, force: true });
    }
  });

  it("clears only confirmed derived Ask Agent memory summaries", async () => {
    const extensionRootPath = await makeExtensionRoot();
    const homeDir = await fs.mkdtemp(
      path.join(os.tmpdir(), ".tmp-helper-home-"),
    );
    const originalHome = process.env.HOME;
    process.env.HOME = homeDir;

    try {
      const helperPort = 47208;
      const helperServer = http.createServer();
      servers.push(helperServer);
      const askAgentHistoryPath = path.join(
        await fs.mkdtemp(path.join(os.tmpdir(), ".tmp-ask-agent-history-")),
        "history.json",
      );
      const askAgentHistoryStore = new BrowserGatewayAskAgentHistoryStore({
        filePath: askAgentHistoryPath,
      });
      const askAgentMemoryStore = new BrowserGatewayAskAgentMemoryStore({
        filePath: path.join(
          await fs.mkdtemp(path.join(os.tmpdir(), ".tmp-ask-agent-memory-")),
          "memory.json",
        ),
      });
      const rawTranscriptText =
        "Raw transcript text must stay in history only.";
      await askAgentHistoryStore.write({
        activeSessionId: BROWSER_GATEWAY_ASK_AGENT_SESSION_ID,
        sessions: [
          {
            id: BROWSER_GATEWAY_ASK_AGENT_SESSION_ID,
            title: "Ask Agent",
            createdAt: 100,
            lastActiveAt: 200,
            nextMessageSequence: 2,
            messages: [
              {
                id: "raw-user",
                role: "user",
                content: rawTranscriptText,
                timestamp: 150,
                blocks: [{ type: "text", text: rawTranscriptText }],
              },
            ],
          },
        ],
      });
      await askAgentMemoryStore.upsertSessionMemory({
        sessionId: BROWSER_GATEWAY_ASK_AGENT_SESSION_ID,
        title: "Derived summary title",
        createdAt: 100,
        lastActiveAt: 200,
        messageCount: 1,
        sourceRevision: "revision-a",
        summary: "Private derived session summary should not be exposed.",
        topics: ["memory"],
        decisions: [],
        openQuestions: [],
        durableCandidateHints: [],
        updatedAt: 300,
      });
      await askAgentMemoryStore.upsertChunk({
        id: "chunk-a",
        sessionId: BROWSER_GATEWAY_ASK_AGENT_SESSION_ID,
        sourceMessageIds: ["raw-user"],
        startMessageIndex: 0,
        endMessageIndex: 0,
        sourceRevision: "revision-a",
        summary: "Private derived chunk summary should not be exposed.",
        keywords: ["memory"],
        entities: ["Ask Agent"],
        createdAt: 300,
        updatedAt: 300,
      });
      await fs.mkdir(path.join(homeDir, ".agentlink"), { recursive: true });
      const durableMemoryPath = path.join(homeDir, ".agentlink", "memory.md");
      await fs.writeFile(
        durableMemoryPath,
        "- Durable memory should remain.\n",
        "utf-8",
      );

      const options: HelperRuntimeOptions = {
        port: helperPort,
        helperVersion: "test-version",
        idleShutdownMs: 120_000,
        extensionRootPath,
      };
      helper = await createIsolatedHelper(options, helperServer, {
        askAgentHistoryStore,
        askAgentMemoryStore,
      });
      helperServer.on("request", helper.handleRequest);
      await helper.start();

      const helperBase = `http://127.0.0.1:${helperPort}`;
      const bootstrap = await fetch(helperBase);
      const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0] ?? "";
      expect(cookie).toContain("agentlink_bg_session=");

      const status = await fetch(`${helperBase}/api/ask-agent/memory`, {
        headers: { Cookie: cookie },
      });
      expect(status.ok).toBe(true);
      const statusText = await status.text();
      expect(statusText).toContain("Derived summary title");
      expect(statusText).toContain("sessionSummaryCount");
      expect(statusText).toContain("chunkSummaryCount");
      expect(statusText).not.toContain("Private derived session summary");
      expect(statusText).not.toContain("Private derived chunk summary");
      expect(statusText).not.toContain(rawTranscriptText);

      const unconfirmedClear = await fetch(
        `${helperBase}/api/ask-agent/memory/clear`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: cookie },
          body: JSON.stringify({ confirm: false }),
        },
      );
      expect(unconfirmedClear.status).toBe(400);
      await expect(askAgentMemoryStore.read()).resolves.toMatchObject({
        sessions: [
          expect.objectContaining({
            sessionId: BROWSER_GATEWAY_ASK_AGENT_SESSION_ID,
          }),
        ],
        chunks: [expect.objectContaining({ id: "chunk-a" })],
      });

      const confirmedClear = await fetch(
        `${helperBase}/api/ask-agent/memory/clear`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: cookie },
          body: JSON.stringify({ confirm: true }),
        },
      );
      expect(confirmedClear.ok).toBe(true);
      await expect(confirmedClear.json()).resolves.toMatchObject({
        ok: true,
        memory: {
          sessionSummaryCount: 0,
          chunkSummaryCount: 0,
          totalSummaryCount: 0,
          lastUpdatedAt: null,
          recentSessions: [],
        },
      });
      await expect(askAgentMemoryStore.read()).resolves.toMatchObject({
        sessions: [],
        chunks: [],
      });
      await expect(askAgentHistoryStore.read()).resolves.toMatchObject({
        sessions: [
          expect.objectContaining({
            messages: [expect.objectContaining({ content: rawTranscriptText })],
          }),
        ],
      });
      await expect(fs.readFile(durableMemoryPath, "utf-8")).resolves.toContain(
        "Durable memory should remain.",
      );
    } finally {
      process.env.HOME = originalHome;
      await fs.rm(homeDir, { recursive: true, force: true });
      await fs.rm(extensionRootPath, { recursive: true, force: true });
    }
  });

  it("tracks authenticated neutral core owner registration and release", async () => {
    const extensionRootPath = await makeExtensionRoot();

    const helperPort = 47205;
    const helperServer = http.createServer();
    servers.push(helperServer);

    const options: HelperRuntimeOptions = {
      port: helperPort,
      helperVersion: "test-version",
      idleShutdownMs: 120_000,
      extensionRootPath,
    };
    helper = await createIsolatedHelper(options, helperServer);
    helperServer.on("request", helper.handleRequest);
    await helper.start();

    const helperBase = `http://127.0.0.1:${helperPort}`;
    const discovery = JSON.parse(
      await fs.readFile(getBrowserGatewayHelperDiscoveryPath(), "utf-8"),
    ) as { clientSharedSecret: string; helperGenerationId?: string };
    expect(discovery.helperGenerationId).toBeTruthy();

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${discovery.clientSharedSecret}`,
    };
    const invalidKind = await fetch(
      `${helperBase}/internal/core-owners/register`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          ownerId: "bad-owner",
          ownerKind: "unknown-surface",
          displayName: "Bad Owner",
          scope: {
            kind: "workspace",
            workspaceId: "workspace-1",
            displayName: "Repo",
          },
          ownerGenerationId: "generation-bad",
        }),
      },
    );
    expect(invalidKind.status).toBe(400);

    const invalidScope = await fetch(
      `${helperBase}/internal/core-owners/register`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          ownerId: "bad-owner",
          ownerKind: "vscode",
          displayName: "Bad Owner",
          scope: { kind: "workspace" },
          ownerGenerationId: "generation-bad",
        }),
      },
    );
    expect(invalidScope.status).toBe(400);

    const owner = {
      ownerId: "owner-vscode-1",
      ownerKind: "vscode",
      displayName: "VS Code — Repo",
      scope: {
        kind: "workspace",
        workspaceId: "workspace-1",
        displayName: "Repo",
      },
      ownerGenerationId: "generation-1",
      instanceId: "instance-1",
      processId: 123,
    };

    const register = await fetch(
      `${helperBase}/internal/core-owners/register`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(owner),
      },
    );
    expect(register.ok).toBe(true);
    await expect(register.json()).resolves.toMatchObject({
      ok: true,
      ownerRegistration: {
        owner: {
          ownerId: "owner-vscode-1",
          ownerKind: "vscode",
          scope: { kind: "workspace", workspaceId: "workspace-1" },
        },
        status: "connected",
        ownerGenerationId: "generation-1",
      },
    });

    const heartbeat = await fetch(
      `${helperBase}/internal/core-owners/heartbeat`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          ownerId: "owner-vscode-1",
          ownerGenerationId: "generation-1",
        }),
      },
    );
    expect(heartbeat.ok).toBe(true);

    const staleGenerationHeartbeat = await fetch(
      `${helperBase}/internal/core-owners/heartbeat`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          ownerId: "owner-vscode-1",
          ownerGenerationId: "generation-2",
        }),
      },
    );
    expect(staleGenerationHeartbeat.status).toBe(404);

    const list = await fetch(`${helperBase}/internal/core-owners`, { headers });
    expect(list.ok).toBe(true);
    await expect(list.json()).resolves.toMatchObject({
      owners: [
        {
          owner: { ownerId: "owner-vscode-1" },
          status: "connected",
          ownerGenerationId: "generation-1",
        },
      ],
    });

    const release = await fetch(`${helperBase}/internal/client/release`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        clientId: "client-a",
        ownerId: "owner-vscode-1",
        ownerGenerationId: "generation-1",
      }),
    });
    expect(release.ok).toBe(true);
    await expect(release.json()).resolves.toMatchObject({
      ok: true,
      ownerRegistration: {
        owner: { ownerId: "owner-vscode-1" },
        status: "disconnected",
      },
    });

    await fs.rm(extensionRootPath, { recursive: true, force: true });
  });

  it("mints and validates authenticated model-auth leases for connected owners", async () => {
    const extensionRootPath = await makeExtensionRoot();

    const helperPort = 47206;
    const helperServer = http.createServer();
    servers.push(helperServer);

    const options: HelperRuntimeOptions = {
      port: helperPort,
      helperVersion: "test-version",
      idleShutdownMs: 120_000,
      extensionRootPath,
    };
    helper = await createIsolatedHelper(options, helperServer);
    helperServer.on("request", helper.handleRequest);
    await helper.start();

    const helperBase = `http://127.0.0.1:${helperPort}`;
    const discovery = JSON.parse(
      await fs.readFile(getBrowserGatewayHelperDiscoveryPath(), "utf-8"),
    ) as { clientSharedSecret: string; helperGenerationId: string };
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${discovery.clientSharedSecret}`,
    };

    await fetch(`${helperBase}/internal/core-owners/register`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ownerId: "gateway-owner",
        ownerKind: "browser-gateway",
        displayName: "Ask Agent",
        scope: {
          kind: "projectless",
          scopeId: "ask-agent",
          displayName: "Ask Agent",
        },
        ownerGenerationId: "gateway-generation-1",
      }),
    });

    const missingHelperGeneration = await fetch(
      `${helperBase}/internal/model-auth/leases`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          providerId: "openai-codex",
          method: "oauth",
          grantedByOwnerId: "vscode-owner",
          grantedToOwnerId: "gateway-owner",
          grantedToOwnerGenerationId: "gateway-generation-1",
          modelScopes: ["chat"],
        }),
      },
    );
    expect(missingHelperGeneration.status).toBe(400);

    const badHelperGeneration = await fetch(
      `${helperBase}/internal/model-auth/leases`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          providerId: "openai-codex",
          method: "oauth",
          grantedByOwnerId: "vscode-owner",
          grantedToOwnerId: "gateway-owner",
          grantedToOwnerGenerationId: "gateway-generation-1",
          modelScopes: ["chat"],
          helperGenerationId: "wrong-helper-generation",
        }),
      },
    );
    expect(badHelperGeneration.status).toBe(409);

    const badOwnerGeneration = await fetch(
      `${helperBase}/internal/model-auth/leases`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          providerId: "openai-codex",
          method: "oauth",
          grantedByOwnerId: "vscode-owner",
          grantedToOwnerId: "gateway-owner",
          grantedToOwnerGenerationId: "gateway-generation-2",
          modelScopes: ["chat"],
          helperGenerationId: discovery.helperGenerationId,
        }),
      },
    );
    expect(badOwnerGeneration.status).toBe(409);

    const leaseResponse = await fetch(
      `${helperBase}/internal/model-auth/leases`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          providerId: "openai-codex",
          method: "oauth",
          grantedByOwnerId: "vscode-owner",
          grantedToOwnerId: "gateway-owner",
          grantedToOwnerGenerationId: "gateway-generation-1",
          modelScopes: ["chat"],
          helperGenerationId: discovery.helperGenerationId,
          ttlMs: 60_000,
          auditId: "audit-1",
        }),
      },
    );
    expect(leaseResponse.ok).toBe(true);
    const leasePayload = (await leaseResponse.json()) as {
      lease: { leaseId: string; helperGenerationId: string };
    };
    expect(leasePayload.lease.helperGenerationId).toBe(
      discovery.helperGenerationId,
    );

    const valid = await fetch(
      `${helperBase}/internal/model-auth/leases/validate`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          leaseId: leasePayload.lease.leaseId,
          ownerId: "gateway-owner",
          ownerGenerationId: "gateway-generation-1",
          modelScope: "chat",
        }),
      },
    );
    await expect(valid.json()).resolves.toEqual({
      ok: true,
      validation: { ok: true },
    });

    const wrongScope = await fetch(
      `${helperBase}/internal/model-auth/leases/validate`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          leaseId: leasePayload.lease.leaseId,
          ownerId: "gateway-owner",
          ownerGenerationId: "gateway-generation-1",
          modelScope: "embeddings",
        }),
      },
    );
    await expect(wrongScope.json()).resolves.toEqual({
      ok: true,
      validation: { ok: false, reason: "scope_not_granted" },
    });

    const revoked = await fetch(
      `${helperBase}/internal/model-auth/leases/revoke`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ leaseId: leasePayload.lease.leaseId }),
      },
    );
    expect(revoked.ok).toBe(true);

    const revokedValidation = await fetch(
      `${helperBase}/internal/model-auth/leases/validate`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          leaseId: leasePayload.lease.leaseId,
          ownerId: "gateway-owner",
          ownerGenerationId: "gateway-generation-1",
          modelScope: "chat",
        }),
      },
    );
    await expect(revokedValidation.json()).resolves.toEqual({
      ok: true,
      validation: { ok: false, reason: "revoked" },
    });

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
    helper = await createIsolatedHelper(options, helperServer);
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
      path.join(os.tmpdir(), ".tmp-helper-extension-root-"),
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
    helper = await createIsolatedHelper(options, helperServer);
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
    helper = await createIsolatedHelper(options, helperServer);
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

  it("serves a helper-owned projectless Ask Agent session without VS Code instances", async () => {
    const extensionRootPath = await makeExtensionRoot();

    const helperPort = 47212;
    const helperServer = http.createServer();
    servers.push(helperServer);
    const askAgentLogPath = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), ".tmp-ask-agent-log-")),
      "ask-agent.jsonl",
    );
    const askAgentPreferencesPath = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), ".tmp-ask-agent-preferences-")),
      "preferences.json",
    );
    const askAgentPreferencesStore = new BrowserGatewayAskAgentPreferencesStore(
      {
        filePath: askAgentPreferencesPath,
      },
    );
    const askAgentHistoryPath = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), ".tmp-ask-agent-history-")),
      "history.json",
    );
    const askAgentHistoryStore = new BrowserGatewayAskAgentHistoryStore({
      filePath: askAgentHistoryPath,
    });
    const askAgentMemoryPath = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), ".tmp-ask-agent-memory-")),
      "memory.json",
    );
    const askAgentMemoryStore = new BrowserGatewayAskAgentMemoryStore({
      filePath: askAgentMemoryPath,
    });
    const priorMemorySessionId =
      "browser-gateway:ask-agent:prior-memory-session";
    const nowForPriorMemory = Date.now();
    await askAgentHistoryStore.write({
      activeSessionId: BROWSER_GATEWAY_ASK_AGENT_SESSION_ID,
      sessions: [
        {
          id: BROWSER_GATEWAY_ASK_AGENT_SESSION_ID,
          title: "Ask Agent",
          createdAt: nowForPriorMemory,
          lastActiveAt: nowForPriorMemory,
          nextMessageSequence: 1,
          messages: [],
        },
        {
          id: priorMemorySessionId,
          title: "Prior browser memory discussion",
          createdAt: nowForPriorMemory - 10_000,
          lastActiveAt: nowForPriorMemory - 5_000,
          nextMessageSequence: 3,
          messages: [
            {
              id: "prior-user",
              role: "user",
              content:
                "Should Browser Ask Agent memory be injected as user text?",
              timestamp: nowForPriorMemory - 6_000,
              blocks: [
                {
                  type: "text",
                  text: "Should Browser Ask Agent memory be injected as user text?",
                },
              ],
            },
            {
              id: "prior-assistant",
              role: "assistant",
              content:
                "No, memory retrieval should be instructions-only and labeled as background recall.",
              timestamp: nowForPriorMemory - 5_000,
              blocks: [
                {
                  type: "text",
                  text: "No, memory retrieval should be instructions-only and labeled as background recall.",
                },
              ],
            },
          ],
        },
      ],
    });
    const summaryCalls: Array<{ messages: Array<{ content: string }> }> = [];
    const askAgentSummarizer = {
      summarize: async ({ messages }) => {
        summaryCalls.push({
          messages: messages.map((message) => ({ content: message.content })),
        });
        const lastUser = [...messages]
          .reverse()
          .find((message) => message.role === "user");
        return {
          title: "Summarized Ask Agent chat",
          summary: `Rolling summary for ${lastUser?.content ?? "unknown"}`,
          topics: ["ask-agent", "memory"],
          decisions: ["Persist derived memory summaries"],
          openQuestions: [],
          durableCandidateHints: ["Review durable preference candidates"],
          latestTurn: {
            summary: `Latest turn for ${lastUser?.content ?? "unknown"}`,
            keywords: ["latest", "memory"],
            entities: ["Browser Ask Agent"],
          },
        } satisfies BrowserGatewayAskAgentSummaryResult;
      },
    } satisfies BrowserGatewayAskAgentSummarizer;

    const options: HelperRuntimeOptions = {
      port: helperPort,
      helperVersion: "test-version",
      idleShutdownMs: 120_000,
      extensionRootPath,
      askAgentLogPath,
    };
    const completeCalls: Array<{ content: string; memoryContext?: string }> =
      [];
    const askAgentModelClient = {
      complete: async ({
        messages,
        memoryContext,
        onDelta,
      }: Parameters<BrowserGatewayAskAgentModelClient["complete"]>[0]) => {
        const lastMessage = messages.at(-1) ?? { content: "" };
        const priorFailureCalls = completeCalls.filter(
          (call) => call.content === "Please fail memory retrieval",
        ).length;
        completeCalls.push({
          content: lastMessage.content,
          memoryContext,
        });
        if (
          lastMessage.content === "Please fail memory retrieval" &&
          priorFailureCalls === 0
        ) {
          throw Object.assign(new Error("test model overloaded"), {
            status: 503,
            code: "overloaded",
          });
        }
        onDelta?.("Model says ");
        await new Promise((resolve) => setTimeout(resolve, 0));
        onDelta?.("hello from cached credentials.");
        return "Model says hello from cached credentials.";
      },
    } satisfies Pick<BrowserGatewayAskAgentModelClient, "complete">;
    helper = await createIsolatedHelper(options, helperServer, {
      askAgentModelClient,
      askAgentSummarizer,
      askAgentMemoryStore,
      askAgentMemorySummaryDebounceMs: 10,
      askAgentPreferencesStore,
      askAgentHistoryStore,
    });
    helperServer.on("request", helper.handleRequest);
    await helper.start();

    const helperBase = `http://127.0.0.1:${helperPort}`;
    const discovery = JSON.parse(
      await fs.readFile(getBrowserGatewayHelperDiscoveryPath(), "utf-8"),
    ) as { clientSharedSecret: string; helperGenerationId: string };
    const internalHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${discovery.clientSharedSecret}`,
    };
    const root = await fetch(`${helperBase}/`);
    expect(root.ok).toBe(true);
    const cookie = String(root.headers.get("set-cookie")?.split(";")[0] ?? "");

    const unauthorized = await fetch(`${helperBase}/api/ask-agent/session`);
    expect(unauthorized.status).toBe(401);

    const sessionResponse = await fetch(`${helperBase}/api/ask-agent/session`, {
      headers: { Cookie: cookie },
    });
    expect(sessionResponse.ok).toBe(true);
    const body = (await sessionResponse.json()) as {
      ok: true;
      ownerRegistration: {
        owner: { ownerId: string; ownerKind: string; scope: { kind: string } };
        ownerGenerationId: string;
      };
      session: {
        sessionId: string;
        mode: string;
        owner: { ownerKind: string };
      };
      snapshot: {
        session: { foreground: { mode: string; sessionId: string } };
      };
    };
    expect(body.ownerRegistration.owner.ownerId).toBe(
      BROWSER_GATEWAY_ASK_AGENT_OWNER_ID,
    );
    expect(body.ownerRegistration.owner.ownerKind).toBe("browser-gateway");
    expect(body.ownerRegistration.owner.scope.kind).toBe("projectless");
    expect(body.session.mode).toBe("ask");
    expect(body.session.owner.ownerKind).toBe("browser-gateway");
    expect(body.snapshot.session.foreground.mode).toBe("ask");
    expect(body.snapshot.session.foreground.sessionId).toBe(
      body.session.sessionId,
    );

    const vscodeOwnerResponse = await fetch(
      `${helperBase}/internal/core-owners/register`,
      {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({
          ownerId: "vscode-owner",
          ownerKind: "vscode",
          displayName: "VS Code Test Owner",
          scope: {
            kind: "workspace",
            workspaceId: "workspace-test",
            displayName: "Workspace Test",
          },
          ownerGenerationId: "vscode-generation-1",
          instanceId: "vscode-instance-1",
          processId: process.pid,
        }),
      },
    );
    expect(vscodeOwnerResponse.ok).toBe(true);

    const ownersResponse = await fetch(`${helperBase}/internal/core-owners`, {
      headers: internalHeaders,
    });
    expect(ownersResponse.ok).toBe(true);
    await expect(ownersResponse.json()).resolves.toMatchObject({
      owners: [
        expect.objectContaining({
          owner: expect.objectContaining({
            ownerId: BROWSER_GATEWAY_ASK_AGENT_OWNER_ID,
          }),
          status: "connected",
          ownerGenerationId: body.ownerRegistration.ownerGenerationId,
        }),
        expect.objectContaining({
          owner: expect.objectContaining({ ownerId: "vscode-owner" }),
          status: "connected",
          ownerGenerationId: "vscode-generation-1",
        }),
      ],
    });

    const leaseResponse = await fetch(
      `${helperBase}/internal/model-auth/leases`,
      {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({
          providerId: "openai-codex",
          method: "oauth",
          grantedByOwnerId: "vscode-owner",
          grantedToOwnerId: body.ownerRegistration.owner.ownerId,
          grantedToOwnerGenerationId: body.ownerRegistration.ownerGenerationId,
          modelScopes: ["chat"],
          helperGenerationId: discovery.helperGenerationId,
          ttlMs: 60_000,
          auditId: "ask-agent-audit-1",
        }),
      },
    );
    expect(leaseResponse.ok).toBe(true);
    const leasePayload = (await leaseResponse.json()) as {
      lease: { leaseId: string };
    };
    const leaseValidation = await fetch(
      `${helperBase}/internal/model-auth/leases/validate`,
      {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({
          leaseId: leasePayload.lease.leaseId,
          ownerId: body.ownerRegistration.owner.ownerId,
          ownerGenerationId: body.ownerRegistration.ownerGenerationId,
          modelScope: "chat",
        }),
      },
    );
    await expect(leaseValidation.json()).resolves.toEqual({
      ok: true,
      validation: { ok: true },
    });

    const unauthorizedSend = await fetch(`${helperBase}/api/ask-agent/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Hello" }),
    });
    expect(unauthorizedSend.status).toBe(401);

    const attachmentSend = await fetch(`${helperBase}/api/ask-agent/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        sessionId: body.session.sessionId,
        text: "Read this",
        attachments: ["/tmp/example.txt"],
      }),
    });
    expect(attachmentSend.status).toBe(400);
    await expect(attachmentSend.json()).resolves.toEqual({
      error: "ask_agent_path_attachments_unavailable",
    });

    const mediaSend = await fetch(`${helperBase}/api/ask-agent/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        id: "ask-user-media-1",
        sessionId: body.session.sessionId,
        text: "Inspect this media",
        images: [
          {
            name: "screenshot.png",
            mimeType: "image/png",
            base64: "abc123",
          },
        ],
        documents: [
          {
            name: "notes.txt",
            mimeType: "text/plain",
            base64: "bm90ZXM=",
          },
        ],
      }),
    });
    expect(mediaSend.ok).toBe(true);
    const mediaBody = (await mediaSend.json()) as {
      ok: true;
      snapshot: {
        session: {
          foreground: {
            projectedMessages: AskAgentProjectedMessageForTest[];
          };
        };
      };
    };
    expect(mediaBody.snapshot.session.foreground.projectedMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "ask-user-media-1",
          role: "user",
          content: "Inspect this media",
          displayMedia: {
            images: [
              {
                name: "screenshot.png",
                mimeType: "image/png",
                src: "data:image/png;base64,abc123",
              },
            ],
            documents: [{ name: "notes.txt", mimeType: "text/plain" }],
          },
        }),
      ]),
    );
    expect(
      mediaBody.snapshot.session.foreground.projectedMessages.find(
        (message) => message.id === "ask-user-media-1",
      ),
    ).not.toHaveProperty("media");

    const sendResponse = await fetch(`${helperBase}/api/ask-agent/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        id: "ask-user-1",
        sessionId: body.session.sessionId,
        text: "Hello Ask Agent",
      }),
    });
    expect(sendResponse.ok).toBe(true);
    const sendBody = (await sendResponse.json()) as {
      ok: true;
      snapshot: {
        session: {
          foreground: {
            projectedMessages: AskAgentProjectedMessageForTest[];
          };
        };
      };
    };
    expect(sendBody.snapshot.session.foreground.projectedMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "Hello Ask Agent" }),
        expect.objectContaining({
          role: "assistant",
          content: expect.stringContaining("needs model credentials"),
        }),
      ]),
    );

    const sessionsResponse = await fetch(
      `${helperBase}/api/ask-agent/sessions`,
      {
        headers: { Cookie: cookie },
      },
    );
    expect(sessionsResponse.ok).toBe(true);
    const sessionsBody = (await sessionsResponse.json()) as {
      sessions: Array<{ id: string; title: string; messageCount: number }>;
    };
    expect(sessionsBody.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: body.session.sessionId,
          title: "Inspect this media",
          messageCount: 4,
        }),
      ]),
    );

    const newSessionResponse = await fetch(
      `${helperBase}/api/ask-agent/session/new`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: "{}",
      },
    );
    expect(newSessionResponse.ok).toBe(true);
    const newSessionBody = (await newSessionResponse.json()) as {
      snapshot: { session: { foreground: { sessionId: string } } };
    };
    const newSessionId = newSessionBody.snapshot.session.foreground.sessionId;
    expect(newSessionId).not.toBe(body.session.sessionId);

    const newSessionSend = await fetch(`${helperBase}/api/ask-agent/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        id: "ask-user-new-session",
        sessionId: newSessionId,
        text: "Hello new Ask Agent session",
      }),
    });
    expect(newSessionSend.ok).toBe(true);
    await expect(newSessionSend.json()).resolves.toMatchObject({
      ok: true,
      snapshot: {
        session: {
          foreground: {
            sessionId: newSessionId,
            projectedMessages: expect.arrayContaining([
              expect.objectContaining({
                role: "user",
                content: "Hello new Ask Agent session",
              }),
            ]),
          },
        },
      },
    });

    const loadSessionResponse = await fetch(
      `${helperBase}/api/ask-agent/session/load`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ sessionId: body.session.sessionId }),
      },
    );
    expect(loadSessionResponse.ok).toBe(true);
    await expect(loadSessionResponse.json()).resolves.toMatchObject({
      ok: true,
      snapshot: {
        session: { foreground: { sessionId: body.session.sessionId } },
      },
    });
    await expect(askAgentHistoryStore.read()).resolves.toMatchObject({
      activeSessionId: body.session.sessionId,
      sessions: expect.arrayContaining([
        expect.objectContaining({
          id: body.session.sessionId,
          messages: expect.arrayContaining([
            expect.objectContaining({ content: "Hello Ask Agent" }),
          ]),
        }),
        expect.objectContaining({
          id: newSessionId,
          messages: expect.arrayContaining([
            expect.objectContaining({ content: "Hello new Ask Agent session" }),
          ]),
        }),
      ]),
    });

    const emptySessionResponse = await fetch(
      `${helperBase}/api/ask-agent/session/new`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: "{}",
      },
    );
    expect(emptySessionResponse.ok).toBe(true);
    const emptySessionBody = (await emptySessionResponse.json()) as {
      snapshot: { session: { foreground: { sessionId: string } } };
    };
    const emptySessionId =
      emptySessionBody.snapshot.session.foreground.sessionId;

    const missingFirstPromptResponse = await fetch(
      `${helperBase}/api/ask-agent/session/copy-first-prompt`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ sessionId: emptySessionId }),
      },
    );
    expect(missingFirstPromptResponse.status).toBe(404);
    await expect(missingFirstPromptResponse.json()).resolves.toEqual({
      error: "ask_agent_prompt_not_found",
    });

    const copyFirstPromptResponse = await fetch(
      `${helperBase}/api/ask-agent/session/copy-first-prompt`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ sessionId: body.session.sessionId }),
      },
    );
    expect(copyFirstPromptResponse.ok).toBe(true);
    await expect(copyFirstPromptResponse.json()).resolves.toEqual({
      ok: true,
      prompt: "Inspect this media",
    });

    const renameSessionResponse = await fetch(
      `${helperBase}/api/ask-agent/session/rename`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({
          sessionId: body.session.sessionId,
          title: "Renamed Ask Agent chat",
        }),
      },
    );
    expect(renameSessionResponse.ok).toBe(true);
    await expect(renameSessionResponse.json()).resolves.toMatchObject({
      ok: true,
      snapshot: {
        session: {
          sessions: expect.arrayContaining([
            expect.objectContaining({
              id: body.session.sessionId,
              title: "Renamed Ask Agent chat",
            }),
          ]),
        },
      },
    });

    const deleteSessionResponse = await fetch(
      `${helperBase}/api/ask-agent/session/delete`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ sessionId: newSessionId }),
      },
    );
    expect(deleteSessionResponse.ok).toBe(true);
    await expect(deleteSessionResponse.json()).resolves.toMatchObject({
      ok: true,
      snapshot: {
        session: {
          sessions: expect.not.arrayContaining([
            expect.objectContaining({ id: newSessionId }),
          ]),
        },
      },
    });

    const credentialResponse = await fetch(
      `${helperBase}/internal/model-auth/credentials`,
      {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({
          providerId: "openai-codex",
          method: "oauth",
          bearerToken: "oauth-token-secret",
          grantedByOwnerId: "vscode-owner",
          modelScopes: ["chat"],
          helperGenerationId: discovery.helperGenerationId,
          ttlMs: 60_000,
          accountLabel: "acct@example.com",
          canRefresh: true,
        }),
      },
    );
    expect(credentialResponse.ok).toBe(true);
    const credentialBody = await credentialResponse.text();
    expect(credentialBody).not.toContain("oauth-token-secret");
    expect(JSON.parse(credentialBody)).toMatchObject({
      ok: true,
      credential: {
        providerId: "openai-codex",
        method: "oauth",
        accountLabel: "acct@example.com",
        canRefresh: true,
      },
    });

    const anthropicCredentialResponse = await fetch(
      `${helperBase}/internal/model-auth/credentials`,
      {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({
          providerId: "anthropic",
          method: "apiKey",
          bearerToken: "anthropic-token-secret",
          grantedByOwnerId: "vscode-owner",
          modelScopes: ["chat"],
          helperGenerationId: discovery.helperGenerationId,
          ttlMs: 60_000,
          accountLabel: "Stored Anthropic API key",
          canRefresh: false,
        }),
      },
    );
    expect(anthropicCredentialResponse.ok).toBe(true);
    const anthropicCredentialBody = await anthropicCredentialResponse.text();
    expect(anthropicCredentialBody).not.toContain("anthropic-token-secret");
    expect(JSON.parse(anthropicCredentialBody)).toMatchObject({
      ok: true,
      credential: {
        providerId: "anthropic",
        method: "apiKey",
        accountLabel: "Stored Anthropic API key",
        canRefresh: false,
      },
    });

    await askAgentMemoryStore.upsertSessionMemory({
      sessionId: "bones-session",
      title: "Getting to Know Bones",
      createdAt: Date.now() - 11_000,
      lastActiveAt: Date.now() - 4_000,
      messageCount: 2,
      sourceRevision: "bones-revision",
      summary:
        "User wants the assistant to learn more about them for personalized future help.",
      topics: ["personalization", "preferences"],
      decisions: ["Use user-provided profile details for future conversations"],
      openQuestions: [],
      durableCandidateHints: [],
      updatedAt: Date.now() - 4_000,
    });
    await askAgentMemoryStore.upsertChunk({
      id: "bones-profile-chunk",
      sessionId: "bones-session",
      sourceMessageIds: ["bones-user", "bones-assistant"],
      startMessageIndex: 0,
      endMessageIndex: 1,
      sourceRevision: "bones-revision",
      summary:
        "Assistant asked follow-up questions to build a better personal profile and shared a tentative recap of known details.",
      keywords: ["personal profile", "preferences", "hobbies"],
      entities: ["Bones", "Cairns", "Warhammer 40k"],
      createdAt: Date.now() - 4_000,
      updatedAt: Date.now() - 4_000,
    });
    await askAgentMemoryStore.upsertSessionMemory({
      sessionId: priorMemorySessionId,
      title: "Prior browser memory discussion",
      createdAt: Date.now() - 10_000,
      lastActiveAt: Date.now() - 5_000,
      messageCount: 2,
      sourceRevision: "prior-revision",
      summary:
        "We discussed Browser Ask Agent memory retrieval injection and decided memory must be instructions-only.",
      topics: ["memory", "retrieval", "injection"],
      decisions: ["Inject memory through instructions, not user messages"],
      openQuestions: [],
      durableCandidateHints: [],
      updatedAt: Date.now() - 5_000,
    });
    await askAgentMemoryStore.upsertChunk({
      id: "prior-memory-chunk",
      sessionId: priorMemorySessionId,
      sourceMessageIds: ["prior-user", "prior-assistant"],
      startMessageIndex: 0,
      endMessageIndex: 1,
      sourceRevision: "prior-revision",
      summary:
        "Prior turn covered Browser Ask Agent memory retrieval injection and instruction-only context.",
      keywords: ["memory", "retrieval", "injection"],
      entities: ["Browser Ask Agent"],
      createdAt: Date.now() - 5_000,
      updatedAt: Date.now() - 5_000,
    });

    const catalogResponse = await fetch(
      `${helperBase}/internal/model-catalog`,
      {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({
          publishedByOwnerId: "vscode-owner",
          helperGenerationId: discovery.helperGenerationId,
          models: [
            {
              id: "claude-sonnet-4-5",
              displayName: "Claude Sonnet 4.5",
              providerId: "anthropic",
              contextWindow: 200_000,
              maxInputTokens: 180_000,
              reasoningEfforts: ["none", "low", "medium", "high"],
              defaultReasoningEffort: "medium",
              authenticated: true,
            },
            {
              id: "gpt-5.3-codex",
              displayName: "GPT-5.3 Codex",
              providerId: "codex",
              contextWindow: 200_000,
              maxInputTokens: 200_000,
              reasoningEfforts: ["none", "minimal", "low", "medium", "high"],
              defaultReasoningEffort: "low",
              authenticated: true,
            },
          ],
        }),
      },
    );
    expect(catalogResponse.ok).toBe(true);
    await expect(catalogResponse.json()).resolves.toMatchObject({
      ok: true,
      modelCount: 2,
    });

    const modelsResponse = await fetch(`${helperBase}/api/ask-agent/models`, {
      headers: { Cookie: cookie },
    });
    expect(modelsResponse.ok).toBe(true);
    const modelsBody = (await modelsResponse.json()) as {
      models?: Array<{ id: string; provider: string }>;
      source?: string;
    };
    expect(modelsBody.source).toBe("cached");
    expect(modelsBody.models?.map((model) => model.id)).toEqual([
      "claude-sonnet-4-5",
      "gpt-5.3-codex",
    ]);
    expect(
      modelsBody.models?.find((model) => model.id === "gpt-5.3-codex"),
    ).toMatchObject({ provider: "codex" });

    const modelResponse = await fetch(`${helperBase}/api/ask-agent/model`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ model: "claude-sonnet-4-5" }),
    });
    expect(modelResponse.ok).toBe(true);
    await expect(modelResponse.json()).resolves.toMatchObject({
      ok: true,
      snapshot: {
        session: { foreground: { model: "claude-sonnet-4-5" } },
      },
    });

    const uiLogResponse = await fetch(`${helperBase}/api/ask-agent/log`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        event: "send.start",
        fields: {
          text: "should be sanitized but browser never sends this field",
          textChars: 17,
          model: "claude-sonnet-4-5",
        },
      }),
    });
    expect(uiLogResponse.ok).toBe(true);

    const thinkingResponse = await fetch(
      `${helperBase}/api/ask-agent/thinking`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ effort: "high" }),
      },
    );
    expect(thinkingResponse.ok).toBe(true);
    await expect(thinkingResponse.json()).resolves.toMatchObject({
      ok: true,
      snapshot: {
        session: { foreground: { reasoningEffort: "high" } },
      },
    });
    await expect(askAgentPreferencesStore.read()).resolves.toEqual({
      model: "claude-sonnet-4-5",
      reasoningEffort: "high",
    });

    const codexModelResponse = await fetch(
      `${helperBase}/api/ask-agent/model`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ model: "gpt-5.3-codex" }),
      },
    );
    expect(codexModelResponse.ok).toBe(true);
    await expect(codexModelResponse.json()).resolves.toMatchObject({
      ok: true,
      snapshot: {
        session: { foreground: { model: "gpt-5.3-codex" } },
      },
    });

    const codexAliasSend = await fetch(`${helperBase}/api/ask-agent/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        id: "ask-user-codex-alias",
        sessionId: body.session.sessionId,
        text: "Use VS Code Codex provider id",
      }),
    });
    expect(codexAliasSend.ok).toBe(true);
    await expect(codexAliasSend.json()).resolves.toMatchObject({
      ok: true,
      snapshot: {
        session: {
          foreground: {
            projectedMessages: expect.arrayContaining([
              expect.objectContaining({
                id: "ask-user-codex-alias",
                role: "user",
              }),
              expect.objectContaining({
                role: "assistant",
                content: "Model says hello from cached credentials.",
              }),
            ]),
          },
        },
      },
    });
    const completeCallsAfterCodexAlias = completeCalls.length;
    const duplicateCodexAliasSend = await fetch(
      `${helperBase}/api/ask-agent/send`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({
          id: "ask-user-codex-alias",
          sessionId: body.session.sessionId,
          text: "Use VS Code Codex provider id",
        }),
      },
    );
    expect(duplicateCodexAliasSend.ok).toBe(true);
    const duplicateCodexAliasBody = (await duplicateCodexAliasSend.json()) as {
      snapshot: {
        session: {
          foreground: { projectedMessages: AskAgentProjectedMessageForTest[] };
        };
      };
    };
    expect(completeCalls).toHaveLength(completeCallsAfterCodexAlias);
    expect(
      duplicateCodexAliasBody.snapshot.session.foreground.projectedMessages.filter(
        (message) => message.id === "ask-user-codex-alias",
      ),
    ).toHaveLength(1);

    const modelResponseAfterCodexAlias = await fetch(
      `${helperBase}/api/ask-agent/model`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ model: "claude-sonnet-4-5" }),
      },
    );
    expect(modelResponseAfterCodexAlias.ok).toBe(true);

    const streamingSse = await fetch(`${helperBase}/api/ask-agent/events`, {
      headers: { Accept: "text/event-stream", Cookie: cookie },
    });
    expect(streamingSse.ok).toBe(true);
    const streamingReader = streamingSse.body?.getReader();
    expect(streamingReader).toBeTruthy();

    const brokerReadySend = await fetch(`${helperBase}/api/ask-agent/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        id: "ask-user-2",
        sessionId: body.session.sessionId,
        text: "Can you answer about memory retrieval now?",
      }),
    });
    expect(brokerReadySend.ok).toBe(true);
    const brokerReadyBody = (await brokerReadySend.json()) as {
      snapshot: {
        session: {
          foreground: {
            statusOverride: string;
            projectedMessages: AskAgentProjectedMessageForTest[];
          };
        };
      };
    };
    expect(
      brokerReadyBody.snapshot.session.foreground.statusOverride,
    ).toBeNull();
    if (streamingReader) {
      const chunks: string[] = [];
      while (chunks.join("\n").split("event: update").length < 3) {
        const next = await streamingReader.read();
        if (next.done) break;
        chunks.push(
          Buffer.from(next.value ?? new Uint8Array()).toString("utf-8"),
        );
      }
      const streamText = chunks.join("\n");
      expect(streamText).toContain('"streaming":true');
      expect(streamText).toContain("Model says ");
      await streamingReader.cancel();
    }
    expect(completeCalls.at(-1)?.content).toBe(
      "Can you answer about memory retrieval now?",
    );
    expect(completeCalls.at(-1)?.memoryContext).toContain(
      "<conversation-memory>",
    );
    expect(completeCalls.at(-1)?.memoryContext).toContain("instructions-only");
    expect(completeCalls.at(-1)?.memoryContext).not.toContain(
      "<conversation-transcript-excerpts>",
    );
    expect(
      brokerReadyBody.snapshot.session.foreground.projectedMessages,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: "Model says hello from cached credentials.",
        }),
      ]),
    );
    const brokerReadyAssistant =
      brokerReadyBody.snapshot.session.foreground.projectedMessages
        .filter(
          (message) =>
            message.role === "assistant" &&
            message.content === "Model says hello from cached credentials.",
        )
        .at(-1);
    expect(brokerReadyAssistant?.memoryDisclosure).toMatchObject({
      status: "used",
      transcriptExcerptCount: 0,
      sources: expect.arrayContaining([
        expect.objectContaining({
          kind: "summary",
          label: "summary:chunk:prior-memory-chunk",
          title: "Prior browser memory discussion",
        }),
      ]),
    });
    expect(
      brokerReadyAssistant?.memoryDisclosure?.summaryCount,
    ).toBeGreaterThan(0);
    expect(
      JSON.stringify(brokerReadyAssistant?.memoryDisclosure),
    ).not.toContain(
      "Should Browser Ask Agent memory be injected as user text?",
    );
    await waitForExpectation(async () => {
      expect(summaryCalls.length).toBeGreaterThanOrEqual(1);
      await expect(askAgentMemoryStore.read()).resolves.toMatchObject({
        sessions: expect.arrayContaining([
          expect.objectContaining({
            sessionId: body.session.sessionId,
            title: "Summarized Ask Agent chat",
            summary:
              "Rolling summary for Can you answer about memory retrieval now?",
            topics: ["ask-agent", "memory"],
            decisions: ["Persist derived memory summaries"],
            durableCandidateHints: ["Review durable preference candidates"],
          }),
        ]),
        chunks: expect.arrayContaining([
          expect.objectContaining({
            sessionId: body.session.sessionId,
            summary:
              "Latest turn for Can you answer about memory retrieval now?",
            keywords: ["latest", "memory"],
            entities: ["Browser Ask Agent"],
          }),
        ]),
      });
    });
    const summariesAfterSuccessfulSend = summaryCalls.length;

    const profileRecallSend = await fetch(`${helperBase}/api/ask-agent/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        id: "ask-user-profile-recall",
        sessionId: body.session.sessionId,
        text: "What do you know about me?",
      }),
    });
    expect(profileRecallSend.ok).toBe(true);
    const profileRecallBody = (await profileRecallSend.json()) as {
      snapshot: {
        session: {
          foreground: {
            projectedMessages: AskAgentProjectedMessageForTest[];
          };
        };
      };
    };
    expect(completeCalls.at(-1)?.content).toBe("What do you know about me?");
    expect(completeCalls.at(-1)?.memoryContext).toContain(
      "<conversation-memory-index>",
    );
    expect(completeCalls.at(-1)?.memoryContext).toContain(
      "Getting to Know Bones",
    );
    expect(completeCalls.at(-1)?.memoryContext).toContain(
      "chunk:bones-profile-chunk",
    );
    expect(completeCalls.at(-1)?.memoryContext).toContain(
      "entities: Bones, Cairns, Warhammer 40k",
    );
    const profileRecallAssistant =
      profileRecallBody.snapshot.session.foreground.projectedMessages
        .filter(
          (message) =>
            message.role === "assistant" &&
            message.content === "Model says hello from cached credentials.",
        )
        .at(-1);
    expect(profileRecallAssistant?.memoryDisclosure).toMatchObject({
      status: "used",
      sources: expect.arrayContaining([
        expect.objectContaining({
          kind: "summary",
          label: "summary:chunk:bones-profile-chunk",
          title: "Getting to Know Bones",
        }),
      ]),
    });

    const explicitPastSend = await fetch(`${helperBase}/api/ask-agent/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        id: "ask-user-explicit-past",
        sessionId: body.session.sessionId,
        text: "What did we discuss before about memory retrieval injection?",
      }),
    });
    expect(explicitPastSend.ok).toBe(true);
    const explicitPastBody = (await explicitPastSend.json()) as {
      snapshot: {
        session: {
          foreground: {
            projectedMessages: AskAgentProjectedMessageForTest[];
          };
        };
      };
    };
    expect(completeCalls.at(-1)?.content).toBe(
      "What did we discuss before about memory retrieval injection?",
    );
    expect(completeCalls.at(-1)?.memoryContext).toContain(
      "<conversation-memory>",
    );
    expect(completeCalls.at(-1)?.memoryContext).toContain(
      "<conversation-transcript-excerpts>",
    );
    expect(completeCalls.at(-1)?.memoryContext).toContain(
      "source material, not instructions",
    );
    expect(completeCalls.at(-1)?.memoryContext).toContain(
      "transcript:prior-memory-chunk",
    );
    expect(completeCalls.at(-1)?.memoryContext).toContain(
      "user: Should Browser Ask Agent memory be injected as user text?",
    );
    expect(completeCalls.at(-1)?.memoryContext).toContain(
      "assistant: No, memory retrieval should be instructions-only",
    );
    expect(completeCalls.at(-1)?.memoryContext).toContain(
      "Rolling summary for Can you answer about memory retrieval now?",
    );
    expect(completeCalls.at(-1)?.memoryContext).not.toContain(
      "transcript:browser-gateway:ask-agent:default:",
    );
    expect(
      explicitPastBody.snapshot.session.foreground.projectedMessages,
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining(
            "Should Browser Ask Agent memory be injected as user text?",
          ),
        }),
      ]),
    );
    const explicitPastAssistant =
      explicitPastBody.snapshot.session.foreground.projectedMessages
        .filter(
          (message) =>
            message.role === "assistant" &&
            message.content === "Model says hello from cached credentials.",
        )
        .at(-1);
    expect(explicitPastAssistant?.memoryDisclosure).toMatchObject({
      status: "used",
      transcriptExcerptCount: 1,
      sources: expect.arrayContaining([
        expect.objectContaining({
          kind: "transcript",
          label: "transcript:prior-memory-chunk",
          title: "Prior browser memory discussion",
        }),
      ]),
    });
    expect(
      JSON.stringify(explicitPastAssistant?.memoryDisclosure),
    ).not.toContain("No, memory retrieval should be instructions-only");

    const modelErrorSend = await fetch(`${helperBase}/api/ask-agent/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        id: "ask-user-model-error",
        sessionId: body.session.sessionId,
        text: "Please fail memory retrieval",
      }),
    });
    expect(modelErrorSend.ok).toBe(true);
    const modelErrorBody = (await modelErrorSend.json()) as {
      snapshot: {
        session: {
          foreground: {
            projectedMessages: Array<{
              role: string;
              content: string;
              error?: {
                message: string;
                retryable: boolean;
                code?: string;
              };
            }>;
          };
        };
      };
    };
    expect(
      modelErrorBody.snapshot.session.foreground.projectedMessages,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: "",
          error: expect.objectContaining({
            message: "test model overloaded",
            retryable: true,
            code: "overloaded",
          }),
        }),
      ]),
    );

    const retryResponse = await fetch(`${helperBase}/api/ask-agent/retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ sessionId: body.session.sessionId }),
    });
    expect(retryResponse.ok).toBe(true);
    const retryBody = (await retryResponse.json()) as {
      snapshot: {
        session: {
          foreground: {
            projectedMessages: Array<{
              role: string;
              content: string;
              error?: { code?: string };
            }>;
          };
        };
      };
    };
    expect(completeCalls.at(-1)?.content).toBe("Please fail memory retrieval");
    expect(completeCalls.at(-1)?.memoryContext).toContain(
      "<conversation-memory>",
    );
    expect(completeCalls.at(-1)?.memoryContext).toContain("instructions-only");
    expect(
      retryBody.snapshot.session.foreground.projectedMessages.filter(
        (message) =>
          message.role === "user" &&
          message.content === "Please fail memory retrieval",
      ),
    ).toHaveLength(1);
    expect(retryBody.snapshot.session.foreground.projectedMessages).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          error: expect.objectContaining({ code: "model_error" }),
        }),
      ]),
    );
    expect(retryBody.snapshot.session.foreground.projectedMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: "Model says hello from cached credentials.",
        }),
      ]),
    );
    await waitForExpectation(async () => {
      expect(summaryCalls.length).toBeGreaterThan(summariesAfterSuccessfulSend);
      await expect(askAgentMemoryStore.read()).resolves.toMatchObject({
        sessions: expect.arrayContaining([
          expect.objectContaining({
            sessionId: body.session.sessionId,
            summary: "Rolling summary for Please fail memory retrieval",
          }),
        ]),
        chunks: expect.arrayContaining([
          expect.objectContaining({
            sessionId: body.session.sessionId,
            summary: "Latest turn for Please fail memory retrieval",
          }),
        ]),
      });
    });
    const summariesAfterRetry = summaryCalls.length;

    const unavailableRetryResponse = await fetch(
      `${helperBase}/api/ask-agent/retry`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ sessionId: body.session.sessionId }),
      },
    );
    expect(unavailableRetryResponse.status).toBe(409);
    await expect(unavailableRetryResponse.json()).resolves.toEqual({
      error: "ask_agent_retry_unavailable",
    });

    const missingSessionRetryResponse = await fetch(
      `${helperBase}/api/ask-agent/retry`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({}),
      },
    );
    expect(missingSessionRetryResponse.status).toBe(400);
    await expect(missingSessionRetryResponse.json()).resolves.toEqual({
      error: "invalid_request",
    });

    const blankSessionRetryResponse = await fetch(
      `${helperBase}/api/ask-agent/retry`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ sessionId: "   " }),
      },
    );
    expect(blankSessionRetryResponse.status).toBe(400);
    await expect(blankSessionRetryResponse.json()).resolves.toEqual({
      error: "invalid_request",
    });

    const unknownSessionRetryResponse = await fetch(
      `${helperBase}/api/ask-agent/retry`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({
          sessionId: "browser-gateway:ask-agent:missing",
        }),
      },
    );
    expect(unknownSessionRetryResponse.status).toBe(404);
    await expect(unknownSessionRetryResponse.json()).resolves.toEqual({
      error: "ask_agent_session_not_found",
    });

    const clearCredential = await fetch(
      `${helperBase}/internal/model-auth/credentials/clear`,
      {
        method: "POST",
        headers: internalHeaders,
        body: "{}",
      },
    );
    expect(clearCredential.ok).toBe(true);
    await expect(clearCredential.json()).resolves.toEqual({
      ok: true,
      removed: true,
    });

    const afterClearSend = await fetch(`${helperBase}/api/ask-agent/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        id: "ask-user-3",
        sessionId: body.session.sessionId,
        text: "Still connected?",
      }),
    });
    expect(afterClearSend.ok).toBe(true);
    const afterClearBody = (await afterClearSend.json()) as {
      snapshot: {
        session: {
          foreground: {
            statusOverride: string;
            projectedMessages: AskAgentProjectedMessageForTest[];
          };
        };
      };
    };
    expect(
      afterClearBody.snapshot.session.foreground.statusOverride,
    ).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(summaryCalls).toHaveLength(summariesAfterRetry);
    expect(
      afterClearBody.snapshot.session.foreground.projectedMessages,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: expect.stringContaining("needs model credentials"),
        }),
      ]),
    );

    const askAgentLogs = await readJsonlLog(askAgentLogPath);
    expect(askAgentLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "ask-agent.send",
          textChars: "Hello Ask Agent".length,
          credential: "missing",
          model: "gpt-5.3-codex",
          reasoning: "low",
          ok: true,
          phase: "received",
        }),
        expect.objectContaining({
          event: "helper.ready",
          helperGenerationId: discovery.helperGenerationId,
        }),
        expect.objectContaining({
          event: "model-catalog.published",
          ownerId: "vscode-owner",
          modelCount: 2,
        }),
        expect.objectContaining({
          event: "ask-agent.model",
          model: "claude-sonnet-4-5",
          ok: true,
        }),
        expect.objectContaining({
          event: "browser.send.start",
          textChars: 17,
          model: "claude-sonnet-4-5",
        }),
        expect.objectContaining({
          event: "ask-agent.thinking",
          effort: "high",
          ok: true,
        }),
        expect.objectContaining({
          event: "ask-agent.send.complete",
          credential: "ready",
          outcome: "model_success",
          ok: true,
        }),
        expect.objectContaining({
          event: "ask-agent.send.model_error",
          credential: "ready",
          error: "model_error",
          errorMessage: "test model overloaded",
          errorStatus: 503,
          errorCode: "overloaded",
          ok: false,
        }),
        expect.objectContaining({
          event: "ask-agent.send.complete",
          credential: "missing",
          outcome: "credential_missing",
          ok: true,
        }),
      ]),
    );
    const rawAskAgentLog = await fs.readFile(askAgentLogPath, "utf-8");
    expect(rawAskAgentLog).not.toContain("oauth-token-secret");
    expect(rawAskAgentLog).not.toContain(
      "should be sanitized but browser never sends this field",
    );
    expect(rawAskAgentLog).not.toContain("Hello Ask Agent");
    expect(rawAskAgentLog).not.toContain("Can you answer now?");
    expect(rawAskAgentLog).not.toContain("Please fail");
    expect(rawAskAgentLog).not.toContain("Still connected?");

    const sse = await fetch(`${helperBase}/api/ask-agent/events`, {
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
      expect(chunk).toContain("browser-gateway:ask-agent:default");
      await reader.cancel();
    }

    await helper.stop("test-cleanup");
    helper = null;
    const restartedHelperServer = http.createServer();
    servers.push(restartedHelperServer);
    helper = await createIsolatedHelper(
      {
        ...options,
        port: 47213,
      },
      restartedHelperServer,
      {
        askAgentModelClient,
        askAgentPreferencesStore: new BrowserGatewayAskAgentPreferencesStore({
          filePath: askAgentPreferencesPath,
        }),
      },
    );
    restartedHelperServer.on("request", helper.handleRequest);
    await helper.start();
    const restartedDiscovery = JSON.parse(
      await fs.readFile(getBrowserGatewayHelperDiscoveryPath(), "utf-8"),
    ) as { helperGenerationId: string };
    const restartedBase = "http://127.0.0.1:47213";
    const restartedRoot = await fetch(`${restartedBase}/`);
    const restartedCookie = String(
      restartedRoot.headers.get("set-cookie")?.split(";")[0] ?? "",
    );
    const restartedSession = await fetch(
      `${restartedBase}/api/ask-agent/session`,
      {
        headers: { Cookie: restartedCookie },
      },
    );
    expect(restartedSession.ok).toBe(true);
    await expect(restartedSession.json()).resolves.toMatchObject({
      snapshot: {
        session: {
          foreground: {
            model: "gpt-5.3-codex",
            reasoningEffort: "high",
          },
        },
      },
    });
    const restartedInternalHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${helper.getClientSharedSecret()}`,
    };
    const restartedOwnerResponse = await fetch(
      `${restartedBase}/internal/core-owners/register`,
      {
        method: "POST",
        headers: restartedInternalHeaders,
        body: JSON.stringify({
          ownerId: "vscode-owner",
          ownerKind: "vscode",
          displayName: "VS Code Test Owner",
          scope: {
            kind: "workspace",
            workspaceId: "workspace-test",
            displayName: "Workspace Test",
          },
          ownerGenerationId: "vscode-generation-2",
          instanceId: "vscode-instance-1",
          processId: process.pid,
        }),
      },
    );
    expect(restartedOwnerResponse.ok).toBe(true);
    const restartedCatalog = await fetch(
      `${restartedBase}/internal/model-catalog`,
      {
        method: "POST",
        headers: restartedInternalHeaders,
        body: JSON.stringify({
          publishedByOwnerId: "vscode-owner",
          helperGenerationId: restartedDiscovery.helperGenerationId,
          models: [
            {
              id: "claude-sonnet-4-5",
              displayName: "Claude Sonnet 4.5",
              providerId: "anthropic",
              contextWindow: 200_000,
              maxInputTokens: 180_000,
              reasoningEfforts: ["none", "low", "medium", "high"],
              defaultReasoningEffort: "medium",
              authenticated: true,
            },
            {
              id: "gpt-5.3-codex",
              displayName: "GPT-5.3 Codex",
              providerId: "openai-codex",
              contextWindow: 200_000,
              maxInputTokens: 200_000,
              reasoningEfforts: ["none", "minimal", "low", "medium", "high"],
              defaultReasoningEffort: "low",
              authenticated: true,
            },
          ],
        }),
      },
    );
    expect(restartedCatalog.ok).toBe(true);
    const restartedAfterCatalog = await fetch(
      `${restartedBase}/api/ask-agent/session`,
      {
        headers: { Cookie: restartedCookie },
      },
    );
    await expect(restartedAfterCatalog.json()).resolves.toMatchObject({
      snapshot: {
        session: {
          foreground: {
            model: "claude-sonnet-4-5",
            reasoningEffort: "high",
          },
        },
      },
    });

    await fs.rm(extensionRootPath, { recursive: true, force: true });
    await fs.rm(path.dirname(askAgentPreferencesPath), {
      recursive: true,
      force: true,
    });
  });

  it("skips debounced Ask Agent memory summarization when credentials are cleared before it runs", async () => {
    const extensionRootPath = await makeExtensionRoot();
    const helperPort = 47217;
    const helperServer = http.createServer();
    servers.push(helperServer);
    const askAgentLogPath = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), ".tmp-ask-agent-log-")),
      "ask-agent.jsonl",
    );
    const askAgentHistoryStore = new BrowserGatewayAskAgentHistoryStore({
      filePath: path.join(
        await fs.mkdtemp(path.join(os.tmpdir(), ".tmp-ask-agent-history-")),
        "history.json",
      ),
    });
    const askAgentMemoryStore = new BrowserGatewayAskAgentMemoryStore({
      filePath: path.join(
        await fs.mkdtemp(path.join(os.tmpdir(), ".tmp-ask-agent-memory-")),
        "memory.json",
      ),
    });
    const summaryCalls: string[] = [];
    const askAgentSummarizer = {
      summarize: async ({ messages }) => {
        summaryCalls.push(messages.at(-1)?.content ?? "");
        return {
          title: "Should not persist",
          summary: "Should not persist",
          topics: [],
          decisions: [],
          openQuestions: [],
          durableCandidateHints: [],
          latestTurn: {
            summary: "Should not persist",
            keywords: [],
            entities: [],
          },
        } satisfies BrowserGatewayAskAgentSummaryResult;
      },
    } satisfies BrowserGatewayAskAgentSummarizer;
    const askAgentModelClient = {
      complete: async ({
        onDelta,
      }: Parameters<BrowserGatewayAskAgentModelClient["complete"]>[0]) => {
        onDelta?.("Answer before credential clear");
        return "Answer before credential clear";
      },
    } satisfies Pick<BrowserGatewayAskAgentModelClient, "complete">;
    const options: HelperRuntimeOptions = {
      port: helperPort,
      helperVersion: "test-version",
      idleShutdownMs: 120_000,
      extensionRootPath,
      askAgentLogPath,
    };
    helper = await createIsolatedHelper(options, helperServer, {
      askAgentModelClient,
      askAgentSummarizer,
      askAgentMemoryStore,
      askAgentHistoryStore,
      askAgentMemorySummaryDebounceMs: 75,
    });
    helperServer.on("request", helper.handleRequest);
    await helper.start();

    const helperBase = `http://127.0.0.1:${helperPort}`;
    const root = await fetch(`${helperBase}/`);
    const cookie = String(root.headers.get("set-cookie")?.split(";")[0] ?? "");
    const discovery = JSON.parse(
      await fs.readFile(getBrowserGatewayHelperDiscoveryPath(), "utf-8"),
    ) as { clientSharedSecret: string; helperGenerationId: string };
    const internalHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${discovery.clientSharedSecret}`,
    };
    await fetch(`${helperBase}/internal/model-auth/credentials`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({
        providerId: "openai-codex",
        method: "oauth",
        bearerToken: "oauth-token-secret",
        grantedByOwnerId: "vscode-owner",
        modelScopes: ["chat"],
        helperGenerationId: discovery.helperGenerationId,
        ttlMs: 60_000,
      }),
    });
    const sendResponse = await fetch(`${helperBase}/api/ask-agent/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ text: "Summarize after debounce" }),
    });
    expect(sendResponse.ok).toBe(true);

    const clearResponse = await fetch(
      `${helperBase}/internal/model-auth/credentials/clear`,
      {
        method: "POST",
        headers: internalHeaders,
        body: "{}",
      },
    );
    expect(clearResponse.ok).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 125));
    expect(summaryCalls).toEqual([]);
    await expect(askAgentMemoryStore.read()).resolves.toMatchObject({
      sessions: [],
      chunks: [],
    });
    await waitForExpectation(async () => {
      const logEntries = await readJsonlLog(askAgentLogPath);
      expect(logEntries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "ask-agent.memory.summary.skipped",
            reason: "credential_unavailable",
          }),
        ]),
      );
    });

    await fs.rm(extensionRootPath, { recursive: true, force: true });
  });

  it("does not repopulate derived memory when clearing during in-flight summarization", async () => {
    const extensionRootPath = await makeExtensionRoot();
    const helperPort = 47218;
    const helperServer = http.createServer();
    servers.push(helperServer);
    const askAgentHistoryStore = new BrowserGatewayAskAgentHistoryStore({
      filePath: path.join(
        await fs.mkdtemp(path.join(os.tmpdir(), ".tmp-ask-agent-history-")),
        "history.json",
      ),
    });
    const askAgentMemoryStore = new BrowserGatewayAskAgentMemoryStore({
      filePath: path.join(
        await fs.mkdtemp(path.join(os.tmpdir(), ".tmp-ask-agent-memory-")),
        "memory.json",
      ),
    });
    const releaseSummary: {
      current?: (summary: BrowserGatewayAskAgentSummaryResult) => void;
    } = {};
    let resolveSummaryStarted: (() => void) | undefined;
    const summaryStarted = new Promise<void>((resolve) => {
      resolveSummaryStarted = resolve;
    });
    const askAgentSummarizer = {
      summarize: async () => {
        resolveSummaryStarted?.();
        return await new Promise<BrowserGatewayAskAgentSummaryResult>(
          (summaryResolve) => {
            releaseSummary.current = summaryResolve;
          },
        );
      },
    } satisfies BrowserGatewayAskAgentSummarizer;
    const askAgentModelClient = {
      complete: async ({
        onDelta,
      }: Parameters<BrowserGatewayAskAgentModelClient["complete"]>[0]) => {
        onDelta?.("Answer before memory clear");
        return "Answer before memory clear";
      },
    } satisfies Pick<BrowserGatewayAskAgentModelClient, "complete">;
    const options: HelperRuntimeOptions = {
      port: helperPort,
      helperVersion: "test-version",
      idleShutdownMs: 120_000,
      extensionRootPath,
    };
    helper = await createIsolatedHelper(options, helperServer, {
      askAgentModelClient,
      askAgentSummarizer,
      askAgentMemoryStore,
      askAgentHistoryStore,
      askAgentMemorySummaryDebounceMs: 0,
    });
    helperServer.on("request", helper!.handleRequest);
    await helper!.start();

    const helperBase = `http://127.0.0.1:${helperPort}`;
    const root = await fetch(`${helperBase}/`);
    const cookie = String(root.headers.get("set-cookie")?.split(";")[0] ?? "");
    const discovery = JSON.parse(
      await fs.readFile(getBrowserGatewayHelperDiscoveryPath(), "utf-8"),
    ) as { clientSharedSecret: string; helperGenerationId: string };
    await fetch(`${helperBase}/internal/model-auth/credentials`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${discovery.clientSharedSecret}`,
      },
      body: JSON.stringify({
        providerId: "openai-codex",
        method: "oauth",
        bearerToken: "oauth-token-secret",
        grantedByOwnerId: "vscode-owner",
        modelScopes: ["chat"],
        helperGenerationId: discovery.helperGenerationId,
        ttlMs: 60_000,
      }),
    });

    const sendResponse = await fetch(`${helperBase}/api/ask-agent/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ text: "Summarize while clear runs" }),
    });
    expect(sendResponse.ok).toBe(true);
    await summaryStarted;

    const clearResponse = await fetch(
      `${helperBase}/api/ask-agent/memory/clear`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ confirm: true }),
      },
    );
    expect(clearResponse.ok).toBe(true);
    await expect(clearResponse.json()).resolves.toMatchObject({
      memory: { totalSummaryCount: 0 },
    });

    const resolveSummary = releaseSummary.current;
    if (!resolveSummary) throw new Error("summary resolver was not captured");
    resolveSummary({
      title: "Late summary after clear",
      summary: "This summary must not persist after clear.",
      topics: ["race"],
      decisions: [],
      openQuestions: [],
      durableCandidateHints: [],
      latestTurn: {
        summary: "Late chunk after clear",
        keywords: ["race"],
        entities: ["Ask Agent"],
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    await expect(askAgentMemoryStore.read()).resolves.toMatchObject({
      sessions: [],
      chunks: [],
    });

    await fs.rm(extensionRootPath, { recursive: true, force: true });
  });

  it("debounces Ask Agent memory summarization per session", async () => {
    const extensionRootPath = await makeExtensionRoot();
    const helperPort = 47216;
    const helperServer = http.createServer();
    servers.push(helperServer);
    const askAgentHistoryStore = new BrowserGatewayAskAgentHistoryStore({
      filePath: path.join(
        await fs.mkdtemp(path.join(os.tmpdir(), ".tmp-ask-agent-history-")),
        "history.json",
      ),
    });
    const askAgentPreferencesStore = new BrowserGatewayAskAgentPreferencesStore(
      {
        filePath: path.join(
          await fs.mkdtemp(
            path.join(os.tmpdir(), ".tmp-ask-agent-preferences-"),
          ),
          "preferences.json",
        ),
      },
    );
    const askAgentMemoryStore = new BrowserGatewayAskAgentMemoryStore({
      filePath: path.join(
        await fs.mkdtemp(path.join(os.tmpdir(), ".tmp-ask-agent-memory-")),
        "memory.json",
      ),
    });
    const summaryCalls: Array<{ lastUser: string; messageCount: number }> = [];
    const askAgentSummarizer = {
      summarize: async ({ messages }) => {
        const lastUser = [...messages]
          .reverse()
          .find((message) => message.role === "user")?.content;
        summaryCalls.push({
          lastUser: lastUser ?? "",
          messageCount: messages.length,
        });
        return {
          title: "Debounced memory",
          summary: `Summary for ${lastUser ?? "unknown"}`,
          topics: ["debounce"],
          decisions: [],
          openQuestions: [],
          durableCandidateHints: [],
          latestTurn: {
            summary: `Latest ${lastUser ?? "unknown"}`,
            keywords: ["debounce"],
            entities: ["Ask Agent"],
          },
        } satisfies BrowserGatewayAskAgentSummaryResult;
      },
    } satisfies BrowserGatewayAskAgentSummarizer;
    const askAgentModelClient = {
      complete: async ({
        messages,
        onDelta,
      }: Parameters<BrowserGatewayAskAgentModelClient["complete"]>[0]) => {
        const lastUser = messages.at(-1)?.content ?? "";
        onDelta?.(`Answer to ${lastUser}`);
        return `Answer to ${lastUser}`;
      },
    } satisfies Pick<BrowserGatewayAskAgentModelClient, "complete">;
    const options: HelperRuntimeOptions = {
      port: helperPort,
      helperVersion: "test-version",
      idleShutdownMs: 120_000,
      extensionRootPath,
    };
    helper = await createIsolatedHelper(options, helperServer, {
      askAgentModelClient,
      askAgentSummarizer,
      askAgentMemoryStore,
      askAgentMemorySummaryDebounceMs: 75,
      askAgentPreferencesStore,
      askAgentHistoryStore,
    });
    helperServer.on("request", helper.handleRequest);
    await helper.start();

    const helperBase = `http://127.0.0.1:${helperPort}`;
    const root = await fetch(`${helperBase}/`);
    const cookie = String(root.headers.get("set-cookie")?.split(";")[0] ?? "");
    const discovery = JSON.parse(
      await fs.readFile(getBrowserGatewayHelperDiscoveryPath(), "utf-8"),
    ) as { clientSharedSecret: string; helperGenerationId: string };
    const internalHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${discovery.clientSharedSecret}`,
    };
    await fetch(`${helperBase}/internal/core-owners/register`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({
        ownerId: "vscode-owner",
        ownerKind: "vscode",
        displayName: "VS Code Test Owner",
        scope: { kind: "workspace", workspaceId: "workspace-test" },
        ownerGenerationId: "vscode-generation-1",
        instanceId: "vscode-instance-1",
        processId: process.pid,
      }),
    });
    await fetch(`${helperBase}/internal/model-auth/credentials`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({
        providerId: "openai-codex",
        method: "oauth",
        bearerToken: "oauth-token-secret",
        grantedByOwnerId: "vscode-owner",
        modelScopes: ["chat"],
        helperGenerationId: discovery.helperGenerationId,
        ttlMs: 60_000,
      }),
    });
    const sessionResponse = await fetch(`${helperBase}/api/ask-agent/session`, {
      headers: { Cookie: cookie },
    });
    const sessionBody = (await sessionResponse.json()) as {
      session: { sessionId: string };
    };

    for (const text of ["First debounce turn", "Second debounce turn"]) {
      const response = await fetch(`${helperBase}/api/ask-agent/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({
          sessionId: sessionBody.session.sessionId,
          text,
        }),
      });
      expect(response.ok).toBe(true);
    }

    await waitForExpectation(async () => {
      expect(summaryCalls).toEqual([
        { lastUser: "Second debounce turn", messageCount: 4 },
      ]);
      await expect(askAgentMemoryStore.read()).resolves.toMatchObject({
        sessions: expect.arrayContaining([
          expect.objectContaining({
            sessionId: sessionBody.session.sessionId,
            summary: "Summary for Second debounce turn",
            messageCount: 4,
          }),
        ]),
        chunks: expect.arrayContaining([
          expect.objectContaining({
            sessionId: sessionBody.session.sessionId,
            summary: "Latest Second debounce turn",
            startMessageIndex: 2,
            endMessageIndex: 3,
          }),
        ]),
      });
    });

    await fs.rm(extensionRootPath, { recursive: true, force: true });
  });

  it("skips Ask Agent memory persistence when generated summaries contain secret-like content", async () => {
    const extensionRootPath = await makeExtensionRoot();
    const helperPort = 47217;
    const helperServer = http.createServer();
    servers.push(helperServer);
    const askAgentLogPath = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), ".tmp-ask-agent-log-")),
      "ask-agent.jsonl",
    );
    const askAgentHistoryStore = new BrowserGatewayAskAgentHistoryStore({
      filePath: path.join(
        await fs.mkdtemp(path.join(os.tmpdir(), ".tmp-ask-agent-history-")),
        "history.json",
      ),
    });
    const askAgentMemoryStore = new BrowserGatewayAskAgentMemoryStore({
      filePath: path.join(
        await fs.mkdtemp(path.join(os.tmpdir(), ".tmp-ask-agent-memory-")),
        "memory.json",
      ),
    });
    let summaryCallCount = 0;
    const askAgentSummarizer = {
      summarize: async () => {
        summaryCallCount += 1;
        return {
          title: "Credential debugging",
          summary:
            "User pasted token: ghp_abcdefghijklmnopqrstuvwxyz123456 while debugging model auth.",
          topics: ["model auth"],
          decisions: [],
          openQuestions: [],
          durableCandidateHints: [],
          latestTurn: {
            summary: "Discussed credential debugging.",
            keywords: ["auth"],
            entities: ["Ask Agent"],
          },
        } satisfies BrowserGatewayAskAgentSummaryResult;
      },
    } satisfies BrowserGatewayAskAgentSummarizer;
    const askAgentModelClient = {
      complete: async ({
        messages,
        onDelta,
      }: Parameters<BrowserGatewayAskAgentModelClient["complete"]>[0]) => {
        const lastUser = messages.at(-1)?.content ?? "";
        onDelta?.(`Answer to ${lastUser}`);
        return `Answer to ${lastUser}`;
      },
    } satisfies Pick<BrowserGatewayAskAgentModelClient, "complete">;
    const options: HelperRuntimeOptions = {
      port: helperPort,
      helperVersion: "test-version",
      idleShutdownMs: 120_000,
      extensionRootPath,
      askAgentLogPath,
    };
    helper = await createIsolatedHelper(options, helperServer, {
      askAgentModelClient,
      askAgentSummarizer,
      askAgentMemoryStore,
      askAgentHistoryStore,
      askAgentMemorySummaryDebounceMs: 50,
    });
    helperServer.on("request", helper.handleRequest);
    await helper.start();

    const helperBase = `http://127.0.0.1:${helperPort}`;
    const root = await fetch(`${helperBase}/`);
    const cookie = String(root.headers.get("set-cookie")?.split(";")[0] ?? "");
    const discovery = JSON.parse(
      await fs.readFile(getBrowserGatewayHelperDiscoveryPath(), "utf-8"),
    ) as { clientSharedSecret: string; helperGenerationId: string };
    const internalHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${discovery.clientSharedSecret}`,
    };
    const sessionResponse = await fetch(`${helperBase}/api/ask-agent/session`, {
      headers: { Cookie: cookie },
    });
    const sessionBody = (await sessionResponse.json()) as {
      session: { sessionId: string };
    };
    await askAgentMemoryStore.upsertSessionMemory({
      sessionId: sessionBody.session.sessionId,
      title: "Prior clean memory",
      createdAt: 100,
      lastActiveAt: 200,
      messageCount: 2,
      sourceRevision: "prior-clean-revision",
      summary: "Prior clean memory for this session.",
      topics: ["prior"],
      decisions: [],
      openQuestions: [],
      durableCandidateHints: [],
      updatedAt: 200,
    });
    await askAgentMemoryStore.upsertChunk({
      id: `${sessionBody.session.sessionId}:0-1`,
      sessionId: sessionBody.session.sessionId,
      sourceMessageIds: ["prior-user", "prior-assistant"],
      startMessageIndex: 0,
      endMessageIndex: 1,
      sourceRevision: "prior-clean-revision",
      summary: "Prior clean latest turn.",
      keywords: ["prior"],
      entities: ["Ask Agent"],
      createdAt: 100,
      updatedAt: 200,
    });

    await fetch(`${helperBase}/internal/model-auth/credentials`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({
        providerId: "openai-codex",
        method: "oauth",
        bearerToken: "oauth-token-secret",
        grantedByOwnerId: "vscode-owner",
        modelScopes: ["chat"],
        helperGenerationId: discovery.helperGenerationId,
        ttlMs: 60_000,
      }),
    });

    const response = await fetch(`${helperBase}/api/ask-agent/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        sessionId: sessionBody.session.sessionId,
        text: "Please remember this credential detail",
      }),
    });
    expect(response.ok).toBe(true);

    await waitForExpectation(async () => {
      expect(summaryCallCount).toBe(1);
      await expect(askAgentMemoryStore.read()).resolves.toMatchObject({
        sessions: [],
        chunks: [],
      });
      const logEntries = await readJsonlLog(askAgentLogPath);
      expect(logEntries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "ask-agent.memory.summary.skipped",
            reason: "secret_like_content",
            field: "summary",
            pattern: "github_token",
          }),
        ]),
      );
    });

    await fs.rm(extensionRootPath, { recursive: true, force: true });
  });

  it("stops an in-flight helper-owned Ask Agent model turn", async () => {
    const extensionRootPath = await makeExtensionRoot();
    const helperPort = 47214;
    const helperServer = http.createServer();
    servers.push(helperServer);
    const options: HelperRuntimeOptions = {
      port: helperPort,
      helperVersion: "test-version",
      idleShutdownMs: 120_000,
      extensionRootPath,
    };

    let signalFromCall: AbortSignal | undefined;
    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const askAgentModelClient = {
      complete: async ({
        signal,
        onDelta,
      }: Parameters<BrowserGatewayAskAgentModelClient["complete"]>[0]) => {
        signalFromCall = signal;
        onDelta?.("Partial response");
        resolveStarted?.();
        return await new Promise<string>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new Error("browser_gateway_ask_agent_model_aborted")),
            { once: true },
          );
        });
      },
    } satisfies Pick<BrowserGatewayAskAgentModelClient, "complete">;

    helper = await createIsolatedHelper(options, helperServer, {
      askAgentModelClient,
    });
    helperServer.on("request", helper.handleRequest);
    await helper.start();

    const helperBase = `http://127.0.0.1:${helperPort}`;
    const root = await fetch(`${helperBase}/`);
    const cookie = String(root.headers.get("set-cookie")?.split(";")[0] ?? "");
    const discovery = JSON.parse(
      await fs.readFile(getBrowserGatewayHelperDiscoveryPath(), "utf-8"),
    ) as { clientSharedSecret: string; helperGenerationId: string };
    const internalHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${discovery.clientSharedSecret}`,
    };
    const ownerResponse = await fetch(
      `${helperBase}/internal/core-owners/register`,
      {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({
          ownerId: "vscode-owner",
          ownerKind: "vscode",
          displayName: "VS Code Owner",
          scope: { kind: "workspace", workspaceId: "ws", displayName: "WS" },
          ownerGenerationId: "vscode-generation-1",
          capabilities: [],
          processId: process.pid,
        }),
      },
    );
    expect(ownerResponse.ok).toBe(true);
    const credentialResponse = await fetch(
      `${helperBase}/internal/model-auth/credentials`,
      {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({
          providerId: "openai-codex",
          method: "oauth",
          bearerToken: "oauth-token-secret",
          grantedByOwnerId: "vscode-owner",
          modelScopes: ["chat"],
          helperGenerationId: discovery.helperGenerationId,
          ttlMs: 60_000,
          accountLabel: "acct@example.com",
          canRefresh: true,
        }),
      },
    );
    expect(credentialResponse.ok).toBe(true);

    const sendPromise = fetch(`${helperBase}/api/ask-agent/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ text: "Please stream until stopped" }),
    });
    await started;
    expect(signalFromCall?.aborted).toBe(false);

    const overlappingSend = await fetch(`${helperBase}/api/ask-agent/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ text: "Second overlapping send" }),
    });
    expect(overlappingSend.status).toBe(409);
    await expect(overlappingSend.json()).resolves.toEqual({
      error: "ask_agent_turn_in_progress",
    });

    const stopResponse = await fetch(`${helperBase}/api/ask-agent/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: "{}",
    });
    expect(stopResponse.ok).toBe(true);
    const stopBody = (await stopResponse.json()) as {
      snapshot: {
        session: {
          foreground: {
            streaming: boolean;
            status: string;
            projectedMessages: Array<{
              role: string;
              content: string;
              error?: { code?: string; retryable?: boolean };
            }>;
          };
        };
      };
    };
    expect(stopBody).toMatchObject({ ok: true, stopped: true });
    expect(stopBody.snapshot.session.foreground.streaming).toBe(false);
    expect(stopBody.snapshot.session.foreground.status).toBe("idle");
    expect(stopBody.snapshot.session.foreground.projectedMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: "",
          blocks: [],
          error: expect.objectContaining({
            message: "Response stopped.",
            code: "model_stopped",
            retryable: false,
          }),
        }),
      ]),
    );
    expect(signalFromCall?.aborted).toBe(true);

    const sendResponse = await sendPromise;
    expect(sendResponse.ok).toBe(true);
    const sendBody = (await sendResponse.json()) as {
      snapshot: {
        session: {
          foreground: {
            streaming: boolean;
            status: string;
            projectedMessages: Array<{
              role: string;
              content: string;
              error?: { code?: string; retryable?: boolean };
            }>;
          };
        };
      };
    };
    expect(sendBody.snapshot.session.foreground.streaming).toBe(false);
    expect(sendBody.snapshot.session.foreground.status).toBe("idle");
    expect(sendBody.snapshot.session.foreground.projectedMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: "",
          blocks: [],
          error: expect.objectContaining({
            message: "Response stopped.",
            code: "model_stopped",
            retryable: false,
          }),
        }),
      ]),
    );

    await fs.rm(extensionRootPath, { recursive: true, force: true });
  });

  it("surfaces safe Ask Agent ask_user tool calls and resumes after submitted answers", async () => {
    let callCount = 0;
    const seenToolMessages: CoreModelMessage[][] = [];
    const expectedAnswerToolMessage = expect.objectContaining({
      role: "assistant",
      content: [
        expect.objectContaining({
          type: "tool_use",
          id: "call_question",
          name: "ask_user",
        }),
        expect.objectContaining({
          type: "tool_result",
          tool_use_id: "call_question",
          content: JSON.stringify({
            ok: true,
            responses: [
              {
                question: "Continue with the read-only plan?",
                answer: true,
                note: "Proceed safely.",
              },
            ],
          }),
        }),
      ],
    });
    const modelClient = makeAskAgentToolLoopClient(
      async ({ onDelta, toolMessages }) => {
        callCount++;
        seenToolMessages.push([...(toolMessages ?? [])]);
        if (callCount === 1) {
          onDelta?.("Need input before continuing.");
          return {
            text: "Need input before continuing.",
            toolCalls: [
              {
                id: "call_question",
                name: "ask_user",
                input: {
                  context: "Need a read-only choice.",
                  questions: [
                    {
                      id: "continue",
                      type: "yes_no",
                      question: "Continue with the read-only plan?",
                    },
                  ],
                },
              },
            ],
          };
        }
        if (callCount === 2) {
          throw Object.assign(new Error("test model overloaded after answer"), {
            code: "overloaded",
            retryable: true,
          });
        }
        onDelta?.("Continuing after your answer.");
        return { text: "Continuing after your answer.", toolCalls: [] };
      },
    );
    const harness = await makeAskAgentToolLoopTestHarness({ modelClient });
    helper = harness.helper;
    servers.push(harness.helperServer);

    const send = await fetch(`${harness.helperBase}/api/ask-agent/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: harness.cookie },
      body: JSON.stringify({ text: "Ask me something" }),
    });
    const sendBody = (await send.json()) as {
      snapshot: {
        ui: { question: { id: string; context: string } | null };
        session: {
          foreground: { streaming: boolean; projectedMessages: ChatMessage[] };
        };
      };
    };

    expect(send.ok).toBe(true);
    expect(sendBody.snapshot.ui.question).toMatchObject({
      id: "call_question",
      context: "Need a read-only choice.",
    });
    expect(sendBody.snapshot.session.foreground.streaming).toBe(false);

    const answer = await fetch(`${harness.helperBase}/api/ask-agent/question`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: harness.cookie },
      body: JSON.stringify({
        id: "call_question",
        answers: { continue: true },
        notes: { continue: "Proceed safely." },
      }),
    });
    const answerBody = (await answer.json()) as {
      snapshot: {
        session: { foreground: { projectedMessages: ChatMessage[] } };
      };
    };
    let assistant =
      answerBody.snapshot.session.foreground.projectedMessages.find(
        (message) => message.role === "assistant",
      );

    expect(answer.ok).toBe(true);
    expect(callCount).toBe(2);
    expect(seenToolMessages[0]).toEqual([]);
    expect(seenToolMessages[1]).toEqual([expectedAnswerToolMessage]);
    expect(assistant?.content).toBe("");
    expect(assistant?.error).toMatchObject({
      message: "test model overloaded after answer",
      retryable: true,
      code: "overloaded",
    });
    expect(assistant?.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool_call",
          id: "call_question",
          name: "ask_user",
          complete: true,
        }),
        expect.objectContaining({
          type: "question_answer",
          items: [
            {
              question: "Continue with the read-only plan?",
              answer: true,
              note: "Proceed safely.",
            },
          ],
        }),
      ]),
    );

    const retry = await fetch(`${harness.helperBase}/api/ask-agent/retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: harness.cookie },
      body: JSON.stringify({
        sessionId: BROWSER_GATEWAY_ASK_AGENT_SESSION_ID,
      }),
    });
    const retryBody = (await retry.json()) as {
      snapshot: {
        session: { foreground: { projectedMessages: ChatMessage[] } };
      };
    };
    assistant = retryBody.snapshot.session.foreground.projectedMessages.find(
      (message) =>
        message.role === "assistant" &&
        message.content === "Continuing after your answer.",
    );

    expect(retry.ok).toBe(true);
    expect(callCount).toBe(3);
    expect(seenToolMessages[2]).toEqual([expectedAnswerToolMessage]);
    expect(assistant?.blocks).toEqual([
      { type: "text", text: "Continuing after your answer." },
    ]);
  });

  it("applies safe Ask Agent todo_write and set_task_status tool calls", async () => {
    let callCount = 0;
    const modelClient = makeAskAgentToolLoopClient(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          text: "Tracking work.",
          toolCalls: [
            {
              id: "call_todos",
              name: "todo_write",
              input: {
                todos: [
                  {
                    id: "audit",
                    content: "Audit safe tools",
                    activeForm: "Auditing safe tools",
                    status: "in_progress",
                  },
                ],
              },
            },
          ],
        };
      }
      return {
        text: "Done.",
        toolCalls: [
          {
            id: "call_final",
            name: "set_task_status",
            input: {
              status: "completed",
              summary: "Safe Ask Agent tool loop completed.",
              completeTodos: true,
            },
          },
        ],
      };
    });
    const harness = await makeAskAgentToolLoopTestHarness({ modelClient });
    helper = harness.helper;
    servers.push(harness.helperServer);

    const send = await fetch(`${harness.helperBase}/api/ask-agent/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: harness.cookie },
      body: JSON.stringify({ text: "Track and finish this" }),
    });
    const body = (await send.json()) as {
      snapshot: {
        session: {
          foreground: {
            todos: Array<{ id: string; status: string }>;
            projectedMessages: ChatMessage[];
          };
        };
      };
    };
    const assistant = body.snapshot.session.foreground.projectedMessages.find(
      (message) => message.role === "assistant",
    );

    expect(send.ok).toBe(true);
    expect(body.snapshot.session.foreground.todos).toEqual([
      expect.objectContaining({ id: "audit", status: "completed" }),
    ]);
    expect(assistant?.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool_call",
          id: "call_todos",
          name: "todo_write",
          complete: true,
          inputJson: JSON.stringify({
            todos: [
              {
                id: "audit",
                content: "Audit safe tools",
                activeForm: "Auditing safe tools",
                status: "in_progress",
              },
            ],
          }),
        }),
        expect.objectContaining({
          type: "tool_call",
          id: "call_final",
          name: "set_task_status",
          complete: true,
          inputJson: JSON.stringify({
            status: "completed",
            summary: "Safe Ask Agent tool loop completed.",
            completeTodos: true,
          }),
        }),
      ]),
    );
    expect(assistant?.finalMarker).toMatchObject({
      status: "completed",
      source: "tool",
      summary: "Safe Ask Agent tool loop completed.",
      toolCall: expect.objectContaining({ name: "set_task_status" }),
    });
  });

  it("clears pending Ask Agent questions when set_task_status finalizes a later turn", async () => {
    let callCount = 0;
    const modelClient = makeAskAgentToolLoopClient(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          text: "Need input before continuing.",
          toolCalls: [
            {
              id: "call_question",
              name: "ask_user",
              input: {
                context: "Need a choice.",
                questions: [
                  {
                    id: "continue",
                    type: "yes_no",
                    question: "Continue?",
                  },
                ],
              },
            },
          ],
        };
      }
      return {
        text: "Finalizing without waiting.",
        toolCalls: [
          {
            id: "call_final",
            name: "set_task_status",
            input: {
              status: "completed",
              summary: "Final status superseded the pending question.",
            },
          },
        ],
      };
    });
    const harness = await makeAskAgentToolLoopTestHarness({ modelClient });
    helper = harness.helper;
    servers.push(harness.helperServer);

    const first = await fetch(`${harness.helperBase}/api/ask-agent/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: harness.cookie },
      body: JSON.stringify({ text: "Ask first" }),
    });
    const firstBody = (await first.json()) as {
      snapshot: { ui: { question: { id: string } | null } };
    };
    expect(firstBody.snapshot.ui.question?.id).toBe("call_question");

    const second = await fetch(`${harness.helperBase}/api/ask-agent/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: harness.cookie },
      body: JSON.stringify({ text: "Finalize now" }),
    });
    const secondBody = (await second.json()) as {
      snapshot: {
        ui: { question: unknown; questionProgress: unknown };
        session: {
          foreground: {
            questionRequest: unknown;
            projectedMessages: ChatMessage[];
          };
        };
      };
    };
    const finalAssistant = [
      ...secondBody.snapshot.session.foreground.projectedMessages,
    ]
      .reverse()
      .find((message) => message.role === "assistant");

    expect(second.ok).toBe(true);
    expect(secondBody.snapshot.ui.question).toBeNull();
    expect(secondBody.snapshot.ui.questionProgress).toBeNull();
    expect(secondBody.snapshot.session.foreground.questionRequest).toBeNull();
    expect(finalAssistant?.finalMarker).toMatchObject({
      status: "completed",
      summary: "Final status superseded the pending question.",
    });
  });

  it("executes local read tools only inside explicit Ask Agent read grants", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ask-agent-read-"),
    );
    const grantedDir = path.join(tempRoot, "granted");
    const deniedDir = path.join(tempRoot, "denied");
    await fs.mkdir(grantedDir);
    await fs.mkdir(deniedDir);
    const grantedFile = path.join(grantedDir, "notes.txt");
    const deniedFile = path.join(deniedDir, "secret.txt");
    const symlinkEscape = path.join(grantedDir, "escape-secret.txt");
    const symlinkDirEscape = path.join(grantedDir, "escape-dir");
    await fs.writeFile(grantedFile, "alpha\nbeta target\ngamma", "utf-8");
    await fs.writeFile(deniedFile, "do not read target", "utf-8");
    await fs.symlink(deniedFile, symlinkEscape);
    await fs.symlink(deniedDir, symlinkDirEscape);

    const toolResults: CoreModelMessage[][] = [];
    const modelClient = makeAskAgentToolLoopClient(
      async ({ messages, toolMessages }) => {
        toolResults.push([...(toolMessages ?? [])]);
        if (toolMessages?.length) {
          return { text: "Done reading.", toolCalls: [] };
        }
        const latestUserText = [...messages]
          .reverse()
          .find((message) => message.role === "user")?.content;
        if (latestUserText === "Read before grant") {
          return {
            text: "Trying denied read.",
            toolCalls: [
              {
                id: "call_denied_read",
                name: "read_file",
                input: { path: grantedFile },
              },
            ],
          };
        }
        return {
          text: "Trying granted reads.",
          toolCalls: [
            {
              id: "call_read",
              name: "read_file",
              input: { path: grantedFile, offset: 2, limit: 1 },
            },
            {
              id: "call_list",
              name: "list_files",
              input: { path: grantedDir },
            },
            {
              id: "call_search",
              name: "search_files",
              input: { path: grantedDir, regex: "target" },
            },
            {
              id: "call_denied_outside",
              name: "read_file",
              input: { path: deniedFile },
            },
            {
              id: "call_denied_symlink_file",
              name: "read_file",
              input: { path: symlinkEscape },
            },
            {
              id: "call_denied_symlink_list",
              name: "list_files",
              input: { path: symlinkDirEscape },
            },
            {
              id: "call_denied_symlink_search",
              name: "search_files",
              input: { path: symlinkDirEscape, regex: "target" },
            },
          ],
        };
      },
    );
    const harness = await makeAskAgentToolLoopTestHarness({ modelClient });
    helper = harness.helper;
    servers.push(harness.helperServer);

    const denied = await fetch(`${harness.helperBase}/api/ask-agent/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: harness.cookie },
      body: JSON.stringify({ text: "Read before grant" }),
    });
    expect(denied.ok).toBe(true);
    expect(JSON.stringify(toolResults.at(-1))).toContain("path_not_granted");

    const grant = await fetch(
      `${harness.helperBase}/api/ask-agent/read-grants`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: harness.cookie },
        body: JSON.stringify({ path: grantedDir, confirm: true }),
      },
    );
    const grantBody = (await grant.json()) as {
      snapshot: { ui: { readGrants: Array<{ rootPath: string }> } };
    };
    expect(grant.ok).toBe(true);
    expect(grantBody.snapshot.ui.readGrants).toEqual([
      expect.objectContaining({ rootPath: await fs.realpath(grantedDir) }),
    ]);

    const allowed = await fetch(`${harness.helperBase}/api/ask-agent/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: harness.cookie },
      body: JSON.stringify({ text: "Read after grant" }),
    });
    expect(allowed.ok).toBe(true);
    const latestToolResults = JSON.stringify(
      toolResults.find((messages) => messages.length === 7),
    );
    expect(latestToolResults).toContain("2 | beta target");
    expect(latestToolResults).toContain("notes.txt");
    expect(latestToolResults).toContain("target");
    expect(latestToolResults).toContain("path_not_granted");
    expect(latestToolResults).not.toContain("do not read");

    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("keeps Ask Agent file read grants scoped to the exact file", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ask-agent-file-grant-"),
    );
    const grantedFile = path.join(tempRoot, "allowed.txt");
    const siblingFile = path.join(tempRoot, "sibling.txt");
    await fs.writeFile(grantedFile, "allowed content", "utf-8");
    await fs.writeFile(siblingFile, "sibling content", "utf-8");

    const toolResults: CoreModelMessage[][] = [];
    const modelClient = makeAskAgentToolLoopClient(async ({ toolMessages }) => {
      toolResults.push([...(toolMessages ?? [])]);
      if (toolMessages?.length) return { text: "Done.", toolCalls: [] };
      return {
        text: "Trying exact file grant.",
        toolCalls: [
          {
            id: "call_allowed_file",
            name: "read_file",
            input: { path: grantedFile },
          },
          {
            id: "call_denied_sibling",
            name: "read_file",
            input: { path: siblingFile },
          },
          {
            id: "call_denied_parent_list",
            name: "list_files",
            input: { path: tempRoot },
          },
        ],
      };
    });
    const harness = await makeAskAgentToolLoopTestHarness({ modelClient });
    helper = harness.helper;
    servers.push(harness.helperServer);

    const grant = await fetch(
      `${harness.helperBase}/api/ask-agent/read-grants`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: harness.cookie },
        body: JSON.stringify({ path: grantedFile, confirm: true }),
      },
    );
    expect(grant.ok).toBe(true);

    const send = await fetch(`${harness.helperBase}/api/ask-agent/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: harness.cookie },
      body: JSON.stringify({ text: "Read exact file only" }),
    });
    expect(send.ok).toBe(true);
    const latestToolResults = JSON.stringify(
      toolResults.find((messages) => messages.length === 3),
    );
    expect(latestToolResults).toContain("allowed content");
    expect(latestToolResults).toContain("path_not_granted");
    expect(latestToolResults).not.toContain("sibling content");

    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("runs Ask Agent image generation in the helper using cached credentials", async () => {
    const originalFetch = globalThis.fetch;
    const providerRequests: Array<{ url: string; body: unknown }> = [];
    const upstreamRequests: string[] = [];
    const tinyPngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("https://chatgpt.com/backend-api/codex/responses")) {
          providerRequests.push({
            url,
            body: init?.body ? JSON.parse(String(init.body)) : null,
          });
          return new Response(
            `data: ${JSON.stringify({
              type: "response.image_generation_call.partial_image",
              partial_image_b64: tinyPngBase64,
              size: "1024x1024",
            })}\n\ndata: [DONE]\n\n`,
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        }
        return await originalFetch(input, init);
      },
    );

    const upstream = http.createServer((req, res) => {
      const url = req.url ?? "/";
      if (url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      upstreamRequests.push(url);
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
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
          instanceId: "instance-image-should-not-run",
          workspaceName: "AgentLink",
          workspacePath: "/workspace/agentlink",
          pid: process.pid,
          port: upstreamPort,
          url: `http://127.0.0.1:${upstreamPort}`,
          protocolVersion: 1,
          startedAt: new Date().toISOString(),
          authToken: "image-token",
        },
      ]),
      "utf-8",
    );

    const modelClient = makeAskAgentToolLoopClient(async ({ toolMessages }) => {
      if (toolMessages?.length) {
        return { text: "Image generated.", toolCalls: [] };
      }
      return {
        text: "Generating image.",
        toolCalls: [
          {
            id: "image-call-1",
            name: "generate_image",
            input: { prompt: "Create a tiny test avatar", count: 1 },
          },
        ],
      };
    });
    const harness = await makeAskAgentToolLoopTestHarness({ modelClient });
    helper = harness.helper;
    servers.push(harness.helperServer);

    const sendPromise = fetch(`${harness.helperBase}/api/ask-agent/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: harness.cookie },
      body: JSON.stringify({ text: "Generate an image" }),
    });
    await waitForExpectation(async () => {
      const session = await fetch(
        `${harness.helperBase}/api/ask-agent/session`,
        {
          headers: { Cookie: harness.cookie },
        },
      );
      const body = (await session.json()) as {
        snapshot: { ui: { approval: { id?: string; detail?: string } | null } };
      };
      expect(body.snapshot.ui.approval?.id).toMatch(
        /^ask-agent-generate-image-/,
      );
      expect(body.snapshot.ui.approval?.detail).toContain(
        "Output: Ask Agent chat display only (no files will be written)",
      );
    });

    const session = await fetch(`${harness.helperBase}/api/ask-agent/session`, {
      headers: { Cookie: harness.cookie },
    });
    const sessionBody = (await session.json()) as {
      snapshot: { ui: { approval: { id: string } | null } };
    };
    const approvalId = sessionBody.snapshot.ui.approval?.id;
    expect(approvalId).toBeTruthy();
    const approval = await fetch(
      `${harness.helperBase}/api/ask-agent/approval`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: harness.cookie },
        body: JSON.stringify({ id: approvalId, decision: "accept" }),
      },
    );
    expect(approval.ok).toBe(true);

    const send = await sendPromise;
    const body = (await send.json()) as {
      snapshot: {
        session: { foreground: { projectedMessages: ChatMessage[] } };
      };
    };
    const assistant = body.snapshot.session.foreground.projectedMessages.find(
      (message) => message.role === "assistant",
    );
    expect(send.ok).toBe(true);
    expect(assistant?.content).toContain("Image generated.");
    expect(providerRequests).toHaveLength(1);
    expect(providerRequests[0]?.body).toEqual(
      expect.objectContaining({ tools: [{ type: "image_generation" }] }),
    );
    expect(upstreamRequests).not.toContain(
      "/internal/ask-agent/generate-image",
    );
  });

  it("routes MCP tool calls through a VS Code-owned main-agent MCP bridge", async () => {
    const upstreamRequests: Array<{
      url: string;
      authorization?: string;
      body: unknown;
    }> = [];
    const upstream = http.createServer(async (req, res) => {
      const url = req.url ?? "/";
      if (url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (url === "/api/instance-status") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ kind: "idle", label: "Idle" }));
        return;
      }
      if (url === "/internal/ask-agent/mcp-status") {
        upstreamRequests.push({
          url,
          authorization: req.headers.authorization,
          body: {},
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            infos: [
              {
                name: "linear",
                status: "connected",
                toolCount: 1,
                resourceCount: 0,
                promptCount: 0,
                tools: [{ name: "list_issues", description: "List issues" }],
              },
            ],
          }),
        );
        return;
      }
      if (url === "/internal/ask-agent/mcp-config") {
        upstreamRequests.push({
          url,
          authorization: req.headers.authorization,
          body: {},
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            configSnapshot: {
              profile: "ask-agent",
              version: 1,
              sources: [],
              entries: [],
              statusInfos: [],
              capabilities: {
                canEditConfig: true,
                canOpenRawConfig: true,
                canReconnect: true,
                canReauthenticate: true,
                canDisable: true,
                canUseProjectConfig: false,
              },
            },
          }),
        );
        return;
      }
      if (
        url === "/internal/ask-agent/mcp-config/server" ||
        url === "/internal/ask-agent/mcp-config/open-raw"
      ) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const raw = Buffer.concat(chunks).toString("utf-8").trim();
        upstreamRequests.push({
          url,
          authorization: req.headers.authorization,
          body: raw ? JSON.parse(raw) : {},
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (url === "/internal/ask-agent/mcp-refresh") {
        upstreamRequests.push({
          url,
          authorization: req.headers.authorization,
          body: {},
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            infos: [
              {
                name: "linear",
                status: "connected",
                toolCount: 1,
                resourceCount: 0,
                promptCount: 0,
                tools: [{ name: "list_issues", description: "List issues" }],
              },
            ],
          }),
        );
        return;
      }
      if (url === "/internal/ask-agent/mcp-tools") {
        upstreamRequests.push({
          url,
          authorization: req.headers.authorization,
          body: {},
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            tools: [
              {
                name: "call_mcp_tool",
                description: "Call an MCP tool through main-agent policy.",
                input_schema: { type: "object", properties: {} },
              },
            ],
          }),
        );
        return;
      }
      if (url === "/internal/ask-agent/mcp-tool") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const raw = Buffer.concat(chunks).toString("utf-8").trim();
        upstreamRequests.push({
          url,
          authorization: req.headers.authorization,
          body: raw ? JSON.parse(raw) : {},
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ issues: ["LIN-1"] }),
                },
              ],
            },
          }),
        );
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
          instanceId: "instance-mcp",
          workspaceName: "AgentLink",
          workspacePath: "/workspace/agentlink",
          pid: process.pid,
          port: upstreamPort,
          url: `http://127.0.0.1:${upstreamPort}`,
          protocolVersion: 1,
          startedAt: new Date().toISOString(),
          authToken: "mcp-token",
        },
      ]),
      "utf-8",
    );

    const receivedToolMessages: CoreModelMessage[][] = [];
    const modelToolNames: string[][] = [];
    const modelClient = makeAskAgentToolLoopClient(
      async ({ toolMessages, tools }) => {
        receivedToolMessages.push([...(toolMessages ?? [])]);
        modelToolNames.push((tools ?? []).map((tool) => tool.name));
        if (toolMessages?.length) {
          return { text: "MCP result received.", toolCalls: [] };
        }
        return {
          text: "Attempting an MCP call.",
          toolCalls: [
            {
              id: "call_mcp",
              name: "call_mcp_tool",
              input: {
                server: "linear",
                tool: "list_issues",
                input: { query: "test" },
              },
            },
          ],
        };
      },
    );
    const harness = await makeAskAgentToolLoopTestHarness({ modelClient });
    helper = harness.helper;
    servers.push(harness.helperServer);

    const status = await fetch(
      `${harness.helperBase}/api/ask-agent/mcp-status`,
      {
        headers: { Cookie: harness.cookie },
      },
    );
    expect(status.ok).toBe(true);
    expect(await status.json()).toEqual({
      ok: true,
      infos: [
        {
          name: "linear",
          status: "connected",
          toolCount: 1,
          resourceCount: 0,
          promptCount: 0,
          tools: [{ name: "list_issues", description: "List issues" }],
        },
      ],
    });

    const config = await fetch(
      `${harness.helperBase}/api/ask-agent/mcp-config`,
      {
        headers: { Cookie: harness.cookie },
      },
    );
    expect(config.ok).toBe(true);
    expect(await config.json()).toMatchObject({
      ok: true,
      configSnapshot: { profile: "ask-agent" },
    });

    const saveConfig = await fetch(
      `${harness.helperBase}/api/ask-agent/mcp-config/server`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: harness.cookie },
        body: JSON.stringify({
          profile: "ask-agent",
          scope: "ask-agent-global",
          server: { name: "linear", command: "linear-mcp" },
        }),
      },
    );
    expect(saveConfig.ok).toBe(true);

    const openRaw = await fetch(
      `${harness.helperBase}/api/ask-agent/mcp-config/open-raw`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: harness.cookie },
        body: JSON.stringify({
          profile: "ask-agent",
          scope: "ask-agent-global",
        }),
      },
    );
    expect(openRaw.ok).toBe(true);

    const refresh = await fetch(
      `${harness.helperBase}/api/ask-agent/mcp-refresh`,
      {
        method: "POST",
        headers: { Cookie: harness.cookie },
      },
    );
    expect(refresh.ok).toBe(true);
    expect(await refresh.json()).toEqual({
      ok: true,
      infos: [
        {
          name: "linear",
          status: "connected",
          toolCount: 1,
          resourceCount: 0,
          promptCount: 0,
          tools: [{ name: "list_issues", description: "List issues" }],
        },
      ],
    });

    const send = await fetch(`${harness.helperBase}/api/ask-agent/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: harness.cookie },
      body: JSON.stringify({ text: "Call MCP" }),
    });
    const body = (await send.json()) as {
      snapshot: {
        session: { foreground: { projectedMessages: ChatMessage[] } };
      };
    };
    const assistant = body.snapshot.session.foreground.projectedMessages.find(
      (message) => message.role === "assistant",
    );

    expect(send.ok).toBe(true);
    expect(assistant?.content).toContain("MCP result received.");
    expect(modelToolNames[0]).toContain("call_mcp_tool");
    expect(JSON.stringify(receivedToolMessages[1])).toContain("LIN-1");
    expect(upstreamRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: "/internal/ask-agent/mcp-config",
          authorization: "Bearer mcp-token",
        }),
        expect.objectContaining({
          url: "/internal/ask-agent/mcp-config/server",
          authorization: "Bearer mcp-token",
          body: expect.objectContaining({
            profile: "ask-agent",
            scope: "ask-agent-global",
          }),
        }),
        expect.objectContaining({
          url: "/internal/ask-agent/mcp-config/open-raw",
          authorization: "Bearer mcp-token",
          body: expect.objectContaining({
            profile: "ask-agent",
            scope: "ask-agent-global",
          }),
        }),
        expect.objectContaining({
          url: "/internal/ask-agent/mcp-tool",
          authorization: "Bearer mcp-token",
          body: expect.objectContaining({
            name: "call_mcp_tool",
            input: expect.objectContaining({ server: "linear" }),
          }),
        }),
      ]),
    );
  });

  it("blocks non-projectless Ask Agent tool calls from side effects", async () => {
    const receivedToolMessages: CoreModelMessage[][] = [];
    const modelClient = makeAskAgentToolLoopClient(async ({ toolMessages }) => {
      receivedToolMessages.push([...(toolMessages ?? [])]);
      return {
        text: "Attempting a forbidden action.",
        toolCalls: [
          {
            id: "call_shell",
            name: "execute_command",
            input: { command: "touch /tmp/should-not-run" },
          },
        ],
      };
    });
    const harness = await makeAskAgentToolLoopTestHarness({ modelClient });
    helper = harness.helper;
    servers.push(harness.helperServer);

    const send = await fetch(`${harness.helperBase}/api/ask-agent/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: harness.cookie },
      body: JSON.stringify({ text: "Run a command" }),
    });
    const body = (await send.json()) as {
      snapshot: {
        session: { foreground: { projectedMessages: ChatMessage[] } };
      };
    };
    const assistant = body.snapshot.session.foreground.projectedMessages.find(
      (message) => message.role === "assistant",
    );

    expect(send.ok).toBe(true);
    expect(assistant?.content).toContain("Attempting a forbidden action.");
    expect(assistant?.finalMarker).toBeUndefined();
    expect(receivedToolMessages.length).toBe(1);
  });

  it("requires approval before launching an Ask Agent project handoff", async () => {
    const upstreamRequests: Array<{
      url: string;
      authorization?: string;
      body: unknown;
    }> = [];
    const upstream = http.createServer(async (req, res) => {
      const url = req.url ?? "/";
      if (url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (url === "/api/instance-status") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ kind: "idle", label: "Idle" }));
        return;
      }
      if (url === "/api/session/new" || url === "/api/send") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const raw = Buffer.concat(chunks).toString("utf-8").trim();
        upstreamRequests.push({
          url,
          authorization: req.headers.authorization,
          body: raw ? JSON.parse(raw) : {},
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            snapshot: {
              session: { foreground: { sessionId: "project-session-1" } },
            },
          }),
        );
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
          instanceId: "instance-handoff",
          workspaceName: "AgentLink",
          workspacePath: "/workspace/agentlink",
          pid: process.pid,
          port: upstreamPort,
          url: `http://127.0.0.1:${upstreamPort}`,
          protocolVersion: 1,
          startedAt: new Date().toISOString(),
          authToken: "handoff-token",
        },
      ]),
      "utf-8",
    );

    const extensionRootPath = await makeExtensionRoot();
    const helperPort = await getAvailablePort();
    const helperServer = http.createServer();
    servers.push(helperServer);
    helper = await createIsolatedHelper(
      {
        port: helperPort,
        helperVersion: "test-version",
        idleShutdownMs: 120_000,
        extensionRootPath,
      },
      helperServer,
    );
    helperServer.on("request", helper.handleRequest);
    await helper.start();
    const helperBase = `http://127.0.0.1:${helperPort}`;
    const root = await fetch(`${helperBase}/`);
    const cookie = String(root.headers.get("set-cookie")?.split(";")[0] ?? "");

    const targets = await fetch(
      `${helperBase}/api/ask-agent/project-handoff/targets`,
      { headers: { Cookie: cookie } },
    );
    expect(targets.ok).toBe(true);
    const targetsJson = (await targets.json()) as {
      targets: Array<{ instanceId: string; workspaceName: string }>;
    };
    expect(targetsJson.targets).toEqual([
      expect.objectContaining({
        instanceId: "instance-handoff",
        workspaceName: "AgentLink",
      }),
    ]);

    const instruction = "Continue implementing the approved project slice.";
    const proposed = await fetch(
      `${helperBase}/api/ask-agent/project-handoff/propose`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({
          targetInstanceId: "instance-handoff",
          mode: "code",
          instruction,
        }),
      },
    );
    expect(proposed.ok).toBe(true);
    const proposedJson = (await proposed.json()) as {
      handoff: { id: string; status: string };
      snapshot: { ui: { projectHandoff: { id: string; status: string } } };
    };
    expect(proposedJson.handoff.status).toBe("pending");
    expect(proposedJson.snapshot.ui.projectHandoff).toMatchObject({
      id: proposedJson.handoff.id,
      status: "pending",
    });
    expect(upstreamRequests).toEqual([]);

    const stale = await fetch(
      `${helperBase}/api/ask-agent/project-handoff/approve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ id: "missing" }),
      },
    );
    expect(stale.status).toBe(404);
    expect(upstreamRequests).toEqual([]);

    const approved = await fetch(
      `${helperBase}/api/ask-agent/project-handoff/approve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ id: proposedJson.handoff.id }),
      },
    );
    expect(approved.ok).toBe(true);
    const approvedJson = (await approved.json()) as {
      snapshot: { ui: { projectHandoff: { status: string } } };
    };
    expect(approvedJson.snapshot.ui.projectHandoff.status).toBe("completed");
    expect(upstreamRequests).toEqual([
      {
        url: "/api/session/new",
        authorization: "Bearer handoff-token",
        body: { mode: "code" },
      },
      {
        url: "/api/send",
        authorization: "Bearer handoff-token",
        body: { text: instruction, sessionId: "project-session-1" },
      },
    ]);

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
      path.join(os.tmpdir(), ".tmp-helper-extension-root-"),
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
    helper = await createIsolatedHelper(options, helperServer);
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
