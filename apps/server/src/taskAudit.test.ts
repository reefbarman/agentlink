import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  AUDIT_HEAD_FILE,
  AUDIT_LOG_FILE,
  auditEntryHash,
  auditTextDigest,
  auditedTaskStore,
  openTaskAudit,
  taskAuditRecords,
  verifyTaskAudit,
  type TaskAuditEntry,
} from "./taskAudit.js";
import { openTaskStore, type TaskRun } from "./taskStore.js";
import { runAssistantServerCli } from "./serverCli.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "task-audit-"));
  cleanup.push(() =>
    fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
  );
  return dir;
}

const ID = "aaaaaaaaaaaa";
const COMMIT = "1".repeat(40);

const task = (overrides: Partial<TaskRun> = {}): TaskRun => ({
  id: ID,
  repository: "https://github.com/acme/demo",
  objective: "Fix the bug",
  projectId: `task-${ID}`,
  branch: `agentlink/fix-${ID}`,
  workspace: `/srv/.tasks/${ID}/demo`,
  state: "queued",
  attempts: 0,
  evidence: [],
  effects: [],
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const readLines = async (dir: string) =>
  (await fs.readFile(path.join(dir, AUDIT_LOG_FILE), "utf8"))
    .split("\n")
    .filter(Boolean);

/** A log with a few entries across two tasks. */
async function writtenLog() {
  const dir = await tempDir();
  const audit = await openTaskAudit({ directory: dir });
  const created = task({ origin: { projectId: "p", sessionId: "chat-1" } });
  await audit.taskChanged(undefined, created);
  await audit.taskChanged(
    created,
    task({ state: "implementing", sessionId: "impl-1", updatedAt: 2 }),
    { runsIn: "runner" },
  );
  await audit.taskChanged(undefined, task({ id: "bbbbbbbbbbbb" }));
  await audit.flush();
  return { dir, audit };
}

describe("taskAuditRecords", () => {
  it("records creation with the chat that asked, then the state", () => {
    const records = taskAuditRecords(
      undefined,
      task({ origin: { projectId: "p", sessionId: "chat-1" } }),
    );
    expect(records.map((record) => record.kind)).toEqual(["created", "state"]);
    expect(records[0]!.data).toMatchObject({
      repository: "https://github.com/acme/demo",
      objective: auditTextDigest("Fix the bug"),
      origin: { projectId: "p", sessionId: "chat-1" },
    });
    expect(JSON.stringify(records)).not.toContain("Fix the bug");
  });

  it("records the task chat and where it runs", () => {
    const records = taskAuditRecords(
      task(),
      task({ state: "implementing", sessionId: "impl-1" }),
      { runsIn: "runner" },
    );
    expect(records).toEqual([
      { kind: "state", data: { state: "implementing" } },
      { kind: "session", data: { sessionId: "impl-1", runsIn: "runner" } },
    ]);
  });

  it("records new evidence and effects once, without command output", () => {
    const validation = {
      kind: "validation" as const,
      commit: COMMIT,
      at: 3,
      passed: false,
      commands: [
        {
          command: "npm test",
          exitCode: 1,
          timedOut: false,
          durationMs: 50,
          outputTail: "secret-looking output",
        },
      ],
    };
    const review = {
      kind: "review" as const,
      commit: COMMIT,
      at: 4,
      model: "claude/sonnet",
      sessionId: "review-1",
      verdict: "changes_requested" as const,
      findings: [
        { severity: "blocking" as const, file: "a.ts", reason: "Off by one" },
      ],
    };
    const before = task({ evidence: [validation] });
    const after = task({
      evidence: [validation, review],
      effects: [{ kind: "push", commit: COMMIT, status: "intended", at: 5 }],
      connectionId: "conn-1",
    });
    const records = taskAuditRecords(before, after);
    expect(records.map((record) => record.kind)).toEqual([
      "connection",
      "evidence",
      "effect",
    ]);
    expect(records[1]!.data).toMatchObject({
      kind: "review",
      verdict: "changes_requested",
      findings: [
        {
          severity: "blocking",
          file: "a.ts",
          reason: auditTextDigest("Off by one"),
        },
      ],
    });
    expect(JSON.stringify(taskAuditRecords(undefined, before))).not.toContain(
      "secret-looking output",
    );
    // The same effect with a new outcome is a new record.
    const done = task({
      ...after,
      effects: [
        { kind: "push", commit: COMMIT, status: "done", at: 6 },
      ] as TaskRun["effects"],
    });
    expect(taskAuditRecords(after, done)).toEqual([
      {
        kind: "effect",
        data: { effect: "push", commit: COMMIT, status: "done" },
      },
    ]);
  });

  it("records follow-ups by content, even once old ones are dropped", () => {
    const followUp = (at: number) => ({ instructions: `step ${at}`, at });
    const origin = { projectId: "p", sessionId: "chat-2" };
    const records = taskAuditRecords(
      task({ followUps: [followUp(1), followUp(2)] }),
      task({ followUps: [followUp(2), followUp(3)], origin }),
    );
    expect(records).toEqual([
      {
        kind: "follow_up",
        data: { instructions: auditTextDigest("step 3"), origin },
      },
    ]);
  });
});

describe("openTaskAudit", () => {
  it("writes a chain that verifies, and keeps each task's entries", async () => {
    const { dir, audit } = await writtenLog();
    await audit.request(
      ID,
      "stop",
      { kind: "task_chat", sessionId: "impl-1" },
      9,
    );
    expect(await audit.verify()).toEqual({
      ok: true,
      entries: 7,
      problems: [],
      damaged: [],
    });
    const entries = audit.entries(ID);
    expect(entries.map((entry) => entry.kind)).toEqual([
      "created",
      "state",
      "state",
      "session",
      "request",
    ]);
    expect(entries.at(-1)!.data).toEqual({
      action: "stop",
      by: { kind: "task_chat", sessionId: "impl-1" },
    });
    // Reopened: the same entries, and appending continues the chain.
    const reopened = await openTaskAudit({ directory: dir });
    expect(reopened.entries(ID)).toEqual(entries);
    await reopened.taskDeleted(task(), 10);
    expect((await reopened.verify()).entries).toBe(8);
    const head = JSON.parse(
      await fs.readFile(path.join(dir, AUDIT_HEAD_FILE), "utf8"),
    ) as { seq: number };
    expect(head.seq).toBe(8);
  });

  it("records request text only as its digest", async () => {
    const dir = await tempDir();
    const audit = await openTaskAudit({ directory: dir });
    await audit.request(
      ID,
      "message",
      { kind: "task_chat", sessionId: "s" },
      1,
      { text: "please use the marker-7731 branch" },
    );
    expect(audit.entries(ID)[0]!.data.text).toBe(
      auditTextDigest("please use the marker-7731 branch"),
    );
    expect(
      await fs.readFile(path.join(dir, AUDIT_LOG_FILE), "utf8"),
    ).not.toContain("marker-7731");
  });

  it("detects a changed line", async () => {
    const { dir } = await writtenLog();
    const lines = await readLines(dir);
    lines[2] = lines[2]!.replace('"implementing"', '"ready"');
    await fs.writeFile(path.join(dir, AUDIT_LOG_FILE), `${lines.join("\n")}\n`);
    const result = await verifyTaskAudit(dir);
    expect(result.ok).toBe(false);
    expect(result.entries).toBe(2);
    expect(result.problems[0]).toMatch(/line 3 was changed/u);
  });

  it("detects a changed line whose hash was recomputed", async () => {
    const { dir } = await writtenLog();
    const lines = await readLines(dir);
    const entry = JSON.parse(lines[1]!) as TaskAuditEntry;

    const forged = { ...entry, data: { state: "ready" } };
    lines[1] = JSON.stringify({ ...forged, hash: auditEntryHash(forged) });
    await fs.writeFile(path.join(dir, AUDIT_LOG_FILE), `${lines.join("\n")}\n`);
    const result = await verifyTaskAudit(dir);
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/line 3 does not follow/u);
  });

  it("detects a removed or reordered line", async () => {
    const { dir } = await writtenLog();
    const lines = await readLines(dir);
    await fs.writeFile(
      path.join(dir, AUDIT_LOG_FILE),
      `${[lines[0], lines[2], lines[3], lines[4], lines[5]].join("\n")}\n`,
    );
    const removed = await verifyTaskAudit(dir);
    expect(removed.ok).toBe(false);
    expect(removed.problems[0]).toMatch(/removed or reordered/u);

    await fs.writeFile(
      path.join(dir, AUDIT_LOG_FILE),
      `${[lines[1], lines[0], ...lines.slice(2)].join("\n")}\n`,
    );
    expect((await verifyTaskAudit(dir)).ok).toBe(false);
  });

  it("detects entries removed from the end", async () => {
    const { dir } = await writtenLog();
    const lines = await readLines(dir);
    await fs.writeFile(
      path.join(dir, AUDIT_LOG_FILE),
      `${lines.slice(0, -2).join("\n")}\n`,
    );
    const result = await verifyTaskAudit(dir);
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/removed from the end/u);

    await fs.rm(path.join(dir, AUDIT_LOG_FILE));
    expect((await verifyTaskAudit(dir)).ok).toBe(false);
  });

  it("detects a missing head", async () => {
    const { dir } = await writtenLog();
    await fs.rm(path.join(dir, AUDIT_HEAD_FILE));
    const result = await verifyTaskAudit(dir);
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(["the log's head record is missing"]);
  });

  it("drops a final line cut short by a crash", async () => {
    const { dir } = await writtenLog();
    await fs.appendFile(path.join(dir, AUDIT_LOG_FILE), '{"seq":7,"at');
    const logged: string[] = [];
    const audit = await openTaskAudit({
      directory: dir,
      log: (line) => logged.push(line),
    });
    expect(logged).toEqual([
      "Audit log: dropped a final line cut short by a crash",
    ]);
    await audit.taskDeleted(task(), 5);
    expect(await audit.verify()).toMatchObject({ ok: true, entries: 7 });
  });

  it("keeps a damaged log and records the damage in the chain", async () => {
    const { dir } = await writtenLog();
    const lines = await readLines(dir);
    lines[3] = lines[3]!.replace('"runner"', '"server"');
    await fs.writeFile(path.join(dir, AUDIT_LOG_FILE), `${lines.join("\n")}\n`);
    const logged: string[] = [];
    const audit = await openTaskAudit({
      directory: dir,
      log: (line) => logged.push(line),
      now: () => 1234,
    });
    expect(logged[0]).toMatch(/Audit log damaged: line 4 was changed/u);
    const kept = await fs.readFile(
      path.join(dir, `${AUDIT_LOG_FILE}.damaged-1234`),
      "utf8",
    );
    expect(kept).toContain('"server"');
    const result = await audit.verify();
    expect(result).toMatchObject({ ok: true, entries: 4 });
    expect(result.damaged).toEqual([
      {
        at: 1234,
        problems: [expect.stringMatching(/line 4 was changed/u)],
        keptAs: `${AUDIT_LOG_FILE}.damaged-1234`,
      },
    ]);
    // Entries after the damage are not credited to the task.
    expect(audit.entries(ID).map((entry) => entry.kind)).toEqual([
      "created",
      "state",
      "state",
    ]);
  });
});

