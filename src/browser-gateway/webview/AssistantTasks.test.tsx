// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type ChatTaskCard,
  ChatTaskStrip,
  OPEN_TASK_EVENT,
  type Task,
  type TaskDetail,
  TasksPanel,
  taskStateLabel,
  notPublishedReason,
  publishAction,
  shortRepository,
  taskName,
} from "./AssistantTasks";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Route = (body: unknown) => unknown;

/** A fetch stub answering `METHOD path` routes; records every call. */
function stubFetch(routes: Record<string, Route>) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url, body });
    const route = routes[`${method} ${url}`];
    if (!route) {
      return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
      });
    }
    return new Response(JSON.stringify(route(body)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

const REVIEW = {
  commit: "abc1234def",
  at: 1,
  model: "codex/gpt-5",
  sessionId: "review-1",
  verdict: "approve" as const,
  findings: [
    {
      severity: "suggestion" as const,
      file: "README.md",
      line: 3,
      reason: "Wording could be tighter",
    },
  ],
};

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    projectId: "task-t1",
    repository: "https://github.com/reefbarman/demo",
    objective: "Fix the README\n\nMore detail here.",
    branch: "agentlink/fix-readme",
    state: "ready",
    headCommit: "abc1234def",
    commits: ["abc1234def"],
    sessionId: "impl-1",
    summary: "Tightened the README.",
    createdAt: 1,
    updatedAt: 2,
    current: {
      implementation: { commit: "abc1234def", at: 1 },
      validation: {
        commit: "abc1234def",
        at: 1,
        passed: true,
        commands: [
          {
            command: "npm test",
            exitCode: 0,
            timedOut: false,
            durationMs: 1_500,
            outputTail: "all good",
          },
        ],
      },
      review: REVIEW,
    },
    ...overrides,
  };
}

function detail(
  value: Task,
  publish: TaskDetail["publish"] = { connectionId: "c1", grantedAt: 1 },
): TaskDetail {
  return {
    task: value,
    events: [{ at: 1, state: "queued" }],
    validation: ["npm test"],
    publish,
  };
}

