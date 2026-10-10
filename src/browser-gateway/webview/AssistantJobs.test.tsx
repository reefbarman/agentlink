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
  AssistantHub,
  InboxPanel,
  JobForm,
  JobsPanel,
  describeSchedule,
  emptyJobForm,
  groupInboxEntries,
  jobFormFromJob,
  jobRequestBody,
  openAssistantChat,
  scheduleFromForm,
  type InboxEntry,
  type Job,
} from "./AssistantJobs";

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

const job = (patch: Partial<Job> = {}): Job => ({
  id: "11111111-1111-4111-8111-111111111111",
  name: "Morning brief",
  projectId: "home",
  prompt: "Brief me",
  schedule: {
    kind: "weekly",
    days: ["mon", "tue", "wed", "thu", "fri"],
    time: "07:30",
    timeZone: "Australia/Sydney",
  },
  enabled: true,
  approvalMode: "autonomous",
  nextRunAt: Date.parse("2026-10-12T20:30:00Z"),
  ...patch,
});

const PROJECTS = {
  activeProjectId: "home",
  canCreate: false,
  canClone: false,
  projects: [
    { id: "home", label: "Home" },
    { id: "work", label: "Work" },
  ],
};

describe("schedule helpers", () => {
  it("describes each kind of schedule", () => {
    expect(describeSchedule({ kind: "interval", everyMinutes: 15 })).toBe(
      "Every 15 minutes",
    );
    expect(describeSchedule({ kind: "interval", everyMinutes: 60 })).toBe(
      "Every hour",
    );
    expect(describeSchedule({ kind: "interval", everyMinutes: 180 })).toBe(
      "Every 3 hours",
    );
    expect(
      describeSchedule({ kind: "daily", time: "07:30", timeZone: "UTC" }),
    ).toBe("Daily at 07:30 (UTC)");
    expect(describeSchedule(job().schedule)).toBe(
      "Weekdays at 07:30 (Australia/Sydney)",
    );
    expect(
      describeSchedule({
        kind: "weekly",
        days: ["sat", "sun"],
        time: "09:00",
        timeZone: "UTC",
      }),
    ).toBe("Weekends at 09:00 (UTC)");
    expect(
      describeSchedule({
        kind: "weekly",
        days: ["wed", "mon"],
        time: "09:00",
        timeZone: "UTC",
      }),
    ).toBe("Mon, Wed at 09:00 (UTC)");
  });

  it("turns a form into a schedule, or says what is wrong", () => {
    const form = emptyJobForm("home", "UTC");
    expect(
      scheduleFromForm({
        ...form,
        kind: "interval",
        every: "2",
        unit: "hours",
      }),
    ).toEqual({ schedule: { kind: "interval", everyMinutes: 120 } });
    expect(
      scheduleFromForm({
        ...form,
        kind: "interval",
        every: "10",
        unit: "minutes",
      }),
    ).toEqual({ error: "Runs can repeat every 15 minutes at most often." });
    expect(scheduleFromForm({ ...form, time: "7:30" })).toEqual({
      error: "Use a 24-hour time such as 07:30.",
    });
    expect(scheduleFromForm({ ...form, kind: "weekly", days: [] })).toEqual({
      error: "Pick at least one day.",
    });
    expect(
      scheduleFromForm({ ...form, kind: "weekly", days: ["fri", "mon"] }),
    ).toEqual({
      schedule: {
        kind: "weekly",
        days: ["mon", "fri"],
        time: "07:30",
        timeZone: "UTC",
      },
    });
  });

  it("round-trips a job through the form and clears defaults on edit", () => {
    const form = jobFormFromJob(
      job({
        schedule: { kind: "interval", everyMinutes: 120 },
        model: "claude/opus",
        reasoningEffort: "high",
      }),
      "UTC",
    );
    expect(form).toMatchObject({
      kind: "interval",
      every: "2",
      unit: "hours",
      model: "claude/opus",
      effort: "high",
    });
    const schedule = { kind: "interval" as const, everyMinutes: 120 };
    expect(
      jobRequestBody({ ...form, model: "" }, schedule, true),
    ).not.toHaveProperty("model");
    expect(
      jobRequestBody({ ...form, model: "" }, schedule, false),
    ).toMatchObject({ model: null, reasoningEffort: null });
    expect(jobRequestBody(form, schedule, false)).toMatchObject({
      model: "claude/opus",
      reasoningEffort: "high",
    });
  });

  it("groups inbox entries by day", () => {
    const now = new Date(2026, 9, 10, 15, 0).getTime();
    const entry = (id: string, createdAt: number): InboxEntry => ({
      id,
      kind: "run_completed",
      createdAt,
      title: id,
      projectId: "home",
      read: false,
    });
    const groups = groupInboxEntries(
      [
        entry("a", new Date(2026, 9, 10, 9, 0).getTime()),
        entry("b", new Date(2026, 9, 10, 1, 0).getTime()),
        entry("c", new Date(2026, 9, 9, 23, 0).getTime()),
      ],
      now,
    );
    expect(
      groups.map((group) => [group.label, group.entries.map((e) => e.id)]),
    ).toEqual([
      ["Today", ["a", "b"]],
      ["Yesterday", ["c"]],
    ]);
  });
});