describe("agentlink-server audit-check", () => {
  it("exits 0 for an intact chain and 1 for a broken one", async () => {
    const root = await tempDir();
    await fs.mkdir(path.join(root, "projects", "home"), { recursive: true });
    const configPath = path.join(root, "server.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        dataRoot: "data",
        listen: { host: "127.0.0.1", port: 8443 },
        publicOrigins: ["https://assistant.home.arpa:8443"],
        tls: { localCa: true },
        defaultModel: { providerId: "codex", modelId: "gpt-6.1-sol" },
        providers: [{ type: "codex", modelIds: ["gpt-6.1-sol"] }],
        projects: [{ id: "home", root: "projects/home" }],
      }),
    );
    const dir = path.join(root, "data", "audit");
    const audit = await openTaskAudit({ directory: dir });
    await audit.taskChanged(undefined, task());
    await audit.flush();
    const run = async () => {
      let stdout = "";
      const code = await runAssistantServerCli(
        ["audit-check", "--config", configPath],
        {
          stdout: (text: string) => {
            stdout += text;
          },
          log: () => undefined,
          env: {},
          waitForShutdown: () => new Promise<string>(() => undefined),
        },
      );
      return { code, stdout };
    };
    await expect(run()).resolves.toEqual({
      code: 0,
      stdout: "Audit log OK: 2 entries, hash chain intact\n",
    });
    const lines = await readLines(dir);
    await fs.writeFile(path.join(dir, AUDIT_LOG_FILE), `${lines[0]}\n`);
    const broken = await run();
    expect(broken.code).toBe(1);
    expect(broken.stdout).toMatch(
      /broken after 1 good entry: .*removed from the end/u,
    );
  });
});