describe("chat task cards", () => {
  const card = (overrides: Partial<ChatTaskCard> = {}): ChatTaskCard => ({
    id: "t1",
    state: "implementing",
    objective: "Fix the README",
    repository: "https://github.com/reefbarman/demo",
    updatedAt: 2,
    ...overrides,
  });

  it("show nothing for a chat without tasks", () => {
    const { container } = render(<ChatTaskStrip tasks={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("use the Tasks panel's labels and follow each snapshot", () => {
    const { rerender } = render(<ChatTaskStrip tasks={[card()]} />);
    expect(screen.getByText("Fix the README")).toBeTruthy();
    expect(screen.getByText(taskStateLabel("implementing").label)).toBeTruthy();
    expect(screen.getByText("reefbarman/demo", { exact: false })).toBeTruthy();
    expect(screen.queryByText("Pull request")).toBeNull();

    rerender(
      <ChatTaskStrip
        tasks={[
          card({
            state: "published",
            pullRequest: "https://github.com/reefbarman/demo/pull/3",
          }),
        ]}
      />,
    );
    expect(screen.getByText("Draft PR open")).toBeTruthy();
    expect(screen.getByText("Pull request").getAttribute("href")).toBe(
      "https://github.com/reefbarman/demo/pull/3",
    );
  });

  it("open the task in the Tasks panel", () => {
    const opened: string[] = [];
    const listener = (event: Event) =>
      opened.push((event as CustomEvent<string>).detail);
    window.addEventListener(OPEN_TASK_EVENT, listener);
    try {
      render(<ChatTaskStrip tasks={[card()]} />);
      fireEvent.click(screen.getByTitle("Open in Tasks"));
      expect(opened).toEqual(["t1"]);
    } finally {
      window.removeEventListener(OPEN_TASK_EVENT, listener);
    }
  });
});

describe("task helpers", () => {
  it("names tasks and repositories", () => {
    expect(taskName("  \n Fix it \nmore")).toBe("Fix it");
    expect(taskName("")).toBe("Coding task");
    expect(shortRepository("https://github.com/a/b.git")).toBe("a/b");
  });

  it("offers publishing only for ready work with permission", () => {
    expect(publishAction(task(), true)).toEqual({
      label: "Publish draft PR",
      allowUnreviewed: false,
    });
    expect(publishAction(task(), false)).toBeUndefined();
    expect(publishAction(task({ state: "implementing" }), true)).toBe(
      undefined,
    );
    expect(
      publishAction(
        task({
          state: "blocked_review",
          current: { implementation: undefined },
        }),
        true,
      ),
    ).toEqual({ label: "Publish without review", allowUnreviewed: true });
    expect(
      publishAction(task({ state: "published", publishedCommit: "old" }), true),
    ).toEqual({ label: "Update PR", allowUnreviewed: false });
    expect(
      publishAction(
        task({ state: "published", publishedCommit: "abc1234def" }),
        true,
      ),
    ).toBeUndefined();
  });

  it("explains why a ready task did not publish", () => {
    expect(notPublishedReason(task(), false)).toMatch(/no GitHub connection/u);
    expect(
      notPublishedReason(task({ state: "blocked_review", current: {} }), true),
    ).toMatch(/no reviewer/u);
    expect(
      notPublishedReason(
        task({ error: "publish_failed", errorDetail: "422 from GitHub" }),
        true,
      ),
    ).toBe("Publishing failed: 422 from GitHub");
    expect(notPublishedReason(task({ state: "published" }), true)).toBe(
      undefined,
    );
  });
});

describe("TasksPanel", () => {
  it("lists tasks and opens one", async () => {
    stubFetch({
      "GET /api/tasks": () => ({
        tasks: [
          task({ pullRequest: { number: 7, url: "https://github.com/pr/7" } }),
        ],
        enabled: true,
      }),
      "GET /api/tasks/t1": () => detail(task()),
    });
    render(<TasksPanel revision={0} onClose={() => undefined} />);
    expect(await screen.findByText("Fix the README")).toBeTruthy();
    expect(screen.getByText("reefbarman/demo", { exact: false })).toBeTruthy();
    expect(screen.getByText("#7", { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByText("Fix the README"));
    expect(await screen.findByText("npm test")).toBeTruthy();
    expect(screen.getByText("Tightened the README.")).toBeTruthy();
    expect(
      screen.getByText("Wording could be tighter", { exact: false }),
    ).toBeTruthy();
    fireEvent.click(screen.getByText("All tasks"));
    expect(await screen.findByText("Fix the README")).toBeTruthy();
  });

  it("says when tasks are off", async () => {
    stubFetch({ "GET /api/tasks": () => ({ tasks: [], enabled: false }) });
    render(<TasksPanel revision={0} onClose={() => undefined} />);
    expect(await screen.findByText(/need projectsRoot/u)).toBeTruthy();
  });

  it("shows the repositories a task reads", async () => {
    stubFetch({
      "GET /api/tasks/t1": () =>
        detail(
          task({ references: ["https://github.com/reefbarman/agentlink"] }),
        ),
    });
    render(
      <TasksPanel revision={0} onClose={() => undefined} initialTaskId="t1" />,
    );
    expect(await screen.findByText("Reads")).toBeTruthy();
    const link = screen.getByText("reefbarman/agentlink");
    expect(link.getAttribute("href")).toBe(
      "https://github.com/reefbarman/agentlink",
    );
  });

  it("publishes a ready task that did not publish itself", async () => {
    const calls = stubFetch({
      "GET /api/tasks/t1": () => detail(task()),
      "POST /api/tasks/t1/publish": () => ({ task: task() }),
    });
    render(
      <TasksPanel revision={0} onClose={() => undefined} initialTaskId="t1" />,
    );
    fireEvent.click(await screen.findByText("Publish draft PR"));
    await waitFor(() =>
      expect(
        calls.find((call) => call.path === "/api/tasks/t1/publish")?.body,
      ).toEqual({}),
    );
  });

  it("publishes without a review when the owner chooses to", async () => {
    const unreviewed = task({ state: "blocked_review", current: {} });
    const calls = stubFetch({
      "GET /api/tasks/t1": () => detail(unreviewed),
      "POST /api/tasks/t1/publish": () => ({ task: unreviewed }),
    });
    render(
      <TasksPanel revision={0} onClose={() => undefined} initialTaskId="t1" />,
    );
    expect(await screen.findByText(/no reviewer looked/u)).toBeTruthy();
    fireEvent.click(screen.getByText("Publish without review"));
    await waitFor(() =>
      expect(
        calls.find((call) => call.path === "/api/tasks/t1/publish")?.body,
      ).toEqual({ allowUnreviewed: true }),
    );
  });

  it("hides Publish without a standing permission", async () => {
    stubFetch({ "GET /api/tasks/t1": () => detail(task(), null) });
    render(
      <TasksPanel revision={0} onClose={() => undefined} initialTaskId="t1" />,
    );
    expect(await screen.findByText(/no GitHub connection/u)).toBeTruthy();
    expect(screen.queryByText(/Publish/u)).toBeNull();
  });

  it("stops a running task and resumes a failed one", async () => {
    let current = task({ state: "implementing", current: {} });
    const calls = stubFetch({
      "GET /api/tasks/t1": () => detail(current),
      "POST /api/tasks/t1/stop": () => {
        current = task({ state: "failed", error: "stopped", current: {} });
        return { ok: true };
      },
      "POST /api/tasks/t1/resume": () => ({ task: current }),
    });
    render(
      <TasksPanel revision={0} onClose={() => undefined} initialTaskId="t1" />,
    );
    expect(screen.queryByText("Delete")).toBeNull();
    fireEvent.click(await screen.findByText("Stop"));
    fireEvent.click(await screen.findByText("Resume"));
    await waitFor(() =>
      expect(calls.map((call) => `${call.method} ${call.path}`)).toContain(
        "POST /api/tasks/t1/resume",
      ),
    );
    expect(calls.map((call) => `${call.method} ${call.path}`)).toContain(
      "POST /api/tasks/t1/stop",
    );
  });

  it("deletes a finished task after confirming", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const calls = stubFetch({
      "GET /api/tasks/t1": () => detail(task()),
      "DELETE /api/tasks/t1": () => ({ ok: true }),
    });
    render(
      <TasksPanel revision={0} onClose={() => undefined} initialTaskId="t1" />,
    );
    fireEvent.click(await screen.findByText("Delete"));
    expect(await screen.findByText("The task was deleted.")).toBeTruthy();
    expect(calls.some((call) => call.method === "DELETE")).toBe(true);
  });

  it("shows the implementation chat read-only", async () => {
    stubFetch({
      "GET /api/tasks/t1": () => detail(task()),
      "GET /api/projects/task-t1/sessions/impl-1": () => ({
        transcript: {
          omitted: 0,
          entries: [
            { kind: "user", text: "Fix the README" },
            { kind: "tool", toolName: "apply_diff" },
            { kind: "assistant", text: "Done, committed." },
          ],
        },
      }),
    });
    render(
      <TasksPanel revision={0} onClose={() => undefined} initialTaskId="t1" />,
    );
    fireEvent.click(await screen.findByText("Implementation chat"));
    expect(await screen.findByText("Done, committed.")).toBeTruthy();
    expect(screen.getByText("apply_diff")).toBeTruthy();
    fireEvent.click(screen.getByText("Back to the task", { exact: false }));
    expect(await screen.findByText("npm test")).toBeTruthy();
  });

  it("opens a task's own chat in the chat list, where it can be written to", async () => {
    stubFetch({
      "GET /api/tasks/t1": () =>
        detail(task({ origin: { projectId: "home", sessionId: "chat-1" } })),
    });
    const openTaskChat = vi.fn();
    render(
      <TasksPanel
        revision={0}
        onClose={() => undefined}
        initialTaskId="t1"
        openTaskChat={openTaskChat}
      />,
    );
    fireEvent.click(await screen.findByText("Open chat"));
    expect(openTaskChat).toHaveBeenCalledWith("home", "impl-1");
    expect(screen.queryByText("Implementation chat")).toBeNull();
  });
});
