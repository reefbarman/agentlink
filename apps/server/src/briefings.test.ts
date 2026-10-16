import type { EmbeddedAgentTurnEvent } from "@agentlink/protocol";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AssistantServerAuth } from "./assistantServer.js";
import { BriefingSpecError, parseBriefingSpec } from "./briefingSpec.js";
import {
  BRIEFING_STATUS,
  briefingOpenItems,
  countUnsourced,
  createBriefings,
  type BriefingSources,
} from "./briefings.js";
import { inboxEntryForRun, openInboxStore } from "./inboxStore.js";
import { createJobRunner } from "./jobRunner.js";
import {
  JobInputError,
  openJobStore,
  parseJobFields,
  type JobDefinition,
  type JobFields,
  type JobRun,
} from "./jobStore.js";
import { defaultPersona } from "./persona.js";
import { pushMessageForEntry, type PushMessage } from "./pushService.js";
import { createQuietPush } from "./quietPush.js";
import { SessionEventHub } from "./SessionEventHub.js";
import type { TaskRun } from "./taskStore.js";
import { openWatchStore } from "./watchStore.js";
import type { AssistantSessionOperations } from "./workspaceRoutes.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
  vi.useRealTimers();
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const BRIEFING_FIELDS: JobFields = {
  name: "Morning briefing",
  projectId: "home",
  prompt: "Keep it friendly.",
  schedule: { kind: "daily", time: "07:00", timeZone: "Australia/Brisbane" },
  enabled: true,
  approvalMode: "ask",
  briefing: {
    sections: ["watches", "news", "calendar", "email", "open_items"],
    topics: ["games", "tech"],
    maxWords: 300,
  },
};

const job = (fields: Partial<JobFields> = {}): JobDefinition => ({
  ...BRIEFING_FIELDS,
  ...fields,
  id: "00000000-0000-4000-8000-000000000001",
  createdAt: 0,
  updatedAt: 0,
  scheduledFrom: 0,
});

const sources = (
  overrides: Partial<BriefingSources> = {},
): BriefingSources => ({
  watchChanges: () => [],
  openItems: () => [],
  webSearch: () => true,
  timeZone: () => "Australia/Brisbane",
  now: () => Date.UTC(2026, 9, 16, 21, 0),
  ...overrides,
});

describe("briefing spec", () => {
  it("defaults to every section and about 300 words", () => {
    expect(parseBriefingSpec({})).toEqual({
      sections: ["watches", "news", "calendar", "email", "open_items"],
      topics: [],
      maxWords: 300,
    });
    expect(
      parseBriefingSpec({ sections: ["news"], topics: [" games "] }),
    ).toEqual({ sections: ["news"], topics: ["games"], maxWords: 300 });
  });

  it.each([
    [{ sections: [] }, "briefing_sections_invalid"],
    [{ sections: ["news", "news"] }, "briefing_sections_invalid"],
    [{ sections: ["weather"] }, "briefing_sections_invalid"],
    [{ topics: ["a\nb"] }, "briefing_topics_invalid"],
    [{ maxWords: 50 }, "briefing_length_invalid"],
    [{ extra: true }, "briefing_invalid"],
  ])("refuses %j", (value, code) => {
    expect(() => parseBriefingSpec(value)).toThrow(BriefingSpecError);
    expect(() => parseBriefingSpec(value)).toThrow(code);
  });

  it("is a job kind of its own, never also a watch", () => {
    expect(() =>
      parseJobFields(
        {
          ...BRIEFING_FIELDS,
          watch: { url: "https://example.com/" },
        } as unknown as Record<string, unknown>,
        { partial: false, defaultTimeZone: "UTC" },
      ),
    ).toThrow(new JobInputError("job_kind_conflict"));
  });
});

describe("briefing prompt", () => {
  it("degrades a missing connection to one fixed line", () => {
    const { prompt } = createBriefings(
      sources({ webSearch: () => false }),
    ).prepare(job(), []);
    expect(prompt).toContain(`"${BRIEFING_STATUS.newsUnavailable}"`);
    expect(prompt).toContain(`"${BRIEFING_STATUS.calendarNotConnected}"`);
    expect(prompt).toContain(`"${BRIEFING_STATUS.emailNotConnected}"`);
    expect(prompt).toContain(`"${BRIEFING_STATUS.noWatchChanges}"`);
    expect(prompt).toContain(`"${BRIEFING_STATUS.nothingOpen}"`);
    expect(prompt).not.toContain("web_search");
  });

  it("asks for news on the topics, a length budget and source links", () => {
    const { prompt } = createBriefings(sources()).prepare(job(), []);
    expect(prompt).toContain(
      'Use web_search for news from the last day on each topic: "games", "tech"',
    );
    expect(prompt).toContain("At most about 300 words");
    expect(prompt).toContain("Every bullet ends with its source link");
    expect(prompt).toContain("17 October 2026");
    expect(prompt).toContain("Keep it friendly.");
  });

  it("includes only the sections chosen, in order", () => {
    const { prompt } = createBriefings(sources()).prepare(
      job({
        briefing: {
          sections: ["open_items", "news"],
          topics: [],
          maxWords: 200,
        },
      }),
      [],
    );
    expect(prompt.indexOf("## Open items")).toBeLessThan(
      prompt.indexOf("## News"),
    );
    expect(prompt).not.toContain("## Calendar");
    expect(prompt).toContain(`"${BRIEFING_STATUS.noTopics}"`);
  });
});