describe("auditedTaskStore", () => {
  it("records creates, saves and deletes, and keeps entries after delete", async () => {
    const dir = await tempDir();
    const audit = await openTaskAudit({ directory: path.join(dir, "audit") });
    const store = auditedTaskStore(
      await openTaskStore({ directory: path.join(dir, "tasks") }),
      audit,
      { runsIn: () => "runner", now: () => 99 },
    );
    const created = await store.create(task());
    await store.save({
      ...created,
      state: "implementing",
      sessionId: "impl-1",
      updatedAt: 2,
    });
    expect(await store.delete(ID)).toBe(true);
    expect(store.get(ID)).toBeUndefined();
    expect(audit.entries(ID).map((entry) => [entry.kind, entry.data])).toEqual([
      [
        "created",
        expect.objectContaining({ objective: auditTextDigest("Fix the bug") }),
      ],
      ["state", { state: "queued" }],
      ["state", { state: "implementing" }],
      ["session", { sessionId: "impl-1", runsIn: "runner" }],
      ["deleted", {}],
    ]);
    expect(audit.entries(ID).at(-1)!.at).toBe(99);
    expect((await audit.verify()).ok).toBe(true);
  });

  it("still saves the task when the audit write fails", async () => {
    const dir = await tempDir();
    const store = auditedTaskStore(await openTaskStore({ directory: dir }), {
      taskChanged: async () => {
        throw new Error("disk full");
      },
      taskDeleted: async () => undefined,
    });
    await store.create(task());
    expect(store.get(ID)?.state).toBe("queued");
  });
});
