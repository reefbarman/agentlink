import type { EmbeddedAgentTurnEvent } from "@agentlink/protocol";
import { promises as fs } from "node:fs";
import http from "node:http";
import net, { type AddressInfo, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AssistantServerAuth } from "./assistantServer.js";
import { inboxEntryForRun } from "./inboxStore.js";
import { createJobRunner, type JobRunner } from "./jobRunner.js";
import {
  openJobStore,
  type JobDefinition,
  type JobFields,
  type JobRun,
  type JobStore,
} from "./jobStore.js";
import { unusualUsage } from "./jobUsage.js";
import { SessionEventHub } from "./SessionEventHub.js";
import {
  createWatcher,
  describeChange,
  feedItems,
  parseVerdict,
  selectHtml,
  watchHash,
  watchedText,
} from "./watches.js";
import { openWatchStore, type WatchStore } from "./watchStore.js";
import { parseWatchTarget, WatchTargetError } from "./watchTarget.js";
import {
  directConnector,
  fetchWebPage,
  type FetchedPage,
  type SecureSocket,
} from "./webFetch.js";
import type { AssistantSessionOperations } from "./workspaceRoutes.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

describe("watch targets", () => {
  it("accepts a public page, upgrading http, with the default cap", () => {
    expect(parseWatchTarget({ url: "http://example.com/news#top" })).toEqual({
      url: "https://example.com/news",
      notifyPerDay: 3,
    });
    expect(
      parseWatchTarget({
        url: "https://example.com/",
        selector: "div#main.post",
        notifyPerDay: 0,
      }),
    ).toEqual({
      url: "https://example.com/",
      selector: "div#main.post",
      notifyPerDay: 0,
    });
  });

  it.each([
    [{ url: "https://10.0.0.1/" }, "watch_url_invalid"],
    [{ url: "https://localhost/" }, "watch_url_invalid"],
    [{ url: "ftp://example.com/" }, "watch_url_invalid"],
    [
      { url: "https://example.com/", selector: "div > p" },
      "watch_selector_invalid",
    ],
    [
      { url: "https://example.com/", selector: "#a#b" },
      "watch_selector_invalid",
    ],
    [
      { url: "https://example.com/", notifyPerDay: 1.5 },
      "watch_notify_invalid",
    ],
    [{ url: "https://example.com/", extra: 1 }, "watch_invalid"],
  ])("refuses %j", (value, code) => {
    expect(() => parseWatchTarget(value)).toThrow(WatchTargetError);
    expect(() => parseWatchTarget(value)).toThrow(code);
  });
});

