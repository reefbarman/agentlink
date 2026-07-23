/** @vitest-environment node */

import * as fs from "fs/promises";
import * as http from "http";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { ASK_AGENT_OWNER_COMMAND_CAPABILITIES } from "./AskAgentOwnerAdapter.js";
import { BROWSER_GATEWAY_ASK_AGENT_OWNER_ID } from "../browserGatewayAskAgentSessionStore.js";
import { BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION } from "../dataPlane/protocol.js";
import { BrowserGatewayAskAgentHistoryStore } from "../browserGatewayAskAgentHistory.js";
import { BrowserGatewayAskAgentMemoryStore } from "../browserGatewayAskAgentMemory.js";
import { BrowserGatewayAskAgentPreferencesStore } from "../browserGatewayAskAgentPreferences.js";
import { BrowserGatewayHelper } from "./browserGatewayHelper.js";

async function availablePort(): Promise<number> {
  const server = http.createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function requestStatus(
  url: string,
  headers: Record<string, string>,
): Promise<number> {
  const target = new URL(url);
  return new Promise<number>((resolve, reject) => {
    const request = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        headers,
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.once("error", reject);
    request.end();
  });
}

async function makeExtensionRoot(): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "agentlink-relay-integration-root-"),
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
  await fs.writeFile(
    path.join(root, "media", "agentlink-terminal.svg"),
    "<svg/>",
    "utf-8",
  );
  return root;
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (text: string) => boolean,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("relay_read_timeout")), 2_000),
      ),
    ]);
    if (result.done) break;
    text += decoder.decode(result.value, { stream: true });
    if (predicate(text)) return text;
  }
  throw new Error(`relay predicate not reached: ${text}`);
}

function eventData(text: string, eventName: string): Record<string, unknown> {
  const match = new RegExp(`event: ${eventName}\\ndata: (\\{[^\\n]+\\})`).exec(
    text,
  );
  if (!match?.[1]) throw new Error(`missing ${eventName}`);
  return JSON.parse(match[1]) as Record<string, unknown>;
}

