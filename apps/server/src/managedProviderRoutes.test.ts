import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import type { AssistantServerAuth } from "./assistantServer.js";
import { HttpError } from "./httpJson.js";
import { createManagedProviderRoutes } from "./managedProviderRoutes.js";
import {
  openManagedProviders,
  type ManagedProviders,
} from "./managedProviders.js";
import type { AssistantServerModelChoice } from "./serverConfig.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const KEY = `sk-proj-${"k".repeat(40)}`;
const CODEX: AssistantServerModelChoice = {
  providerId: "codex",
  modelId: "gpt-codex",
};
const OPENAI: AssistantServerModelChoice = {
  providerId: "openai",
  modelId: "gpt-api",
  displayName: "GPT API",
};

function auth(subjectId: string, valid: () => boolean): AssistantServerAuth {
  const signedIn: AssistantServerAuth = {
    principal: { tenantId: "agentlink-server", subjectId },
    session: {
      ownerId: subjectId,
      sessionId: "s",
      deviceId: "d",
      deviceLabel: "Phone",
      createdAt: 0,
      expiresAt: Number.MAX_SAFE_INTEGER,
    },
    signal: new AbortController().signal,
    revalidate: async () => ({ valid: valid() }),
    detach: () => signedIn,
  };
  return signedIn;
}

async function setup(wrap?: (providers: ManagedProviders) => ManagedProviders) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "provider-routes-"));
  cleanup.push(() =>
    fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    }),
  );
  await fs.mkdir(path.join(root, "settings"));
  await fs.writeFile(
    path.join(root, "settings", "model-providers.json"),
    '{"schemaVersion": 1}\n',
  );
  const opened = await openManagedProviders({
    settingsFile: path.join(root, "settings", "model-providers.json"),
    credentialsDirectory: path.join(root, "credentials"),
    externallyManaged: false,
    isKnownModel: (model) =>
      [CODEX, OPENAI].some(
        (choice) =>
          choice.providerId === model.providerId &&
          choice.modelId === model.modelId,
      ),
  });
  const providers = wrap ? wrap(opened) : opened;
  const available = () =>
    providers.hasOpenAiKey() ? [CODEX, OPENAI] : [CODEX];
  let caller = auth("owner", () => true);
  const routes = createManagedProviderRoutes({
    providers,
    openAiModels: [OPENAI],
    availableModels: available,
    defaultModel: () => providers.selectedDefault() ?? CODEX,
    isOwner: (request) => request.principal.subjectId === "owner",
    now: () => 5_000,
  });
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
            error: error instanceof HttpError ? error.code : "unexpected",
          }),
        );
      });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const port = (server.address() as { port: number }).port;
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const call = async (method: string, route: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
    const text = await response.text();
    return { status: response.status, body: JSON.parse(text), text };
  };
  return {
    root,
    call,
    setCaller: (next: AssistantServerAuth) => (caller = next),
  };
}