describe("watched text", () => {
  it("reads a feed's items, newest first, as lines", () => {
    const rss = `<?xml version="1.0"?><rss><channel><title>Blog</title>
      <item><title><![CDATA[v2 &amp; more]]></title><link>https://e.com/v2</link><pubDate>Fri</pubDate></item>
      <item><title>v1</title><link>https://e.com/v1</link></item></channel></rss>`;
    expect(feedItems(rss)).toEqual([
      "- v2 & more (Fri) https://e.com/v2",
      "- v1 https://e.com/v1",
    ]);
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Release 1.2</title>
      <link rel="alternate" href="https://e.com/r/1.2"/><updated>2026-10-16</updated></entry></feed>`;
    expect(feedItems(atom)).toEqual([
      "- Release 1.2 (2026-10-16) https://e.com/r/1.2",
    ]);
    expect(feedItems("<html><body>hi</body></html>")).toBeUndefined();
  });

  it("picks the outermost elements matching a simple selector", () => {
    const html = `<html><body><div class="post big"><p>One <div class="post">nested</div></p></div>
      <!-- <div class="post">commented</div> --><div class="other">skip</div>
      <section id="price"><b>$10</b></section></body></html>`;
    expect(selectHtml(html, ".post")).toEqual([
      '<p>One <div class="post">nested</div></p>',
    ]);
    expect(selectHtml(html, "section#price")).toEqual(["<b>$10</b>"]);
    expect(selectHtml(html, "div.post.big")).toHaveLength(1);
    expect(selectHtml(html, "#missing")).toEqual([]);
    expect(
      watchedText(
        {
          url: "https://e.com/",
          contentType: "text/html",
          text: "",
          raw: html,
        },
        "#price",
      ),
    ).toBe("$10");
    expect(() =>
      watchedText(
        {
          url: "https://e.com/",
          contentType: "text/html",
          text: "",
          raw: html,
        },
        "#missing",
      ),
    ).toThrow('Nothing on https://e.com/ matches "#missing"');
  });

  it("hashes text with whitespace normalised", () => {
    expect(watchHash("a  b\n\nc")).toBe(watchHash(" a b c "));
    expect(watchHash("a b c")).not.toBe(watchHash("a b d"));
  });

  it("describes added and removed lines", () => {
    expect(describeChange("a\nb\nc", "a\nc\nd")).toEqual({
      added: ["d"],
      removed: ["b"],
    });
  });

  it("reads the judging turn's verdict, telling the owner when unsure", () => {
    expect(parseVerdict("NOT RELEVANT: just a typo fix")).toEqual({
      relevant: false,
      summary: "just a typo fix",
    });
    expect(parseVerdict("**RELEVANT:** v2 is out")).toEqual({
      relevant: true,
      summary: "v2 is out",
    });
    expect(parseVerdict("Version 2 is out")).toEqual({
      relevant: true,
      summary: "Version 2 is out",
    });
  });
});

const WATCH_FIELDS: JobFields = {
  name: "Releases",
  projectId: "home",
  prompt: "A new stable release",
  schedule: { kind: "interval", everyMinutes: 60 },
  enabled: true,
  approvalMode: "ask",
  watch: { url: "https://example.com/releases", notifyPerDay: 1 },
};

/** The page the fake fetch serves, and what it was asked. */
function createFakePage() {
  const page = { text: "v1 released", etag: '"1"', notModified: false };
  const requests: Array<{ etag?: string }> = [];
  const fetch = vi.fn(
    async (request: {
      readonly url: string;
      readonly conditional?: { readonly etag?: string };
    }): Promise<FetchedPage> => {
      requests.push(
        request.conditional?.etag ? { etag: request.conditional.etag } : {},
      );
      if (page.notModified && request.conditional?.etag === page.etag) {
        return {
          url: request.url,
          status: 304,
          contentType: "",
          text: "",
          bodyTruncated: false,
          notModified: true,
        };
      }
      return {
        url: request.url,
        status: 200,
        contentType: "text/plain",
        text: page.text,
        raw: page.text,
        bodyTruncated: false,
        etag: page.etag,
      };
    },
  );
  return { page, requests, fetch };
}

/** Fake session operations: a turn ends when the test says so. */
function createOperations(events: SessionEventHub) {
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
  const event = (
    sessionId: string,
    body: Record<string, unknown>,
  ): EmbeddedAgentTurnEvent =>
    ({
      schemaVersion: 1,
      sessionId,
      turnId: "turn",
      sequence: 1,
      emittedAt: Date.now(),
      ...body,
    }) as unknown as EmbeddedAgentTurnEvent;
  /** The judging turn answers `text`, after one model request. */
  const answer = (sessionId: string, text: string) => {
    const key = `home/${sessionId}`;
    events.publish(key, {
      kind: "turn",
      event: event(sessionId, {
        type: "usage.updated",
        usage: { inputTokens: 900, outputTokens: 100, cacheReadTokens: 50 },
      }),
    });
    events.publish(key, {
      kind: "turn",
      event: event(sessionId, {
        type: "turn.completed",
        result: { status: "completed", sessionId, turnId: "turn", text },
      }),
    });
    events.publish(key, {
      kind: "task",
      state: "finished",
      taskId: `t-${sessionId}`,
      status: "completed",
    });
  };
  return {
    operations: operations as unknown as AssistantSessionOperations,
    calls: operations,
    turns,
    answer,
  };
}

async function setupWatch(fields: Partial<JobFields> = {}) {
  const root = await tempDir("watch-runner-");
  const store: JobStore = await openJobStore({
    directory: path.join(root, "jobs"),
  });
  const watchStore: WatchStore = await openWatchStore({
    directory: path.join(root, "watches"),
  });
  const events = new SessionEventHub();
  const fake = createOperations(events);
  const page = createFakePage();
  const watcher = createWatcher({
    store: watchStore,
    fetch: page.fetch,
    policy: () => ({ preset: "open", allow: [] }),
    timeZone: () => "Australia/Brisbane",
  });
  const noisy: number[] = [];
  const runner: JobRunner = createJobRunner({
    store,
    operations: fake.operations,
    events,
    ownerId: () => "owner",
    resolveModel: () => undefined,
    projectDefaults: () => ({
      model: { providerId: "codex", modelId: "gpt-5" },
    }),
    prepareRun: async (job, _run, signal) => {
      if (!job.watch) return undefined;
      const check = await watcher.check(job, signal);
      if (check.kind === "quiet") {
        return {
          finish: { status: "completed", summary: check.summary },
          record: { watch: check.record },
        };
      }
      if (check.kind === "failed") {
        return {
          finish: {
            status: "failed",
            error: check.error,
            errorDetail: check.detail,
          },
          record: { watch: check.record },
        };
      }
      return { prompt: check.prompt, record: { watch: check.record } };
    },
    finishRun: async (job, run, text) => {
      if (run.watch?.outcome !== "changed") return {};
      const judged = await watcher.judge(job, run, text);
      if (judged.noisy) noisy.push(judged.noisy.count);
      return {
        watch: judged.record,
        ...(judged.summary ? { summary: judged.summary } : {}),
      };
    },
    onJobDeleted: (jobId) => void watcher.forget(jobId),
  });
  cleanup.push(() => runner.close());
  await runner.start();
  const job = await store.create({ ...WATCH_FIELDS, ...fields }, Date.now());
  await runner.jobChanged(job.id);
  /** Run the watch now and wait for its final record. */
  const runOnce = async (whileRunning?: (run: JobRun) => void) => {
    const started = await runner.runNow(job.id);
    // Generous under a loaded full-suite run.
    const wait = { timeout: 10_000 };
    if (whileRunning) {
      // Its turn started: the runner is following the session's events.
      await vi.waitFor(() => {
        const sessionId = store.run(started.runId)?.sessionId;
        expect(
          sessionId !== undefined &&
            fake.turns.some((turn) => turn.sessionId === sessionId),
        ).toBe(true);
      }, wait);
      whileRunning(store.run(started.runId)!);
    }
    await vi.waitFor(
      () =>
        expect(
          ["completed", "failed"].includes(store.run(started.runId)!.status),
        ).toBe(true),
      wait,
    );
    return store.run(started.runId)!;
  };
  return {
    root,
    store,
    watchStore,
    runner,
    fake,
    page,
    job: store.get(job.id)! as JobDefinition,
    runOnce,
    noisy,
  };
}

describe("watch runs", () => {
  it("remembers the page first, then makes no model call while it is unchanged", async () => {
    const harness = await setupWatch();
    const first = await harness.runOnce();
    expect(first).toMatchObject({
      status: "completed",
      watch: { outcome: "baseline" },
    });
    expect(first.sessionId).toBeUndefined();

    const second = await harness.runOnce();
    expect(second).toMatchObject({
      status: "completed",
      watch: { outcome: "unchanged" },
      summary: "No change since the last check.",
    });
    expect(harness.fake.calls.createSession).not.toHaveBeenCalled();
    expect(harness.fake.calls.startTurn).not.toHaveBeenCalled();
    expect(second.usage).toBeUndefined();
    // Neither tells the owner anything.
    expect(inboxEntryForRun(second, harness.job)).toBeUndefined();
  });

  it("sends the last validators and stops at a 304", async () => {
    const harness = await setupWatch();
    await harness.runOnce();
    harness.page.page.notModified = true;
    const run = await harness.runOnce();
    expect(run).toMatchObject({
      status: "completed",
      watch: { outcome: "not_modified" },
    });
    expect(harness.page.requests).toEqual([{}, { etag: '"1"' }]);
    expect(harness.fake.calls.createSession).not.toHaveBeenCalled();
  });

  it("records an irrelevant change, with its usage, but does not notify", async () => {
    const harness = await setupWatch();
    await harness.runOnce();
    harness.page.page.text = "v1 released\nfooter year 2027";
    harness.page.page.etag = '"2"';
    const run = await harness.runOnce((live) =>
      harness.fake.answer(
        live.sessionId!,
        "NOT RELEVANT: only the footer changed",
      ),
    );
    expect(harness.fake.turns[0]!.text).toContain("<page-change>");
    expect(harness.fake.turns[0]!.text).toContain("+ footer year 2027");
    expect(harness.fake.turns[0]!.text).toContain(
      "What matters to the owner: A new stable release",
    );
    expect(run).toMatchObject({
      status: "completed",
      summary: "only the footer changed",
      watch: { outcome: "changed", relevant: false },
      usage: { requests: 1, inputTokens: 950, outputTokens: 100 },
    });
    expect(inboxEntryForRun(run, harness.job)).toBeUndefined();
    expect(harness.watchStore.get(harness.job.id)?.findings).toEqual([]);
  });

  it("tells the owner up to the daily cap and keeps the rest for the briefing", async () => {
    const harness = await setupWatch();
    await harness.runOnce();
    harness.page.page.text = "v2 released";
    const told = await harness.runOnce((live) =>
      harness.fake.answer(
        live.sessionId!,
        "RELEVANT: v2 is out https://example.com/releases",
      ),
    );
    expect(told.watch).toEqual({
      outcome: "changed",
      relevant: true,
      notified: true,
    });
    expect(inboxEntryForRun(told, harness.job)).toMatchObject({
      kind: "watch_changed",
      title: "Releases: changed",
      body: "v2 is out https://example.com/releases",
      sessionId: told.sessionId,
    });

    harness.page.page.text = "v3 released";
    const held = await harness.runOnce((live) =>
      harness.fake.answer(live.sessionId!, "RELEVANT: v3 is out"),
    );
    expect(held.watch).toEqual({
      outcome: "changed",
      relevant: true,
      notified: false,
      heldForBriefing: true,
    });
    expect(inboxEntryForRun(held, harness.job)).toBeUndefined();
    expect(
      harness.watchStore
        .get(harness.job.id)
        ?.findings.map((finding) => [finding.summary, finding.notified]),
    ).toEqual([
      ["v2 is out https://example.com/releases", true],
      ["v3 is out", false],
    ]);
  });

  it(
    "keeps the last 10 snapshots and deletes them with the watch",
    {
      timeout: 60_000,
    },
    async () => {
      const harness = await setupWatch({
        watch: { url: "https://example.com/releases", notifyPerDay: 0 },
      });
      for (let index = 0; index < 12; index += 1) {
        harness.page.page.text = `version ${index}`;
        await harness.runOnce(
          index === 0
            ? undefined
            : (live) =>
                harness.fake.answer(live.sessionId!, "NOT RELEVANT: no"),
        );
      }
      const state = harness.watchStore.get(harness.job.id)!;
      expect(state.snapshots).toHaveLength(10);
      expect(state.snapshots.at(-1)?.text).toBe("version 11");
      const file = path.join(harness.root, "watches", `${harness.job.id}.json`);
      await expect(fs.stat(file)).resolves.toBeTruthy();

      await harness.store.delete(harness.job.id);
      await harness.runner.jobChanged(harness.job.id);
      await harness.watchStore.flush();
      await vi.waitFor(async () => {
        await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
      });
      expect(harness.watchStore.get(harness.job.id)).toBeUndefined();
    },
  );

  it("reports a page it cannot read once, not every check", async () => {
    const harness = await setupWatch();
    harness.page.fetch.mockRejectedValue(new Error("Blocked intranet.example"));
    const first = await harness.runOnce();
    const second = await harness.runOnce();
    expect(first).toMatchObject({
      status: "failed",
      error: "watch_fetch_failed",
      errorDetail: "Blocked intranet.example",
      watch: { outcome: "fetch_failed" },
    });
    expect(inboxEntryForRun(first, harness.job)).toMatchObject({
      kind: "run_failed",
    });
    expect(inboxEntryForRun(second, harness.job, first)).toBeUndefined();
  });
});

describe("watch fetches", () => {
  /**
   * A local plain-HTTP server standing in for public HTTPS sites. Only the
   * connector's lookup knows `watch.example`, so these also prove requests
   * go over the checked connection rather than Node's own DNS.
   */
  async function startSite(
    handler: (
      request: http.IncomingMessage,
      response: http.ServerResponse,
    ) => void,
  ) {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    cleanup.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const { port } = server.address() as AddressInfo;
    const connector = directConnector({
      // Public for the watched site, private for anything else.
      lookup: async (hostname) =>
        hostname === "watch.example" ? ["93.184.215.14"] : ["192.168.1.10"],
      connect: (): Socket => net.connect({ host: "127.0.0.1", port }),
    });
    const plain: SecureSocket = async (raw) => raw;
    return { connector, plain };
  }

  it("refuses a redirect to a private address", async () => {
    const site = await startSite((request, response) => {
      response.writeHead(302, {
        location:
          request.url === "/ip"
            ? "https://10.0.0.5/admin"
            : "https://intranet.example/",
      });
      response.end();
    });
    const fetch = (url: string) =>
      fetchWebPage({
        url,
        policy: { preset: "open", allow: [] },
        connector: site.connector,
        secureSocket: site.plain,
        keepRaw: true,
      });
    await expect(fetch("https://watch.example/page")).rejects.toThrow(
      "Blocked intranet.example: it resolves to a non-public address",
    );
    await expect(fetch("https://watch.example/ip")).rejects.toThrow(
      "IP addresses",
    );
  });

  it("sends conditional headers and returns no body for a 304", async () => {
    const site = await startSite((request, response) => {
      if (request.headers["if-none-match"] === '"v1"') {
        response.writeHead(304, { etag: '"v1"' });
        response.end();
        return;
      }
      response.writeHead(200, {
        "content-type": "text/html",
        etag: '"v1"',
        "last-modified": "Fri, 16 Oct 2026 00:00:00 GMT",
      });
      response.end("<html><body><main>Hello</main></body></html>");
    });
    const base = {
      url: "https://watch.example/",
      policy: { preset: "open" as const, allow: [] },
      connector: site.connector,
      secureSocket: site.plain,
      keepRaw: true,
    };
    const first = await fetchWebPage(base);
    expect(first).toMatchObject({
      status: 200,
      etag: '"v1"',
      lastModified: "Fri, 16 Oct 2026 00:00:00 GMT",
      text: "Hello",
    });
    expect(first.raw).toContain("<main>Hello</main>");
    const again = await fetchWebPage({
      ...base,
      conditional: { etag: '"v1"' },
    });
    expect(again).toMatchObject({ status: 304, notModified: true, text: "" });
  });

  it("sends the bare host name, not name:80, so sites do not redirect forever", async () => {
    // GitHub answers `Host: github.com:80` with a redirect to the same URL.
    const hosts: (string | undefined)[] = [];
    const site = await startSite((request, response) => {
      hosts.push(request.headers.host);
      if (request.headers.host !== "watch.example") {
        response.writeHead(301, { location: "https://watch.example/feed" });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/atom+xml" });
      response.end("<feed></feed>");
    });
    const page = await fetchWebPage({
      url: "https://watch.example/feed",
      policy: { preset: "open", allow: [] },
      connector: site.connector,
      secureSocket: site.plain,
      keepRaw: true,
    });
    expect(page.status).toBe(200);
    expect(hosts).toEqual(["watch.example"]);
  });
});

describe("usage guard", () => {
  const run = (runId: string, tokens: number, at: number): JobRun => ({
    runId,
    jobId: "j",
    projectId: "home",
    trigger: "schedule",
    status: "completed",
    createdAt: at,
    updatedAt: at,
    finishedAt: at,
    usage: { requests: 1, inputTokens: tokens, outputTokens: 0 },
  });

  it("flags a run over three times the usual, once there is a history", () => {
    const history = [run("c", 1_000, 3), run("b", 1_200, 2), run("a", 900, 1)];
    expect(unusualUsage(run("d", 3_100, 4), history)).toBe(1_000);
    expect(unusualUsage(run("d", 2_900, 4), history)).toBeUndefined();
    expect(
      unusualUsage(run("d", 99_000, 4), history.slice(0, 2)),
    ).toBeUndefined();
  });
});