describe("briefing source check", () => {
  it("counts bullets without a link, but not status lines", () => {
    const text = [
      "## News",
      "- Big launch today https://example.com/a",
      "- A rumour with no source",
      "* [Patch notes](https://example.com/b)",
      "1. Your task waits [open](/?openTask=abc123def456)",
      "## Calendar",
      "- **Calendar: not connected yet.**",
      "Plain paragraph without a link",
    ].join("\n");
    expect(countUnsourced(text)).toBe(1);
  });
});

describe("briefing open items", () => {
  it("lists tasks waiting for the owner and runs waiting for approval", async () => {
    const tasks = [
      {
        id: "aaaaaaaaaaaa",
        objective: "Fix the footer\nmore",
        state: "awaiting_approval",
      },
      { id: "bbbbbbbbbbbb", objective: "Busy", state: "implementing" },
      {
        id: "cccccccccccc",
        objective: "Blocked one",
        state: "blocked_review",
        pullRequest: { number: 3, url: "https://github.com/o/r/pull/3" },
      },
    ] as unknown as TaskRun[];
    const dir = await tempDir("briefing-items-");
    const store = await openJobStore({ directory: dir });
    const other = await store.create(
      { ...BRIEFING_FIELDS, briefing: undefined, name: "Nightly" } as JobFields,
      0,
    );
    await store.saveRun({
      runId: "r1",
      jobId: other.id,
      projectId: "home",
      trigger: "schedule",
      status: "awaiting_approval",
      sessionId: "s1",
      createdAt: 0,
      updatedAt: 0,
    });
    expect(briefingOpenItems(tasks, store)).toEqual([
      {
        text: 'Task "Fix the footer" waits for your approval',
        link: "/?openTask=aaaaaaaaaaaa",
      },
      {
        text: 'Task "Blocked one" is blocked: no review',
        link: "https://github.com/o/r/pull/3",
      },
      {
        text: '"Nightly" waits for your approval',
        link: "/?openProject=home&openSession=s1",
      },
    ]);
  });
});

/** The real runner, watch store and briefing builder, with fake chats. */
async function setupBriefing() {
  const root = await tempDir("briefing-runner-");
  const store = await openJobStore({ directory: path.join(root, "jobs") });
  const watchStore = await openWatchStore({
    directory: path.join(root, "watches"),
  });
  const events = new SessionEventHub();
  let next = 0;
  const turns: Array<{ sessionId: string; text: string }> = [];
  const operations = {
    sessionKey: (projectId: string, sessionId: string) =>
      `${projectId}/${sessionId}`,
    createSession: vi.fn(async () => ({ sessionId: `s${(next += 1)}` })),
    setApprovalMode: vi.fn(async () => "ask"),
    startTurn: vi.fn(
      async (
        auth: AssistantServerAuth,
        projectId: string,
        sessionId: string,
        text: string,
      ) => {
        turns.push({ sessionId, text });
        events.publish(`${projectId}/${sessionId}`, {
          kind: "task",
          state: "started",
          taskId: `t-${sessionId}`,
          operation: "turn",
          actor: {
            subjectId: auth.principal.subjectId,
            deviceId: auth.session.deviceId,
          },
        });
        return { taskId: `t-${sessionId}` };
      },
    ),
    cancel: vi.fn(async () => undefined),
    readSession: vi.fn(async () => ({ messages: [] })),
  };
  const answer = (sessionId: string, text: string) => {
    const key = `home/${sessionId}`;
    events.publish(key, {
      kind: "turn",
      event: {
        schemaVersion: 1,
        sessionId,
        turnId: "turn",
        sequence: 1,
        emittedAt: Date.now(),
        type: "turn.completed",
        result: { status: "completed", sessionId, turnId: "turn", text },
      } as unknown as EmbeddedAgentTurnEvent,
    });
    events.publish(key, {
      kind: "task",
      state: "finished",
      taskId: `t-${sessionId}`,
      status: "completed",
    });
  };
  let clock = Date.UTC(2026, 9, 15, 21, 0);
  const briefings = createBriefings({
    watchChanges: (since, through) =>
      watchStore.all().flatMap((state) =>
        state.findings
          .filter((finding) => finding.at > since && finding.at <= through)
          .map((finding) => ({
            at: finding.at,
            watchName: "Releases",
            summary: finding.summary,
            url: finding.url,
            notified: finding.notified,
          })),
      ),
    openItems: () => [],
    webSearch: () => true,
    timeZone: () => "Australia/Brisbane",
    now: () => clock,
  });
  const runner = createJobRunner({
    store,
    operations: operations as unknown as AssistantSessionOperations,
    events,
    ownerId: () => "owner",
    resolveModel: () => undefined,
    projectDefaults: () => ({
      model: { providerId: "codex", modelId: "gpt-5" },
    }),
    prepareRun: async (definition) => {
      if (!definition.briefing) return undefined;
      const prepared = briefings.prepare(definition, store.runs(definition.id));
      return { prompt: prepared.prompt, record: { briefing: prepared.record } };
    },
    finishRun: async (definition, run, text) => {
      const briefing = briefings.finish(run, text);
      return briefing ? { briefing } : {};
    },
  });
  cleanup.push(() => runner.close());
  await runner.start();
  const created = await store.create(BRIEFING_FIELDS, clock);
  await runner.jobChanged(created.id);
  const wait = { timeout: 10_000 };
  /** Run the briefing now; its chat answers `reply`. */
  const brief = async (
    reply: string,
  ): Promise<{ run: JobRun; prompt: string }> => {
    const started = await runner.runNow(created.id);
    await vi.waitFor(() => {
      const sessionId = store.run(started.runId)?.sessionId;
      expect(turns.some((turn) => turn.sessionId === sessionId)).toBe(true);
    }, wait);
    const run = store.run(started.runId)!;
    const prompt = turns.find((turn) => turn.sessionId === run.sessionId)!.text;
    answer(run.sessionId!, reply);
    await vi.waitFor(
      () => expect(store.run(started.runId)?.status).toBe("completed"),
      wait,
    );
    return { run: store.run(started.runId)!, prompt };
  };
  const finding = async (at: number, summary: string) => {
    const state = watchStore.get("00000000-0000-4000-8000-0000000000aa");
    await watchStore.save({
      jobId: "00000000-0000-4000-8000-0000000000aa",
      url: "https://example.com/releases",
      snapshots: [],
      notifiedAt: [],
      ...state,
      findings: [
        ...(state?.findings ?? []),
        {
          at,
          runId: `r-${at}`,
          summary,
          url: "https://example.com/releases",
          notified: false,
        },
      ],
    });
  };
  return {
    store,
    job: store.get(created.id)!,
    brief,
    finding,
    setClock: (at: number) => {
      clock = at;
    },
    clock: () => clock,
  };
}