describe("BrowserGatewayHelper relay integration", () => {
  it("authenticates, stores owner publications, streams selected state, and preserves proxy fallback", async () => {
    const extensionRootPath = await makeExtensionRoot();
    const storeDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "agentlink-relay-integration-store-"),
    );
    const port = await availablePort();
    const server = http.createServer();
    const helper = new BrowserGatewayHelper(
      {
        port,
        helperVersion: "relay-integration",
        idleShutdownMs: 120_000,
        extensionRootPath,
      },
      server,
      {
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
    server.on("request", helper.handleRequest);
    const base = `http://127.0.0.1:${port}`;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let commandReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      await helper.start();
      const root = await fetch(`${base}/`);
      const cookie = root.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
      expect(cookie).not.toBe("");

      const unauthorized = await fetch(`${base}/api/relay/events`);
      expect(unauthorized.status).toBe(401);
      await expect(
        requestStatus(`${base}/api/relay/events`, {
          Cookie: cookie,
          Host: `attacker@127.0.0.1:${port}`,
        }),
      ).resolves.toBe(403);

      const registration = await fetch(
        `${base}/internal/core-owners/register`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${helper.getClientSharedSecret()}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            ownerId: "relay-owner",
            ownerKind: "vscode",
            displayName: "Relay workspace",
            scope: {
              kind: "workspace",
              workspaceId: "relay-workspace",
              displayName: "Relay workspace",
            },
            ownerGenerationId: "relay-owner-generation-1",
            capabilities: [
              { capabilityId: "session.select", state: "enabled" },
            ],
            instanceId: "relay-instance-1",
            processId: process.pid,
          }),
        },
      );
      expect(registration.ok).toBe(true);
      const registrationBody = (await registration.json()) as {
        helperGenerationId: string;
        effectiveOwnerId: string;
        ownerRegistration: { ownerGenerationId: string };
      };
      const identity = {
        helperGenerationId: registrationBody.helperGenerationId,
        ownerId: registrationBody.effectiveOwnerId,
        ownerGenerationId: registrationBody.ownerRegistration.ownerGenerationId,
      };

      const checkpoint = {
        protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
        ...identity,
        checkpointId: "relay-checkpoint-0",
        checkpointSequence: 0,
        emittedAt: Date.now(),
        foreground: null,
        catalog: {
          projects: [],
          sessions: [],
          defaultProjectId: null,
          foregroundSessionId: null,
        },
        transcript: { messages: [], earlierCursor: null, hasEarlier: false },
        ui: { interaction: null, queue: [], todos: [], operations: [] },
        background: [],
        fleet: [],
        diffs: [],
        repository: null,
        theme: { revision: "theme-1", colorScheme: "dark", variables: [] },
        modelCatalogRevision: "models-1",
        capabilities: [],
      };
      const initialPublication = await fetch(
        `${base}/internal/data-plane/publications`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${helper.getClientSharedSecret()}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
            ...identity,
            batchId: "relay-batch-0",
            firstSequence: 0,
            lastSequence: 0,
            checkpoint,
            events: [],
          }),
        },
      );
      expect(initialPublication.ok).toBe(true);

      const askAgentSession = await fetch(`${base}/api/ask-agent/session`, {
        headers: { Cookie: cookie },
      });
      expect(askAgentSession.ok).toBe(true);
      const askAgentSessionBody = (await askAgentSession.json()) as {
        ownerRegistration: {
          owner: { ownerId: string };
          ownerGenerationId: string;
          capabilities: Array<{ capabilityId: string; state: string }>;
        };
        session: { sessionId: string };
      };
      expect(askAgentSessionBody.ownerRegistration).toMatchObject({
        owner: { ownerId: BROWSER_GATEWAY_ASK_AGENT_OWNER_ID },
        ownerGenerationId: `browser-gateway:ask-agent:${identity.helperGenerationId}`,
        capabilities: expect.arrayContaining(
          ASK_AGENT_OWNER_COMMAND_CAPABILITIES.map((capabilityId) => ({
            capabilityId,
            state: "enabled",
          })),
        ),
      });

      const stream = await fetch(`${base}/api/relay/events`, {
        headers: { Cookie: cookie },
      });
      expect(stream.status).toBe(200);
      expect(stream.headers.get("content-type")).toBe("text/event-stream");
      reader = stream.body!.getReader();
      const initialText = await readUntil(reader, (text) =>
        text.includes("event: catalog"),
      );
      const hello = eventData(initialText, "hello");

      const askAgentSubscription = await fetch(
        `${base}/api/relay/subscription`,
        {
          method: "POST",
          headers: {
            Cookie: cookie,
            Origin: base,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            browserConnectionId: hello.browserConnectionId,
            csrfNonce: hello.csrfNonce,
            ownerId: BROWSER_GATEWAY_ASK_AGENT_OWNER_ID,
            ownerGenerationId:
              askAgentSessionBody.ownerRegistration.ownerGenerationId,
          }),
        },
      );
      expect(askAgentSubscription.status).toBe(202);
      const askAgentSubscriptionBody = (await askAgentSubscription.json()) as {
        subscriptionId: string;
      };
      const askAgentCheckpoint = await readUntil(reader, (text) =>
        text.includes("event: checkpoint"),
      );
      expect(askAgentCheckpoint).toContain(BROWSER_GATEWAY_ASK_AGENT_OWNER_ID);
      expect(askAgentCheckpoint).toContain(
        askAgentSessionBody.session.sessionId,
      );

      const localCommand = {
        browserConnectionId: hello.browserConnectionId,
        csrfNonce: hello.csrfNonce,
        subscriptionId: askAgentSubscriptionBody.subscriptionId,
        operationId: "ask-agent-local-operation-1",
        deadlineClass: "default",
        command: {
          kind: "session.select",
          sessionId: askAgentSessionBody.session.sessionId,
        },
      };
      const localCommandResponse = await fetch(`${base}/api/relay/commands`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: base,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(localCommand),
      });
      expect(localCommandResponse.status).toBe(202);
      const localOperationText = await readUntil(
        reader,
        (text) =>
          text.includes('"operationId":"ask-agent-local-operation-1"') &&
          text.includes('"state":"completed"'),
      );
      expect(localOperationText).toContain("event: relay.operation");
      const duplicateLocalCommand = await fetch(`${base}/api/relay/commands`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: base,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(localCommand),
      });
      expect(duplicateLocalCommand.status).toBe(202);
      await expect(duplicateLocalCommand.json()).resolves.toMatchObject({
        duplicate: true,
        operation: { state: "completed" },
      });

      const subscription = await fetch(`${base}/api/relay/subscription`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: base,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          browserConnectionId: hello.browserConnectionId,
          csrfNonce: hello.csrfNonce,
          ownerId: identity.ownerId,
          ownerGenerationId: identity.ownerGenerationId,
        }),
      });
      expect(subscription.status).toBe(202);
      const subscriptionBody = (await subscription.json()) as {
        subscriptionId: string;
      };
      const checkpointText = await readUntil(reader, (text) =>
        text.includes("event: checkpoint"),
      );
      expect(checkpointText).toContain("relay-checkpoint-0");
      expect(helper.getLifecycleStateForTest().livenessReasons).toContain(
        "browser_stream",
      );

      const commandStream = await fetch(
        `${base}/internal/data-plane/commands?${new URLSearchParams(identity)}`,
        {
          headers: {
            Authorization: `Bearer ${helper.getClientSharedSecret()}`,
          },
        },
      );
      expect(commandStream.status).toBe(200);
      commandReader = commandStream.body!.getReader();
      await readUntil(commandReader, (text) => text.includes('"kind":"hello"'));

      const commandResponse = await fetch(`${base}/api/relay/commands`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: base,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          browserConnectionId: hello.browserConnectionId,
          csrfNonce: hello.csrfNonce,
          subscriptionId: subscriptionBody.subscriptionId,
          operationId: "relay-operation-1",
          deadlineClass: "default",
          command: { kind: "session.select", sessionId: "session-1" },
        }),
      });
      expect(commandResponse.status).toBe(202);
      const commandText = await readUntil(commandReader, (text) =>
        text.includes('"operationId":"relay-operation-1"'),
      );
      expect(commandText).toContain("event: command");
      expect(commandText).toContain('"idempotency":"idempotent"');

      const acknowledgement = await fetch(
        `${base}/internal/data-plane/acknowledgements`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${helper.getClientSharedSecret()}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
            ...identity,
            operation: {
              operationId: "relay-operation-1",
              kind: "session.select",
              state: "completed",
            },
            acknowledgedAt: Date.now(),
          }),
        },
      );
      expect(acknowledgement.status).toBe(200);
      const operationText = await readUntil(
        reader,
        (text) =>
          text.includes('"operationId":"relay-operation-1"') &&
          text.includes('"state":"completed"'),
      );
      expect(operationText).toContain("event: relay.operation");
      expect(operationText).not.toContain("ownerSequence");

      const publication = await fetch(
        `${base}/internal/data-plane/publications`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${helper.getClientSharedSecret()}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
            ...identity,
            batchId: "relay-batch-1",
            firstSequence: 1,
            lastSequence: 1,
            checkpoint: null,
            events: [
              {
                protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
                ...identity,
                ownerSequence: 1,
                eventId: "relay-event-1",
                kind: "foreground.control.updated",
                emittedAt: Date.now(),
                payload: { foreground: null },
              },
            ],
          }),
        },
      );
      expect(publication.ok).toBe(true);
      const eventText = await readUntil(reader, (text) =>
        text.includes("relay-event-1"),
      );
      expect(eventText).toContain("event: owner.event");
      expect(eventText).toMatch(
        new RegExp(
          `id: ${identity.helperGenerationId}/${identity.ownerId}/${identity.ownerGenerationId}/\\d+`,
        ),
      );

      const detailHandle = {
        ...identity,
        handleId: "relay-detail-1",
        kind: "message",
        byteLength: 12,
        expiresAt: Date.now() + 60_000,
        mediaType: "text/plain",
      } as const;
      const detailUpload = await fetch(
        `${base}/internal/data-plane/details?${new URLSearchParams({
          handle: JSON.stringify(detailHandle),
        })}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${helper.getClientSharedSecret()}`,
            "Content-Type": "application/octet-stream",
          },
          body: "relay detail",
        },
      );
      expect(detailUpload.status).toBe(201);
      const detailRead = await fetch(
        `${base}/api/relay/details?${new URLSearchParams({
          handleId: detailHandle.handleId,
          ownerId: identity.ownerId,
          ownerGenerationId: identity.ownerGenerationId,
        })}`,
        { headers: { Cookie: cookie } },
      );
      expect(detailRead.status).toBe(200);
      expect(detailRead.headers.get("content-type")).toBe("text/plain");
      await expect(detailRead.text()).resolves.toBe("relay detail");

      const legacyFallback = await fetch(`${base}/api/unmatched`, {
        headers: { Cookie: cookie },
      });
      expect(legacyFallback.status).toBe(503);
      await expect(legacyFallback.json()).resolves.toEqual({
        error: "no_instances_available",
        currentInstanceId: "",
        instances: [],
      });
    } finally {
      await reader?.cancel().catch(() => undefined);
      await commandReader?.cancel().catch(() => undefined);
      await helper.stop("relay-integration-cleanup");
      await fs.rm(extensionRootPath, { recursive: true, force: true });
      await fs.rm(storeDir, { recursive: true, force: true });
    }
  });
});
