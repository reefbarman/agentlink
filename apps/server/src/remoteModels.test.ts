import type {
  CoreModelBackend,
  CoreModelCompleteRequest,
} from "@agentlink/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRunnerHttpClient,
  startRunnerHttpServer,
} from "./runnerProtocol.js";
import {
  modelProxyRoutes,
  openRemoteModelBackends,
  toWireModelRequest,
} from "./remoteModels.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0)) await step();
});

const CAPS = {
  supportsThinking: true,
  supportsCaching: false,
  supportsImages: false,
  supportsToolUse: true,
  contextWindow: 1000,
  maxOutputTokens: 100,
};

async function proxy(backend: CoreModelBackend) {
  const server = await startRunnerHttpServer({
    host: "127.0.0.1",
    port: 0,
    authorize: (token) => (token === "runner" ? true : undefined),
    routes: () =>
      modelProxyRoutes({
        backends: [backend],
        principal: { tenantId: "local", subjectId: "runner:task-1" },
      }),
  });
  cleanup.push(() => server.close());
  return createRunnerHttpClient({
    baseUrl: `http://127.0.0.1:${server.port}`,
    token: "runner",
  });
}

describe("the model proxy", () => {
  it("sends only the serializable request, never in-process state", () => {
    const wire = toWireModelRequest({
      model: "m",
      systemPrompt: "s",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 10,
      signal: new AbortController().signal,
      onTransportActivity: () => undefined,
      executionControls: {
        maxRetries: 2,
        maxOutputBytes: 99,
        beforeModelDispatch: () => undefined,
      },
      providerHints: {
        sessionId: "s1",
        codex: {
          sessionId: "c1",
          fullHistory: true,
          conversationState: { secret: "in memory" } as never,
        },
      },
    });
    expect(wire).toEqual({
      model: "m",
      systemPrompt: "s",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 10,
      executionControls: { maxRetries: 2, maxOutputBytes: 99 },
      providerHints: {
        sessionId: "s1",
        codex: { sessionId: "c1", fullHistory: true },
      },
    });
  });

  it("describes the control plane's models and forwards complete, keeping error codes", async () => {
    const complete = vi.fn(async (request: CoreModelCompleteRequest) => {
      if (request.systemPrompt === "fail") {
        throw Object.assign(new Error("Sign in again"), {
          code: "model_auth_required",
          status: 401,
        });
      }
      return { text: `echo ${String(request.messages[0]!.content)}` };
    });
    const client = await proxy({
      providerId: "codex",
      displayName: "Codex",
      condenseModel: "small",
      listModels: () => [
        {
          id: "big",
          displayName: "Big",
          providerId: "codex",
          contextWindow: 1000,
          authenticated: true,
        },
      ],
      getCapabilities: () => CAPS,
      getPromptProfile: () => ({ family: "gpt" }) as never,
      async *stream() {
        yield { type: "done" };
      },
      complete,
    });
    const [remote] = await openRemoteModelBackends(client);
    expect(remote!.providerId).toBe("codex");
    expect(remote!.condenseModel).toBe("small");
    expect(remote!.listModels().map((model) => model.id)).toEqual(["big"]);
    expect(remote!.getCapabilities("big")).toEqual(CAPS);
    expect(remote!.getPromptProfile?.("big")).toEqual({ family: "gpt" });
    expect(() => remote!.getCapabilities("unknown")).toThrow();
    // The backend has no sign-in status, so neither does its remote.
    expect(remote!.getAuthStatus).toBeUndefined();

    const before = vi.fn();
    await expect(
      remote!.complete(
        {
          model: "big",
          systemPrompt: "s",
          messages: [{ role: "user", content: "hello" }],
          maxTokens: 10,
          executionControls: {
            maxRetries: 1,
            maxOutputBytes: 50,
            beforeModelDispatch: before,
          },
        },
        {
          principal: { tenantId: "x", subjectId: "y" },
          authContext: undefined,
        },
      ),
    ).resolves.toEqual({ text: "echo hello" });
    expect(before).toHaveBeenCalledWith({ model: "big" });
    // The control plane enforces the runner's numbers itself.
    expect(complete.mock.calls[0]![0].executionControls).toMatchObject({
      maxRetries: 1,
      maxOutputBytes: 50,
    });

    await expect(
      remote!.complete(
        {
          model: "big",
          systemPrompt: "fail",
          messages: [{ role: "user", content: "x" }],
          maxTokens: 10,
        },
        {
          principal: { tenantId: "x", subjectId: "y" },
          authContext: undefined,
        },
      ),
    ).rejects.toMatchObject({
      message: "Sign in again",
      code: "model_auth_required",
      status: 401,
    });
  });
});