describe("openAssistantChat", () => {
  it("loads a chat in this project, or reloads into another", async () => {
    const calls = stubFetch({
      "GET /api/ask-agent/projects": () => PROJECTS,
      "POST /api/ask-agent/projects/select": () => ({ ok: true }),
    });
    const loadSession = vi.fn();
    const reloadPage = vi.fn();
    await openAssistantChat({
      projectId: "home",
      sessionId: "chat-1",
      loadSession,
      reloadPage,
    });
    expect(loadSession).toHaveBeenCalledWith("chat-1");
    expect(reloadPage).not.toHaveBeenCalled();
    await openAssistantChat({
      projectId: "work",
      sessionId: "chat-2",
      loadSession,
      reloadPage,
    });
    expect(reloadPage).toHaveBeenCalledTimes(1);
    expect(
      calls.filter((call) => call.method === "POST").map((call) => call.body),
    ).toEqual([
      { projectId: "home", sessionId: "chat-1" },
      { projectId: "work", sessionId: "chat-2" },
    ]);
  });
});

describe("JobForm", () => {
  it("creates a weekly job and checks the form first", async () => {
    const calls = stubFetch({
      "POST /api/jobs": (body) => ({ job: { ...job(), ...(body as object) } }),
    });
    const onSaved = vi.fn();
    render(
      <JobForm
        job={null}
        projects={PROJECTS.projects}
        defaultProjectId="work"
        models={[
          { id: "claude/opus", displayName: "Opus", reasoningEfforts: ["low"] },
        ]}
        onCancel={() => undefined}
        onSaved={onSaved}
      />,
    );
    fireEvent.input(screen.getByPlaceholderText("Morning brief"), {
      target: { value: "Inbox zero" },
    });
    fireEvent.click(screen.getByText("Create job"));
    expect(
      await screen.findByText("Write what each run should ask."),
    ).toBeTruthy();
    expect(calls).toHaveLength(0);

    fireEvent.input(screen.getByLabelText(/Prompt/u), {
      target: { value: "Summarise my inbox" },
    });
    fireEvent.change(screen.getByLabelText("Repeat"), {
      target: { value: "weekly" },
    });
    // Weekdays are picked by default: drop Friday.
    fireEvent.click(screen.getByLabelText("Fri"));
    fireEvent.input(screen.getByLabelText("Time zone"), {
      target: { value: "Europe/London" },
    });
    fireEvent.change(screen.getByDisplayValue("Project default"), {
      target: { value: "claude/opus" },
    });
    fireEvent.click(screen.getByText("Ask before each change"));
    fireEvent.click(screen.getByText("Create job"));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/api/jobs",
      body: {
        name: "Inbox zero",
        projectId: "work",
        prompt: "Summarise my inbox",
        schedule: {
          kind: "weekly",
          days: ["mon", "tue", "wed", "thu"],
          time: "07:30",
          timeZone: "Europe/London",
        },
        enabled: true,
        approvalMode: "ask",
        model: "claude/opus",
      },
    });
  });
});