describe("managed provider routes", () => {
  it("shows the key's state and a redacted label, never the key", async () => {
    const { call } = await setup();
    const initial = await call("GET", "/api/providers/openai");
    expect(initial.body).toEqual({
      revision: 0,
      openai: { state: "not-set" },
      openAiModels: [
        { providerId: "openai", modelId: "gpt-api", displayName: "GPT API" },
      ],
      availableModels: [{ providerId: "codex", modelId: "gpt-codex" }],
      defaultModel: { providerId: "codex", modelId: "gpt-codex" },
      defaultModelSource: "server",
    });
    const saved = await call("PUT", "/api/providers/openai/key", {
      expectedRevision: 0,
      apiKey: KEY,
    });
    expect(saved.status).toBe(200);
    expect(saved.text).not.toContain(KEY);
    expect(saved.body.openai).toEqual({
      state: "saved",
      label: "sk-…kkkk",
      savedAt: 5_000,
    });
    expect(saved.body.availableModels).toHaveLength(2);
    const after = await call("GET", "/api/providers/openai");
    expect(after.text).not.toContain(KEY);
  });

  it("accepts only the fixed fields: no paths, URLs or extra settings", async () => {
    const { call } = await setup();
    for (const body of [
      { expectedRevision: 0, apiKey: KEY, file: "/etc/passwd" },
      { expectedRevision: 0, apiKey: KEY, baseURL: "https://evil.example" },
      { apiKey: KEY },
    ]) {
      const result = await call("PUT", "/api/providers/openai/key", body);
      expect(result.status).toBe(400);
      expect(result.text).not.toContain(KEY);
    }
    await expect(
      call("PUT", "/api/providers/openai/key", {
        expectedRevision: 0,
        apiKey: "pasted the wrong thing",
      }),
    ).resolves.toMatchObject({
      status: 400,
      body: { error: "api_key_invalid" },
    });
    await expect(
      call("PUT", "/api/providers/openai/key?apiKey=x", {
        expectedRevision: 0,
        apiKey: KEY,
      }),
    ).resolves.toMatchObject({
      status: 400,
      body: { error: "provider_request_invalid" },
    });
    await expect(
      call("POST", "/api/providers/openai/key", {
        expectedRevision: 0,
        apiKey: KEY,
      }),
    ).resolves.toMatchObject({ status: 405 });
    await expect(
      call("PUT", "/api/providers/default-model", {
        expectedRevision: 0,
        model: { providerId: "openai", modelId: "gpt-api", baseURL: "x" },
      }),
    ).resolves.toMatchObject({ status: 400, body: { error: "model_invalid" } });
  });

  it("lets only the owner, with a current session, change anything", async () => {
    const { call, setCaller } = await setup();
    setCaller(auth("guest", () => true));
    await expect(call("GET", "/api/providers/openai")).resolves.toMatchObject({
      status: 403,
    });
    await expect(
      call("PUT", "/api/providers/openai/key", {
        expectedRevision: 0,
        apiKey: KEY,
      }),
    ).resolves.toMatchObject({ status: 403 });
    setCaller(auth("owner", () => false));
    await expect(
      call("PUT", "/api/providers/openai/key", {
        expectedRevision: 0,
        apiKey: KEY,
      }),
    ).resolves.toMatchObject({
      status: 401,
      body: { error: "authentication_required" },
    });
    setCaller(auth("owner", () => true));
    await expect(call("GET", "/api/providers/openai")).resolves.toMatchObject({
      body: { openai: { state: "not-set" } },
    });
  });

  it("sets a default only to a model new chats can use now", async () => {
    const { call } = await setup();
    await expect(
      call("PUT", "/api/providers/default-model", {
        expectedRevision: 0,
        model: { providerId: "openai", modelId: "gpt-api" },
      }),
    ).resolves.toMatchObject({
      status: 400,
      body: { error: "model_not_available" },
    });
    const saved = await call("PUT", "/api/providers/openai/key", {
      expectedRevision: 0,
      apiKey: KEY,
    });
    const chosen = await call("PUT", "/api/providers/default-model", {
      expectedRevision: saved.body.revision,
      model: { providerId: "openai", modelId: "gpt-api" },
    });
    expect(chosen.body).toMatchObject({
      defaultModel: { providerId: "openai", modelId: "gpt-api" },
      defaultModelSource: "setup",
    });
    await expect(
      call("PUT", "/api/providers/default-model", {
        expectedRevision: saved.body.revision,
        model: null,
      }),
    ).resolves.toMatchObject({
      status: 409,
      body: { error: "providers_changed" },
    });
    const removed = await call("DELETE", "/api/providers/openai/key", {
      expectedRevision: chosen.body.revision,
    });
    // The owner's choice stays; requests on it now fail until a key is back.
    expect(removed.body).toMatchObject({
      openai: { state: "not-set" },
      defaultModel: { providerId: "openai", modelId: "gpt-api" },
    });
    const cleared = await call("PUT", "/api/providers/default-model", {
      expectedRevision: removed.body.revision,
      model: null,
    });
    expect(cleared.body).toMatchObject({
      defaultModel: { providerId: "codex", modelId: "gpt-codex" },
      defaultModelSource: "server",
    });
  });

  it("does not echo storage errors, which could name the key's path", async () => {
    const { call } = await setup((providers) => ({
      ...providers,
      saveOpenAiKey: async () => {
        throw new Error(
          "EACCES: permission denied, open '/srv/data/credentials/openai-api-key'",
        );
      },
    }));
    const failed = await call("PUT", "/api/providers/openai/key", {
      expectedRevision: 0,
      apiKey: KEY,
    });
    expect(failed).toMatchObject({
      status: 500,
      body: { error: "provider_save_failed" },
    });
    expect(failed.text).not.toContain("credentials");
  });
});
