import type { AgentModelReference } from "@agentlink/core";
import type {
  CoreReasoningEffort,
  EmbeddedAgentTurnEvent,
} from "@agentlink/protocol";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAskAgentBridge, type AskAgentBridge } from "./askAgentBridge.js";
import type { AssistantServerAuth } from "./assistantServer.js";
import { HttpError } from "./httpJson.js";
import {
  SessionEventHub,
  type AssistantSessionEvent,
} from "./SessionEventHub.js";
import type { AssistantSessionOperations } from "./workspaceRoutes.js";

const MODEL: AgentModelReference = {
  providerId: "fixture",
  modelId: "fixture-model",
};
const REVIEW: AgentModelReference = {
  providerId: "claude",
  modelId: "claude-review",
};

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

interface ChatMessage {
  readonly role: string;
  readonly content: string;
}

interface Snapshot {
  readonly ui: { readonly approval: { readonly id: string } | null };
  readonly session: {
    readonly sessions: ReadonlyArray<{ readonly id: string; title: string }>;
    readonly foreground: {
      readonly sessionId: string;
      readonly model: string;
      readonly projectedMessages: readonly ChatMessage[];
    };
  };
}

/** Fake session operations that publish scripted events to a real hub. */
function createFakeOperations(events: SessionEventHub) {
  const sessions = new Map<
    string,
    {
      model: AgentModelReference;
      reasoningEffort?: CoreReasoningEffort;
      messages: unknown[];
    }
  >();
  let next = 0;
  const key = (projectId: string, sessionId: string) =>
    `${projectId}/${sessionId}`;
  const publish = (sessionId: string, event: AssistantSessionEvent) =>
    events.publish(key("home", sessionId), event);
  const turn = (sessionId: string, event: Record<string, unknown>) =>
    publish(sessionId, {
      kind: "turn",
      event: { emittedAt: Date.now(), ...event } as EmbeddedAgentTurnEvent,
    });
  /** What the next started task does; it runs after `startTurn` returns. */
  let script: (sessionId: string, taskId: string) => void = () => undefined;
  const run = (sessionId: string) => {
    const taskId = `task-${(next += 1)}`;
    const current = script;
    setTimeout(() => current(sessionId, taskId), 5);
    return { taskId };
  };
  const operations = {
    sessionKey: key,
    listSessions: vi.fn(async () =>
      [...sessions.keys()].map((sessionId) => ({
        sessionId,
        updatedAt: Date.now(),
      })),
    ),
    readSession: vi.fn(async (_auth, _projectId, sessionId: string) => {
      const session = sessions.get(sessionId)!;
      return {
        messages: session.messages,
        model: session.model,
        reasoningEffort: session.reasoningEffort,
        createdAt: 1,
        updatedAt: 2,
      };
    }),
    createSession: vi.fn(
      async (
        _auth,
        _projectId,
        model,
        reasoningEffort?: CoreReasoningEffort,
      ) => {
        const sessionId = `ws-${(next += 1)}`;
        sessions.set(sessionId, {
          model: model ?? MODEL,
          reasoningEffort,
          messages: [],
        });
        return { sessionId };
      },
    ),
    setModel: vi.fn(async (_auth, _projectId, sessionId: string, model) => {
      sessions.get(sessionId)!.model = model;
    }),
    setReasoningEffort: vi.fn(
      async (_auth, _projectId, sessionId: string, effort) => {
        sessions.get(sessionId)!.reasoningEffort = effort;
      },
    ),
    startTurn: vi.fn(async (_auth, _projectId, sessionId: string) =>
      run(sessionId),
    ),
    answerInteraction: vi.fn(async (_auth, _projectId, sessionId: string) =>
      run(sessionId),
    ),
    cancel: vi.fn(async () => undefined),
  } satisfies AssistantSessionOperations;
  return {
    operations,
    sessions,
    turn,
    publish,
    setScript(next: (sessionId: string, taskId: string) => void) {
      script = next;
    },
  };
}