describe("briefing runs", () => {
  it("includes only watch changes since the previous briefing", async () => {
    const harness = await setupBriefing();
    const day1 = harness.clock();
    await harness.finding(day1 - 60 * 60_000, "v1 shipped");
    const first = await harness.brief(
      "## Watches\n- v1 shipped https://example.com/releases",
    );
    expect(first.prompt).toContain("v1 shipped");
    expect(first.run.briefing).toEqual({
      since: day1 - 24 * 60 * 60_000,
      through: day1,
      watchChanges: 1,
      unsourced: 0,
    });

    const day2 = day1 + 24 * 60 * 60_000;
    await harness.finding(day1 + 60 * 60_000, "v2 shipped");
    harness.setClock(day2);
    const second = await harness.brief(
      "## Watches\n- v2 shipped https://example.com/releases\n- And a claim with no link",
    );
    expect(second.prompt).toContain("v2 shipped");
    expect(second.prompt).not.toContain("v1 shipped");
    expect(second.run.briefing).toMatchObject({
      since: day1,
      through: day2,
      watchChanges: 1,
      unsourced: 1,
    });
    // It lands in the Inbox as a briefing, saying what was unsourced.
    expect(inboxEntryForRun(second.run, harness.job)).toMatchObject({
      kind: "briefing",
      title: "Morning briefing (1 item without a source)",
      sessionId: second.run.sessionId,
    });
  });

  it("holds the push in quiet hours but not the Inbox entry", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    // 06:00 in Brisbane: inside the default 22:00 to 07:00 quiet hours.
    vi.setSystemTime(Date.UTC(2026, 9, 15, 20, 0));
    const inbox = await openInboxStore({
      directory: await tempDir("briefing-inbox-"),
    });
    const sent: PushMessage[] = [];
    const quiet = createQuietPush({
      settings: () => defaultPersona("Australia/Brisbane"),
      send: (message) => sent.push(message),
      isUnread: (id) =>
        inbox.list().some((entry) => entry.id === id && !entry.read),
    });
    cleanup.push(async () => quiet.close());
    const run: JobRun = {
      runId: "r",
      jobId: job().id,
      projectId: "home",
      trigger: "schedule",
      status: "completed",
      sessionId: "s",
      summary: "## Watches\n- v2 https://example.com",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const added = await inbox.add(inboxEntryForRun(run, job())!, Date.now());
    quiet.deliver(added!, pushMessageForEntry(added!));
    expect(inbox.list()).toHaveLength(1);
    expect(inbox.list()[0]!.kind).toBe("briefing");
    expect(sent).toEqual([]);
    expect(quiet.held()).toBe(1);
    // At 07:00 it goes out.
    await vi.advanceTimersByTimeAsync(60 * 60_000 + 1_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.title).toBe("Morning briefing");
  });
});