describe("JobsPanel", () => {
  it("lists jobs, runs one now, pauses one, and follows a live run", async () => {
    const paused = job({
      id: "22222222-2222-4222-8222-222222222222",
      name: "Weekly review",
      enabled: false,
      nextRunAt: undefined,
      lastRun: {
        runId: "r0",
        jobId: "22222222-2222-4222-8222-222222222222",
        projectId: "work",
        trigger: "schedule",
        status: "completed",
        createdAt: 1,
        updatedAt: 2,
        finishedAt: 2,
        sessionId: "old-chat",
      },
      projectId: "work",
    });
    const running = job({
      activeRun: {
        runId: "r1",
        jobId: job().id,
        projectId: "home",
        trigger: "manual",
        status: "awaiting_approval",
        createdAt: 1,
        updatedAt: 1,
        sessionId: "live-chat",
      },
    });
    const calls = stubFetch({
      "GET /api/jobs": () => ({ jobs: [running, paused] }),
      "GET /api/ask-agent/projects": () => PROJECTS,
      "GET /api/ask-agent/models": () => ({ models: [] }),
      [`POST /api/jobs/${paused.id}/run`]: () => ({ run: {} }),
      [`PATCH /api/jobs/${paused.id}`]: () => ({ job: paused }),
    });
    const openChat = vi.fn(async () => undefined);
    render(
      <JobsPanel revision={0} onClose={() => undefined} openChat={openChat} />,
    );
    expect(await screen.findByText("Weekly review")).toBeTruthy();
    expect(screen.getByText("Needs your approval")).toBeTruthy();
    expect(screen.getByText(/Paused/u)).toBeTruthy();
    expect(
      screen.getByText("Weekdays at 07:30 (Australia/Sydney) · Home"),
    ).toBeTruthy();

    // A live run is followed in its chat rather than started again.
    fireEvent.click(screen.getByText("Follow"));
    expect(openChat).toHaveBeenCalledWith("home", "live-chat");

    fireEvent.click(screen.getByText(/Run\s+now/u));
    await waitFor(() =>
      expect(calls.some((call) => call.path.endsWith("/run"))).toBe(true),
    );
    fireEvent.click(screen.getByLabelText("Run Weekly review on its schedule"));
    await waitFor(() =>
      expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({
        enabled: true,
      }),
    );
  });
});

describe("InboxPanel", () => {
  const entries: InboxEntry[] = [
    {
      id: "e1",
      kind: "needs_approval",
      createdAt: Date.now(),
      title: "Morning brief needs your approval",
      projectId: "work",
      sessionId: "chat-9",
      read: false,
    },
    {
      id: "e2",
      kind: "run_completed",
      createdAt: Date.now() - 1_000,
      title: "Morning brief finished",
      body: "All quiet",
      projectId: "home",
      sessionId: "chat-8",
      read: true,
    },
  ];

  it("opens an entry's chat, marking it read, and marks all read", async () => {
    const calls = stubFetch({
      "GET /api/inbox": () => ({ entries, unread: 1 }),
      "POST /api/inbox/read": () => ({ ok: true }),
    });
    const openChat = vi.fn(async () => undefined);
    render(
      <InboxPanel revision={0} onClose={() => undefined} openChat={openChat} />,
    );
    expect(await screen.findByText("Today")).toBeTruthy();
    expect(screen.getByText("All quiet")).toBeTruthy();
    fireEvent.click(
      screen.getByLabelText("Unread: Morning brief needs your approval"),
    );
    expect(openChat).toHaveBeenCalledWith("work", "chat-9");
    await waitFor(() =>
      expect(calls.find((call) => call.method === "POST")?.body).toEqual({
        ids: ["e1"],
      }),
    );
    // Nothing left unread: no "Mark all read".
    expect(screen.queryByText(/Mark all/u)).toBeNull();
  });

  it("marks everything read from the header", async () => {
    const calls = stubFetch({
      "GET /api/inbox": () => ({
        entries: entries.map((entry) => ({ ...entry, read: false })),
        unread: 2,
      }),
      "POST /api/inbox/read": () => ({ ok: true }),
    });
    render(
      <InboxPanel
        revision={0}
        onClose={() => undefined}
        openChat={async () => undefined}
      />,
    );
    fireEvent.click(await screen.findByText(/Mark all/u));
    await waitFor(() =>
      expect(calls.find((call) => call.method === "POST")?.body).toEqual({
        all: true,
      }),
    );
    expect(screen.queryByText(/Mark all/u)).toBeNull();
  });
});

describe("AssistantHub", () => {
  it("shows the unread count and opens the panels", async () => {
    stubFetch({
      "GET /api/inbox": () => ({ entries: [], unread: 0 }),
      "GET /api/jobs": () => ({ jobs: [] }),
      "GET /api/ask-agent/projects": () => PROJECTS,
      "GET /api/ask-agent/models": () => ({ models: [] }),
    });
    render(
      <AssistantHub
        inboxUnread={3}
        revision={1}
        loadSession={() => undefined}
        reloadPage={() => undefined}
      />,
    );
    fireEvent.click(screen.getByLabelText("Inbox (3 unread)"));
    expect(await screen.findByText(/Nothing here yet/u)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Close"));
    fireEvent.click(screen.getByText("Jobs"));
    expect(await screen.findByText(/No jobs yet/u)).toBeTruthy();
  });
});