async function startBridge(
  stateFile?: string,
  options: {
    readonly signal?: AbortSignal;
    readonly defaults?: Parameters<typeof createAskAgentBridge>[0]["defaults"];
  } = {},
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ask-agent-bridge-"));
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  const events = new SessionEventHub();
  const fake = createFakeOperations(events);
  const file = stateFile ?? path.join(dir, "settings", "ask-agent.json");
  const bridge: AskAgentBridge = await createAskAgentBridge({
    projectId: "home",
    operations: fake.operations,
    events,
    models: {
      available: [
        MODEL,
        {
          ...REVIEW,
          displayName: "Claude review",
          contextWindow: 1_000_000,
          reasoningEfforts: ["low", "high", "max"],
          defaultReasoningEffort: "high",
        },
      ],
      defaultModel: MODEL,
    },
    stateFile: file,
    ...(options.defaults ? { defaults: options.defaults } : {}),
  });
  const auth: AssistantServerAuth = {
    principal: { tenantId: "agentlink-server", subjectId: "owner" },
    session: {
      ownerId: "owner",
      sessionId: "s",
      deviceId: "d",
      deviceLabel: "Laptop",
      createdAt: 0,
      expiresAt: Number.MAX_SAFE_INTEGER,
    },
    signal: options.signal ?? new AbortController().signal,
    revalidate: async () => ({ valid: true }),
  };
  const server = http.createServer((request, response) => {
    bridge
      .handleRequest(request, response, auth)
      .then((handled) => {
        if (!handled) {
          response.writeHead(404);
          response.end();
        }
      })
      .catch((error: unknown) => {
        if (response.headersSent) return response.destroy();
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
  const port = (server.address() as { port: number }).port;
  cleanup.push(async () => {
    await bridge.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const call = async (
    route: string,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  };
  return { bridge, fake, call, file };
}

const snapshotOf = (body: Record<string, unknown>) =>
  body.snapshot as unknown as Snapshot;

describe("Ask Agent bridge", () => {
  it("starts new chats on the project's default model and thinking level", async () => {
    let defaults: { model?: AgentModelReference } = {};
    const { call } = await startBridge(undefined, {
      defaults: () => ({ ...defaults, reasoningEffort: "max" }),
    });
    const first = snapshotOf(
      await call("/api/ask-agent/session").then((r) => r.body),
    );
    expect(first.session.foreground.model).toBe("fixture/fixture-model");

    // A settings change applies to the next new chat.
    defaults = { model: REVIEW };
    const created = await call("/api/ask-agent/session/new", {});
    expect(snapshotOf(created.body).session.foreground.model).toBe(
      "claude/claude-review",
    );
    const session = await call("/api/ask-agent/session");
    expect(
      (
        session.body.snapshot as {
          session: { foreground: { reasoningEffort?: string } };
        }
      ).session.foreground.reasoningEffort,
    ).toBe("max");
  });

  it("streams a turn into the shared UI's session snapshot", async () => {
    const { fake, call, file } = await startBridge();
    fake.setScript((sessionId, taskId) => {
      fake.publish(sessionId, {
        kind: "task",
        state: "started",
        taskId,
        operation: "turn",
        actor: { subjectId: "owner", deviceId: "d" },
      });
      fake.turn(sessionId, { type: "text.delta", text: "Hel" });
      fake.turn(sessionId, { type: "text.delta", text: "lo" });
      fake.turn(sessionId, {
        type: "turn.completed",
        result: { text: "Hello" },
      });
      fake.publish(sessionId, {
        kind: "task",
        state: "finished",
        taskId,
        status: "completed",
      });
    });

    const sent = await call("/api/ask-agent/send", { text: "hi there" });
    expect(sent.status).toBe(200);
    const { foreground } = snapshotOf(sent.body).session;
    expect(
      foreground.projectedMessages.map(({ role, content }) => ({
        role,
        content,
      })),
    ).toEqual([
      { role: "user", content: "hi there" },
      { role: "assistant", content: "Hello" },
    ]);
    expect(fake.operations.createSession).toHaveBeenCalledTimes(1);
    expect(fake.operations.startTurn).toHaveBeenCalledWith(
      expect.anything(),
      "home",
      "ws-1",
      "hi there",
    );
    // The UI session is mapped to the durable workspace session.
    const saved = JSON.parse(await fs.readFile(file, "utf8"));
    expect(Object.values(saved.aliases)).toEqual(["ws-1"]);

    // The second turn reuses the same workspace session.
    await call("/api/ask-agent/send", { text: "again" });
    expect(fake.operations.createSession).toHaveBeenCalledTimes(1);
    expect(fake.operations.startTurn).toHaveBeenLastCalledWith(
      expect.anything(),
      "home",
      "ws-1",
      "again",
    );
  });

  it("surfaces an approval and resumes the turn with the decision", async () => {
    const { fake, call } = await startBridge();
    fake.setScript((sessionId, taskId) => {
      fake.turn(sessionId, {
        type: "tool.requested",
        toolCallId: "call-1",
        toolName: "write_file",
        displayInput: { path: "note.txt" },
      });
      fake.turn(sessionId, {
        type: "interaction.required",
        interaction: {
          interactionId: "int-1",
          toolName: "write_file",
          summary: "Write note.txt",
          displayInput: { path: "note.txt" },
        },
        interactionRevision: "rev-1",
      });
      fake.publish(sessionId, {
        kind: "task",
        state: "finished",
        taskId,
        status: "suspended",
      });
      // The resume (after the decision) finishes the turn.
      fake.setScript((resumed, resumeTask) => {
        fake.turn(resumed, {
          type: "tool.completed",
          toolCallId: "call-1",
          toolName: "write_file",
          displayContent: "wrote note.txt",
        });
        fake.turn(resumed, {
          type: "turn.completed",
          result: { text: "Done" },
        });
        fake.publish(resumed, {
          kind: "task",
          state: "finished",
          taskId: resumeTask,
          status: "completed",
        });
      });
    });

    const send = call("/api/ask-agent/send", { text: "write a note" });
    const approval = await vi.waitFor(async () => {
      const { body } = await call("/api/ask-agent/session");
      const pending = snapshotOf(body).ui.approval;
      expect(pending).not.toBeNull();
      return pending!;
    });
    expect(approval).toMatchObject({
      id: "int-1",
      filePath: "Write note.txt",
    });
    await expect(
      call("/api/ask-agent/approval", { id: "other", decision: "accept" }),
    ).resolves.toMatchObject({ status: 404 });
    const answered = await call("/api/ask-agent/approval", {
      id: "int-1",
      decision: "accept",
    });
    expect(answered.status).toBe(200);
    expect(fake.operations.answerInteraction).toHaveBeenCalledWith(
      expect.anything(),
      "home",
      "ws-1",
      {
        interactionId: "int-1",
        interactionRevision: "rev-1",
        decision: "allow",
      },
    );
    const finished = await send;
    expect(finished.status).toBe(200);
    const snapshot = snapshotOf(finished.body);
    expect(snapshot.ui.approval).toBeNull();
    expect(snapshot.session.foreground.projectedMessages.at(-1)).toMatchObject({
      role: "assistant",
      content: "Done",
    });
  });

  it("stops a running turn and cancels the workspace task", async () => {
    const { fake, call } = await startBridge();
    // A turn that never finishes on its own.
    fake.setScript((sessionId) => {
      fake.turn(sessionId, { type: "text.delta", text: "thinking" });
    });
    const send = call("/api/ask-agent/send", { text: "long job" });
    await vi.waitFor(() =>
      expect(fake.operations.startTurn).toHaveBeenCalled(),
    );
    const stopped = await call("/api/ask-agent/stop", {});
    expect(stopped.body).toMatchObject({ ok: true, stopped: true });
    expect(fake.operations.cancel).toHaveBeenCalledWith(
      expect.anything(),
      "home",
      "ws-1",
    );
    // The workspace reports the cancellation; the send then settles.
    fake.publish("ws-1", {
      kind: "task",
      state: "finished",
      taskId: "task-2",
      status: "cancelled",
    });
    await expect(send).resolves.toMatchObject({ status: 200 });
  });

  it("tracks running, needs-you and unread chats across chat switches", async () => {
    const { bridge, fake, call } = await startBridge();
    const activityOf = async () => {
      const { body } = await call("/api/ask-agent/sessions");
      return Object.fromEntries(
        (body.sessions as Array<{ id: string; activity?: string }>).map(
          (session) => [session.id, session.activity],
        ),
      );
    };
    // A turn that waits until the test finishes it.
    fake.setScript((sessionId) => {
      fake.turn(sessionId, { type: "text.delta", text: "working" });
    });
    const first = snapshotOf(
      await call("/api/ask-agent/session").then((r) => r.body),
    ).session.foreground.sessionId;
    const send = call("/api/ask-agent/send", { text: "long job" });
    await vi.waitFor(async () =>
      expect(await activityOf()).toEqual({ [first]: "running" }),
    );
    expect(bridge.activity()).toEqual({ running: 1, needsYou: 0, unread: 0 });

    // The owner moves to another chat; the turn keeps writing to its own.
    const created = await call("/api/ask-agent/session/new", {});
    const second = snapshotOf(created.body).session.foreground.sessionId;
    expect(second).not.toBe(first);
    await expect(
      call("/api/ask-agent/session/delete", { sessionId: first }),
    ).resolves.toMatchObject({ status: 409 });
    fake.turn("ws-1", { type: "text.delta", text: " hard" });
    fake.turn("ws-1", {
      type: "turn.completed",
      result: { text: "working hard" },
    });
    fake.publish("ws-1", {
      kind: "task",
      state: "finished",
      taskId: "task-2",
      status: "completed",
    });
    await expect(send).resolves.toMatchObject({ status: 200 });
    expect((await activityOf())[first]).toBe("unread");
    expect(bridge.activity()).toEqual({ running: 0, needsYou: 0, unread: 1 });

    // Opening it shows the finished reply and clears the flag.
    const loaded = await call("/api/ask-agent/session/load", {
      sessionId: first,
    });
    expect(
      snapshotOf(loaded.body).session.foreground.projectedMessages.at(-1),
    ).toMatchObject({ role: "assistant", content: "working hard" });
    expect((await activityOf())[first]).toBeUndefined();

    // A pending approval is "needs you" until it is answered.
    fake.setScript((sessionId, taskId) => {
      fake.turn(sessionId, {
        type: "interaction.required",
        interaction: {
          interactionId: "int-9",
          toolName: "write_file",
          summary: "Write note.txt",
          displayInput: { path: "note.txt" },
        },
        interactionRevision: "rev-9",
      });
      fake.publish(sessionId, {
        kind: "task",
        state: "finished",
        taskId,
        status: "suspended",
      });
      fake.setScript((resumed, resumeTask) => {
        fake.turn(resumed, { type: "turn.completed", result: { text: "ok" } });
        fake.publish(resumed, {
          kind: "task",
          state: "finished",
          taskId: resumeTask,
          status: "completed",
        });
      });
    });
    const asking = call("/api/ask-agent/send", { text: "write a note" });
    await vi.waitFor(async () =>
      expect((await activityOf())[first]).toBe("needs-you"),
    );
    expect(bridge.activity().needsYou).toBe(1);
    await call("/api/ask-agent/approval", { id: "int-9", decision: "accept" });
    await expect(asking).resolves.toMatchObject({ status: 200 });
    expect((await activityOf())[first]).not.toBe("needs-you");
  });

  it("switches the session model, and lists, renames and hides sessions", async () => {
    const { fake, call, file } = await startBridge();
    fake.setScript((sessionId, taskId) => {
      fake.turn(sessionId, { type: "turn.completed", result: { text: "ok" } });
      fake.publish(sessionId, {
        kind: "task",
        state: "finished",
        taskId,
        status: "completed",
      });
    });
    await call("/api/ask-agent/send", { text: "first" });
    const models = await call("/api/ask-agent/models");
    expect(
      (models.body.models as Array<{ id: string }>).map((model) => model.id),
    ).toEqual(["fixture/fixture-model", "claude/claude-review"]);
    await expect(
      call("/api/ask-agent/model", { model: "nope/nope" }),
    ).resolves.toMatchObject({ status: 400 });
    await call("/api/ask-agent/model", { model: "claude/claude-review" });
    await call("/api/ask-agent/send", { text: "review this" });
    expect(fake.operations.setModel).toHaveBeenCalledWith(
      expect.anything(),
      "home",
      "ws-1",
      { providerId: "claude", modelId: "claude-review" },
    );
    expect(fake.sessions.get("ws-1")?.model.modelId).toBe("claude-review");
    // A thinking level the new model supports is applied with the switch.
    expect(["low", "high", "max"]).toContain(
      fake.sessions.get("ws-1")?.reasoningEffort,
    );

    const listed = await call("/api/ask-agent/sessions");
    const [session] = listed.body.sessions as Array<{ id: string }>;
    await call("/api/ask-agent/session/rename", {
      sessionId: session!.id,
      title: "Renamed",
    });
    await call("/api/ask-agent/session/delete", { sessionId: session!.id });
    const saved = JSON.parse(await fs.readFile(file, "utf8"));
    expect(saved.titles).toEqual({ "ws-1": "Renamed" });
    expect(saved.hidden).toEqual(["ws-1"]);
  });

  it("offers each model's thinking levels and applies the chosen one", async () => {
    const { fake, call } = await startBridge();
    fake.setScript((sessionId, taskId) => {
      fake.turn(sessionId, { type: "turn.completed", result: { text: "ok" } });
      fake.publish(sessionId, {
        kind: "task",
        state: "finished",
        taskId,
        status: "completed",
      });
    });
    const models = (await call("/api/ask-agent/models")).body.models as Array<{
      id: string;
      reasoningEfforts?: string[];
      contextWindow: number;
    }>;
    expect(models[0]?.reasoningEfforts).toBeUndefined();
    expect(models[1]).toMatchObject({
      id: "claude/claude-review",
      reasoningEfforts: ["low", "high", "max"],
      contextWindow: 1_000_000,
    });

    await call("/api/ask-agent/model", { model: "claude/claude-review" });
    await expect(
      call("/api/ask-agent/thinking", { effort: "medium" }),
    ).resolves.toMatchObject({ status: 400 });
    await expect(
      call("/api/ask-agent/thinking", { effort: "max" }),
    ).resolves.toMatchObject({ status: 200 });
    await call("/api/ask-agent/send", { text: "think hard" });
    expect(fake.operations.createSession).toHaveBeenCalledWith(
      expect.anything(),
      "home",
      REVIEW,
      "max",
    );

    await call("/api/ask-agent/thinking", { effort: "low" });
    await call("/api/ask-agent/send", { text: "less" });
    expect(fake.operations.setReasoningEffort).toHaveBeenCalledWith(
      expect.anything(),
      "home",
      "ws-1",
      "low",
    );
    expect(fake.sessions.get("ws-1")?.reasoningEffort).toBe("low");
  });

  it("restores durable sessions on first use and skips hidden ones", async () => {
    const first = await startBridge();
    first.fake.sessions.set("ws-old", {
      model: REVIEW,
      messages: [
        { role: "user", content: "remember me" },
        { role: "assistant", content: [{ type: "text", text: "I will" }] },
      ],
    });
    first.fake.sessions.set("ws-hidden", {
      model: MODEL,
      messages: [{ role: "user", content: "secret" }],
    });
    await fs.mkdir(path.dirname(first.file), { recursive: true });
    await fs.writeFile(
      first.file,
      JSON.stringify({
        version: 1,
        aliases: {},
        titles: {},
        hidden: ["ws-hidden"],
      }),
    );
    // A fresh bridge over the same state file.
    const second = await startBridge(first.file);
    for (const [id, session] of first.fake.sessions) {
      second.fake.sessions.set(id, session);
    }
    const listed = await second.call("/api/ask-agent/sessions");
    const sessions = listed.body.sessions as Array<{
      id: string;
      title: string;
    }>;
    expect(sessions.map((session) => session.title)).toContain("remember me");
    expect(sessions.map((session) => session.title)).not.toContain("secret");
    const loaded = await second.call("/api/ask-agent/session/load", {
      sessionId: "ws-old",
    });
    expect(snapshotOf(loaded.body).session.foreground.model).toBe(
      "claude/claude-review",
    );
  });

  it("refuses media it cannot handle and ignores other paths", async () => {
    const { call } = await startBridge();
    await expect(
      call("/api/ask-agent/send", {
        text: "look",
        images: [{ data: "x" }],
      }),
    ).resolves.toMatchObject({
      status: 400,
      body: { error: "ask_agent_media_unavailable" },
    });
    await expect(call("/api/ask-agent/slash-commands")).resolves.toMatchObject({
      status: 200,
      body: { commands: [] },
    });
    await expect(call("/api/instances")).resolves.toMatchObject({
      status: 200,
      body: { instances: [] },
    });
    await expect(call("/api/projects")).rejects.toThrow();
  });

  it("refuses an event stream whose session was revoked before it opened", async () => {
    const revoked = new AbortController();
    revoked.abort();
    const { call } = await startBridge(undefined, { signal: revoked.signal });
    await expect(call("/api/ask-agent/events")).resolves.toMatchObject({
      status: 401,
      body: { error: "authentication_required" },
    });
  });
});
