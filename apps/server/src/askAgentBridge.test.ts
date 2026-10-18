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
import { parseAgentResultPrompt } from "./backgroundResultDelivery.js";
import type { TaskState } from "./taskStore.js";
import type { AssistantServerAuth } from "./assistantServer.js";
import { HttpError } from "./httpJson.js";
import {
  SessionEventHub,
  type AssistantSessionEvent,
} from "./SessionEventHub.js";
import { AUTO_CONTINUE_PROMPT } from "./sessionProgress.js";
import { parseTaskResultPrompt } from "./taskResultDelivery.js";
import type { TaskRun } from "./taskStore.js";
import type { AssistantSessionOperations } from "./workspaceRoutes.js";
import type { WorkspaceBackgroundRecord } from "@agentlink/workspace-host";

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
  readonly blocks?: ReadonlyArray<{
    readonly type: string;
    readonly text?: string;
  }>;
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
      approvalMode?: "autonomous" | "ask";
      messages: unknown[];
      /** Another project's session (a task's); "home" when absent. */
      projectId?: string;
    }
  >();
  const agents = new Map<string, WorkspaceBackgroundRecord[]>();
  /** Messages handed to running turns, and whether one is running. */
  const interjections: Array<{ sessionId: string; id: string; text: string }> =
    [];
  let acceptInterjections = true;
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
    listSessions: vi.fn(async (_auth, projectId: string) =>
      [...sessions.entries()]
        .filter(([, session]) => (session.projectId ?? "home") === projectId)
        .map(([sessionId]) => ({
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
        approvalMode: session.approvalMode ?? ("autonomous" as const),
        createdAt: 1,
        updatedAt: 2,
      };
    }),
    setApprovalMode: vi.fn(
      async (
        _auth,
        _projectId,
        sessionId: string,
        mode: "autonomous" | "ask",
      ) => {
        sessions.get(sessionId)!.approvalMode = mode;
        return mode;
      },
    ),
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
    startTurn: vi.fn(
      async (_auth, _projectId, sessionId: string, _text: string) =>
        run(sessionId),
    ),
    answerInteraction: vi.fn(async (_auth, _projectId, sessionId: string) =>
      run(sessionId),
    ),
    interject: vi.fn(
      async (
        _auth,
        _projectId,
        sessionId: string,
        interjection: { id: string; text: string },
      ) => {
        if (!acceptInterjections) return { queued: false };
        interjections.push({ sessionId, ...interjection });
        return { queued: true };
      },
    ),
    withdrawInterjection: vi.fn(
      async (_auth, _projectId, sessionId: string, interjectionId: string) => {
        const index = interjections.findIndex(
          (item) => item.sessionId === sessionId && item.id === interjectionId,
        );
        if (index < 0) return { withdrawn: false };
        interjections.splice(index, 1);
        return { withdrawn: true };
      },
    ),
    cancel: vi.fn(async () => undefined),
    deleteSession: vi.fn(async (_auth, _projectId, sessionId: string) => {
      if (!sessions.delete(sessionId)) {
        throw new HttpError(404, "session_not_found");
      }
    }),
    listAgents: vi.fn(
      async (_auth, _projectId, sessionId: string) =>
        agents.get(sessionId) ?? [],
    ),
    readAgentTranscript: vi.fn(
      async (_auth, _projectId, sessionId: string, childSessionId: string) => {
        const agent = (agents.get(sessionId) ?? []).find(
          (record) => record.childSessionId === childSessionId,
        );
        if (!agent) throw new HttpError(404, "agent_not_found");
        return {
          task: agent.task,
          messages: [{ role: "assistant", content: "child says hi" }],
        };
      },
    ),
    steerAgent: vi.fn(async () => ({ queued: 1 })),
    stopAgent: vi.fn(
      async (_auth, _projectId, sessionId: string, childSessionId: string) =>
        updateAgent(sessionId, childSessionId, { lifecycle: "cancelled" }),
    ),
    answerAgentApproval: vi.fn(
      async (_auth, _projectId, sessionId: string, childSessionId: string) =>
        updateAgent(sessionId, childSessionId, {
          lifecycle: "running",
          approval: undefined,
        }),
    ),
  } satisfies AssistantSessionOperations;
  function updateAgent(
    sessionId: string,
    childSessionId: string,
    patch: Partial<WorkspaceBackgroundRecord>,
  ): WorkspaceBackgroundRecord {
    const list = agents.get(sessionId) ?? [];
    const index = list.findIndex(
      (record) => record.childSessionId === childSessionId,
    );
    const updated = { ...list[index]!, ...patch };
    list[index] = updated;
    return updated;
  }
  return {
    operations,
    sessions,
    agents,
    interjections,
    acceptInterjections(accept: boolean) {
      acceptInterjections = accept;
    },
    turn,
    publish,
    /** Publish any event to another project's session (a task's). */
    publishEventTo: (
      projectId: string,
      sessionId: string,
      event: AssistantSessionEvent,
    ) => events.publish(key(projectId, sessionId), event),
    /** Publish to another project's session (a task's). */
    publishTo: (
      projectId: string,
      sessionId: string,
      event: Record<string, unknown>,
    ) =>
      events.publish(key(projectId, sessionId), {
        kind: "turn",
        event: { emittedAt: Date.now(), ...event } as EmbeddedAgentTurnEvent,
      }),
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
    readonly agentRefreshMs?: number;
    readonly chatTasks?: Parameters<
      typeof createAskAgentBridge
    >[0]["chatTasks"];
    readonly linkedMessage?: Parameters<
      typeof createAskAgentBridge
    >[0]["linkedMessage"];
    readonly stopRun?: Parameters<typeof createAskAgentBridge>[0]["stopRun"];
    readonly chatDeleted?: Parameters<
      typeof createAskAgentBridge
    >[0]["chatDeleted"];
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
    ...(options.agentRefreshMs
      ? { agentRefreshMs: options.agentRefreshMs }
      : {}),
    ...(options.chatTasks ? { chatTasks: options.chatTasks } : {}),
    ...(options.linkedMessage ? { linkedMessage: options.linkedMessage } : {}),
    ...(options.stopRun ? { stopRun: options.stopRun } : {}),
    ...(options.chatDeleted ? { chatDeleted: options.chatDeleted } : {}),
  });
  const signedIn = {
    principal: { tenantId: "agentlink-server" as const, subjectId: "owner" },
    session: {
      ownerId: "owner",
      sessionId: "s",
      deviceId: "d",
      deviceLabel: "Laptop",
      createdAt: 0,
      expiresAt: Number.MAX_SAFE_INTEGER,
    },
  };
  const detached: AssistantServerAuth = {
    ...signedIn,
    signal: options.signal ?? new AbortController().signal,
    revalidate: async () => ({ valid: true }),
    detach: () => detached,
  };
  // Like the real server: a request's auth is invalid once it has closed.
  const requestAuth = (response: http.ServerResponse): AssistantServerAuth => {
    const closed = new AbortController();
    response.once("close", () => closed.abort());
    return {
      ...signedIn,
      signal: options.signal
        ? AbortSignal.any([options.signal, closed.signal])
        : closed.signal,
      revalidate: async () => ({
        valid: !closed.signal.aborted && !options.signal?.aborted,
      }),
      detach: () => detached,
    };
  };
  const server = http.createServer((request, response) => {
    bridge
      .handleRequest(request, response, requestAuth(response))
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
  return { bridge, fake, call, file, detached };
}

const codingTask = (overrides: Partial<TaskRun> = {}): TaskRun => ({
  id: "aaaaaaaaaaaa",
  projectId: "task-aaaaaaaaaaaa",
  repository: "https://github.com/reefbarman/site",
  objective: "Update the AgentLink page",
  branch: "agentlink/update-the-agentlink-page-aaaaaaaaaaaa",
  workspace: "/w/aaaaaaaaaaaa/site",
  state: "published",
  origin: { projectId: "home", sessionId: "ws-1" },
  pullRequest: { number: 7, url: "https://github.com/reefbarman/site/pull/7" },
  summary: "Updated the page.",
  attempts: 1,
  evidence: [],
  effects: [],
  createdAt: 1,
  updatedAt: 2,
  finishedAt: 2,
  ...overrides,
});

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

  describe("work here", () => {
    const textOf = (message: ChatMessage) =>
      message.content ||
      (message.blocks ?? []).map((block) => block.text ?? "").join("");

    it("shows a task's work in the chat that asked, routes the chat to it, then hands the chat back", async () => {
      const linkedMessage = vi.fn(async () => undefined);
      const stopRun = vi.fn(async () => undefined);
      const { bridge, fake, call, detached } = await startBridge(undefined, {
        linkedMessage,
        stopRun,
      });
      fake.setScript((sessionId, taskId) => {
        fake.publish(sessionId, {
          kind: "task",
          state: "started",
          taskId,
          operation: "turn",
          actor: { subjectId: "owner", deviceId: "d" },
        });
        fake.turn(sessionId, { type: "text.delta", text: "On it" });
        fake.turn(sessionId, { type: "turn.completed", result: { text: "" } });
        fake.publish(sessionId, {
          kind: "task",
          state: "finished",
          taskId,
          status: "completed",
        });
      });
      await call("/api/ask-agent/send", { text: "fix the footer here" });
      const origin = [...fake.sessions.keys()][0]!;
      const messages = async () =>
        snapshotOf((await call("/api/ask-agent/session")).body).session
          .foreground.projectedMessages;

      await bridge.attachWork(detached, origin, {
        projectId: "task-t1",
        workspaceSessionId: "tws",
        title: "Fix the footer",
      });
      fake.publishTo("task-t1", "tws", {
        type: "text.delta",
        text: "Editing footer.html",
      });
      bridge.noteWork(origin, "Checks passed (1 of 1).");
      fake.publishTo("task-t1", "tws", {
        type: "text.delta",
        text: "Review fixes",
      });
      await vi.waitFor(async () => {
        const texts = (await messages()).map(textOf);
        expect(texts).toContain("**Working here:** Fix the footer");
        expect(texts.indexOf("Editing footer.html")).toBeGreaterThan(-1);
        // The notice sits between the two stretches of work.
        expect(texts.indexOf("Checks passed (1 of 1).")).toBeGreaterThan(
          texts.indexOf("Editing footer.html"),
        );
        expect(texts.indexOf("Review fixes")).toBeGreaterThan(
          texts.indexOf("Checks passed (1 of 1)."),
        );
      });

      // The owner writes in the same chat: it goes to the task.
      await call("/api/ask-agent/send", { text: "use the blue logo" });
      expect(fake.operations.interject).toHaveBeenCalledWith(
        expect.anything(),
        "task-t1",
        "tws",
        expect.objectContaining({ text: "use the blue logo" }),
      );
      expect(fake.operations.startTurn).toHaveBeenCalledTimes(1);
      // Taken in by the task: shown once here.
      const [taken] = fake.interjections.splice(0);
      fake.publishTo("task-t1", "tws", {
        type: "user.interjected",
        interjectionId: taken!.id,
        text: taken!.text,
      });
      await vi.waitFor(async () =>
        expect(
          (await messages()).filter(
            (message) => textOf(message) === "use the blue logo",
          ),
        ).toHaveLength(1),
      );

      // Its approvals show here and are answered in its own session.
      fake.publishTo("task-t1", "tws", {
        type: "interaction.required",
        interaction: {
          interactionId: "int-9",
          toolName: "write_file",
          summary: "Write .env",
          displayInput: { path: ".env" },
        },
        interactionRevision: "rev-9",
      });
      const approval = await vi.waitFor(async () => {
        const shown = snapshotOf((await call("/api/ask-agent/session")).body).ui
          .approval;
        expect(shown).not.toBeNull();
        return shown!;
      });
      await call("/api/ask-agent/approval", {
        id: approval.id,
        decision: "accept",
      });
      expect(fake.operations.answerInteraction).toHaveBeenCalledWith(
        expect.anything(),
        "task-t1",
        "tws",
        expect.objectContaining({ interactionId: "int-9", decision: "allow" }),
      );

      // Stop stops the task.
      await call("/api/ask-agent/stop", {});
      expect(stopRun).toHaveBeenCalledWith("tws");

      // Handed back: the chat's own session answers again.
      bridge.detachWork(origin);
      await call("/api/ask-agent/send", { text: "thanks" });
      expect(fake.operations.startTurn).toHaveBeenCalledTimes(2);
      expect(fake.operations.startTurn.mock.calls[1]?.[2]).toBe(origin);
      expect(linkedMessage).not.toHaveBeenCalled();
    });
  });

  describe("Auto Continue", () => {
    const todo = (id: string, status: string) => ({
      id,
      content: id,
      activeForm: id,
      status,
    });
    /** Each started turn runs the next step; the last repeats. */
    const scriptSteps = (
      fake: Awaited<ReturnType<typeof startBridge>>["fake"],
      steps: Array<{
        tools?: Array<{ name: string; display?: unknown }>;
        text: string;
        hold?: Promise<void>;
      }>,
    ) => {
      let index = 0;
      fake.setScript(async (sessionId, taskId) => {
        const step = steps[Math.min(index, steps.length - 1)]!;
        index += 1;
        fake.publish(sessionId, {
          kind: "task",
          state: "started",
          taskId,
          operation: "turn",
          actor: { subjectId: "owner", deviceId: "d" },
        });
        await step.hold;
        for (const [n, tool] of (step.tools ?? []).entries()) {
          fake.turn(sessionId, {
            type: "tool.completed",
            toolCallId: `${taskId}-${n}`,
            toolName: tool.name,
            displayContent: tool.display,
          });
        }
        fake.turn(sessionId, { type: "text.delta", text: step.text });
        fake.turn(sessionId, {
          type: "turn.completed",
          result: { text: step.text },
        });
        fake.publish(sessionId, {
          kind: "task",
          state: "finished",
          taskId,
          status: "completed",
        });
      });
    };

    it("carries on by itself while todos are unfinished, hiding its prompt", async () => {
      const { fake, call } = await startBridge();
      scriptSteps(fake, [
        {
          tools: [
            {
              name: "todo_write",
              display: {
                todos: [
                  todo("plan", "completed"),
                  todo("build", "in_progress"),
                ],
              },
            },
          ],
          text: "Planned",
        },
        {
          tools: [
            { name: "write_file", display: { path: "a.txt" } },
            {
              name: "todo_write",
              display: {
                todos: [todo("plan", "completed"), todo("build", "completed")],
              },
            },
          ],
          text: "Built",
        },
      ]);
      await call("/api/ask-agent/send", { text: "build it" });
      await vi.waitFor(() =>
        expect(fake.operations.startTurn).toHaveBeenCalledTimes(2),
      );
      expect(fake.operations.startTurn.mock.calls[1]?.[3]).toBe(
        AUTO_CONTINUE_PROMPT,
      );
      await vi.waitFor(async () => {
        const { foreground } = snapshotOf(
          (await call("/api/ask-agent/session")).body,
        ).session;
        expect(
          foreground.projectedMessages.map((message) => message.role),
        ).toEqual(["user", "assistant", "assistant"]);
        expect(
          (foreground as unknown as { todos: Array<{ status: string }> }).todos,
        ).toEqual([
          expect.objectContaining({ status: "completed" }),
          expect.objectContaining({ status: "completed" }),
        ]);
      });
      // Done: no third turn.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fake.operations.startTurn).toHaveBeenCalledTimes(2);
    });

    it("stops after a turn that made no progress", async () => {
      const { fake, call } = await startBridge();
      scriptSteps(fake, [
        {
          tools: [
            { name: "todo_write", display: { todos: [todo("a", "pending")] } },
          ],
          text: "Planned",
        },
        { tools: [{ name: "read_file" }], text: "Looked around" },
      ]);
      await call("/api/ask-agent/send", { text: "do it" });
      await vi.waitFor(() =>
        expect(fake.operations.startTurn).toHaveBeenCalledTimes(2),
      );
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(fake.operations.startTurn).toHaveBeenCalledTimes(2);
    });

    it("gives way to a message the owner sends, and Stop ends it", async () => {
      const { fake, call } = await startBridge();
      fake.acceptInterjections(false);
      let release!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const plan = {
        name: "todo_write",
        display: { todos: [todo("a", "in_progress")] },
      };
      scriptSteps(fake, [
        { tools: [plan], text: "Planned", hold },
        { tools: [plan], text: "On it" },
      ]);
      const first = call("/api/ask-agent/send", { text: "do it" });
      await vi.waitFor(() =>
        expect(fake.operations.startTurn).toHaveBeenCalledTimes(1),
      );
      const second = call("/api/ask-agent/send", { text: "use blue" });
      await vi.waitFor(() =>
        expect(fake.operations.interject).toHaveBeenCalledTimes(1),
      );
      release();
      await Promise.all([first, second]);
      // The owner's message ran next, not the continuation prompt.
      expect(fake.operations.startTurn.mock.calls[1]?.[3]).toBe("use blue");
      // Its turn left work too, so the chat carries on, until Stop.
      await vi.waitFor(() =>
        expect(
          fake.operations.startTurn.mock.calls.length,
        ).toBeGreaterThanOrEqual(3),
      );
      expect(fake.operations.startTurn.mock.calls[2]?.[3]).toBe(
        AUTO_CONTINUE_PROMPT,
      );
      await call("/api/ask-agent/stop", {});
      const stoppedAt = fake.operations.startTurn.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(fake.operations.startTurn.mock.calls.length).toBeLessThanOrEqual(
        stoppedAt + 1,
      );
      const settled = fake.operations.startTurn.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(fake.operations.startTurn).toHaveBeenCalledTimes(settled);
    });
  });

  describe("messages sent while a turn runs", () => {
    /** A turn that works until `release`, taking interjections meanwhile. */
    const scriptTurn = (
      fake: Awaited<ReturnType<typeof startBridge>>["fake"],
    ) => {
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      fake.setScript(async (sessionId, taskId) => {
        fake.publish(sessionId, {
          kind: "task",
          state: "started",
          taskId,
          operation: "turn",
          actor: { subjectId: "owner", deviceId: "d" },
        });
        fake.turn(sessionId, { type: "text.delta", text: "Working" });
        await released;
        for (const taken of fake.interjections.splice(0)) {
          fake.turn(sessionId, {
            type: "user.interjected",
            interjectionId: taken.id,
            text: taken.text,
          });
          fake.turn(sessionId, { type: "text.delta", text: "Got it" });
        }
        fake.turn(sessionId, { type: "turn.completed", result: { text: "" } });
        fake.publish(sessionId, {
          kind: "task",
          state: "finished",
          taskId,
          status: "completed",
        });
      });
      return release;
    };
    const textOf = (message: ChatMessage) =>
      message.content ||
      (message.blocks ?? []).map((block) => block.text ?? "").join("");

    it("go into the running turn, like VS Code's queued messages", async () => {
      const { fake, call } = await startBridge();
      const release = scriptTurn(fake);
      const first = call("/api/ask-agent/send", { text: "fix the site" });
      await vi.waitFor(async () => {
        const { projectedMessages } = snapshotOf(
          (await call("/api/ask-agent/session")).body,
        ).session.foreground;
        expect(projectedMessages.map(textOf)).toContain("Working");
      });

      const second = call("/api/ask-agent/send", {
        text: "use the blue logo",
        id: "queued-1",
      });
      await vi.waitFor(() =>
        expect(fake.interjections).toEqual([
          expect.objectContaining({
            id: "queued-1",
            text: "use the blue logo",
          }),
        ]),
      );
      release();
      const [, answered] = await Promise.all([first, second]);

      expect(answered.status).toBe(200);
      // One turn: the message was answered inside it, not as a turn of its own.
      expect(fake.operations.startTurn).toHaveBeenCalledTimes(1);
      const messages = snapshotOf((await call("/api/ask-agent/session")).body)
        .session.foreground.projectedMessages;
      expect(
        messages.map((message) => [message.role, textOf(message)]),
      ).toEqual([
        ["user", "fix the site"],
        ["assistant", "Working"],
        ["user", "use the blue logo"],
        ["assistant", "Got it"],
      ]);
    });

    it("run as the next turn when the running turn cannot take them", async () => {
      const { fake, call } = await startBridge();
      fake.acceptInterjections(false);
      const release = scriptTurn(fake);
      const first = call("/api/ask-agent/send", { text: "fix the site" });
      await vi.waitFor(() =>
        expect(fake.operations.startTurn).toHaveBeenCalledTimes(1),
      );
      const second = call("/api/ask-agent/send", { text: "and the footer" });
      await vi.waitFor(() =>
        expect(fake.operations.interject).toHaveBeenCalledTimes(1),
      );
      release();
      await Promise.all([first, second]);
      expect(fake.operations.startTurn).toHaveBeenCalledTimes(2);
      expect(fake.operations.startTurn.mock.calls[1]?.[3]).toBe(
        "and the footer",
      );
    });
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

  it("shows the open chat's background agents, their approvals and transcripts", async () => {
    const { fake, call } = await startBridge(undefined, {
      agentRefreshMs: 20,
    });
    const child = (
      patch: Partial<WorkspaceBackgroundRecord> = {},
    ): WorkspaceBackgroundRecord =>
      ({
        schemaVersion: 1,
        childSessionId: "child-1",
        parentSessionId: "ws-1",
        parentTurnId: "turn-1",
        rootSessionId: "ws-1",
        projectId: "home",
        depth: 1,
        task: "Review the change",
        scopes: [],
        model: REVIEW,
        lifecycle: "running",
        phase: "responding",
        resultState: "running",
        createdAt: 10,
        updatedAt: 20,
        startedAt: 11,
        partialOutput: "Looking at notes.md",
        steeringQueued: 0,
        ...patch,
      }) as WorkspaceBackgroundRecord;
    fake.setScript((sessionId, taskId) => {
      // The turn starts a child, which outlives it.
      fake.agents.set(sessionId, [child()]);
      fake.publish(sessionId, {
        kind: "agent",
        state: "updated",
        childSessionId: "child-1",
        lifecycle: "running",
        phase: "responding",
      });
      fake.turn(sessionId, {
        type: "turn.completed",
        result: { text: "Started a review" },
      });
      fake.publish(sessionId, {
        kind: "task",
        state: "finished",
        taskId,
        status: "completed",
      });
    });
    await call("/api/ask-agent/send", { text: "get a review" });

    const card = await vi.waitFor(async () => {
      const { body } = await call("/api/ask-agent/session");
      const background = (body.snapshot as { background: unknown[] })
        .background;
      expect(background).toHaveLength(1);
      return background[0];
    });
    expect(card).toMatchObject({
      id: "child-1",
      task: "Review the change",
      status: "streaming",
      resolvedModel: "claude-review",
      streamingText: "Looking at notes.md",
      canKill: true,
    });
    // The chat reports as running while its agent works.
    const listed = await call("/api/ask-agent/sessions");
    expect(
      (listed.body.sessions as Array<{ activity?: string }>)[0]?.activity,
    ).toBe("running");

    // A child waiting for the owner gets the normal approval card,
    // attributed to the agent; the decision goes to that child.
    fake.agents.set("ws-1", [
      child({
        lifecycle: "awaiting_approval",
        approval: {
          interactionId: "int-7",
          source: "durable_interaction",
          toolName: "execute_command",
          summary: "Run npm test",
          createdAt: 30,
        },
      }),
    ]);
    const approval = await vi.waitFor(async () => {
      const { body } = await call("/api/ask-agent/session");
      const pending = (
        body.snapshot as {
          ui: { approval: { id: string; backgroundTask?: string } | null };
        }
      ).ui.approval;
      expect(pending?.id).toBe("agent-approval:child-1:int-7");
      return pending!;
    });
    expect(approval.backgroundTask).toBe("Review the change");
    const answered = await call("/api/ask-agent/approval", {
      id: approval.id,
      decision: "accept",
    });
    expect(answered.status).toBe(200);
    expect(fake.operations.answerAgentApproval).toHaveBeenCalledWith(
      expect.anything(),
      "home",
      "ws-1",
      "child-1",
      { interactionId: "int-7", decision: "allow" },
    );
    expect(snapshotOf(answered.body).ui.approval).toBeNull();

    const transcript = await call("/api/ask-agent/background/transcript", {
      sessionId: "child-1",
    });
    expect(transcript.body).toEqual({
      ok: true,
      transcript: {
        sessionId: "child-1",
        task: "Review the change",
        messages: [{ role: "assistant", content: "child says hi" }],
      },
    });
    expect(
      (
        await call("/api/ask-agent/background/steer", {
          sessionId: "child-1",
          message: "wrap up",
        })
      ).status,
    ).toBe(200);
    expect(fake.operations.steerAgent).toHaveBeenCalledWith(
      expect.anything(),
      "home",
      "ws-1",
      "child-1",
      "wrap up",
    );
    await call("/api/ask-agent/background/stop", { sessionId: "child-1" });
    const stopped = await call("/api/ask-agent/session");
    expect(
      (stopped.body.snapshot as { background: Array<{ status: string }> })
        .background[0]?.status,
    ).toBe("cancelled");

    // Only the open chat's agents are reachable.
    expect(
      (
        await call("/api/ask-agent/background/transcript", {
          sessionId: "someone-else",
        })
      ).status,
    ).toBe(404);
    await call("/api/ask-agent/session/new", {});
    const fresh = await call("/api/ask-agent/session");
    expect(
      (fresh.body.snapshot as { background: unknown[] }).background,
    ).toEqual([]);
  });

  describe("finished background agents", () => {
    const child = (
      patch: Partial<WorkspaceBackgroundRecord> = {},
    ): WorkspaceBackgroundRecord =>
      ({
        schemaVersion: 1,
        childSessionId: "child-1",
        parentSessionId: "ws-1",
        parentTurnId: "turn-1",
        rootSessionId: "ws-1",
        projectId: "home",
        depth: 1,
        task: "List the files",
        scopes: [],
        lifecycle: "running",
        phase: "responding",
        resultState: "running",
        createdAt: 10,
        updatedAt: 20,
        steeringQueued: 0,
        ...patch,
      }) as WorkspaceBackgroundRecord;
    const done = child({
      lifecycle: "completed",
      phase: "completed",
      resultState: "completed",
      resultText: "AGENTS.md, notes.md",
    });
    const agentChanged = (
      fake: Awaited<ReturnType<typeof startBridge>>["fake"],
    ) =>
      fake.publish("ws-1", {
        kind: "agent",
        state: "updated",
        childSessionId: "child-1",
        lifecycle: "completed",
        phase: "completed",
      });
    const turnText = (
      fake: Awaited<ReturnType<typeof startBridge>>["fake"],
      index: number,
    ) =>
      (fake.operations.startTurn.mock.calls[index] as unknown[])[3] as string;
    const reply = (
      fake: Awaited<ReturnType<typeof startBridge>>["fake"],
      text: string,
      before?: (sessionId: string) => void,
    ) =>
      fake.setScript((sessionId, taskId) => {
        before?.(sessionId);
        fake.turn(sessionId, { type: "text.delta", text });
        fake.turn(sessionId, { type: "turn.completed", result: { text } });
        fake.publish(sessionId, {
          kind: "task",
          state: "finished",
          taskId,
          status: "completed",
        });
      });

    it("wakes the chat once with the result card when an agent finishes", async () => {
      const { fake, call } = await startBridge();
      reply(fake, "Started it", (sessionId) =>
        fake.agents.set(sessionId, [child()]),
      );
      await call("/api/ask-agent/send", {
        text: "list files in the background",
      });

      reply(fake, "It found two files.");
      fake.agents.set("ws-1", [done]);
      agentChanged(fake);
      await vi.waitFor(() =>
        expect(fake.operations.startTurn).toHaveBeenCalledTimes(2),
      );
      expect(parseAgentResultPrompt(turnText(fake, 1))).toMatchObject([
        { childSessionId: "child-1", resultText: "AGENTS.md, notes.md" },
      ]);
      const messages = await vi.waitFor(async () => {
        const snapshot = snapshotOf(
          (await call("/api/ask-agent/session")).body,
        );
        const projected = snapshot.session.foreground.projectedMessages;
        expect(projected.at(-1)?.content).toBe("It found two files.");
        return projected;
      });
      // The result shows as a card, never as something the owner typed.
      expect(messages.filter((message) => message.role === "user")).toEqual([
        expect.objectContaining({ content: "list files in the background" }),
      ]);
      expect(JSON.stringify(messages)).toContain("bg_agent_result");

      // Later updates do not report it again.
      agentChanged(fake);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fake.operations.startTurn).toHaveBeenCalledTimes(2);
    });

    it("does not wake the chat for a result its turn already collected", async () => {
      const { fake, call } = await startBridge();
      reply(fake, "Both files are listed", (sessionId) => {
        fake.agents.set(sessionId, [done]);
        fake.turn(sessionId, {
          type: "tool.completed",
          toolCallId: "call-1",
          toolName: "get_background_result",
          displayContent: { status: "completed", record: done },
        });
      });
      await call("/api/ask-agent/send", { text: "list files and wait" });
      agentChanged(fake);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fake.operations.startTurn).toHaveBeenCalledTimes(1);
    });

    it("does not wake a chat the owner stopped", async () => {
      const { fake, call } = await startBridge();
      reply(fake, "Started it", (sessionId) =>
        fake.agents.set(sessionId, [child()]),
      );
      await call("/api/ask-agent/send", {
        text: "list files in the background",
      });
      await call("/api/ask-agent/stop", {});
      fake.agents.set("ws-1", [done]);
      agentChanged(fake);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fake.operations.startTurn).toHaveBeenCalledTimes(1);
    });

    it("delivers a coding task's outcome into its chat as a notice and a turn", async () => {
      const { fake, call, bridge, detached } = await startBridge();
      reply(fake, "On it");
      await call("/api/ask-agent/send", { text: "fix the site" });

      reply(fake, "The pull request is ready to review.");
      await expect(
        bridge.deliverTaskResult(detached, "ws-1", codingTask()),
      ).resolves.toBe("delivered");
      expect(fake.operations.startTurn).toHaveBeenCalledTimes(2);
      expect(parseTaskResultPrompt(turnText(fake, 1))).toMatchObject({
        taskId: "aaaaaaaaaaaa",
        state: "published",
        pullRequest: "https://github.com/reefbarman/site/pull/7",
      });
      const messages = await vi.waitFor(async () => {
        const projected = snapshotOf(
          (await call("/api/ask-agent/session")).body,
        ).session.foreground.projectedMessages;
        expect(projected.at(-1)?.content).toBe(
          "The pull request is ready to review.",
        );
        return projected;
      });
      // A notice from the task, never something the owner typed.
      expect(messages.filter((message) => message.role === "user")).toEqual([
        expect.objectContaining({ content: "fix the site" }),
      ]);
      expect(JSON.stringify(messages)).toContain("Coding task");
      expect(JSON.stringify(messages)).not.toContain("coding_task_result");
    });

    it("shows the open chat's coding tasks as live cards", async () => {
      let state: TaskState = "implementing";
      const chatTasks = vi.fn((sessionId: string) =>
        sessionId === "ws-1"
          ? [
              {
                id: "aaaaaaaaaaaa",
                state,
                objective: "Update the AgentLink page",
                repository: "https://github.com/reefbarman/site",
                updatedAt: 2,
              },
            ]
          : [],
      );
      const { fake, call, bridge } = await startBridge(undefined, {
        chatTasks,
      });
      const tasksOf = async () =>
        (
          (await call("/api/ask-agent/session")).body.snapshot as {
            tasks: Array<{ id: string; state: string }>;
          }
        ).tasks;
      // No chat yet, so nothing to show.
      expect(await tasksOf()).toEqual([]);
      reply(fake, "Started it");
      await call("/api/ask-agent/send", { text: "fix the site" });
      expect(await tasksOf()).toEqual([
        expect.objectContaining({ id: "aaaaaaaaaaaa", state: "implementing" }),
      ]);
      // Read fresh on every snapshot, so it follows the Tasks panel.
      state = "published";
      bridge.refresh();
      expect(await tasksOf()).toEqual([
        expect.objectContaining({ state: "published" }),
      ]);
      await call("/api/ask-agent/session/new", {});
      expect(await tasksOf()).toEqual([]);
    });

    it("shows a task's chat in the chat list, live, and hands it messages", async () => {
      const linkedMessage = vi.fn(async () => undefined);
      const { fake, call, bridge, detached } = await startBridge(undefined, {
        linkedMessage,
      });
      fake.sessions.set("ws-task", {
        projectId: "task-aaaaaaaaaaaa",
        model: MODEL,
        messages: [
          { role: "user", content: "Update the page" },
          { role: "assistant", content: [{ type: "text", text: "Done." }] },
        ],
      });
      const list = async () =>
        (await call("/api/ask-agent/sessions")).body.sessions as Array<{
          id: string;
          title: string;
          kind: string;
        }>;
      // Another project's chat: not listed until linked.
      expect(await list()).toEqual([]);
      await bridge.linkSession(detached, "ws-task", {
        projectId: "task-aaaaaaaaaaaa",
        title: "Task: Update the page",
      });
      expect(await list()).toEqual([
        expect.objectContaining({
          id: "ws-task",
          kind: "task",
          title: "Task: Update the page",
        }),
      ]);
      expect(fake.operations.readSession).toHaveBeenCalledWith(
        expect.anything(),
        "task-aaaaaaaaaaaa",
        "ws-task",
      );

      // While the task works, its chat streams below its history.
      bridge.followSession(detached, "ws-task", {
        title: "Task: Update the page",
        prompt: "Update the page",
      });
      await call("/api/ask-agent/session/load", { sessionId: "ws-task" });
      await vi.waitFor(async () => {
        fake.publishTo("task-aaaaaaaaaaaa", "ws-task", {
          type: "text.delta",
          text: "Working",
        });
        const messages = snapshotOf((await call("/api/ask-agent/session")).body)
          .session.foreground.projectedMessages;
        // History keeps its text in blocks; live messages in content.
        const text = (message: (typeof messages)[number]) =>
          message.content ||
          (message.blocks ?? []).map((block) => block.text ?? "").join("");
        expect(messages.map(text)).toEqual([
          "Update the page",
          "Done.",
          expect.stringContaining("Working"),
        ]);
      });

      // Writing to it while it works goes into its running turn, not a
      // turn of its own here.
      const sent = await call("/api/ask-agent/send", {
        text: "Use the blue logo",
        sessionId: "ws-task",
        id: "steer-1",
      });
      expect(sent.status).toBe(200);
      expect(fake.operations.interject).toHaveBeenCalledWith(
        expect.anything(),
        "task-aaaaaaaaaaaa",
        "ws-task",
        { id: "steer-1", text: "Use the blue logo" },
      );
      expect(linkedMessage).not.toHaveBeenCalled();
      expect(fake.operations.startTurn).not.toHaveBeenCalled();
      expect(
        snapshotOf(sent.body).session.foreground.projectedMessages.at(-1),
      ).toMatchObject({ role: "user", content: "Use the blue logo" });

      // Taken in: shown once, and the reply goes on below it.
      fake.publishTo("task-aaaaaaaaaaaa", "ws-task", {
        type: "user.interjected",
        interjectionId: "steer-1",
        text: "Use the blue logo",
      });
      fake.publishTo("task-aaaaaaaaaaaa", "ws-task", {
        type: "text.delta",
        text: "Switching",
      });
      await vi.waitFor(async () => {
        const messages = snapshotOf(
          (await call("/api/ask-agent/session")).body,
        ).session.foreground.projectedMessages.map(
          (message) =>
            message.content ||
            (message.blocks ?? []).map((block) => block.text ?? "").join(""),
        );
        expect(messages.slice(-2)).toEqual(["Use the blue logo", "Switching"]);
        expect(
          messages.filter((message) => message === "Use the blue logo"),
        ).toHaveLength(1);
      });

      // One its turn ended without taking goes to the task's runner.
      await call("/api/ask-agent/send", {
        text: "And the footer",
        sessionId: "ws-task",
        id: "steer-2",
      });
      fake.publishEventTo("task-aaaaaaaaaaaa", "ws-task", {
        kind: "task",
        state: "finished",
        taskId: "t-1",
        status: "completed",
      });
      await vi.waitFor(() =>
        expect(linkedMessage).toHaveBeenCalledWith("ws-task", "And the footer"),
      );

      // Not working: its runner gets the message straight away.
      await bridge.adoptSession(detached, "ws-task", "Task: Update the page");
      fake.operations.interject.mockClear();
      await call("/api/ask-agent/send", {
        text: "Thanks",
        sessionId: "ws-task",
      });
      expect(fake.operations.interject).not.toHaveBeenCalled();
      expect(linkedMessage).toHaveBeenLastCalledWith("ws-task", "Thanks");

      // A deleted task's chat goes away.
      await bridge.unlinkSession("ws-task");
      expect(await list()).toEqual([]);
    });

    it("skips a chat that is gone or was deleted", async () => {
      const { fake, call, bridge, detached } = await startBridge();
      reply(fake, "On it");
      await call("/api/ask-agent/send", { text: "fix the site" });
      await expect(
        bridge.deliverTaskResult(detached, "ws-unknown", codingTask()),
      ).resolves.toBe("chat_missing");

      const first = snapshotOf((await call("/api/ask-agent/session")).body)
        .session.foreground.sessionId;
      await call("/api/ask-agent/session/new", {});
      await expect(
        call("/api/ask-agent/session/delete", { sessionId: first }),
      ).resolves.toMatchObject({ status: 200 });
      await expect(
        bridge.deliverTaskResult(detached, "ws-1", codingTask()),
      ).resolves.toBe("chat_missing");
      expect(fake.operations.startTurn).toHaveBeenCalledTimes(1);
    });
  });

  it("lets the owner choose whether a chat asks before each change", async () => {
    const { fake, call } = await startBridge();
    const modeOf = (body: Record<string, unknown>) =>
      (body.snapshot as { approvalMode?: string }).approvalMode;
    expect(modeOf((await call("/api/ask-agent/session")).body)).toBe(
      "autonomous",
    );
    // Before the first message there is no session yet: the choice waits.
    const early = await call("/api/ask-agent/approval-mode", { mode: "ask" });
    expect(modeOf(early.body)).toBe("ask");
    expect(fake.operations.setApprovalMode).not.toHaveBeenCalled();

    fake.setScript((sessionId, taskId) => {
      fake.turn(sessionId, { type: "turn.completed", result: { text: "ok" } });
      fake.publish(sessionId, {
        kind: "task",
        state: "finished",
        taskId,
        status: "completed",
      });
    });
    await call("/api/ask-agent/send", { text: "hello" });
    expect(fake.operations.setApprovalMode).toHaveBeenCalledWith(
      expect.anything(),
      "home",
      "ws-1",
      "ask",
    );
    expect(modeOf((await call("/api/ask-agent/session")).body)).toBe("ask");

    const back = await call("/api/ask-agent/approval-mode", {
      mode: "autonomous",
    });
    expect(modeOf(back.body)).toBe("autonomous");
    expect(fake.operations.setApprovalMode).toHaveBeenLastCalledWith(
      expect.anything(),
      "home",
      "ws-1",
      "autonomous",
    );
    expect(
      (await call("/api/ask-agent/approval-mode", { mode: "sometimes" }))
        .status,
    ).toBe(400);
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

  it("shows a proposed job change in full on its approval card", async () => {
    const { fake, call } = await startBridge();
    const text = [
      "Create a scheduled job:",
      "",
      "Name: Morning brief",
      "Schedule: every weekday at 07:30 (Australia/Sydney)",
      "Prompt for each run:",
      "Brief me.",
    ].join("\n");
    fake.setScript((sessionId) => {
      fake.turn(sessionId, {
        type: "interaction.required",
        interaction: {
          interactionId: "int-job",
          toolName: "schedule_job",
          summary: 'Schedule "Morning brief": every weekday at 07:30?',
          displayContent: {
            kind: "assistant_job_change",
            action: "create",
            jobName: "Morning brief",
            text,
          },
        },
        interactionRevision: "rev-job",
      });
    });
    // Never answered here: the turn stays paused until the bridge closes.
    void call("/api/ask-agent/send", { text: "brief me every weekday" }).catch(
      () => undefined,
    );
    const approval = await vi.waitFor(async () => {
      const { body } = await call("/api/ask-agent/session");
      const pending = snapshotOf(body).ui.approval;
      expect(pending).not.toBeNull();
      return pending!;
    });
    expect(approval).toMatchObject({
      id: "int-job",
      filePath: 'Schedule "Morning brief": every weekday at 07:30?',
      writeOperation: "create",
      detail: text,
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

  it("starts a new chat while another waits for an approval, whose card stays in its own chat", async () => {
    const { fake, call } = await startBridge();
    const activityOf = async () => {
      const { body } = await call("/api/ask-agent/sessions");
      return Object.fromEntries(
        (body.sessions as Array<{ id: string; activity?: string }>).map(
          (session) => [session.id, session.activity],
        ),
      );
    };
    // The first chat's turn asks for an approval; every other turn (and
    // its resume) just answers.
    let asking: string | undefined;
    fake.setScript((sessionId, taskId) => {
      if (!asking) {
        asking = sessionId;
        fake.turn(sessionId, {
          type: "interaction.required",
          interaction: {
            interactionId: "int-1",
            toolName: "schedule_job",
            summary: 'Schedule "Gate canary"?',
            displayInput: {},
          },
          interactionRevision: "rev-1",
        });
        fake.publish(sessionId, {
          kind: "task",
          state: "finished",
          taskId,
          status: "suspended",
        });
        return;
      }
      const text = sessionId === asking ? "Scheduled." : "Hello there.";
      fake.turn(sessionId, { type: "text.delta", text });
      fake.turn(sessionId, { type: "turn.completed", result: { text } });
      fake.publish(sessionId, {
        kind: "task",
        state: "finished",
        taskId,
        status: "completed",
      });
    });
    const first = snapshotOf(
      await call("/api/ask-agent/session").then((r) => r.body),
    ).session.foreground.sessionId;
    const waiting = call("/api/ask-agent/send", { text: "schedule a canary" });
    await vi.waitFor(async () => {
      const { body } = await call("/api/ask-agent/session");
      expect(snapshotOf(body).ui.approval).toMatchObject({ id: "int-1" });
    });

    // A new chat does not show the other chat's card.
    const created = await call("/api/ask-agent/session/new", {});
    const second = snapshotOf(created.body).session.foreground.sessionId;
    expect(snapshotOf(created.body).ui.approval).toBeNull();

    // Its message runs as its own turn straight away, never offered to the
    // waiting chat.
    const answered = await call("/api/ask-agent/send", {
      sessionId: second,
      text: "say hello",
    });
    expect(answered.status).toBe(200);
    expect(
      snapshotOf(answered.body).session.foreground.projectedMessages.at(-1),
    ).toMatchObject({ role: "assistant", content: "Hello there." });
    expect(snapshotOf(answered.body).ui.approval).toBeNull();
    expect(fake.interjections).toEqual([]);
    await expect(waiting).resolves.toMatchObject({ status: 200 });
    expect(await activityOf()).toMatchObject({ [first]: "needs-you" });

    // The waiting chat still shows its card, and answering it there
    // finishes its turn in that chat.
    const back = await call("/api/ask-agent/session/load", {
      sessionId: first,
    });
    const card = snapshotOf(back.body).ui.approval;
    expect(card?.id).toBe(`run:${asking}:int-1`);
    await expect(
      call("/api/ask-agent/approval", { id: card!.id, decision: "accept" }),
    ).resolves.toMatchObject({ status: 200 });
    expect(fake.operations.answerInteraction).toHaveBeenCalledWith(
      expect.anything(),
      "home",
      asking,
      {
        interactionId: "int-1",
        interactionRevision: "rev-1",
        decision: "allow",
      },
    );
    await vi.waitFor(async () => {
      const { body } = await call("/api/ask-agent/session");
      const snapshot = snapshotOf(body);
      expect(snapshot.ui.approval).toBeNull();
      expect(
        snapshot.session.foreground.projectedMessages.at(-1),
      ).toMatchObject({ role: "assistant", content: "Scheduled." });
    });
    expect((await activityOf())[first]).toBeUndefined();
  });

  it("removes or edits a queued message before it runs", async () => {
    const { fake, call } = await startBridge();
    // A turn that runs until the test finishes it; later turns answer.
    let running: { sessionId: string; taskId: string } | undefined;
    fake.setScript((sessionId, taskId) => {
      if (!running) {
        running = { sessionId, taskId };
        fake.turn(sessionId, { type: "text.delta", text: "working" });
        return;
      }
      fake.turn(sessionId, { type: "turn.completed", result: { text: "ok" } });
      fake.publish(sessionId, {
        kind: "task",
        state: "finished",
        taskId,
        status: "completed",
      });
    });
    const queueOf = async () => {
      const { body } = await call("/api/ask-agent/session");
      const foreground = (
        body.snapshot as {
          session: { foreground: { messageQueue?: Array<{ id: string }> } };
        }
      ).session.foreground;
      return (foreground.messageQueue ?? []).map((queued) => queued.id);
    };
    const longJob = call("/api/ask-agent/send", { text: "long job" });
    await vi.waitFor(() => expect(running).toBeDefined());

    // Queued while it works, and offered to that turn.
    const removed = call("/api/ask-agent/send", {
      id: "queued-1",
      text: "also do this",
    });
    await vi.waitFor(() =>
      expect(fake.interjections.map((item) => item.id)).toEqual(["queued-1"]),
    );
    expect(await queueOf()).toEqual(["queued-1"]);
    // Remove: taken back from the turn, out of the queue.
    await expect(
      call("/api/ask-agent/queue", { action: "remove", id: "queued-1" }),
    ).resolves.toMatchObject({ status: 200 });
    expect(fake.interjections).toEqual([]);
    expect(await queueOf()).toEqual([]);
    await expect(
      call("/api/ask-agent/queue", { action: "remove", id: "queued-1" }),
    ).resolves.toMatchObject({ status: 404 });

    // Edit: the turn gets the new text; a message it already took cannot
    // change.
    const edited = call("/api/ask-agent/send", {
      id: "queued-2",
      text: "draft wording",
    });
    await vi.waitFor(() =>
      expect(fake.interjections.map((item) => item.id)).toEqual(["queued-2"]),
    );
    await expect(
      call("/api/ask-agent/queue", {
        action: "update",
        id: "queued-2",
        text: "final wording",
      }),
    ).resolves.toMatchObject({ status: 200 });
    await vi.waitFor(() =>
      expect(fake.interjections).toEqual([
        expect.objectContaining({ id: "queued-2", text: "final wording" }),
      ]),
    );
    fake.interjections.splice(0);
    await expect(
      call("/api/ask-agent/queue", { action: "remove", id: "queued-2" }),
    ).resolves.toMatchObject({ status: 409 });

    // The long job ends without taking either message.
    fake.turn(running!.sessionId, {
      type: "turn.completed",
      result: { text: "done" },
    });
    fake.publish(running!.sessionId, {
      kind: "task",
      state: "finished",
      taskId: running!.taskId,
      status: "completed",
    });
    await expect(longJob).resolves.toMatchObject({ status: 200 });
    await expect(removed).resolves.toMatchObject({ status: 200 });
    await expect(edited).resolves.toMatchObject({ status: 200 });
    // The removed message never ran; the edited one ran with its new text.
    expect(fake.operations.startTurn.mock.calls.map((args) => args[3])).toEqual(
      ["long job", "final wording"],
    );
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
    // Deleted for good, and nothing about it stays in the bridge's file.
    expect(fake.operations.deleteSession).toHaveBeenCalledWith(
      expect.anything(),
      "home",
      "ws-1",
    );
    expect(fake.sessions.has("ws-1")).toBe(false);
    const saved = JSON.parse(await fs.readFile(file, "utf8"));
    expect(saved.titles).toEqual({});
    expect(saved.hidden).toEqual([]);
    expect(JSON.stringify(saved)).not.toContain("ws-1");
  });

  it("keeps a chat whose deletion is refused, and reports deletions", async () => {
    const chatDeleted = vi.fn(async () => undefined);
    const { fake, call } = await startBridge(undefined, { chatDeleted });
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
    const [session] = (await call("/api/ask-agent/sessions")).body
      .sessions as Array<{ id: string }>;
    fake.operations.deleteSession.mockRejectedValueOnce(
      new HttpError(409, "session_agent_running"),
    );
    await expect(
      call("/api/ask-agent/session/delete", { sessionId: session!.id }),
    ).resolves.toMatchObject({
      status: 409,
      body: { error: "session_agent_running" },
    });
    expect(fake.sessions.has("ws-1")).toBe(true);
    expect(chatDeleted).not.toHaveBeenCalled();
    const listed = (await call("/api/ask-agent/sessions")).body
      .sessions as Array<{ id: string }>;
    expect(listed).toHaveLength(1);

    await expect(
      call("/api/ask-agent/session/delete", { sessionId: session!.id }),
    ).resolves.toMatchObject({ status: 200 });
    expect(chatDeleted).toHaveBeenCalledWith("ws-1");
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

  it("restores durable sessions on first use and deletes hidden ones", async () => {
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
    // Hidden by an older server's delete: now deleted for good.
    expect(second.fake.sessions.has("ws-hidden")).toBe(false);
    const saved = JSON.parse(await fs.readFile(first.file, "utf8"));
    expect(saved.hidden).toEqual([]);
    const loaded = await second.call("/api/ask-agent/session/load", {
      sessionId: "ws-old",
    });
    expect(snapshotOf(loaded.body).session.foreground.model).toBe(
      "claude/claude-review",
    );
  });

  it("shows a finished scheduled run's chat, titled and unread", async () => {
    const { bridge, fake, call, file } = await startBridge();
    const jobAuth: AssistantServerAuth = {
      principal: { tenantId: "agentlink-server", subjectId: "owner" },
      session: {
        ownerId: "owner",
        sessionId: "job-run-1",
        deviceId: "job-1",
        deviceLabel: "Job: Brief",
        createdAt: 0,
        expiresAt: Number.MAX_SAFE_INTEGER,
      },
      signal: new AbortController().signal,
      revalidate: async () => ({ valid: true }),
      detach: () => jobAuth,
    };
    // Chats are loaded already when the run finishes.
    await call("/api/ask-agent/sessions");
    fake.sessions.set("ws-run", {
      model: MODEL,
      messages: [
        { role: "user", content: "Brief me" },
        { role: "assistant", content: [{ type: "text", text: "All quiet" }] },
      ],
    });
    await bridge.adoptSession(jobAuth, "ws-run", "Brief · 12 Oct, 07:30");
    const listed = await call("/api/ask-agent/sessions");
    expect(listed.body.sessions).toEqual([
      expect.objectContaining({
        id: "ws-run",
        title: "Brief · 12 Oct, 07:30",
        activity: "unread",
        scheduled: true,
      }),
    ]);
    // Twice is harmless; the title and unread flag are kept for restarts.
    await bridge.adoptSession(jobAuth, "ws-run", "Brief · 12 Oct, 07:30");
    expect(
      ((await call("/api/ask-agent/sessions")).body.sessions as unknown[])
        .length,
    ).toBe(1);
    const saved = JSON.parse(await fs.readFile(file, "utf8")) as {
      titles: Record<string, string>;
      unread: string[];
    };
    expect(saved.titles["ws-run"]).toBe("Brief · 12 Oct, 07:30");
    expect(saved.unread).toContain("ws-run");
  });

  it("follows a scheduled run's chat live and answers its approval", async () => {
    const { bridge, fake, call } = await startBridge();
    const jobAuth: AssistantServerAuth = {
      principal: { tenantId: "agentlink-server", subjectId: "owner" },
      session: {
        ownerId: "owner",
        sessionId: "job-run-2",
        deviceId: "job-1",
        deviceLabel: "Job: Brief",
        createdAt: 0,
        expiresAt: Number.MAX_SAFE_INTEGER,
      },
      signal: new AbortController().signal,
      revalidate: async () => ({ valid: true }),
      detach: () => jobAuth,
    };
    const listed = async () =>
      (await call("/api/ask-agent/sessions")).body.sessions as Array<{
        id: string;
        title: string;
        activity?: string;
        scheduled?: boolean;
      }>;
    await listed();
    fake.sessions.set("ws-run", { model: MODEL, messages: [] });
    bridge.followSession(jobAuth, "ws-run", {
      title: "Brief · now",
      prompt: "Brief me",
    });
    // Following twice is harmless.
    bridge.followSession(jobAuth, "ws-run", { title: "x", prompt: "x" });
    fake.turn("ws-run", { type: "text.delta", text: "Checking" });
    fake.turn("ws-run", {
      type: "tool.requested",
      toolCallId: "call-1",
      toolName: "write_file",
      displayInput: { path: "a.txt" },
    });
    expect(await listed()).toEqual([
      expect.objectContaining({
        id: "ws-run",
        title: "Brief · now",
        activity: "running",
        scheduled: true,
      }),
    ]);
    expect(bridge.activity()).toEqual({ running: 1, needsYou: 0, unread: 0 });

    // Opening it shows the run so far; writing to it waits for the run.
    const opened = await call("/api/ask-agent/session/load", {
      sessionId: "ws-run",
    });
    expect(
      snapshotOf(opened.body).session.foreground.projectedMessages.map(
        (message) => [message.role, message.content],
      ),
    ).toEqual([
      ["user", "Brief me"],
      ["assistant", "Checking"],
    ]);
    await expect(
      call("/api/ask-agent/send", { text: "hello?" }),
    ).resolves.toMatchObject({ status: 409 });
    await expect(
      call("/api/ask-agent/session/delete", { sessionId: "ws-run" }),
    ).resolves.toMatchObject({ status: 409 });

    // The run waits for an approval: shown in its chat, answered from it.
    fake.turn("ws-run", {
      type: "interaction.required",
      interaction: {
        interactionId: "int-r",
        toolName: "write_file",
        summary: "Write a.txt",
        displayInput: { path: "a.txt" },
      },
      interactionRevision: "rev-r",
    });
    const approval = await vi.waitFor(async () => {
      const pending = snapshotOf((await call("/api/ask-agent/session")).body).ui
        .approval;
      expect(pending).not.toBeNull();
      return pending!;
    });
    expect(approval.id).toBe("run:ws-run:int-r");
    expect((await listed())[0]?.activity).toBe("needs-you");
    await expect(
      call("/api/ask-agent/approval", {
        id: "run:ws-run:other",
        decision: "accept",
      }),
    ).resolves.toMatchObject({ status: 404 });
    const answered = await call("/api/ask-agent/approval", {
      id: approval.id,
      decision: "accept",
    });
    expect(answered.status).toBe(200);
    expect(snapshotOf(answered.body).ui.approval).toBeNull();
    expect(fake.operations.answerInteraction).toHaveBeenCalledWith(
      expect.anything(),
      "home",
      "ws-run",
      {
        interactionId: "int-r",
        interactionRevision: "rev-r",
        decision: "allow",
      },
    );

    // Stop while viewing it stops the run's turn.
    await expect(call("/api/ask-agent/stop", {})).resolves.toMatchObject({
      body: { ok: true, stopped: true },
    });
    expect(fake.operations.cancel).toHaveBeenCalledWith(
      expect.anything(),
      "home",
      "ws-run",
    );

    // Finished: the run's own record replaces the live view.
    fake.sessions.get("ws-run")!.messages = [
      { role: "user", content: "Brief me" },
      { role: "assistant", content: [{ type: "text", text: "All done" }] },
    ];
    await bridge.adoptSession(jobAuth, "ws-run", "Brief · now");
    expect(await listed()).toEqual([
      expect.objectContaining({ id: "ws-run", scheduled: true }),
    ]);
    expect((await listed())[0]?.activity).not.toBe("running");
    const done = snapshotOf((await call("/api/ask-agent/session")).body);
    const last = done.session.foreground.projectedMessages.at(-1);
    expect(last?.role).toBe("assistant");
    // The streamed "Checking" is replaced by the recorded reply.
    expect(JSON.stringify(last)).toContain("All done");
    expect(JSON.stringify(done.session.foreground)).not.toContain("Checking");
  });

  it("carries the Assistant's inbox status in every snapshot", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ask-agent-status-"));
    cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
    const events = new SessionEventHub();
    const fake = createFakeOperations(events);
    let status = { inboxUnread: 2, revision: 5 };
    const bridge = await createAskAgentBridge({
      projectId: "home",
      operations: fake.operations,
      events,
      models: { available: [MODEL], defaultModel: MODEL },
      stateFile: path.join(dir, "state.json"),
      assistantStatus: () => status,
    });
    cleanup.push(() => bridge.close());
    const server = http.createServer((request, response) => {
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
        signal: new AbortController().signal,
        revalidate: async () => ({ valid: true }),
        detach: () => auth,
      };
      void bridge.handleRequest(request, response, auth);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    cleanup.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const port = (server.address() as { port: number }).port;
    const read = async () =>
      (
        (await (
          await fetch(`http://127.0.0.1:${port}/api/ask-agent/session`)
        ).json()) as { snapshot: { assistant?: unknown } }
      ).snapshot.assistant;
    expect(await read()).toEqual({ inboxUnread: 2, revision: 5 });
    status = { inboxUnread: 0, revision: 6 };
    expect(await read()).toEqual({ inboxUnread: 0, revision: 6 });
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
      body: { commands: [{ name: "fleet", builtin: true }] },
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
